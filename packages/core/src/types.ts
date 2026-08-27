/* -------------------------------------------------------------------------- */
/* 1. The data contract                                                        */
/*                                                                            */
/* Every data source produces this identical shape. The viewer knows only the  */
/* `source` field, and only to show a badge. v2's local CLI adapter emits the  */
/* same object and nothing downstream changes.                                 */
/*                                                                            */
/* Plain types, and the runtime check that guards them lives in snapshot.ts.   */
/* They were Zod schemas with the types inferred from them, which reads well   */
/* and cost the browser a quarter of a megabyte of source to validate a        */
/* response from an API in this same repository. Splitting them means this     */
/* module is types and constants only, so importing a type here can never drag */
/* a validator into the bundle.                                                */
/* -------------------------------------------------------------------------- */

export type Commit = {
  oid: string;
  /** Full SHAs, ordered. parents[0] is the first parent. */
  parents: string[];
  author: string;
  authorEmail: string;
  /** ISO 8601 */
  date: string;
  subject: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  prNumber?: number;
  /** Commit count of the associated PR, when the host reports it. Drives squash reconstruction. */
  prCommitCount?: number;
  /**
   * Dominant file extension touched by this commit, when the source can supply
   * it. GitHub's GraphQL API cannot, so this is only populated in directory
   * mode and by v2's local adapter. The file-type lens says so rather than
   * inventing a value.
   */
  ext?: string;
};

export type Ref = {
  name: string;
  oid: string;
  kind: 'branch' | 'tag' | 'remote';
};

export type RepoSnapshot = {
  schemaVersion: 1;
  /** "owner/repo" */
  name: string;
  description: string | null;
  head: string;
  defaultBranch: string;
  /** v2 adds 'local'. */
  source: 'github' | 'local';
  truncated: boolean;
  generatedAt: string;
  commits: Commit[];
  refs: Ref[];
  /** Optional file tree at HEAD, used only by the directory-mode fallback. */
  tree?: { path: string; size: number }[];
};

export class TopologyError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'TopologyError';
  }
}

/* -------------------------------------------------------------------------- */
/* 2. Inferred topology                                                        */
/* -------------------------------------------------------------------------- */

export type LimbId = number;

export type LimbNode = {
  id: LimbId;
  /** Commits on this limb, oldest first. The trunk's chain runs root -> HEAD. */
  commits: string[];
  /** Which limb this one grows out of. null only for the trunk. */
  parentLimb: LimbId | null;
  /** SHA on the parent limb where this limb attaches (the merge commit, or the fork point). */
  attachPoint: string | null;
  /** 0 for the trunk. Capped at MAX_LIMB_DEPTH. */
  depth: number;
  /** False for limbs that never merged back: dangling refs, they grow off into space. */
  rejoined: boolean;
  /** True when the limb was reconstructed from PR metadata rather than recorded in the DAG. */
  synthesized: boolean;
  /** Ref name when one is known ("feature/x"), else a generated label. */
  label: string;
  /** Stable 32-bit hash of `label`, seeds every jitter so the same repo is byte-identical. */
  seed: number;
};

export type CommitNode = {
  oid: string;
  commit: Commit;
  limbId: LimbId;
  /** Index within its limb's `commits` array. */
  indexInLimb: number;
  /** Milliseconds since epoch, parsed once. */
  time: number;
  /** True when this commit has >= 2 parents. */
  isMerge: boolean;
  /**
   * True for commits reconstructed from pull request metadata rather than read
   * from the DAG. They render distinctly and never link out to a commit page,
   * because no such commit exists any more.
   */
  synthetic: boolean;
  /** Commits that name this one as a parent. */
  children: string[];
};

export type TreeStructure = {
  snapshot: RepoSnapshot;
  limbs: LimbNode[];
  nodes: Map<string, CommitNode>;
  /** Commit SHAs in canonical order: chronological, ties broken by oid. Index === instance index. */
  order: string[];
  /** oid -> index into `order`. Node identity is the SHA; this is the only place indices come from. */
  indexOf: Map<string, number>;
  roots: string[];
  timeRange: { min: number; max: number };
  stats: {
    commitCount: number;
    mergeCount: number;
    limbCount: number;
    maxDepth: number;
    authors: string[];
    /** True when the history is squash-merged and limbs were reconstructed from PRs. */
    squashReconstructed: boolean;
    /** True when we could not reconstruct anything and the caller should use directory mode. */
    flat: boolean;
  };
};

/* -------------------------------------------------------------------------- */
/* 3. Layout contract                                                          */
/*                                                                            */
/* Layout is a pure function: (tree, mode, options) => positions. It imports   */
/* nothing from Three.js and touches no scene object. Array lengths are        */
/* identical across every mode and every time setting; a commit hidden in a    */
/* view gets scale 0, never a shorter array. That invariant is the only reason */
/* GPU morphing works.                                                         */
/* -------------------------------------------------------------------------- */

export type LayoutMode = 'tree3d' | 'tree2d' | 'byAuthor' | 'byChurn' | 'timeline';

export type RingUnit = 'hour' | 'day' | 'week' | 'month' | 'year';

export type TimeWindow = {
  /** ISO 8601 */
  start: string;
  /** ISO 8601 */
  end: string;
};

export type LayoutOptions = {
  /** 0 = fully radial (3D), 1 = collapsed to a plane (2D). Interpolating this is the unfold. */
  thetaCompression: number;
  /** 0..1 relative to the window, not to the repo. */
  growthCutoff: number;
  ringUnit: RingUnit;
  window: TimeWindow;
  /** Overall trunk height in world units. */
  height: number;
  /** Lateral scale. */
  spread: number;
  /** Vertices generated per limb. Fixed regardless of limb length. */
  limbSegments: number;
};

export type LayoutResult = {
  /** 3 floats per commit, indexed by TreeStructure.order. */
  leafPositions: Float32Array;
  /** 1 float per commit. 0 means "not visible in this view". */
  leafScales: Float32Array;
  /**
   * Leaf size before the growth gate, window gate still applied. The renderer
   * gates growth per-instance in the vertex shader against `leafHeights`, so a
   * leaf appears at its exact moment rather than at the next worker keyframe.
   * `leafScales` stays the gated value everything else reads.
   */
  leafSizes: Float32Array;
  /** Normalized 0..1 height within the window, per commit. The growth clock. */
  leafHeights: Float32Array;
  /** LIMB_RING_VERTS * limbSegments floats per limb. Fixed count, always. */
  limbVertices: Float32Array;
  /** One radius per limb vertex ring. */
  limbRadii: Float32Array;
  /** Per-limb visibility 0..1, so growth can hide a limb without resizing arrays. */
  limbVisible: Float32Array;
  /** Normalized height (0..1) of every ring boundary drawn on the trunk. */
  rings: RingMark[];
  /** How many commits were folded into the pre-window stump. 0 when the window starts at the repo's birth. */
  stumpCommits: number;
  /** How many commits fall after the window and are cut off at the tip. */
  cutCommits: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
};

export type RingMark = {
  /** Normalized 0..1 height within the window. */
  t: number;
  /** True for the emphasized boundary (month lines when viewing days, etc). */
  major: boolean;
  label: string;
};

export const LIMB_RING_VERTS = 6;
export const MAX_LIMB_DEPTH = 6;
export const MAX_LEAVES = 20000;

/* -------------------------------------------------------------------------- */
/* 4. Points of interest                                                       */
/* -------------------------------------------------------------------------- */

export type PoiKind =
  | 'oldest'
  | 'newest'
  | 'largestEdit'
  | 'largestDeletion'
  | 'longestBranch'
  | 'busiestDay'
  | 'firstByAuthor';

export type Poi = {
  kind: PoiKind;
  oid: string;
  title: string;
  detail: string;
};
