import type { Commit, Ref, RepoSnapshot } from '../types.js';

const EPOCH = Date.UTC(2021, 0, 1, 0, 0, 0);
const HOUR = 3_600_000;

export type CommitSpec = {
  oid: string;
  parents?: string[];
  /** Hours after the fixture epoch. Defaults to the commit's index. */
  h?: number;
  author?: string;
  additions?: number;
  deletions?: number;
  prNumber?: number;
  prCommitCount?: number;
  subject?: string;
};

export function commit(spec: CommitSpec, index: number): Commit {
  const h = spec.h ?? index;
  return {
    oid: spec.oid,
    parents: spec.parents ?? [],
    author: spec.author ?? 'Ada Lovelace',
    authorEmail: `${(spec.author ?? 'ada').toLowerCase().replace(/\s+/g, '.')}@example.com`,
    date: new Date(EPOCH + h * HOUR).toISOString(),
    subject: spec.subject ?? `commit ${spec.oid}`,
    additions: spec.additions ?? 10,
    deletions: spec.deletions ?? 2,
    filesChanged: 1,
    ...(spec.prNumber !== undefined ? { prNumber: spec.prNumber } : {}),
    ...(spec.prCommitCount !== undefined ? { prCommitCount: spec.prCommitCount } : {}),
  };
}

export function snapshot(spec: {
  name?: string;
  head: string;
  commits: CommitSpec[];
  refs?: Ref[];
  defaultBranch?: string;
  truncated?: boolean;
}): RepoSnapshot {
  return {
    schemaVersion: 1,
    name: spec.name ?? 'fixture/repo',
    description: null,
    head: spec.head,
    defaultBranch: spec.defaultBranch ?? 'main',
    source: 'github',
    truncated: spec.truncated ?? false,
    generatedAt: new Date(EPOCH).toISOString(),
    commits: spec.commits.map(commit),
    refs: spec.refs ?? [],
  };
}

/* ------------------------------------------------------------------ */
/* The fixture DAGs                                                    */
/* ------------------------------------------------------------------ */

/** a <- b <- c <- d. No merges at all. */
export const linear = () =>
  snapshot({
    head: 'd',
    commits: [
      { oid: 'a' },
      { oid: 'b', parents: ['a'] },
      { oid: 'c', parents: ['b'] },
      { oid: 'd', parents: ['c'] },
    ],
    refs: [{ name: 'main', oid: 'd', kind: 'branch' }],
  });

/**
 *   a - b -------- m - e     (trunk)
 *        \        /
 *         f1 - f2            (limb)
 */
export const singleMerge = () =>
  snapshot({
    head: 'e',
    commits: [
      { oid: 'a', h: 0 },
      { oid: 'b', parents: ['a'], h: 1 },
      { oid: 'f1', parents: ['b'], h: 2 },
      { oid: 'f2', parents: ['f1'], h: 3 },
      { oid: 'm', parents: ['b', 'f2'], h: 4, subject: "Merge branch 'feature'" },
      { oid: 'e', parents: ['m'], h: 5 },
    ],
    refs: [{ name: 'main', oid: 'e', kind: 'branch' }],
  });

/**
 * A merge into a feature branch, which is itself merged into the trunk.
 * The inner branch must come out as a depth-2 sub-limb.
 */
export const nestedMerges = () =>
  snapshot({
    head: 'top',
    commits: [
      { oid: 'a', h: 0 },
      { oid: 'b', parents: ['a'], h: 1 },
      { oid: 'f1', parents: ['b'], h: 2 },
      { oid: 'g1', parents: ['f1'], h: 3 },
      { oid: 'g2', parents: ['g1'], h: 4 },
      { oid: 'f2', parents: ['f1', 'g2'], h: 5, subject: "Merge branch 'inner'" },
      { oid: 'm', parents: ['b', 'f2'], h: 6, subject: "Merge branch 'outer'" },
      { oid: 'top', parents: ['m'], h: 7 },
    ],
    refs: [{ name: 'main', oid: 'top', kind: 'branch' }],
  });

/** A four-parent octopus merge. parents.length <= 2 is not a safe assumption. */
export const octopus = () =>
  snapshot({
    head: 'oct',
    commits: [
      { oid: 'a', h: 0 },
      { oid: 'x1', parents: ['a'], h: 1 },
      { oid: 'y1', parents: ['a'], h: 2 },
      { oid: 'z1', parents: ['a'], h: 3 },
      { oid: 'oct', parents: ['a', 'x1', 'y1', 'z1'], h: 4, subject: 'Merge branches x, y and z' },
    ],
    refs: [{ name: 'main', oid: 'oct', kind: 'branch' }],
  });

/** A ref pointing at work that was never merged back. */
export const dangling = () =>
  snapshot({
    head: 'c',
    commits: [
      { oid: 'a', h: 0 },
      { oid: 'b', parents: ['a'], h: 1 },
      { oid: 'c', parents: ['b'], h: 2 },
      { oid: 'w1', parents: ['b'], h: 3 },
      { oid: 'w2', parents: ['w1'], h: 4 },
    ],
    refs: [
      { name: 'main', oid: 'c', kind: 'branch' },
      { name: 'wip/abandoned', oid: 'w2', kind: 'branch' },
    ],
  });

/** A grafted history: two parentless commits, only one of them on the trunk. */
export const multipleRoots = () =>
  snapshot({
    head: 'm',
    commits: [
      { oid: 'r1', h: 0 },
      { oid: 'a', parents: ['r1'], h: 1 },
      { oid: 'r2', h: 2 },
      { oid: 'b', parents: ['r2'], h: 3 },
      { oid: 'm', parents: ['a', 'b'], h: 4, subject: "Merge branch 'graft'" },
    ],
    refs: [{ name: 'main', oid: 'm', kind: 'branch' }],
  });

/** A shallow clone: `c` names a parent that is not in the snapshot. */
export const shallow = () =>
  snapshot({
    head: 'e',
    commits: [
      { oid: 'c', parents: ['MISSING'], h: 0 },
      { oid: 'd', parents: ['c'], h: 1 },
      { oid: 'e', parents: ['d'], h: 2 },
    ],
    refs: [{ name: 'main', oid: 'e', kind: 'branch' }],
    truncated: true,
  });

export const singleCommit = () =>
  snapshot({
    head: 'only',
    commits: [{ oid: 'only' }],
    refs: [{ name: 'main', oid: 'only', kind: 'branch' }],
  });

export const empty = () => snapshot({ head: '', commits: [], refs: [] });

/** Rewritten history that produced a parent cycle. Must fail, not hang. */
export const cyclic = () =>
  snapshot({
    head: 'c',
    commits: [
      { oid: 'a', parents: ['c'], h: 0 },
      { oid: 'b', parents: ['a'], h: 1 },
      { oid: 'c', parents: ['b'], h: 2 },
    ],
    refs: [],
  });

/** 40 commits, no merges, every one carrying PR metadata: the squash-merge case. */
export const squashed = (withPrData = true) =>
  snapshot({
    head: 'c39',
    commits: Array.from({ length: 40 }, (_, i) => ({
      oid: `c${i}`,
      parents: i === 0 ? [] : [`c${i - 1}`],
      h: i * 6,
      subject: `Add thing ${i} (#${100 + i})`,
      ...(withPrData ? { prNumber: 100 + i, prCommitCount: 3 + (i % 4) } : {}),
    })),
    refs: [{ name: 'main', oid: 'c39', kind: 'branch' }],
  });

/** A wide, deep tree used for layout and performance tests. */
export function synthetic(commitCount: number, branchEvery = 25): RepoSnapshot {
  const commits: CommitSpec[] = [];
  const authors = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Karen Sparck Jones'];
  let prev: string | null = null;
  let n = 0;
  const refs: Ref[] = [];

  while (n < commitCount) {
    const oid = `t${n}`;
    commits.push({
      oid,
      parents: prev ? [prev] : [],
      h: n * 3,
      author: authors[n % authors.length],
      additions: 5 + ((n * 37) % 400),
      deletions: (n * 13) % 120,
    });
    prev = oid;
    n++;

    if (n % branchEvery === 0 && n + 6 < commitCount) {
      const base = prev;
      let bprev = base;
      const len = 3 + (n % 5);
      for (let i = 0; i < len && n < commitCount; i++, n++) {
        const boid = `b${n}`;
        commits.push({
          oid: boid,
          parents: [bprev],
          h: n * 3,
          author: authors[(n + 1) % authors.length],
          additions: 3 + ((n * 17) % 200),
          deletions: (n * 7) % 90,
        });
        bprev = boid;
      }
      const moid = `m${n}`;
      commits.push({
        oid: moid,
        parents: [base, bprev],
        h: n * 3,
        subject: `Merge pull request #${n} from acme/feature-${n}`,
        author: authors[n % authors.length],
      });
      prev = moid;
      n++;
    }
  }
  refs.push({ name: 'main', oid: prev!, kind: 'branch' });
  return snapshot({ head: prev!, commits, refs });
}
