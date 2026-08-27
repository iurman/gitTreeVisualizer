import type { Plugin } from 'vite';
import type { Commit, RepoSnapshot } from '@gittree/core';

/* -------------------------------------------------------------------------- */
/* Development API                                                             */
/*                                                                            */
/* Set GITTREE_LIVE=1 with a GITHUB_TOKEN to proxy the real adapter. Otherwise  */
/* this serves a synthesized repository with the same shape, so the viewer can  */
/* be worked on without credentials and without spending anyone's API budget.   */
/* The opt-in is explicit because an ambient GITHUB_TOKEN in the shell is       */
/* usually scoped to something else entirely.                                   */
/* The snapshot it emits is the same RepoSnapshot as everything else; nothing   */
/* downstream can tell the difference, which is the point of the contract.      */
/* -------------------------------------------------------------------------- */

function synthesize(name: string, commitCount = 1400): RepoSnapshot {
  const authors = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Karen Spärck Jones', 'Barbara Liskov'];
  const words = ['parser', 'cache', 'router', 'store', 'shader', 'index', 'queue', 'schema', 'theme', 'worker'];
  const verbs = ['Fix', 'Add', 'Refactor', 'Remove', 'Speed up', 'Document', 'Rename', 'Simplify'];

  // A deterministic pseudo-random sequence: the dev repo is the same every run,
  // so a visual change is always a change you made.
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const commits: Commit[] = [];
  const start = Date.UTC(2016, 2, 3);
  let clock = start;
  let prev: string | null = null;
  let n = 0;
  const refs: { name: string; oid: string; kind: 'branch' }[] = [];

  const mk = (parents: string[]): Commit => {
    const oid = `${(n + 0x10000).toString(16)}${'0'.repeat(33)}`.slice(0, 40);
    // Bursts and dormant stretches, so the compressed-time scale has something
    // real to compress.
    const gap = rnd() < 0.04 ? 86_400_000 * (12 + rnd() * 90) : 3_600_000 * (0.4 + rnd() * 26);
    clock += gap;
    const big = rnd() < 0.05;
    const c: Commit = {
      oid,
      parents,
      author: authors[Math.floor(rnd() * authors.length)],
      authorEmail: 'dev@example.com',
      date: new Date(clock).toISOString(),
      subject: `${verbs[Math.floor(rnd() * verbs.length)]} the ${words[Math.floor(rnd() * words.length)]}`,
      additions: big ? Math.floor(400 + rnd() * 5200) : Math.floor(1 + rnd() * 180),
      deletions: rnd() < 0.2 ? Math.floor(60 + rnd() * 900) : Math.floor(rnd() * 60),
      filesChanged: Math.max(1, Math.floor(rnd() * 12)),
    };
    n++;
    return c;
  };

  while (n < commitCount) {
    const c = mk(prev ? [prev] : []);
    commits.push(c);
    prev = c.oid;

    if (rnd() < 0.11 && n + 8 < commitCount) {
      const base = prev;
      let tip = base;
      const len = 2 + Math.floor(rnd() * 9);
      const branchName = `feature/${words[Math.floor(rnd() * words.length)]}-${n}`;
      for (let i = 0; i < len && n < commitCount; i++) {
        const b = mk([tip]);
        commits.push(b);
        tip = b.oid;
        // Occasionally branch off the branch, so sub-limbs exist.
        if (rnd() < 0.18 && n + 4 < commitCount) {
          let t2 = tip;
          for (let j = 0; j < 2 + Math.floor(rnd() * 3) && n < commitCount; j++) {
            const d = mk([t2]);
            commits.push(d);
            t2 = d.oid;
          }
          const m2 = mk([tip, t2]);
          m2.subject = `Merge branch 'inner-${n}'`;
          commits.push(m2);
          tip = m2.oid;
        }
      }
      if (rnd() < 0.9) {
        const m = mk([base, tip]);
        m.subject = `Merge pull request #${n} from acme/${branchName}`;
        m.prNumber = n;
        commits.push(m);
        prev = m.oid;
      } else {
        // Abandoned: a ref that never merged back.
        refs.push({ name: branchName, oid: tip, kind: 'branch' });
      }
    }
  }

  refs.unshift({ name: 'main', oid: prev!, kind: 'branch' });
  return {
    schemaVersion: 1,
    name,
    description: 'A synthesized repository, served because no GITHUB_TOKEN is set.',
    head: prev!,
    defaultBranch: 'main',
    source: 'github',
    truncated: false,
    generatedAt: new Date().toISOString(),
    commits: commits.reverse(),
    refs,
  };
}

export function devApi(): Plugin {
  return {
    name: 'gittree-dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const repoMatch = /^\/api\/repo\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (!repoMatch) return next();

        const owner = decodeURIComponent(repoMatch[1]);
        const name = decodeURIComponent(repoMatch[2]);

        res.setHeader('Content-Type', 'application/json; charset=utf-8');

        if (process.env.GITTREE_LIVE === '1' && process.env.GITHUB_TOKEN) {
          try {
            const mod = await server.ssrLoadModule('/api/_github.ts');
            const out = await mod.fetchSnapshot(owner, name, url.searchParams.get('cursor'));
            if (!url.searchParams.get('cursor') && mod.looksFlat(out.snapshot.commits)) {
              const tree = await mod.fetchTree(owner, name, out.headSha);
              if (tree?.length) out.snapshot.tree = tree;
            }
            res.end(JSON.stringify({ snapshot: out.snapshot, cursor: out.cursor }));
          } catch (e) {
            const err = e as { status?: number; message?: string; hint?: string };
            res.statusCode = err.status ?? 500;
            res.end(JSON.stringify({ error: err.message ?? 'Failed', hint: err.hint }));
          }
          return;
        }

        const size = Number(url.searchParams.get('n') ?? 1400);
        res.end(JSON.stringify({ snapshot: synthesize(`${owner}/${name}`, size), cursor: null }));
      });
    },
  };
}
