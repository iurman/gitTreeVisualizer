import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* 1. The data contract                                                        */
/*                                                                            */
/* Every data source produces this identical shape. The viewer knows only the  */
/* `source` field, and only to show a badge. v2's local CLI adapter emits the  */
/* same object and nothing downstream changes.                                 */
/* -------------------------------------------------------------------------- */

export const CommitSchema = z.object({
  oid: z.string().min(1),
  /** Full SHAs, ordered. parents[0] is the first parent. */
  parents: z.array(z.string().min(1)),
  author: z.string(),
  authorEmail: z.string(),
  /** ISO 8601 */
  date: z.string(),
  subject: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  filesChanged: z.number().int().nonnegative(),
  prNumber: z.number().int().positive().optional(),
  /** Commit count of the associated PR, when the host reports it. Drives squash reconstruction. */
  prCommitCount: z.number().int().positive().optional(),
  /**
   * Dominant file extension touched by this commit, when the source can supply
   * it. GitHub's GraphQL API cannot, so this is only populated in directory
   * mode and by v2's local adapter. The file-type lens says so rather than
   * inventing a value.
   */
  ext: z.string().optional(),
});
export type Commit = z.infer<typeof CommitSchema>;

export const RefSchema = z.object({
  name: z.string(),
  oid: z.string().min(1),
  kind: z.enum(['branch', 'tag', 'remote']),
});
export type Ref = z.infer<typeof RefSchema>;

export const RepoSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  /** "owner/repo" */
  name: z.string(),
  description: z.string().nullable(),
  head: z.string(),
  defaultBranch: z.string(),
  /** v2 adds 'local'. */
  source: z.enum(['github', 'local']),
  truncated: z.boolean(),
  generatedAt: z.string(),
  commits: z.array(CommitSchema),
  refs: z.array(RefSchema),
  /** Optional file tree at HEAD, used only by the directory-mode fallback. */
  tree: z.array(z.object({ path: z.string(), size: z.number().nonnegative() })).optional(),
});
export type RepoSnapshot = z.infer<typeof RepoSnapshotSchema>;

/**
 * The adapter boundary. Anything claiming to be a RepoSnapshot passes through
 * here first, so malformed data fails at the seam instead of deep inside
 * layout code where the stack trace means nothing.
 */
export function parseSnapshot(input: unknown): RepoSnapshot {
  return RepoSnapshotSchema.parse(input);
}

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
