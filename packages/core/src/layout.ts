import {
  LIMB_RING_VERTS,
  type LayoutMode,
  type LayoutOptions,
  type LayoutResult,
  type LimbNode,
  type RingMark,
  type TreeStructure,
} from './types.js';
import { hashFloat, hashRange } from './hash.js';
import { autoRingUnit, buildTimeScale, ringMarks, type TimeScale } from './time.js';
import {
  add,
  clamp,
  cross,
  lerp,
  lerpAngle,
  normalize,
  scale as vscale,
  smoothstep,
  type Vec3,
} from './vec.js';

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/*                                                                            */
/* A pure function: (tree, mode, options) => positions. Nothing here imports   */
/* Three.js or touches a scene object, so it runs identically in a worker, in  */
/* a test, and in the serverless function that draws the OG image.             */
/*                                                                            */
/* The one invariant that everything else depends on: array lengths are the    */
/* same in every mode and at every time setting. A commit that a view does not */
/* show gets scale 0, never a shorter array. Break that and the GPU morph      */
/* system has nothing to interpolate between.                                  */
/* -------------------------------------------------------------------------- */

/** 137.507764 degrees. Also the reason limbs avoid each other without collision code. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DEG = Math.PI / 180;

const TRUNK_RADIUS_FRAC = 0.021;
const LEAF_AREA_UNIT = 0.85;
const STUMP_FRAC = 0.06;

export function limbSlotCount(tree: TreeStructure): number {
  // byAuthor needs one slot per contributor plus the spine. Sizing every mode's
  // limb arrays to the largest requirement is what lets modes morph into each other.
  return Math.max(1, tree.limbs.length, tree.stats.authors.length + 1);
}

export function fullWindow(tree: TreeStructure): { start: string; end: string } {
  return {
    start: new Date(tree.timeRange.min).toISOString(),
    end: new Date(tree.timeRange.max).toISOString(),
  };
}

export function defaultLayoutOptions(tree: TreeStructure): LayoutOptions {
  const window = fullWindow(tree);
  return {
    thetaCompression: 0,
    growthCutoff: 1,
    ringUnit: autoRingUnit(window),
    window,
    height: 100,
    spread: 62,
    limbSegments: 22,
  };
}

/* -------------------------------------------------------------------------- */
/* Skeleton: one pass that every mode reuses                                   */
/* -------------------------------------------------------------------------- */

type Skeleton = {
  limb: LimbNode;
  /** Fork point on the parent limb: where this branch actually left the trunk. */
  base: Vec3;
  baseH: number;
  tipH: number;
  rise: number;
  lateral: number;
  theta: number;
  alpha: number;
  radius: number;
  /** How far along the limb growth has reached, 0..1. */
  growth: number;
  sample: (u: number) => Vec3;
  tangent: (u: number) => Vec3;
  radiusAt: (u: number) => number;
  /** Per-commit parameter along the limb, aligned with limb.commits. */
  u: number[];
  /** Sorted (time, u) pairs so children can find their fork point. */
  keys: { t: number; u: number }[];
};

function uAtTime(sk: Skeleton, t: number): number {
  const k = sk.keys;
  if (k.length === 0) return 1;
  if (t <= k[0].t) return k[0].u;
  if (t >= k[k.length - 1].t) return k[k.length - 1].u;
  let lo = 0;
  let hi = k.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (k[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const span = k[hi].t - k[lo].t;
  const f = span > 0 ? (t - k[lo].t) / span : 0;
  return k[lo].u + (k[hi].u - k[lo].u) * f;
}

/**
 * Thickness by the pipe model. A branch's cross-sectional area equals the sum
 * of its children's, plus the area its own leaves demand. Correct-looking taper
 * falls out of the arithmetic instead of being authored by hand.
 */
function pipeRadii(tree: TreeStructure, churnWeighted: boolean): number[] {
  const kids: number[][] = tree.limbs.map(() => []);
  for (const l of tree.limbs) if (l.parentLimb !== null && kids[l.parentLimb]) kids[l.parentLimb].push(l.id);

  const leafArea = tree.limbs.map((l) => {
    if (!churnWeighted) return LEAF_AREA_UNIT * l.commits.length;
    let churn = 0;
    for (const oid of l.commits) {
      const n = tree.nodes.get(oid);
      if (n) churn += n.commit.additions + n.commit.deletions;
    }
    return LEAF_AREA_UNIT * (0.3 * l.commits.length + 0.02 * Math.sqrt(churn) * l.commits.length);
  });

  const radius = new Array<number>(tree.limbs.length).fill(0);
  const byDepth = [...tree.limbs].sort((a, b) => b.depth - a.depth);
  for (const l of byDepth) {
    let sum = 0;
    for (const c of kids[l.id]) sum += radius[c] * radius[c];
    radius[l.id] = Math.sqrt(sum + leafArea[l.id]);
  }
  return radius;
}

function buildSkeletons(
  tree: TreeStructure,
  opts: LayoutOptions,
  scale: TimeScale,
  mode: LayoutMode,
): Skeleton[] {
  const H = opts.height;
  const theta2d = opts.thetaCompression;
  const churnWeighted = mode === 'byChurn';
  const radii = pipeRadii(tree, churnWeighted);

  const trunkRadius = radii[0] || 1;
  const radiusScale = (H * TRUNK_RADIUS_FRAC) / trunkRadius;

  const stumpCommits = countBefore(tree, scale.window.start);
  const baseY = stumpCommits > 0 ? -H * STUMP_FRAC : 0;

  // Sibling ordering decides phyllotaxis position. byChurn reorders by lines
  // changed, which is the whole point of that mode; every other mode keeps the
  // repository's own order so the shape stays verifiable.
  const siblings = new Map<number, number[]>();
  for (const l of tree.limbs) {
    if (l.parentLimb === null) continue;
    const arr = siblings.get(l.parentLimb) ?? [];
    arr.push(l.id);
    siblings.set(l.parentLimb, arr);
  }
  const churnOf = (id: number) => {
    let c = 0;
    for (const oid of tree.limbs[id].commits) {
      const n = tree.nodes.get(oid);
      if (n) c += n.commit.additions + n.commit.deletions;
    }
    return c;
  };
  const siblingIndex = new Map<number, number>();
  for (const [parent, ids] of siblings) {
    const sorted = churnWeighted
      ? [...ids].sort((a, b) => churnOf(b) - churnOf(a))
      : [...ids].sort((a, b) => firstTime(tree, a) - firstTime(tree, b));
    sorted.forEach((id, i) => siblingIndex.set(id, i));
    void parent;
  }

  const maxChurn = churnWeighted ? Math.max(1, ...tree.limbs.map((l) => churnOf(l.id))) : 1;

  const out: Skeleton[] = new Array(tree.limbs.length);
  const byDepth = [...tree.limbs].sort((a, b) => a.depth - b.depth || a.id - b.id);

  for (const limb of byDepth) {
    const n = limb.commits.length;
    const times = limb.commits.map((oid) => tree.nodes.get(oid)?.time ?? 0);
    const radius = radii[limb.id] * radiusScale;

    // A directory with no commits on it, or an author slot nobody filled. It
    // still needs a skeleton so children can hang off it and so its buffer
    // slice stays the same length as every other mode's.
    if (n === 0 && limb.parentLimb !== null) {
      const parent = out[limb.parentLimb] ?? out[0];
      const at: Vec3 = parent ? parent.sample(1) : [0, 0, 0];
      out[limb.id] = {
        limb,
        base: at,
        baseH: 1,
        tipH: 1,
        rise: 0,
        lateral: 0,
        theta: 0,
        alpha: 0,
        radius: 0,
        growth: 0,
        sample: () => at,
        tangent: () => [0, 1, 0],
        radiusAt: () => 0,
        u: [],
        keys: [{ t: 0, u: 1 }],
      };
      continue;
    }

    if (limb.parentLimb === null) {
      /* The trunk: pure compressed time, root to HEAD, with a seeded lean so it
       * never reads as an extruded cylinder. */
      const sway = H * 0.035;
      const seed = limb.seed;
      const phase = hashFloat(seed, 3) * Math.PI * 2;
      const sample = (u: number): Vec3 => {
        const uu = clamp(u, 0, 1);
        const y = baseY + (H - baseY) * uu;
        const bend = Math.sin(uu * 2.4 + phase) * sway * uu;
        const bend2 = Math.cos(uu * 1.7 + phase * 1.3) * sway * 0.7 * uu * (1 - theta2d);
        return [bend, y, bend2];
      };
      const sk: Skeleton = {
        limb,
        base: [0, baseY, 0] as Vec3,
        baseH: 0,
        tipH: 1,
        rise: H - baseY,
        lateral: 0,
        theta: 0,
        alpha: 0,
        radius,
        growth: clamp(opts.growthCutoff, 0, 1),
        sample,
        tangent: (u) => tangentOf(sample, u),
        radiusAt: (u) => radius * lerp(1, 0.4, clamp(u, 0, 1)),
        u: times.map((t) => clamp(scale.height(t), 0, 1)),
        keys: [],
      };
      sk.keys = buildKeys(times, sk.u);
      out[limb.id] = sk;
      continue;
    }

    const parent = out[limb.parentLimb] ?? out[0];
    const forkOid = tree.nodes.get(limb.commits[0])?.commit.parents[0];
    const forkTime = forkOid && tree.nodes.has(forkOid) ? tree.nodes.get(forkOid)!.time : (times[0] ?? scale.window.start);
    const base = parent.sample(uAtTime(parent, forkTime));

    const baseH = clamp(scale.height(forkTime), 0, 1);
    const lastTime = times[n - 1] ?? times[0] ?? scale.window.end;
    const mergeTime = limb.attachPoint ? (tree.nodes.get(limb.attachPoint)?.time ?? lastTime) : lastTime;
    const tipTime = limb.rejoined ? Math.max(mergeTime, lastTime) : lastTime;
    const tipH = clamp(scale.height(tipTime), 0, 1);

    /* Branch angle: 35 to 50 degrees off the parent axis, jittered by the
     * limb's own seed, steeper as depth increases so deep twigs stay inside the
     * canopy instead of flying off horizontally. */
    const alphaBase = hashRange(limb.seed, 2, 35, 50) * DEG;
    const alpha = Math.max(20 * DEG, alphaBase * (1 - 0.1 * (limb.depth - 1)));

    // Phyllotaxis: golden angle steps around the parent, offset by the parent's
    // stable hash. Same repo, same tree, on every machine and every reload.
    const idx = siblingIndex.get(limb.id) ?? 0;
    const theta3d = hashFloat(parent.limb.seed, 7) * Math.PI * 2 + idx * GOLDEN_ANGLE;
    // 2D: collapse toward the XY plane, with a seeded nudge so no two limbs land
    // exactly on top of each other, and a wider angle so the fan reads.
    const side = Math.cos(theta3d) >= 0 ? 0 : Math.PI;
    const theta2dTarget = side + hashRange(limb.seed, 11, -0.06, 0.06);
    const theta = lerpAngle(theta3d, theta2dTarget, theta2d);

    const timeRise = (tipH - baseH) * (H - baseY);
    // A branch opened and merged inside an hour still has to be a visible
    // branch, so length also derives from how much work is on it.
    const minRise = H * 0.02 * Math.sqrt(n);
    const churnBoost = churnWeighted ? 0.6 + 1.1 * Math.sqrt(churnOf(limb.id) / maxChurn) : 1;
    const rise = Math.max(timeRise, minRise) * churnBoost;
    const lateral = Math.min(rise * Math.tan(alpha), opts.spread * 0.5) * lerp(1, 1.18, theta2d);

    const outward: Vec3 = [Math.cos(theta), 0, Math.sin(theta) * (1 - theta2d * 0.94)];
    const perp: Vec3 = normalize(cross(outward, [0, 1, 0]));
    const wobble = hashRange(limb.seed, 5, -0.22, 0.22);
    const sag = hashRange(limb.seed, 6, 0.04, 0.16) * rise;

    const sample = (u: number): Vec3 => {
      const uu = clamp(u, 0, 1);
      // Out fast, then flatten: a branch leaves the trunk sharply and levels off.
      let r = lateral * Math.sin(uu * Math.PI * 0.5);
      // A merged branch bends gently back toward its parent near the tip. An
      // abandoned one keeps going, which is exactly what it did.
      if (limb.rejoined) r *= 1 - 0.18 * smoothstep(0.72, 1, uu);
      const y = base[1] + rise * uu - sag * uu * uu;
      const p = add(base, vscale(outward, r));
      const w = vscale(perp, wobble * lateral * Math.sin(uu * Math.PI));
      return [p[0] + w[0], y, p[2] + w[2]];
    };

    const span = tipH - baseH;
    const uTime = times.map((t, i) => {
      const raw = span > 1e-4 ? (clamp(scale.height(t), 0, 1) - baseH) / span : i / Math.max(1, n - 1);
      const byIndex = n > 1 ? i / (n - 1) : 1;
      // Half time, half index. Pure time would stack a same-day branch's commits
      // on one point; pure index would throw away the repo's rhythm.
      return clamp(lerp(byIndex, clamp(raw, 0, 1), 0.5), 0, 1);
    });

    const growth =
      span > 1e-4
        ? clamp((opts.growthCutoff - baseH) / span, 0, 1)
        : opts.growthCutoff >= baseH
          ? 1
          : 0;

    const sk: Skeleton = {
      limb,
      base,
      baseH,
      tipH,
      rise,
      lateral,
      theta,
      alpha,
      radius,
      growth,
      sample,
      tangent: (u) => tangentOf(sample, u),
      radiusAt: (u) => radius * lerp(1, 0.4, clamp(u, 0, 1)),
      u: uTime,
      keys: buildKeys(times, uTime),
    };
    out[limb.id] = sk;
  }

  return out;
}

function buildKeys(times: number[], us: number[]): { t: number; u: number }[] {
  const keys = times.map((t, i) => ({ t, u: us[i] }));
  keys.sort((a, b) => a.t - b.t);
  return keys;
}

function tangentOf(sample: (u: number) => Vec3, u: number): Vec3 {
  const e = 0.01;
  const a = sample(clamp(u - e, 0, 1));
  const b = sample(clamp(u + e, 0, 1));
  return normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
}

function firstTime(tree: TreeStructure, limbId: number): number {
  const oid = tree.limbs[limbId]?.commits[0];
  return oid ? (tree.nodes.get(oid)?.time ?? 0) : 0;
}

function countBefore(tree: TreeStructure, t: number): number {
  let n = 0;
  for (const node of tree.nodes.values()) if (node.time < t) n++;
  return n;
}

function countAfter(tree: TreeStructure, t: number): number {
  let n = 0;
  for (const node of tree.nodes.values()) if (node.time > t) n++;
  return n;
}

/* -------------------------------------------------------------------------- */
/* The layout entry point                                                      */
/* -------------------------------------------------------------------------- */

export function layout(tree: TreeStructure, mode: LayoutMode, optsIn: LayoutOptions): LayoutResult {
  // tree2d is not a separate layout. It is tree3d with the angle collapsed, and
  // interpolating that one scalar is the entire unfold.
  const opts: LayoutOptions =
    mode === 'tree2d' ? { ...optsIn, thetaCompression: 1 } : { ...optsIn };

  const slots = limbSlotCount(tree);
  const S = Math.max(2, opts.limbSegments);
  const leafCount = tree.order.length;

  const leafPositions = new Float32Array(leafCount * 3);
  const leafScales = new Float32Array(leafCount);
  const limbVertices = new Float32Array(slots * S * LIMB_RING_VERTS * 3);
  const limbRadii = new Float32Array(slots * S);
  const limbVisible = new Float32Array(slots);

  if (leafCount === 0) {
    return {
      leafPositions,
      leafScales,
      limbVertices,
      limbRadii,
      limbVisible,
      rings: [],
      stumpCommits: 0,
      cutCommits: 0,
      bounds: { min: [-1, 0, -1], max: [1, 1, 1] },
    };
  }

  const times: number[] = [];
  for (const oid of tree.order) times.push(tree.nodes.get(oid)!.time);
  const scale = buildTimeScale(times, opts.window, opts.ringUnit);

  const stumpCommits = countBefore(tree, scale.window.start);
  const cutCommits = countAfter(tree, scale.window.end);

  const churnMax = Math.max(
    1,
    ...tree.order.map((oid) => {
      const c = tree.nodes.get(oid)!.commit;
      return c.additions + c.deletions;
    }),
  );

  const bounds = newBounds();

  if (mode === 'timeline') {
    layoutTimeline(tree, opts, scale, { leafPositions, leafScales, limbVertices, limbRadii, limbVisible }, S, slots, churnMax, bounds);
  } else if (mode === 'byAuthor') {
    layoutByAuthor(tree, opts, scale, { leafPositions, leafScales, limbVertices, limbRadii, limbVisible }, S, slots, churnMax, bounds);
  } else {
    layoutTree(tree, opts, scale, mode, { leafPositions, leafScales, limbVertices, limbRadii, limbVisible }, S, slots, churnMax, bounds);
  }

  const rings: RingMark[] = mode === 'byAuthor' ? [] : ringMarks(scale, opts.ringUnit);

  return {
    leafPositions,
    leafScales,
    limbVertices,
    limbRadii,
    limbVisible,
    rings,
    stumpCommits,
    cutCommits,
    bounds: finishBounds(bounds, opts.height),
  };
}

type Buffers = {
  leafPositions: Float32Array;
  leafScales: Float32Array;
  limbVertices: Float32Array;
  limbRadii: Float32Array;
  limbVisible: Float32Array;
};

function leafScaleFor(tree: TreeStructure, oid: string, churnMax: number): number {
  const node = tree.nodes.get(oid)!;
  const churn = node.commit.additions + node.commit.deletions;
  let s = 0.55 + 1.15 * Math.sqrt(clamp(churn / churnMax, 0, 1));
  if (node.isMerge) s *= 1.35;
  if (node.synthetic) s *= 0.78;
  return s;
}

function layoutTree(
  tree: TreeStructure,
  opts: LayoutOptions,
  scale: TimeScale,
  mode: LayoutMode,
  buf: Buffers,
  S: number,
  slots: number,
  churnMax: number,
  bounds: Bounds,
): void {
  const sks = buildSkeletons(tree, opts, scale, mode);
  const theta2d = opts.thetaCompression;

  // Limb geometry. Every limb gets exactly S rings of LIMB_RING_VERTS vertices,
  // no matter how long it is or how many commits it carries. Growth compresses
  // the rings into the grown portion rather than dropping any, which is what
  // makes the tip advance continuously instead of stepping segment to segment.
  for (let slot = 0; slot < slots; slot++) {
    const sk = sks[slot];
    if (!sk) {
      collapseLimb(buf, slot, S, [0, 0, 0]);
      continue;
    }
    const g = clamp(sk.growth, 0, 1);
    buf.limbVisible[slot] = smoothstep(0, 0.03, g);
    for (let j = 0; j < S; j++) {
      const u = j / (S - 1);
      const center = sk.sample(u * g);
      const tan = sk.tangent(u * g);
      const r = sk.radiusAt(u) * (0.35 + 0.65 * g);
      writeRing(buf, slot, j, S, center, tan, r, theta2d);
      growBounds(bounds, center, r);
    }
  }

  // Leaves. Placed on their limb at their own moment in compressed time, spun
  // around it at the golden angle so they never sit in a line.
  for (let i = 0; i < tree.order.length; i++) {
    const oid = tree.order[i];
    const node = tree.nodes.get(oid)!;
    const sk = sks[node.limbId];
    if (!sk) continue;
    const u = sk.u[node.indexInLimb] ?? 1;
    const center = sk.sample(u * clamp(sk.growth, 0, 1));
    const tan = sk.tangent(u);
    const { n, b } = basis(tan);
    const phi = hashFloat(sk.limb.seed, 13) * Math.PI * 2 + node.indexInLimb * GOLDEN_ANGLE;
    const s = leafScaleFor(tree, oid, churnMax);
    const off = sk.radiusAt(u) * 0.9 + s * 0.7;
    const px = center[0] + (n[0] * Math.cos(phi) + b[0] * Math.sin(phi)) * off;
    const py = center[1] + (n[1] * Math.cos(phi) + b[1] * Math.sin(phi)) * off;
    const pz = center[2] + (n[2] * Math.cos(phi) + b[2] * Math.sin(phi)) * off * (1 - theta2d * 0.94);

    buf.leafPositions[i * 3] = safe(px);
    buf.leafPositions[i * 3 + 1] = safe(py);
    buf.leafPositions[i * 3 + 2] = safe(pz);

    const h = scale.height(node.time);
    const inWindow = node.time >= scale.window.start && node.time <= scale.window.end;
    const grown = h <= opts.growthCutoff + 1e-6;
    buf.leafScales[i] = inWindow && grown ? s : 0;
    if (buf.leafScales[i] > 0) growBounds(bounds, [px, py, pz], s);
  }
}

/**
 * Contributors as primary limbs. This is no longer the repository's own
 * structure, so the UI is required to say so while it is on screen.
 */
function layoutByAuthor(
  tree: TreeStructure,
  opts: LayoutOptions,
  scale: TimeScale,
  buf: Buffers,
  S: number,
  slots: number,
  churnMax: number,
  bounds: Bounds,
): void {
  const H = opts.height;
  const theta2d = opts.thetaCompression;
  const authors = tree.stats.authors;
  const authorSlot = new Map<string, number>();
  authors.forEach((a, i) => authorSlot.set(a, Math.min(i + 1, slots - 1)));

  const spans = new Map<string, { min: number; max: number; count: number; churn: number }>();
  for (const oid of tree.order) {
    const node = tree.nodes.get(oid)!;
    const cur = spans.get(node.commit.author) ?? { min: Infinity, max: -Infinity, count: 0, churn: 0 };
    cur.min = Math.min(cur.min, node.time);
    cur.max = Math.max(cur.max, node.time);
    cur.count++;
    cur.churn += node.commit.additions + node.commit.deletions;
    spans.set(node.commit.author, cur);
  }
  const maxCount = Math.max(1, ...[...spans.values()].map((s) => s.count));

  // Slot 0 is the spine: the repository's life, with no commits of its own.
  const spineSeed = tree.limbs[0]?.seed ?? 1;
  const spine = (u: number): Vec3 => [0, H * clamp(u, 0, 1), 0];
  buf.limbVisible[0] = 1;
  for (let j = 0; j < S; j++) {
    const u = j / (S - 1);
    const c = spine(u * clamp(opts.growthCutoff, 0, 1));
    writeRing(buf, 0, j, S, c, [0, 1, 0], H * 0.012 * lerp(1, 0.4, u), theta2d);
    growBounds(bounds, c, H * 0.012);
  }

  type AuthorGeom = { base: Vec3; outward: Vec3; rise: number; lateral: number; baseH: number; span: number; radius: number };
  const geoms = new Map<string, AuthorGeom>();

  authors.forEach((author, i) => {
    const s = spans.get(author);
    if (!s) return;
    const slot = authorSlot.get(author)!;
    const baseH = clamp(scale.height(s.min), 0, 1);
    const tipH = clamp(scale.height(s.max), 0, 1);
    const theta3d = hashFloat(spineSeed, 7) * Math.PI * 2 + i * GOLDEN_ANGLE;
    const side = Math.cos(theta3d) >= 0 ? 0 : Math.PI;
    const theta = lerpAngle(theta3d, side + hashRange(i + 1, 11, -0.08, 0.08), theta2d);
    const alpha = hashRange(i + 1, 2, 38, 52) * DEG;
    const rise = Math.max((tipH - baseH) * H, H * 0.05 * Math.sqrt(s.count));
    const lateral = Math.min(rise * Math.tan(alpha), opts.spread * 0.55) * lerp(1, 1.18, theta2d);
    const radius = H * TRUNK_RADIUS_FRAC * (0.35 + 0.9 * Math.sqrt(s.count / maxCount));
    const geom: AuthorGeom = {
      base: [0, baseH * H, 0],
      outward: [Math.cos(theta), 0, Math.sin(theta) * (1 - theta2d * 0.94)],
      rise,
      lateral,
      baseH,
      span: Math.max(1e-4, tipH - baseH),
      radius,
    };
    geoms.set(author, geom);

    const g = clamp((opts.growthCutoff - baseH) / geom.span, 0, 1);
    buf.limbVisible[slot] = smoothstep(0, 0.03, g);
    for (let j = 0; j < S; j++) {
      const u = (j / (S - 1)) * g;
      const c = authorPoint(geom, u);
      const tan = normalize([
        geom.outward[0] * geom.lateral * 0.6,
        geom.rise,
        geom.outward[2] * geom.lateral * 0.6,
      ]);
      const r = radius * lerp(1, 0.4, j / (S - 1)) * (0.35 + 0.65 * g);
      writeRing(buf, slot, j, S, c, tan, r, theta2d);
      growBounds(bounds, c, r);
    }
  });

  for (let slot = authors.length + 1; slot < slots; slot++) collapseLimb(buf, slot, S, [0, 0, 0]);

  const perAuthorIndex = new Map<string, number>();
  for (let i = 0; i < tree.order.length; i++) {
    const oid = tree.order[i];
    const node = tree.nodes.get(oid)!;
    const geom = geoms.get(node.commit.author);
    if (!geom) continue;
    const h = clamp(scale.height(node.time), 0, 1);
    const u = clamp((h - geom.baseH) / geom.span, 0, 1);
    const g = clamp((opts.growthCutoff - geom.baseH) / geom.span, 0, 1);
    const c = authorPoint(geom, Math.min(u, g));
    const k = (perAuthorIndex.get(node.commit.author) ?? 0) + 1;
    perAuthorIndex.set(node.commit.author, k);
    const phi = k * GOLDEN_ANGLE;
    const s = leafScaleFor(tree, oid, churnMax);
    const off = geom.radius * 0.9 + s * 0.7;
    const px = c[0] + Math.cos(phi) * off;
    const py = c[1] + Math.sin(phi) * off * 0.35;
    const pz = c[2] + Math.sin(phi) * off * (1 - theta2d * 0.94);
    buf.leafPositions[i * 3] = safe(px);
    buf.leafPositions[i * 3 + 1] = safe(py);
    buf.leafPositions[i * 3 + 2] = safe(pz);
    const inWindow = node.time >= scale.window.start && node.time <= scale.window.end;
    buf.leafScales[i] = inWindow && h <= opts.growthCutoff + 1e-6 ? s : 0;
    if (buf.leafScales[i] > 0) growBounds(bounds, [px, py, pz], s);
  }
}

function authorPoint(g: { base: Vec3; outward: Vec3; rise: number; lateral: number }, u: number): Vec3 {
  const uu = clamp(u, 0, 1);
  const r = g.lateral * Math.sin(uu * Math.PI * 0.5);
  return [g.base[0] + g.outward[0] * r, g.base[1] + g.rise * uu, g.base[2] + g.outward[2] * r];
}

/** Everything collapses to a horizontal spine with commits as ticks. */
function layoutTimeline(
  tree: TreeStructure,
  opts: LayoutOptions,
  scale: TimeScale,
  buf: Buffers,
  S: number,
  slots: number,
  churnMax: number,
  bounds: Bounds,
): void {
  const W = opts.spread * 2.2;
  const rowH = opts.height * 0.028;
  const sks = tree.limbs;

  for (let slot = 0; slot < slots; slot++) {
    const limb = sks[slot];
    if (!limb || limb.commits.length === 0) {
      collapseLimb(buf, slot, S, [-W / 2, 0, 0]);
      continue;
    }
    const t0 = tree.nodes.get(limb.commits[0])?.time ?? scale.window.start;
    const t1 = tree.nodes.get(limb.commits[limb.commits.length - 1])?.time ?? scale.window.end;
    const h0 = clamp(scale.height(t0), 0, 1);
    const h1 = clamp(scale.height(t1), 0, 1);
    const x0 = (h0 - 0.5) * W;
    const x1 = (h1 - 0.5) * W;
    const y = limb.depth * rowH;
    // Growth runs left to right here, so the spine simply stops at the cutoff.
    const xCut = (clamp(opts.growthCutoff, 0, 1) - 0.5) * W;
    buf.limbVisible[slot] = h0 <= opts.growthCutoff ? 1 : 0;
    for (let j = 0; j < S; j++) {
      const u = j / (S - 1);
      const x = Math.min(lerp(x0, x1, u), Math.max(x0, xCut));
      const c: Vec3 = [x, y, 0];
      const r = opts.height * 0.004;
      writeRing(buf, slot, j, S, c, [1, 0, 0], r, 1);
      growBounds(bounds, c, r);
    }
  }

  for (let i = 0; i < tree.order.length; i++) {
    const oid = tree.order[i];
    const node = tree.nodes.get(oid)!;
    const h = clamp(scale.height(node.time), 0, 1);
    const s = leafScaleFor(tree, oid, churnMax);
    const px = (h - 0.5) * W;
    const py = node.limbId === 0 ? 0 : tree.limbs[node.limbId].depth * rowH + s * 0.9;
    buf.leafPositions[i * 3] = safe(px);
    buf.leafPositions[i * 3 + 1] = safe(py);
    buf.leafPositions[i * 3 + 2] = 0;
    const inWindow = node.time >= scale.window.start && node.time <= scale.window.end;
    buf.leafScales[i] = inWindow && h <= opts.growthCutoff + 1e-6 ? s : 0;
    if (buf.leafScales[i] > 0) growBounds(bounds, [px, py, 0], s);
  }
}

/* -------------------------------------------------------------------------- */
/* Buffer writers                                                              */
/* -------------------------------------------------------------------------- */

function basis(tan: Vec3): { n: Vec3; b: Vec3 } {
  const t = normalize(tan);
  const up: Vec3 = Math.abs(t[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const n = normalize(cross(up, t));
  const b = normalize(cross(t, n));
  return { n, b };
}

const safe = (x: number): number => (Number.isFinite(x) ? x : 0);

function writeRing(
  buf: Buffers,
  slot: number,
  j: number,
  S: number,
  centerIn: Vec3,
  tan: Vec3,
  radiusIn: number,
  theta2d: number,
): void {
  const center: Vec3 = [safe(centerIn[0]), safe(centerIn[1]), safe(centerIn[2])];
  const radius = Math.max(0, safe(radiusIn));
  const { n, b } = basis(tan);
  const ringBase = (slot * S + j) * LIMB_RING_VERTS * 3;
  buf.limbRadii[slot * S + j] = radius;
  for (let k = 0; k < LIMB_RING_VERTS; k++) {
    const a = (k / LIMB_RING_VERTS) * Math.PI * 2;
    const ca = Math.cos(a) * radius;
    const sa = Math.sin(a) * radius;
    const o = ringBase + k * 3;
    buf.limbVertices[o] = center[0] + n[0] * ca + b[0] * sa;
    buf.limbVertices[o + 1] = center[1] + n[1] * ca + b[1] * sa;
    buf.limbVertices[o + 2] = center[2] + (n[2] * ca + b[2] * sa) * (1 - theta2d * 0.45);
  }
}

function collapseLimb(buf: Buffers, slot: number, S: number, at: Vec3): void {
  buf.limbVisible[slot] = 0;
  for (let j = 0; j < S; j++) {
    buf.limbRadii[slot * S + j] = 0;
    const ringBase = (slot * S + j) * LIMB_RING_VERTS * 3;
    for (let k = 0; k < LIMB_RING_VERTS; k++) {
      const o = ringBase + k * 3;
      buf.limbVertices[o] = at[0];
      buf.limbVertices[o + 1] = at[1];
      buf.limbVertices[o + 2] = at[2];
    }
  }
}

type Bounds = { min: Vec3; max: Vec3; touched: boolean };
const newBounds = (): Bounds => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], touched: false });

function growBounds(b: Bounds, p: Vec3, pad: number): void {
  b.touched = true;
  for (let i = 0; i < 3; i++) {
    if (p[i] - pad < b.min[i]) b.min[i] = p[i] - pad;
    if (p[i] + pad > b.max[i]) b.max[i] = p[i] + pad;
  }
}

function finishBounds(b: Bounds, height: number): { min: [number, number, number]; max: [number, number, number] } {
  if (!b.touched) return { min: [-1, 0, -1], max: [1, height, 1] };
  return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
}
