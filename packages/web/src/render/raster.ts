import { PALETTE, PALETTE_LINEAR, hexToRgb, toLinear, type RGB } from '../palette.js';

/* -------------------------------------------------------------------------- */
/* A software rasterizer                                                       */
/*                                                                            */
/* Small enough to be honest about what it is: a depth buffer, a palette-index */
/* buffer, and a triangle filler. It exists because the pixel-art look is not  */
/* a post-process on this project — the low-resolution grid and the fixed      */
/* twenty-four colours *are* the picture. That means the fallback renderer     */
/* does not have to imitate the WebGL one's shading to match it; it only has   */
/* to land on the same palette indices at the same 480x270 grid, which a few   */
/* hundred lines of scanline filling can do in every browser ever shipped.     */
/*                                                                            */
/* Colour is stored as a palette index, not RGB, so quantization happens once  */
/* at write time through a lookup table instead of per-pixel at the end.       */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Quantization                                                                */
/*                                                                            */
/* A 5-bit-per-channel cube mapping an sRGB colour to the nearest palette      */
/* entry, matched in linear space the way the shader matches it.               */
/*                                                                            */
/* Filled on demand rather than up front. Building all 32,768 cells costs      */
/* 786,000 distance computations — 56 ms on a fast desktop, and several        */
/* hundred on a phone, blocking the very first frame on exactly the machines   */
/* most likely to be running the software renderer in the first place. A tree  */
/* touches a few hundred distinct cells, so the miss path runs a few hundred   */
/* times and then never again. 0xFF is the empty marker: the palette has       */
/* twenty-four entries, so it can never be a real answer.                      */
/* -------------------------------------------------------------------------- */

const LUT_BITS = 5;
const LUT_SIZE = 1 << (LUT_BITS * 3);
const LUT_EMPTY = 0xff;
const LUT_MAX = (1 << LUT_BITS) - 1;
const LUT = new Uint8Array(LUT_SIZE).fill(LUT_EMPTY);

/** The nearest palette entry to one cell of the cube. Runs once per cell, ever. */
function resolveCell(key: number): number {
  const step = 255 / LUT_MAX / 255;
  const lin = toLinear([
    ((key >> (LUT_BITS * 2)) & LUT_MAX) * step,
    ((key >> LUT_BITS) & LUT_MAX) * step,
    (key & LUT_MAX) * step,
  ]);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < PALETTE_LINEAR.length; i++) {
    const c = PALETTE_LINEAR[i];
    const dr = c[0] - lin[0];
    const dg = c[1] - lin[1];
    const db = c[2] - lin[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  LUT[key] = best;
  return best;
}

/** The lookup table itself, for callers that index it in a tight loop. */
export function paletteLut(): Uint8Array {
  return LUT;
}

/** Resolve one cube cell, filling it if this is the first time it is asked for. */
export function lookup(key: number): number {
  const v = LUT[key];
  return v === LUT_EMPTY ? resolveCell(key) : v;
}

/** Quantize an sRGB triple in 0..1 to a palette index. */
export function quantize(r: number, g: number, b: number): number {
  const ri = r <= 0 ? 0 : r >= 1 ? LUT_MAX : (r * LUT_MAX + 0.5) | 0;
  const gi = g <= 0 ? 0 : g >= 1 ? LUT_MAX : (g * LUT_MAX + 0.5) | 0;
  const bi = b <= 0 ? 0 : b >= 1 ? LUT_MAX : (b * LUT_MAX + 0.5) | 0;
  return lookup((ri << (LUT_BITS * 2)) | (gi << LUT_BITS) | bi);
}

/* 4x4 Bayer, the same matrix the WebGL post pass uses. Ordered dither is the
 * only kind of noise that stays still while the camera moves, which matters
 * when the entire point is stable pixels. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const RGB_BYTES: RGB[] = PALETTE.map(hexToRgb);

/**
 * How far a pixel may be nudged before quantizing, added rather than scaled.
 * The ground ramp steps by about 0.022 in sRGB, so half a step of noise is
 * enough to break banding and not enough to read as grain. Scaling instead of
 * adding would make the nudge vanish in the dark blues, which is precisely
 * where a twenty-four colour palette bands worst.
 */
const DITHER = 0.022;

/** Radial darkening toward the edge of the plate, matching the WebGL post pass. */
const VIGNETTE = 0.34;

function littleEndian(): boolean {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = 0x01020304;
  return new Uint8Array(buf)[0] === 0x04;
}

export class Raster {
  width = 0;
  height = 0;
  /** Palette index per pixel. */
  color = new Uint8Array(0);
  /**
   * Reciprocal view depth per pixel; larger is nearer, zero is infinitely far.
   *
   * Storing 1/z rather than z is not a micro-optimisation. Reciprocal depth is
   * the thing that interpolates linearly across a triangle in screen space, so
   * this is the only form that is *correct* without a divide per pixel — and
   * the ground plate, seen almost edge-on and spanning a thousand units of
   * depth, is exactly the shape that gets visibly wrong ordering otherwise.
   */
  depth = new Float32Array(0);
  /** Radial falloff toward the plate edge, precomputed once per resize. */
  private vig = new Float32Array(0);
  /**
   * The ordered-dither offset for each pixel, also precomputed. It only depends
   * on x and y modulo four, but reading it costs one indexed load where
   * recomputing it costs a call, two masks, a multiply and a subtract — per
   * pixel, per primitive, for every pixel the tree covers.
   */
  private bias = new Float32Array(0);

  private image: ImageData | null = null;
  private words: Uint32Array | null = null;
  private packed: Uint32Array;
  private ctx: CanvasRenderingContext2D | null = null;

  constructor() {
    const le = littleEndian();
    this.packed = new Uint32Array(RGB_BYTES.length);
    RGB_BYTES.forEach(([r, g, b], i) => {
      const R = Math.round(r * 255);
      const G = Math.round(g * 255);
      const B = Math.round(b * 255);
      this.packed[i] = le ? (255 << 24) | (B << 16) | (G << 8) | R : (R << 24) | (G << 16) | (B << 8) | 255;
    });
  }

  resize(width: number, height: number, ctx?: CanvasRenderingContext2D | null): void {
    if (width === this.width && height === this.height && (!ctx || this.image)) return;
    this.width = width;
    this.height = height;
    this.color = new Uint8Array(width * height);
    this.depth = new Float32Array(width * height);
    this.vig = new Float32Array(width * height);
    this.bias = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = (x + 0.5) / width - 0.5;
        const dy = (y + 0.5) / height - 0.5;
        const r = Math.hypot(dx, dy) * 1.42;
        const i = y * width + x;
        this.vig[i] = 1 - VIGNETTE * r * r;
        this.bias[i] = (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * DITHER;
      }
    }
    // Without a context there is no ImageData to expand into; the colour and
    // depth buffers still work, which is all a test needs.
    this.ctx = ctx ?? null;
    this.image = ctx ? ctx.createImageData(width, height) : null;
    this.words = this.image ? new Uint32Array(this.image.data.buffer) : null;
  }

  clear(rgb: RGB): void {
    this.depth.fill(0);
    const m = LUT_MAX;
    const w = this.width;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = this.vig[i];
        const d = this.bias[i];
        const ri = clampCell(rgb[0] * v + d, m);
        const gi = clampCell(rgb[1] * v + d, m);
        const bi = clampCell(rgb[2] * v + d, m);
        this.color[i] = lookup((ri << (LUT_BITS * 2)) | (gi << LUT_BITS) | bi);
      }
    }
  }

  /**
   * A depth-tested triangle. Barycentric depth is interpolated in screen space
   * rather than perspective-correctly: every triangle here is either a leaf a
   * few pixels across or one segment of a limb, so the error is far below one
   * palette step and never below one pixel of depth ordering.
   */
  fillTri(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    r: number, g: number, b: number,
  ): void {
    const w = this.width;
    const h = this.height;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!(Math.abs(area) > 1e-9)) return;

    let minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    let maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2)));
    let minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    let maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) return;

    const inv = 1 / area;
    const m = LUT_MAX;
    const i0 = 1 / Math.max(1e-6, z0);
    const i1 = 1 / Math.max(1e-6, z1);
    const i2 = 1 / Math.max(1e-6, z2);

    // Barycentrics are affine in screen space, so they can be stepped rather
    // than recomputed: six multiplies per pixel become two additions. At a
    // hundred thousand covered pixels a frame that is the difference between
    // the software renderer holding sixty and not.
    const dw0dx = -(y1 - y0) * inv;
    const dw0dy = (x1 - x0) * inv;
    const dw1dx = (y2 - y0) * inv;
    const dw1dy = -(x2 - x0) * inv;
    const fx0 = minX + 0.5;
    let rowW0 = ((x1 - x0) * (minY + 0.5 - y0) - (fx0 - x0) * (y1 - y0)) * inv;
    let rowW1 = ((fx0 - x0) * (y2 - y0) - (x2 - x0) * (minY + 0.5 - y0)) * inv;

    for (let py = minY; py <= maxY; py++, rowW0 += dw0dy, rowW1 += dw1dy) {
      let w0 = rowW0;
      let w1 = rowW1;
      const row = py * w;
      for (let px = minX; px <= maxX; px++, w0 += dw0dx, w1 += dw1dx) {
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        // w1 weights vertex 1, w0 weights vertex 2, the remainder vertex 0.
        const iz = i0 * (1 - w0 - w1) + i1 * w1 + i2 * w0;
        const i = row + px;
        if (iz <= this.depth[i]) continue;
        const v = this.vig[i];
        const d = this.bias[i];
        const ri = clampCell(r * v + d, m);
        const gi = clampCell(g * v + d, m);
        const bi = clampCell(b * v + d, m);
        this.depth[i] = iz;
        this.color[i] = lookup((ri << (LUT_BITS * 2)) | (gi << LUT_BITS) | bi);
      }
    }
  }

  /**
   * A triangle with per-vertex colour. Only the ground plate needs this — it is
   * one shape covering half the frame, and drawing it in flat steps produces a
   * visible dome where the shader has a smooth wash.
   */
  fillTriShaded(
    x0: number, y0: number, z0: number, c0: RGB,
    x1: number, y1: number, z1: number, c1: RGB,
    x2: number, y2: number, z2: number, c2: RGB,
  ): void {
    const w = this.width;
    const h = this.height;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!(Math.abs(area) > 1e-9)) return;

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) return;

    const inv = 1 / area;
    const m = LUT_MAX;
    const i0 = 1 / Math.max(1e-6, z0);
    const i1 = 1 / Math.max(1e-6, z1);
    const i2 = 1 / Math.max(1e-6, z2);
    // Colour divided through by depth, so interpolating it against the
    // reciprocal depth below recovers the perspective-correct value. On the
    // ground plate the screen-space shortcut is not close: it stretches the
    // near-to-far wash out along the horizon and lightens half the frame.
    const r0 = c0[0] * i0, g0 = c0[1] * i0, bb0 = c0[2] * i0;
    const r1 = c1[0] * i1, g1 = c1[1] * i1, bb1 = c1[2] * i1;
    const r2 = c2[0] * i2, g2 = c2[1] * i2, bb2 = c2[2] * i2;

    const db2dx = -(y1 - y0) * inv;
    const db2dy = (x1 - x0) * inv;
    const db1dx = (y2 - y0) * inv;
    const db1dy = -(x2 - x0) * inv;
    const fx0 = minX + 0.5;
    let rowB2 = ((x1 - x0) * (minY + 0.5 - y0) - (fx0 - x0) * (y1 - y0)) * inv;
    let rowB1 = ((fx0 - x0) * (y2 - y0) - (x2 - x0) * (minY + 0.5 - y0)) * inv;

    for (let py = minY; py <= maxY; py++, rowB2 += db2dy, rowB1 += db1dy) {
      let b2 = rowB2;
      let b1 = rowB1;
      const row = py * w;
      for (let px = minX; px <= maxX; px++, b2 += db2dx, b1 += db1dx) {
        if (b2 < 0 || b1 < 0 || b2 + b1 > 1) continue;
        const b0 = 1 - b2 - b1;
        const iz = i0 * b0 + i1 * b1 + i2 * b2;
        const i = row + px;
        if (iz <= this.depth[i]) continue;
        const s = 1 / iz;
        const v = this.vig[i] * s;
        const d = this.bias[i];
        const ri = clampCell((r0 * b0 + r1 * b1 + r2 * b2) * v + d, m);
        const gi = clampCell((g0 * b0 + g1 * b1 + g2 * b2) * v + d, m);
        const bi = clampCell((bb0 * b0 + bb1 * b1 + bb2 * b2) * v + d, m);
        this.depth[i] = iz;
        this.color[i] = lookup((ri << (LUT_BITS * 2)) | (gi << LUT_BITS) | bi);
      }
    }
  }

  /** A depth-tested axis-aligned rectangle. Leaves smaller than a few pixels. */
  fillRect(x: number, y: number, size: number, z: number, r: number, g: number, b: number): void {
    const w = this.width;
    const h = this.height;
    const half = size * 0.5;
    const x0 = Math.round(x - half);
    const y0 = Math.round(y - half);
    const minX = Math.max(0, x0);
    const maxX = Math.min(w - 1, Math.max(x0, Math.round(x + half) - 1));
    const minY = Math.max(0, y0);
    const maxY = Math.min(h - 1, Math.max(y0, Math.round(y + half) - 1));
    if (minX > maxX || minY > maxY) return;
    const m = LUT_MAX;
    const iz = 1 / Math.max(1e-6, z);
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const i = py * w + px;
        if (iz <= this.depth[i]) continue;
        const v = this.vig[i];
        const d = this.bias[i];
        const ri = clampCell(r * v + d, m);
        const gi = clampCell(g * v + d, m);
        const bi = clampCell(b * v + d, m);
        this.depth[i] = iz;
        this.color[i] = lookup((ri << (LUT_BITS * 2)) | (gi << LUT_BITS) | bi);
      }
    }
  }

  /** A convex polygon, fanned from its first vertex. Points are [x,y,z] triples. */
  fillConvex(pts: number[], r: number, g: number, b: number): void {
    for (let i = 1; i + 1 < pts.length / 3; i++) {
      this.fillTri(
        pts[0], pts[1], pts[2],
        pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2],
        pts[(i + 1) * 3], pts[(i + 1) * 3 + 1], pts[(i + 1) * 3 + 2],
        r, g, b,
      );
    }
  }

  /** Expand palette indices into the ImageData and hand it to the context. */
  present(): void {
    const words = this.words;
    const image = this.image;
    const ctx = this.ctx;
    if (!words || !image || !ctx) return;
    const packed = this.packed;
    const color = this.color;
    for (let i = 0; i < color.length; i++) words[i] = packed[color[i]];
    ctx.putImageData(image, 0, 0);
  }
}

/**
 * A 0..1 colour channel to a whole cube cell. `(x + 0.5) | 0` in place of
 * Math.round, guarded by the clamp either side so the truncation only ever sees
 * a non-negative number in range.
 */
function clampCell(v: number, m: number): number {
  if (!(v > 0)) return 0;
  const scaled = v * m + 0.5;
  return scaled >= m ? m : scaled | 0;
}
