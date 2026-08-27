import * as THREE from 'three';
import { MAX_LEAVES, type LayoutResult, type TreeStructure } from '@gittree/core';
import type { TreeCamera } from './camera.js';

/* -------------------------------------------------------------------------- */
/* The morph, on the CPU                                                       */
/*                                                                            */
/* The WebGL backend does this interpolation again in a vertex shader, and the */
/* 2D backend has nothing else to do it with — but both need the same answer   */
/* on the CPU regardless, because picking a leaf and flying to one are         */
/* questions about where a commit is *right now*, mid-transition. Keeping the  */
/* delay curve in one place is what stops the cursor and the picture drifting  */
/* apart during a view change.                                                 */
/* -------------------------------------------------------------------------- */

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

/** How far the tree unfolds trunk-outward before a given depth starts moving. */
export const DEPTH_DELAY = 0.34;
/** Width of a single node's transition, in progress units. */
export const MORPH_SPAN = 0.6;

export class MorphState {
  tree: TreeStructure | null = null;
  previous: LayoutResult | null = null;
  current: LayoutResult | null = null;
  progress = 1;
  leafCount = 0;

  /** Per-leaf transition delay, from limb depth. Also used by both renderers. */
  leafDelay = new Float32Array(0);
  /** Deterministic per-leaf noise, for sway and shading. */
  leafSeed = new Float32Array(0);

  private positions = new Float32Array(0);
  private dirty = true;

  setStructure(tree: TreeStructure): void {
    this.tree = tree;
    this.leafCount = Math.min(tree.order.length, MAX_LEAVES);
    this.leafDelay = new Float32Array(this.leafCount);
    this.leafSeed = new Float32Array(this.leafCount);
    this.positions = new Float32Array(this.leafCount * 3);
    const maxDepth = Math.max(1, tree.stats.maxDepth);
    for (let i = 0; i < this.leafCount; i++) {
      const node = tree.nodes.get(tree.order[i])!;
      const depth = tree.limbs[node.limbId]?.depth ?? 0;
      this.leafDelay[i] = (depth / maxDepth) * DEPTH_DELAY;
      this.leafSeed[i] = (hashOid(node.oid) % 10007) / 10007;
    }
    this.previous = null;
    this.current = null;
    this.progress = 1;
    this.dirty = true;
  }

  /** Per-limb transition delay, matching the leaf curve. */
  limbDelay(slot: number): number {
    if (!this.tree) return 0;
    const maxDepth = Math.max(1, this.tree.stats.maxDepth);
    return ((this.tree.limbs[slot]?.depth ?? 0) / maxDepth) * DEPTH_DELAY;
  }

  push(result: LayoutResult): void {
    this.previous = this.current;
    this.current = result;
    this.progress = 0;
    this.dirty = true;
  }

  setProgress(p: number): void {
    this.progress = p;
    this.dirty = true;
  }

  /** Interpolation factor for a node with the given delay, at the current progress. */
  factor(delay: number): number {
    return smoothstep(delay, delay + MORPH_SPAN, this.progress);
  }

  /** World positions of every leaf at the current morph value. */
  leafPositions(): Float32Array {
    if (this.dirty) this.refresh();
    return this.positions;
  }

  private refresh(): void {
    const b = this.current;
    if (!b) return;
    const a = this.previous ?? b;
    for (let i = 0; i < this.leafCount; i++) {
      const s = this.factor(this.leafDelay[i]);
      for (let k = 0; k < 3; k++) {
        const av = a.leafPositions[i * 3 + k];
        const bv = b.leafPositions[i * 3 + k];
        this.positions[i * 3 + k] = av + (bv - av) * s;
      }
    }
    this.dirty = false;
  }

  /** Leaf size at the current morph value. */
  sizeAt(i: number): number {
    const b = this.current;
    if (!b) return 0;
    const a = this.previous ?? b;
    const s = this.factor(this.leafDelay[i]);
    const av = a.leafSizes[i] ?? 0;
    const bv = b.leafSizes[i] ?? 0;
    return av + (bv - av) * s;
  }

  /**
   * Raycast against the leaves analytically. Three's instanced raycasting reads
   * an instance matrix the WebGL backend deliberately never writes, and twenty
   * thousand point-to-ray distances are cheaper than those matrices would have
   * been anyway. The 2D backend has no scene graph to raycast against at all.
   */
  pick(cam: TreeCamera, ndcX: number, ndcY: number, growth: number): number {
    const cur = this.current;
    if (!cur || !this.tree) return -1;
    const p = this.leafPositions();

    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam.camera);
    const origin = ray.ray.origin;
    const dir = ray.ray.direction;

    let bestIdx = -1;
    let bestT = Infinity;
    const v = new THREE.Vector3();
    for (let i = 0; i < this.leafCount; i++) {
      const size = cur.leafSizes[i];
      if (size <= 0) continue;
      if (cur.leafHeights[i] > growth) continue;
      v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      v.sub(origin);
      const t = v.dot(dir);
      if (t <= 0 || t >= bestT) continue;
      const perp = v.addScaledVector(dir, -t).lengthSq();
      // Pick radius grows a little with distance so a leaf that is two pixels
      // across on screen is still reachable with a pointer.
      const r = size * 1.5 + t * 0.012;
      if (perp <= r * r) {
        bestT = t;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  worldPositionOf(index: number): THREE.Vector3 | null {
    if (!this.current || index < 0 || index >= this.leafCount) return null;
    const p = this.leafPositions();
    return new THREE.Vector3(p[index * 3], p[index * 3 + 1], p[index * 3 + 2]);
  }
}

export function hashOid(oid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < oid.length; i++) {
    h ^= oid.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
