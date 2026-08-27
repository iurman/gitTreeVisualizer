import * as THREE from 'three';
import {
  LIMB_RING_VERTS,
  limbSlotCount,
  type LayoutResult,
  type LensAttributes,
  type RingMark,
  type TreeStructure,
} from '@gittree/core';
import { GROUND, SPECIMEN, hexToRgb, type RGB } from '../palette.js';
import { TreeCamera } from './camera.js';
import { MorphState, smoothstep } from './morph.js';
import { Raster } from './raster.js';
import { lensRgb } from './lensPalette.js';
import { LEAF_CEILING_PX, leafPixels, worldPerPixel } from './leafSize.js';
import { BASE_WIDTH, targetSize } from './resolution.js';
import type { BackendEvent, RenderBackend, RendererKind, TransitionOptions } from './backend.js';

/* -------------------------------------------------------------------------- */
/* The compatibility renderer                                                  */
/*                                                                            */
/* Same tree, same palette, same pixel grid, no GPU. It exists because WebGL   */
/* is the one part of this product a browser can simply decline to provide —   */
/* Firefox and Brave both switch it off under fingerprinting protection, a     */
/* blocklisted driver takes it away on machines that are otherwise fine, and   */
/* the whole of iOS before 15 never had WebGL 2 at all. The old answer was a   */
/* flat PNG drawn on the server, which is not the product: no growth, no       */
/* orbit, no lenses, no clicking a commit.                                     */
/*                                                                            */
/* What it gives up, deliberately: the ambient sway on limbs, the ground       */
/* gradient's smoothness, and per-pixel lighting on the bark — a limb is       */
/* shaded in three bands across its width instead, which at two pixels wide is */
/* the same picture. What it keeps: every interaction, and the fact that the   */
/* twenty-four colours are the same twenty-four colours.                       */
/*                                                                            */
/* Three.js is still doing the maths here. Its Matrix4 and PerspectiveCamera   */
/* have no WebGL dependency, so the camera, the projection and the picking are */
/* literally the same code in both backends — only the drawing differs.        */
/* -------------------------------------------------------------------------- */

const BARK = hexToRgb(SPECIMEN[2]);
const BARK_LIT = hexToRgb(SPECIMEN[6]);
const RING_COLOR = hexToRgb(SPECIMEN[7]);
const HAZE = hexToRgb(GROUND[1]);
const DIM = hexToRgb(GROUND[3]);
const GROUND_NEAR = hexToRgb(GROUND[2]);
const GROUND_FAR = hexToRgb(GROUND[1]);
const MARK = hexToRgb('#FFFAEB');

/**
 * A limb is a tube, and the shader shades it per-pixel from a normal it rebuilds
 * from the ring centre. Here it is a screen-space ribbon shaded in five strips
 * across its width, with the normal reconstructed from how far across the strip
 * sits: a point `u` of the way from the centre of the ribbon to its edge has a
 * surface normal `u` across and `sqrt(1 - u^2)` toward the camera. That is the
 * same normal the shader would compute, so the two agree as the camera orbits
 * instead of only at one angle.
 */
const BANDS = [-0.8, -0.4, 0, 0.4, 0.8];
const BAND_WIDTH = 0.4;

/** The key light: low and to the left, the way a specimen plate is lit. */
const KEY = new THREE.Vector3(-0.55, 0.72, 0.42).normalize();

const GROUND_SEGMENTS = 36;
const GROUND_RINGS = 8;
const GROUND_RADIUS = 520;

export class Canvas2DBackend implements RenderBackend {
  readonly kind: RendererKind = 'canvas2d';
  readonly canvas: HTMLCanvasElement;
  readonly cam: TreeCamera;

  private ctx: CanvasRenderingContext2D;
  private buffer: HTMLCanvasElement;
  private bufferCtx: CanvasRenderingContext2D;
  private raster = new Raster();
  private morph = new MorphState();

  private tree: TreeStructure | null = null;
  private slots = 0;
  private segments = 22;
  private renderScale = 1;
  private width = BASE_WIDTH;
  private height = Math.round(BASE_WIDTH * (9 / 16));

  private growth = 1;
  private groundY = 0;
  private selected = -1;
  private hovered = -1;
  private time = 0;
  private sway = 0.22;
  reduceMotion = false;

  private lens: LensAttributes | null = null;
  private dim = new Float32Array(0);
  private fallStart = new Float32Array(0);

  private ringField = new Float32Array(512);

  private transitionStart = 0;
  private transitionDuration = 900;
  private transitioning = false;
  private onTransitionDone: (() => void) | null = null;

  private lastFrame = 0;
  private frameTimes: number[] = [];
  private handlers = new Set<(e: BackendEvent) => void>();

  /** Scratch, reused every frame so a 60 Hz loop allocates nothing. */
  private vp = new THREE.Matrix4();
  private keyView = new THREE.Vector3();
  private centersA = new Float32Array(0);
  private centersB = new Float32Array(0);
  private ribbon = new Float32Array(0);

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas2DBackend: this browser refused a 2D context');
    this.canvas = canvas;
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;

    const buffer = document.createElement('canvas');
    const bctx = buffer.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!bctx) throw new Error('Canvas2DBackend: this browser refused an offscreen 2D context');
    this.buffer = buffer;
    this.bufferCtx = bctx;

    this.cam = new TreeCamera(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.applyTargetSize(this.width, this.height);
  }

  onEvent(handler: (e: BackendEvent) => void): void {
    this.handlers.add(handler);
  }

  /* ---------------------------------------------------------------------- */
  /* Structure                                                              */
  /* ---------------------------------------------------------------------- */

  setStructure(tree: TreeStructure, segments: number): void {
    this.tree = tree;
    this.slots = limbSlotCount(tree);
    this.segments = segments;
    this.morph.setStructure(tree);

    const n = this.morph.leafCount;
    this.dim = new Float32Array(n).fill(1);
    this.fallStart = new Float32Array(n);

    const rings = this.slots * this.segments * 3;
    this.centersA = new Float32Array(rings);
    this.centersB = new Float32Array(rings);
    // Four screen-space corners per limb band, three bands, one segment at a time.
    this.ribbon = new Float32Array(12);
  }

  /* ---------------------------------------------------------------------- */
  /* Transitions                                                            */
  /* ---------------------------------------------------------------------- */

  applyLayout(result: LayoutResult, opts: TransitionOptions = {}): void {
    if (!this.tree) return;
    this.centersA.set(this.centersB);
    ringCentersInto(result.limbVertices, this.slots, this.segments, this.centersB);
    if (!this.morph.current) this.centersA.set(this.centersB);

    this.morph.push(result);
    this.updateRings(result.rings);

    this.transitionDuration = Math.max(1, opts.duration ?? (this.reduceMotion ? 180 : 900));
    this.transitionStart = performance.now();
    this.transitioning = true;
    this.onTransitionDone = opts.onDone ?? null;
  }

  setLayoutImmediate(result: LayoutResult): void {
    this.applyLayout(result, { duration: 1 });
    this.morph.setProgress(1);
    this.centersA.set(this.centersB);
    this.transitioning = false;
  }

  private updateRings(rings: RingMark[]): void {
    const w = this.ringField.length;
    this.ringField.fill(0);
    for (const r of rings) {
      const x = Math.round(Math.min(1, Math.max(0, r.t)) * (w - 1));
      const weight = r.major ? 1 : 0.38;
      for (let d = -1; d <= 1; d++) {
        const i = x + d;
        if (i < 0 || i >= w) continue;
        const v = d === 0 ? weight : weight * 0.35;
        if (v > this.ringField[i]) this.ringField[i] = v;
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Attributes                                                             */
  /* ---------------------------------------------------------------------- */

  setLens(attrs: LensAttributes): void {
    this.lens = attrs;
  }

  setFalling(falling: Float32Array, now: number): void {
    for (let i = 0; i < this.fallStart.length; i++) {
      this.fallStart[i] = falling[i] > 0 ? now + ((i * 37) % 900) / 300 : 0;
    }
  }

  clearFalling(): void {
    this.fallStart.fill(0);
  }

  setDim(match: Set<string> | null): void {
    if (!this.tree) return;
    if (!match) {
      this.dim.fill(1);
      return;
    }
    for (let i = 0; i < this.dim.length; i++) this.dim[i] = match.has(this.tree.order[i]) ? 1 : 0.12;
  }

  setGrowth(v: number): void {
    this.growth = v;
  }

  setGroundY(y: number): void {
    this.groundY = y;
  }

  setUnfold(morph: number): void {
    this.cam.setUnfold(morph);
  }

  setHighlight(selected: number, hovered: number): void {
    this.selected = selected;
    this.hovered = hovered;
  }

  setReduceMotion(v: boolean): void {
    this.reduceMotion = v;
    this.cam.setReduceMotion(v);
    this.sway = v ? 0 : 0.22;
  }

  /* ---------------------------------------------------------------------- */
  /* Sizing                                                                 */
  /* ---------------------------------------------------------------------- */

  resize(width: number, height: number): void {
    this.canvas.width = Math.max(1, Math.floor(width));
    this.canvas.height = Math.max(1, Math.floor(height));
    this.ctx.imageSmoothingEnabled = false;
    const aspect = width / Math.max(1, height);
    this.cam.camera.aspect = aspect;
    this.cam.camera.updateProjectionMatrix();
    const [w, h] = targetSize(aspect, this.renderScale);
    this.applyTargetSize(w, h);
  }

  /**
   * The WebGL backend raises its render resolution while flying so a zoom reads
   * as resolving detail. Doing the same here would quadruple a software
   * rasterizer's per-frame cost at exactly the moment the camera is moving, so
   * this backend holds its resolution and accepts the coarser close-up.
   */
  setRenderScale(_scale: number): void {
    this.renderScale = 1;
  }

  private applyTargetSize(w: number, h: number): void {
    if (w === this.buffer.width && h === this.buffer.height) return;
    this.width = w;
    this.height = h;
    this.buffer.width = w;
    this.buffer.height = h;
    this.bufferCtx.imageSmoothingEnabled = false;
    this.raster.resize(w, h, this.bufferCtx);
  }

  /* ---------------------------------------------------------------------- */
  /* Picking                                                                */
  /* ---------------------------------------------------------------------- */

  pick(ndcX: number, ndcY: number, growth: number): number {
    return this.morph.pick(this.cam, ndcX, ndcY, growth);
  }

  worldPositionOf(index: number): THREE.Vector3 | null {
    return this.morph.worldPositionOf(index);
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  render(now: number): void {
    const dt = this.lastFrame ? Math.min(0.05, (now - this.lastFrame) / 1000) : 0.016;
    this.lastFrame = now;
    this.time = now / 1000;

    if (this.transitioning) {
      const p = Math.min(1, (now - this.transitionStart) / this.transitionDuration);
      this.morph.setProgress(p);
      if (p >= 1) {
        this.transitioning = false;
        this.centersA.set(this.centersB);
        this.onTransitionDone?.();
        this.onTransitionDone = null;
      }
    }

    this.cam.update(dt, now);
    this.cam.camera.updateMatrixWorld();
    this.vp.multiplyMatrices(this.cam.camera.projectionMatrix, this.cam.camera.matrixWorldInverse);
    this.keyView.copy(KEY).transformDirection(this.cam.camera.matrixWorldInverse);

    this.raster.clear(GROUND_FAR);
    if (this.morph.current) {
      this.drawGround();
      this.drawLimbs();
      this.drawLeaves();
    }
    this.raster.present();

    this.ctx.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);

    this.frameTimes.push(dt);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
  }

  get fps(): number {
    if (this.frameTimes.length < 10) return 60;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return avg > 0 ? 1 / avg : 60;
  }

  get transitionActive(): boolean {
    return this.transitioning;
  }

  /* ---- projection ---- */

  /** World point to [screenX, screenY, viewDepth]. Depth <= 0 means behind. */
  private project(x: number, y: number, z: number, out: number[]): boolean {
    const e = this.vp.elements;
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (cw <= 1e-4) return false;
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[0] = (cx / cw * 0.5 + 0.5) * this.width;
    out[1] = (0.5 - (cy / cw) * 0.5) * this.height;
    out[2] = cw;
    return true;
  }

  /** Vertical world units per render-target pixel at a given depth. */
  private unitAt(depth: number): number {
    return worldPerPixel(this.cam.camera.fov, this.height, depth);
  }

  private hazeAmount(depth: number): number {
    const d = this.cam.camera.position.distanceTo(this.cam.target);
    return smoothstep(d * 0.74, d * 1.95, depth);
  }

  /* ---- the ground plate ---- */

  private drawGround(): void {
    const y = this.groundY - 0.4;
    if (this.cam.camera.position.y <= y + 0.5) return;

    const p: number[] = [0, 0, 0];
    if (!this.project(0, y, 0, p)) return;
    const cx = p[0];
    const cy = p[1];
    const cd = p[2];

    // Concentric rings of wedges rather than one fan: a disc of this size runs
    // most of the way to the horizon, so it needs the near-to-far wash to be
    // drawn rather than interpolated, and it needs to survive individual
    // vertices falling behind the camera without losing the whole plate.
    const groundColor = (radius: number) =>
      mix(GROUND_NEAR, GROUND_FAR, smoothstep(0, 0.75, radius / GROUND_RADIUS));
    const centreColor = groundColor(0);

    let inner: number[] | null = null;
    let innerColor = centreColor;
    for (let ring = 1; ring <= GROUND_RINGS; ring++) {
      const t = ring / GROUND_RINGS;
      const radius = GROUND_RADIUS * t * t;
      const outer: number[] = [];
      for (let i = 0; i <= GROUND_SEGMENTS; i++) {
        const ang = (i / GROUND_SEGMENTS) * Math.PI * 2;
        const ok = this.project(Math.cos(ang) * radius, y, Math.sin(ang) * radius, p);
        outer.push(ok ? p[0] : NaN, ok ? p[1] : NaN, ok ? p[2] : NaN);
      }
      const outerColor = groundColor(radius);
      for (let i = 0; i + 1 <= GROUND_SEGMENTS; i++) {
        const o0 = i * 3;
        const o1 = (i + 1) * 3;
        if (Number.isNaN(outer[o0]) || Number.isNaN(outer[o1])) continue;
        if (!inner) {
          this.raster.fillTriShaded(
            cx, cy, cd, centreColor,
            outer[o0], outer[o0 + 1], outer[o0 + 2], outerColor,
            outer[o1], outer[o1 + 1], outer[o1 + 2], outerColor,
          );
          continue;
        }
        if (Number.isNaN(inner[o0]) || Number.isNaN(inner[o1])) continue;
        this.raster.fillTriShaded(
          inner[o0], inner[o0 + 1], inner[o0 + 2], innerColor,
          outer[o0], outer[o0 + 1], outer[o0 + 2], outerColor,
          outer[o1], outer[o1 + 1], outer[o1 + 2], outerColor,
        );
        this.raster.fillTriShaded(
          inner[o0], inner[o0 + 1], inner[o0 + 2], innerColor,
          outer[o1], outer[o1 + 1], outer[o1 + 2], outerColor,
          inner[o1], inner[o1 + 1], inner[o1 + 2], innerColor,
        );
      }
      inner = outer;
      innerColor = outerColor;
    }
  }

  /* ---- limbs ---- */

  private drawLimbs(): void {
    const cur = this.morph.current;
    if (!cur || !this.tree) return;
    const prev = this.morph.previous ?? cur;
    const S = this.segments;

    const a: number[] = [0, 0, 0];
    const bounds = cur.bounds;
    const span = Math.max(1e-3, bounds.max[1] - bounds.min[1]);

    for (let slot = 0; slot < this.slots; slot++) {
      const f = this.morph.factor(this.morph.limbDelay(slot));
      const visible = lerp(prev.limbVisible[slot] ?? 0, cur.limbVisible[slot] ?? 0, f);
      if (visible < 0.02) continue;

      const limb = this.tree.limbs[slot];
      const ghost = !!limb && (limb.synthesized || !limb.rejoined);

      let havePrev = false;
      let px = 0;
      let py = 0;
      let pr = 0;
      let pd = 0;
      let ph = 0;

      for (let j = 0; j < S; j++) {
        const k = (slot * S + j) * 3;
        const cx = lerp(this.centersA[k], this.centersB[k], f);
        const cy = lerp(this.centersA[k + 1], this.centersB[k + 1], f);
        const cz = lerp(this.centersA[k + 2], this.centersB[k + 2], f);
        const radius = lerp(prev.limbRadii[slot * S + j] ?? 0, cur.limbRadii[slot * S + j] ?? 0, f);
        const height = (cy - bounds.min[1]) / span;

        const ok = this.project(cx, cy, cz, a);
        if (!ok) {
          havePrev = false;
          continue;
        }
        const sr = Math.max(0.5, (radius / this.unitAt(a[2])) * 0.5);

        if (havePrev) {
          // A dashed limb is inferred structure, not recorded structure, and
          // must never be mistaken for it. Drop every other segment.
          const skip = ghost && (j & 1) === 0;
          if (!skip) this.segment(px, py, pd, pr, ph, a[0], a[1], a[2], sr, height, ghost, visible);
        }
        px = a[0];
        py = a[1];
        pd = a[2];
        pr = sr;
        ph = height;
        havePrev = true;
      }
    }
  }

  /** One tapered band of a limb, shaded in three strips across its width. */
  private segment(
    x0: number, y0: number, d0: number, r0: number, h0: number,
    x1: number, y1: number, d1: number, r1: number, h1: number,
    ghost: boolean, visible: number,
  ): void {
    let nx = y0 - y1;
    let ny = x1 - x0;
    const len = Math.hypot(nx, ny);
    if (!(len > 1e-6)) return;
    nx /= len;
    ny /= len;

    const hMid = (h0 + h1) * 0.5;
    // Below a couple of pixels across, a tube and a line are the same picture.
    const thin = Math.max(r0, r1) < 1.4;

    // Screen y grows downward and view-space y grows upward, so the vertical
    // component of the reconstructed normal is negated.
    const lambertAt = (u: number): number => {
      const nz = Math.sqrt(Math.max(0, 1 - u * u));
      return (
        0.42 +
        0.58 * Math.max(0, nx * u * this.keyView.x - ny * u * this.keyView.y + nz * this.keyView.z)
      );
    };

    // A one-pixel limb shows its whole visible half in that pixel, so it gets
    // the average across the tube rather than the value at its centre. Taking
    // the centre would hand every thin limb the normal that points straight at
    // the camera, which is the brightest one whenever the key light is behind
    // the viewer — that is what turned a distant canopy into white wire.
    let thinLambert = 0;
    if (thin) {
      for (const u of BANDS) thinLambert += lambertAt(u);
      thinLambert /= BANDS.length;
    }

    for (const at of thin ? [0] : BANDS) {
      const half = thin ? 1 : BAND_WIDTH * 0.5;
      const lo = at - half;
      const hi = at + half;
      const lambert = thin ? thinLambert : lambertAt(at);
      let col = mix(BARK, BARK_LIT, lambert);

      // Growth rings, from the same one-dimensional map of the whole trunk the
      // shader samples. Major boundaries carry more weight, so dense minor
      // rings degrade into texture instead of a band.
      const ring = this.ringField[Math.round(Math.min(1, Math.max(0, hMid)) * (this.ringField.length - 1))];
      if (ring > 0) col = mix(col, RING_COLOR, ring * 0.55 * lambert);
      if (ghost) col = mix(col, RING_COLOR, 0.45);

      // The freshly grown tip is paler, the way new wood is.
      col = mix(col, BARK_LIT, smoothstep(this.growth - 0.03, this.growth, hMid) * 0.5);
      if (visible < 1) col = mix(mix(BARK, HAZE, 0.5), col, visible);
      col = mix(col, HAZE, this.hazeAmount((d0 + d1) * 0.5));

      const q = this.ribbon;
      q[0] = x0 + nx * r0 * lo; q[1] = y0 + ny * r0 * lo; q[2] = d0;
      q[3] = x0 + nx * r0 * hi; q[4] = y0 + ny * r0 * hi; q[5] = d0;
      q[6] = x1 + nx * r1 * hi; q[7] = y1 + ny * r1 * hi; q[8] = d1;
      q[9] = x1 + nx * r1 * lo; q[10] = y1 + ny * r1 * lo; q[11] = d1;
      this.raster.fillTri(q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7], q[8], col[0], col[1], col[2]);
      this.raster.fillTri(q[0], q[1], q[2], q[6], q[7], q[8], q[9], q[10], q[11], col[0], col[1], col[2]);
    }
  }

  /* ---- leaves ---- */

  private drawLeaves(): void {
    const cur = this.morph.current;
    if (!cur) return;
    const pos = this.morph.leafPositions();
    const n = this.morph.leafCount;
    const lens = this.lens;
    const p: number[] = [0, 0, 0];
    const diamond: number[] = new Array(12).fill(0);

    for (let i = 0; i < n; i++) {
      const size = this.morph.sizeAt(i);
      if (size <= 0.0001) continue;

      // The growth gate. A short ramp plus a small overshoot, so a commit reads
      // as opening rather than switching on. Identical to the vertex shader.
      const lead = this.growth - cur.leafHeights[i];
      if (lead < 0) continue;
      const appear = smoothstep(0, 0.006, lead);
      if (appear <= 0.001) continue;
      const pop = 1 + 0.55 * Math.exp(-90 * lead);

      const seed = this.morph.leafSeed[i];
      const phase = seed * Math.PI * 2;
      let x = pos[i * 3];
      let y = pos[i * 3 + 1];
      let z = pos[i * 3 + 2];

      const h = cur.leafHeights[i];
      x += Math.sin(this.time * 0.6 + phase) * this.sway * (0.4 + h);
      z += Math.cos(this.time * 0.47 + phase) * this.sway * (0.4 + h);

      let shrink = 1;
      const start = this.fallStart[i];
      if (start > 0) {
        const age = this.time - start;
        if (age > 0) {
          y = Math.max(this.groundY, y - 0.5 * 9.4 * age * age);
          x += Math.sin(age * 2 + phase) * 0.35 * Math.min(age, 2);
          z += Math.cos(age * 1.7 + phase) * 0.35 * Math.min(age, 2);
          shrink = 0.85;
        }
      }

      if (!this.project(x, y, z, p)) continue;
      if (p[0] < -LEAF_CEILING_PX || p[0] > this.width + LEAF_CEILING_PX) continue;
      if (p[1] < -LEAF_CEILING_PX || p[1] > this.height + LEAF_CEILING_PX) continue;

      const mark = Math.max(i === this.selected ? 1 : 0, i === this.hovered ? 0.6 : 0);
      const world = size * appear * pop * shrink * (1 + mark * 0.4);
      const px = leafPixels(world, this.unitAt(p[2]));

      const family = lens ? (lens.family[i] ?? 1) : 1;
      const tone = lens ? lens.tone[i] : 0.7;
      const emphasis = lens ? lens.emphasis[i] : 0;
      let col = lensRgb(family, tone);
      const shade = 0.72 + 0.28 * Math.sin(phase) + emphasis * 0.25;
      col = [col[0] * shade, col[1] * shade, col[2] * shade];
      col = mix(DIM, col, this.dim[i]);
      if (mark > 0) col = mix(col, MARK, mark * 0.55);
      col = mix(col, HAZE, this.hazeAmount(p[2]));

      // Under three pixels a diamond and a square are the same four pixels, and
      // the square costs no triangle setup.
      if (px <= 2) {
        this.raster.fillRect(p[0], p[1], px, p[2], col[0], col[1], col[2]);
        continue;
      }
      const r = px * 0.5;
      diamond[0] = p[0]; diamond[1] = p[1] - r; diamond[2] = p[2];
      diamond[3] = p[0] + r; diamond[4] = p[1]; diamond[5] = p[2];
      diamond[6] = p[0]; diamond[7] = p[1] + r; diamond[8] = p[2];
      diamond[9] = p[0] - r; diamond[10] = p[1]; diamond[11] = p[2];
      this.raster.fillConvex(diamond, col[0], col[1], col[2]);
    }
  }

  dispose(): void {
    this.handlers.clear();
    this.buffer.width = 0;
    this.buffer.height = 0;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Ring centres, derived from the six vertices of each ring. */
export function ringCentersInto(
  limbVertices: Float32Array,
  slots: number,
  segments: number,
  out: Float32Array,
): Float32Array {
  for (let r = 0; r < slots * segments; r++) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const base = r * LIMB_RING_VERTS * 3;
    for (let k = 0; k < LIMB_RING_VERTS; k++) {
      cx += limbVertices[base + k * 3];
      cy += limbVertices[base + k * 3 + 1];
      cz += limbVertices[base + k * 3 + 2];
    }
    out[r * 3] = cx / LIMB_RING_VERTS;
    out[r * 3 + 1] = cy / LIMB_RING_VERTS;
    out[r * 3 + 2] = cz / LIMB_RING_VERTS;
  }
  return out;
}
