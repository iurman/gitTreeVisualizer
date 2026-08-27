import {
  MAX_LIMB_DEPTH,
  TopologyError,
  type Commit,
  type CommitNode,
  type LimbNode,
  type RepoSnapshot,
  type TreeStructure,
} from './types.js';
import { hash32 } from './hash.js';

/* -------------------------------------------------------------------------- */
/* Topology inference                                                          */
/*                                                                            */
/* Git does not store branch membership. Once a branch is merged and deleted,  */
/* nothing records which commits belonged to it. Everything here is inference, */
/* and the UI is required to say so wherever the inference is a guess.         */
/* -------------------------------------------------------------------------- */

/** Below this ratio of merge commits, the history is squash-merged and limbs must be reconstructed. */
const SQUASH_RATIO = 0.02;
/** Fewer real limbs than this, with no PR data to reconstruct from, means directory mode. */
const FLAT_LIMB_THRESHOLD = 3;

type Ctx = {
  byOid: Map<string, Commit>;
  time: Map<string, number>;
  children: Map<string, string[]>;
  claimedBy: Map<string, number>;
  limbs: LimbNode[];
};

function makeLimb(ctx: Ctx, init: Omit<LimbNode, 'id' | 'seed'>): LimbNode {
  const limb: LimbNode = { ...init, id: ctx.limbs.length, seed: hash32(init.label) };
  ctx.limbs.push(limb);
  for (const oid of limb.commits) ctx.claimedBy.set(oid, limb.id);
  return limb;
}

/**
 * Walk first-parent from `startOid` until we hit a commit that is already
 * claimed, or run out of history. Returns the unclaimed chain oldest-first and
 * the claimed commit it ran into, if any.
 *
 * A shallow clone has commits whose parents are simply absent from the
 * snapshot; that terminates the walk rather than failing. A cycle cannot occur
 * in a well-formed DAG but rewritten history produces malformed input, so the
 * visited set is load-bearing: without it this hangs.
 */
function walkFirstParent(ctx: Ctx, startOid: string): { chain: string[]; hitClaimed: string | null } {
  const chain: string[] = [];
  const visited = new Set<string>();
  let cur: string | undefined = startOid;

  while (cur) {
    if (ctx.claimedBy.has(cur)) return { chain: chain.reverse(), hitClaimed: cur };
    if (visited.has(cur)) {
      throw new TopologyError(
        `Commit history contains a cycle at ${cur.slice(0, 8)}. The snapshot is malformed.`,
        'CYCLE',
      );
    }
    visited.add(cur);
    const commit = ctx.byOid.get(cur);
    if (!commit) break; // shallow clone: the parent is not in the snapshot
    chain.push(cur);
    const next: string | undefined = commit.parents[0];
    cur = next && ctx.byOid.has(next) ? next : undefined;
  }
  return { chain: chain.reverse(), hitClaimed: null };
}

/** Fold a chain that would exceed the depth cap into the limb it hangs off. */
function foldInto(ctx: Ctx, parent: LimbNode, chain: string[]): void {
  for (const oid of chain) ctx.claimedBy.set(oid, parent.id);
  parent.commits = [...parent.commits, ...chain].sort((a, b) => {
    const d = (ctx.time.get(a) ?? 0) - (ctx.time.get(b) ?? 0);
    return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
  });
}

export type BuildOptions = {
  /** Skip the PR-based reconstruction even on a squash-merged repo. Used by tests. */
  noSynthesis?: boolean;
};

export function buildTopology(snapshot: RepoSnapshot, opts: BuildOptions = {}): TreeStructure {
  const byOid = new Map<string, Commit>();
  for (const c of snapshot.commits) byOid.set(c.oid, c);

  const time = new Map<string, number>();
  for (const c of snapshot.commits) {
    const t = Date.parse(c.date);
    time.set(c.oid, Number.isNaN(t) ? 0 : t);
  }

  const children = new Map<string, string[]>();
  for (const c of snapshot.commits) {
    for (const p of c.parents) {
      const arr = children.get(p);
      if (arr) arr.push(c.oid);
      else children.set(p, [c.oid]);
    }
  }

  const ctx: Ctx = { byOid, time, children, claimedBy: new Map(), limbs: [] };

  // An empty repo is a sprout, not a crash.
  if (snapshot.commits.length === 0) {
    return finish(ctx, snapshot, [], [], false, true);
  }

  /* 2. TRUNK. The first-parent chain from HEAD down to a parentless root. */
  const headOid = byOid.has(snapshot.head) ? snapshot.head : newestOid(snapshot.commits);
  const trunkWalk = walkFirstParent(ctx, headOid);
  const trunkChain = trunkWalk.chain;
  makeLimb(ctx, {
    commits: trunkChain,
    parentLimb: null,
    attachPoint: null,
    depth: 0,
    rejoined: true,
    synthesized: false,
    label: snapshot.defaultBranch || 'trunk',
  });

  const refByOid = new Map<string, string>();
  for (const r of snapshot.refs) if (r.kind !== 'tag' && !refByOid.has(r.oid)) refByOid.set(r.oid, r.name);

  /* 3 + 4. Merges spawn limbs; limbs are rescanned for their own merges, so a
   * merge into a feature branch produces a sub-limb. Breadth-first rather than
   * recursive, because a deep repo would otherwise blow the stack. */
  const queue: LimbNode[] = [ctx.limbs[0]];
  while (queue.length) {
    const limb = queue.shift()!;
    // Reverse chronological: the most recent merge claims contested commits first,
    // which matches how a reader remembers the history.
    const merges = limb.commits
      .filter((oid) => (byOid.get(oid)?.parents.length ?? 0) >= 2)
      .sort((a, b) => (time.get(b) ?? 0) - (time.get(a) ?? 0));

    for (const mergeOid of merges) {
      const merge = byOid.get(mergeOid)!;
      // Octopus merges are legal: every parent after the first spawns its own limb.
      for (let i = 1; i < merge.parents.length; i++) {
        const p = merge.parents[i];
        if (!byOid.has(p) || ctx.claimedBy.has(p)) continue;
        const { chain } = walkFirstParent(ctx, p);
        if (chain.length === 0) continue;

        const depth = limb.depth + 1;
        if (depth > MAX_LIMB_DEPTH) {
          foldInto(ctx, limb, chain);
          continue;
        }
        const tip = chain[chain.length - 1];
        const child = makeLimb(ctx, {
          commits: chain,
          parentLimb: limb.id,
          attachPoint: mergeOid,
          depth,
          rejoined: true,
          synthesized: false,
          label: refByOid.get(tip) ?? branchLabel(merge, tip),
        });
        queue.push(child);
      }
    }
  }

  /* 5. DANGLING. A ref pointing at an unclaimed commit never merged back. It
   * grows off into space and is drawn as never rejoining, because that is the
   * true shape of an abandoned branch. */
  const dangling = [...snapshot.refs]
    .filter((r) => r.kind !== 'tag' && byOid.has(r.oid) && !ctx.claimedBy.has(r.oid))
    .sort((a, b) => (time.get(b.oid) ?? 0) - (time.get(a.oid) ?? 0));

  for (const ref of dangling) {
    if (ctx.claimedBy.has(ref.oid)) continue;
    const { chain, hitClaimed } = walkFirstParent(ctx, ref.oid);
    if (chain.length === 0) continue;
    const parent = hitClaimed ? ctx.limbs[ctx.claimedBy.get(hitClaimed)!] : ctx.limbs[0];
    makeLimb(ctx, {
      commits: chain,
      parentLimb: parent?.id ?? 0,
      attachPoint: hitClaimed ?? (trunkChain[0] ?? null),
      depth: Math.min((parent?.depth ?? 0) + 1, MAX_LIMB_DEPTH),
      rejoined: false,
      synthesized: false,
      label: ref.name,
    });
  }

  /* 6. Anything still unclaimed attaches to its nearest claimed ancestor as a
   * stub. This is also where the second root of a grafted history lands. */
  const leftovers = snapshot.commits
    .map((c) => c.oid)
    .filter((oid) => !ctx.claimedBy.has(oid))
    .sort((a, b) => (time.get(b) ?? 0) - (time.get(a) ?? 0));

  for (const oid of leftovers) {
    if (ctx.claimedBy.has(oid)) continue;
    const { chain, hitClaimed } = walkFirstParent(ctx, oid);
    if (chain.length === 0) continue;
    const parent = hitClaimed ? ctx.limbs[ctx.claimedBy.get(hitClaimed)!] : ctx.limbs[0];
    makeLimb(ctx, {
      commits: chain,
      parentLimb: parent?.id ?? 0,
      attachPoint: hitClaimed ?? (trunkChain[0] ?? null),
      depth: Math.min((parent?.depth ?? 0) + 1, MAX_LIMB_DEPTH),
      rejoined: !!hitClaimed,
      synthesized: false,
      label: `stub/${oid.slice(0, 7)}`,
    });
  }

  /* 4.3 The squash-merge problem. */
  const mergeCount = snapshot.commits.filter((c) => c.parents.length >= 2).length;
  const squashed = snapshot.commits.length > 20 && mergeCount / snapshot.commits.length < SQUASH_RATIO;
  let synthetics: Commit[] = [];
  let squashReconstructed = false;

  if (squashed && !opts.noSynthesis) {
    synthetics = synthesizeFromPullRequests(ctx, snapshot);
    squashReconstructed = synthetics.length > 0;
  }

  const realLimbs = ctx.limbs.filter((l) => !l.synthesized).length;
  const flat = realLimbs < FLAT_LIMB_THRESHOLD && !squashReconstructed;

  return finish(ctx, snapshot, synthetics, trunkChain, squashReconstructed, flat);
}

/**
 * A squashed pull request still reports how many commits it originally had.
 * That is enough to reconstruct a limb of the right length hanging off the
 * squash commit. The commits are inventions: they carry the PR's aggregate diff
 * spread across them and are flagged so nothing ever links out to a SHA that
 * does not exist. Never present inferred structure as recorded structure.
 */
function synthesizeFromPullRequests(ctx: Ctx, snapshot: RepoSnapshot): Commit[] {
  const out: Commit[] = [];
  const trunk = ctx.limbs[0];
  if (!trunk) return out;

  for (const oid of trunk.commits) {
    const c = ctx.byOid.get(oid);
    if (!c || !c.prNumber) continue;
    const n = Math.min((c.prCommitCount ?? 0) - 1, 24);
    if (n < 1) continue;

    const base = Date.parse(c.date);
    const chain: string[] = [];
    // Spread the phantom commits back over the days before the squash, so the
    // limb reads as work that happened before the merge rather than at it.
    for (let i = n; i >= 1; i--) {
      const oidSynth = `pr${c.prNumber}-${i}`;
      const fake: Commit = {
        oid: oidSynth,
        parents: [],
        author: c.author,
        authorEmail: c.authorEmail,
        date: new Date(base - i * 3_600_000 * 4).toISOString(),
        subject: `${c.subject} (${n - i + 1}/${n})`,
        additions: Math.round(c.additions / (n + 1)),
        deletions: Math.round(c.deletions / (n + 1)),
        filesChanged: Math.max(1, Math.round(c.filesChanged / (n + 1))),
        prNumber: c.prNumber,
      };
      out.push(fake);
      ctx.byOid.set(oidSynth, fake);
      ctx.time.set(oidSynth, Date.parse(fake.date));
      chain.push(oidSynth);
    }

    makeLimb(ctx, {
      commits: chain,
      parentLimb: trunk.id,
      attachPoint: oid,
      depth: 1,
      rejoined: true,
      synthesized: true,
      label: `pr/${c.prNumber}`,
    });
  }
  return out;
}

function branchLabel(merge: Commit, tip: string): string {
  // "Merge pull request #123 from user/feature-x" and "Merge branch 'x'" both
  // carry the branch name; using it beats a generated label when it is there.
  const pr = /from\s+([^\s]+\/[^\s]+)$/.exec(merge.subject);
  if (pr) return pr[1];
  const named = /Merge branch '([^']+)'/.exec(merge.subject);
  if (named) return named[1];
  if (merge.prNumber) return `pr/${merge.prNumber}`;
  return `limb/${tip.slice(0, 7)}`;
}

function newestOid(commits: Commit[]): string {
  let best = commits[0];
  let bestT = Date.parse(best.date);
  for (const c of commits) {
    const t = Date.parse(c.date);
    if (t > bestT) {
      best = c;
      bestT = t;
    }
  }
  return best.oid;
}

function finish(
  ctx: Ctx,
  snapshot: RepoSnapshot,
  synthetics: Commit[],
  trunkChain: string[],
  squashReconstructed: boolean,
  flat: boolean,
): TreeStructure {
  const syntheticOids = new Set(synthetics.map((c) => c.oid));
  const nodes = new Map<string, CommitNode>();

  for (const limb of ctx.limbs) {
    limb.commits.forEach((oid, i) => {
      const commit = ctx.byOid.get(oid);
      if (!commit) return;
      nodes.set(oid, {
        oid,
        commit,
        limbId: limb.id,
        indexInLimb: i,
        time: ctx.time.get(oid) ?? 0,
        isMerge: commit.parents.length >= 2,
        synthetic: syntheticOids.has(oid),
        children: ctx.children.get(oid) ?? [],
      });
    });
  }

  // Canonical order: chronological, ties broken by oid so it is total and stable.
  const order = [...nodes.keys()].sort((a, b) => {
    const d = (nodes.get(a)!.time ?? 0) - (nodes.get(b)!.time ?? 0);
    return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
  });
  const indexOf = new Map<string, number>();
  order.forEach((oid, i) => indexOf.set(oid, i));

  const roots = [...nodes.values()]
    .filter((n) => n.commit.parents.filter((p) => nodes.has(p)).length === 0 && !n.synthetic)
    .map((n) => n.oid);

  // Reconstructed commits count toward the range even though they are
  // inventions: they are laid out and drawn, so leaving them outside the window
  // would report them as a pre-window stump on a repository nobody has windowed.
  let min = Infinity;
  let max = -Infinity;
  for (const n of nodes.values()) {
    if (n.time < min) min = n.time;
    if (n.time > max) max = n.time;
  }
  if (!Number.isFinite(min)) {
    min = Date.parse(snapshot.generatedAt) || 0;
    max = min + 86_400_000;
  }
  if (max <= min) max = min + 86_400_000;

  const authors = [...new Set([...nodes.values()].filter((n) => !n.synthetic).map((n) => n.commit.author))].sort();

  return {
    snapshot,
    limbs: ctx.limbs,
    nodes,
    order,
    indexOf,
    roots: roots.length ? roots : trunkChain.slice(0, 1),
    timeRange: { min, max },
    stats: {
      commitCount: nodes.size,
      mergeCount: [...nodes.values()].filter((n) => n.isMerge).length,
      limbCount: ctx.limbs.length,
      maxDepth: ctx.limbs.reduce((m, l) => Math.max(m, l.depth), 0),
      authors,
      squashReconstructed,
      flat,
    },
  };
}
