import { MAX_LIMB_DEPTH, type Commit, type CommitNode, type LimbNode, type RepoSnapshot, type TreeStructure } from './types.js';
import { hash32 } from './hash.js';

/* -------------------------------------------------------------------------- */
/* Directory mode                                                              */
/*                                                                            */
/* The fallback for histories with no recoverable branch structure. The        */
/* skeleton comes from the file tree at HEAD: directories branch, files are    */
/* where commits land. Commit history still drives growth, so the animation is */
/* unchanged; only the thing being grown is different. Always labelled in the  */
/* UI, because this shape is the repository's layout, not its history.         */
/* -------------------------------------------------------------------------- */

const MAX_DIRS = 220;

type DirNode = {
  path: string;
  parent: string | null;
  depth: number;
  files: number;
  bytes: number;
  exts: Map<string, number>;
};

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : 'none';
}

export function buildDirectoryTopology(snapshot: RepoSnapshot): TreeStructure {
  const files = snapshot.tree ?? [];
  const dirs = new Map<string, DirNode>();
  dirs.set('', { path: '', parent: null, depth: 0, files: 0, bytes: 0, exts: new Map() });

  for (const f of files) {
    const parts = f.path.split('/');
    const ext = extOf(f.path);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const parent = cur;
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      const depth = Math.min(i + 1, MAX_LIMB_DEPTH);
      if (!dirs.has(cur)) dirs.set(cur, { path: cur, parent, depth, files: 0, bytes: 0, exts: new Map() });
    }
    const node = dirs.get(cur)!;
    node.files++;
    node.bytes += f.size;
    node.exts.set(ext, (node.exts.get(ext) ?? 0) + 1);
  }

  // Keep the largest directories; fold the rest into their nearest surviving ancestor.
  const kept = [...dirs.values()]
    .sort((a, b) => a.depth - b.depth || b.files - a.files)
    .slice(0, MAX_DIRS);
  const keptPaths = new Set(kept.map((d) => d.path));
  const resolve = (path: string | null): string => {
    let p = path ?? '';
    while (p && !keptPaths.has(p)) p = p.slice(0, Math.max(0, p.lastIndexOf('/')));
    return keptPaths.has(p) ? p : '';
  };

  const slotOf = new Map<string, number>();
  const limbs: LimbNode[] = [];
  const ordered = kept.sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : 1));
  for (const d of ordered) {
    const id = limbs.length;
    slotOf.set(d.path, id);
    limbs.push({
      id,
      commits: [],
      parentLimb: d.path === '' ? null : (slotOf.get(resolve(d.parent)) ?? 0),
      attachPoint: null,
      depth: d.depth,
      rejoined: true,
      // Directories are recorded, not inferred. What is inferred here is which
      // directory a commit belongs to, and the interface says so with a badge.
      // The ghosted, dashed treatment is reserved for structure that was
      // genuinely reconstructed, so it must not be used on real directories.
      synthesized: false,
      label: d.path === '' ? snapshot.name.split('/')[1] || 'root' : d.path,
      seed: hash32(d.path || 'root'),
    });
  }

  // Weight directories by file count so commits land where the code actually is.
  const weights = ordered.map((d) => Math.max(1, d.files));
  const total = weights.reduce((a, b) => a + b, 0);
  const cumulative: number[] = [];
  let running = 0;
  for (const w of weights) {
    running += w;
    cumulative.push(running / total);
  }
  const pick = (oid: string): number => {
    const r = (hash32(oid) >>> 0) / 4294967296;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const byTime = [...snapshot.commits].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const nodes = new Map<string, CommitNode>();
  const children = new Map<string, string[]>();
  for (const c of snapshot.commits) for (const p of c.parents) children.set(p, [...(children.get(p) ?? []), c.oid]);

  for (const c of byTime) {
    const slot = limbs.length > 1 ? pick(c.oid) : 0;
    const limb = limbs[slot] ?? limbs[0];
    const dir = ordered[slot];
    const dominant = dir ? [...dir.exts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
    const commit: Commit = dominant ? { ...c, ext: dominant } : c;
    limb.commits.push(c.oid);
    nodes.set(c.oid, {
      oid: c.oid,
      commit,
      limbId: limb.id,
      indexInLimb: limb.commits.length - 1,
      time: Date.parse(c.date) || 0,
      isMerge: c.parents.length >= 2,
      synthetic: false,
      children: children.get(c.oid) ?? [],
    });
  }

  const order = byTime.map((c) => c.oid).filter((oid) => nodes.has(oid));
  const indexOf = new Map<string, number>();
  order.forEach((oid, i) => indexOf.set(oid, i));

  let min = Infinity;
  let max = -Infinity;
  for (const n of nodes.values()) {
    min = Math.min(min, n.time);
    max = Math.max(max, n.time);
  }
  if (!Number.isFinite(min)) {
    min = Date.parse(snapshot.generatedAt) || 0;
    max = min + 86_400_000;
  }
  if (max <= min) max = min + 86_400_000;

  return {
    snapshot,
    limbs,
    nodes,
    order,
    indexOf,
    roots: order.slice(0, 1),
    timeRange: { min, max },
    stats: {
      commitCount: nodes.size,
      mergeCount: [...nodes.values()].filter((n) => n.isMerge).length,
      limbCount: limbs.length,
      maxDepth: limbs.reduce((m, l) => Math.max(m, l.depth), 0),
      authors: [...new Set([...nodes.values()].map((n) => n.commit.author))].sort(),
      squashReconstructed: false,
      flat: true,
    },
  };
}
