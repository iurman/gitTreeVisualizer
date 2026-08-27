import type { Plugin } from 'vite';
import type { Commit, RepoSnapshot } from '@gittree/core';
import { FIRST_PAGE_COMMITS, PAGE_SIZE } from './api/_github.js';

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

/** A squash-merged history: linear, no merge commits. With PR data, branches
 * can be reconstructed; without it, directory mode takes over. */
function linear(name: string, commitCount: number, withPrData: boolean): RepoSnapshot {
  const authors = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing'];
  const words = ['parser', 'cache', 'router', 'store', 'shader', 'index'];
  let seed = 0x51a7c3;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let clock = Date.UTC(2019, 5, 1);
  const commits: Commit[] = [];
  for (let i = 0; i < commitCount; i++) {
    clock += 3_600_000 * (1 + rnd() * 40);
    const oid = `${(i + 0x20000).toString(16)}${'0'.repeat(33)}`.slice(0, 40);
    commits.push({
      oid,
      parents: i === 0 ? [] : [commits[i - 1].oid],
      author: authors[Math.floor(rnd() * authors.length)],
      authorEmail: 'dev@example.com',
      date: new Date(clock).toISOString(),
      subject: `Rework the ${words[Math.floor(rnd() * words.length)]} (#${400 + i})`,
      additions: Math.floor(5 + rnd() * 600),
      deletions: Math.floor(rnd() * 260),
      filesChanged: Math.max(1, Math.floor(rnd() * 9)),
      ...(withPrData ? { prNumber: 400 + i, prCommitCount: 2 + Math.floor(rnd() * 7) } : {}),
    });
  }
  const snapshot: RepoSnapshot = {
    schemaVersion: 1,
    name,
    description: withPrData ? 'A squash-merged history.' : 'A history with no recoverable structure.',
    head: commits[commits.length - 1].oid,
    defaultBranch: 'main',
    source: 'github',
    truncated: false,
    generatedAt: new Date().toISOString(),
    commits: commits.reverse(),
    refs: [{ name: 'main', oid: commits[0].oid, kind: 'branch' }],
  };
  if (!withPrData) {
    const dirs = ['src', 'src/core', 'src/ui', 'src/ui/panels', 'packages/api', 'packages/api/routes', 'docs', 'test'];
    snapshot.tree = Array.from({ length: 240 }, (_, i) => ({
      path: `${dirs[i % dirs.length]}/mod${i % 17}/file${i}.${['ts', 'tsx', 'css', 'md'][i % 4]}`,
      size: 200 + i * 7,
    }));
  }
  return snapshot;
}

/**
 * The shape comes from the repository name, not a query parameter: the viewer
 * builds its own API URLs, so a name is the only thing that survives a deep
 * link. `acme/squash-300` gives a squash-merged history of 300 commits,
 * `acme/flat` one with no recoverable structure at all, and any trailing number
 * sets the size.
 */
function shapeFor(owner: string, name: string, url: URL): RepoSnapshot {
  const size = Number(/-(\d+)$/.exec(name)?.[1] ?? url.searchParams.get('n') ?? 1400);
  if (/^squash/.test(name)) return linear(`${owner}/${name}`, size, true);
  if (/^flat/.test(name)) return linear(`${owner}/${name}`, size, false);
  return synthesize(`${owner}/${name}`, size);
}

export function devApi(): Plugin {
  return {
    name: 'gittree-dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');

        // The flat drawing, so the no-WebGL fallback can be exercised locally.
        const svgMatch = /^\/api\/silhouette\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (svgMatch) {
          // Loaded through Vite so core's TypeScript sources resolve; importing
          // it at config-load time would be evaluated by bare Node instead.
          const core = await server.ssrLoadModule('@gittree/core');
          const snapshot = shapeFor(decodeURIComponent(svgMatch[1]), decodeURIComponent(svgMatch[2]), url);
          let tree = core.buildTopology(snapshot);
          if (tree.stats.flat && snapshot.tree?.length) tree = core.buildDirectoryTopology(snapshot);
          const opts = core.defaultLayoutOptions(tree);
          const window = url.searchParams.get('from') && url.searchParams.get('to')
            ? { start: url.searchParams.get('from')!, end: url.searchParams.get('to')! }
            : opts.window;
          const result = core.layout(tree, 'tree2d', {
            ...opts,
            window,
            ringUnit: core.autoRingUnit(window),
            growthCutoff: 1,
          });
          res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
          res.end(
            core.silhouetteSvg(tree, result, {
              width: Number(url.searchParams.get('w') ?? 1200),
              height: Number(url.searchParams.get('h') ?? 700),
              caption: url.searchParams.get('caption') !== '0',
            }),
          );
          return;
        }

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

        // Paginated the way the real adapter is. Returning the whole history in
        // one response made development pleasant and the measurements a lie:
        // production sends a 300-commit first page and then hundreds, and the
        // viewer ingests each one, so anything quadratic in the number of pages
        // was invisible here and expensive there.
        const full = shapeFor(owner, name, url);
        const from = Number(url.searchParams.get('cursor') ?? 0);
        const size = from === 0 ? FIRST_PAGE_COMMITS : PAGE_SIZE;
        const slice = full.commits.slice(from, from + size);
        const after = from + slice.length;
        res.end(
          JSON.stringify({
            snapshot: { ...full, commits: slice },
            cursor: after < full.commits.length ? String(after) : null,
          }),
        );
      });
    },
  };
}
