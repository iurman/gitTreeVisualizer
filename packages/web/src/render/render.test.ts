import { describe, expect, it } from 'vitest';
import { PALETTE, hexToRgb } from '../palette.js';
import {
  LEAF_CEILING_PX,
  LEAF_HEADROOM,
  LEAF_MAX_PX,
  LEAF_MIN_PX,
  leafPixels,
  softCeiling,
  worldPerPixel,
} from './leafSize.js';
import { detectRenderCapabilities, forcedRenderer, preferredRenderer } from './capabilities.js';
import { Raster, quantize } from './raster.js';
import { lensRgb } from './lensPalette.js';
import { targetSize } from './resolution.js';

/* -------------------------------------------------------------------------- */
/* The rendering contract                                                      */
/*                                                                            */
/* These cover the parts that decide whether the picture is right and whether  */
/* a browser gets one at all: how big a commit is on screen, which backend is  */
/* chosen, and whether the software rasterizer lands on the same palette the   */
/* shader does. Everything here is pure, so it runs in Node with no canvas.    */
/* -------------------------------------------------------------------------- */

describe('leaf sizing', () => {
  it('holds a leaf at the same screen size however far away it is', () => {
    const fov = 42;
    const height = 270;
    // The same leaf, at four very different distances.
    const sizes = [20, 80, 320, 1280].map((depth) => leafPixels(depth * 0.02, worldPerPixel(fov, height, depth)));
    expect(new Set(sizes).size).toBe(1);
  });

  it('never lets a commit fall below one pixel', () => {
    // A forty-commit repository seen whole: tiny leaves, enormous distance.
    const unit = worldPerPixel(42, 270, 4000);
    expect(leafPixels(0.001, unit)).toBe(LEAF_MIN_PX);
    expect(leafPixels(0, unit)).toBe(LEAF_MIN_PX);
  });

  it('never lets a commit grow without bound when the camera flies in', () => {
    // This is the regression: a fly-to used to put a single leaf across a
    // sixtieth of the frame because the size was fixed in world units.
    const unit = worldPerPixel(42, 270, 3);
    expect(leafPixels(50, unit)).toBeLessThanOrEqual(LEAF_CEILING_PX);
    expect(leafPixels(50_000, unit)).toBeLessThanOrEqual(LEAF_CEILING_PX);
  });

  it('still tells a big commit from a small one in a close-up', () => {
    // A hard clamp would make every leaf in a close-up identical, which deletes
    // the one thing a leaf is for. The knee is soft, so ordering survives.
    // These are the real extremes layout.ts produces: 0.95 world units for a
    // one-line commit, 2.85 for the largest edit in the repository.
    const SMALLEST = 0.95;
    const LARGEST = 2.85;
    // Flying to a commit stops about fourteen units away; a whole tree is seen
    // from a few hundred.
    for (const depth of [14, 40, 120, 560]) {
      const unit = worldPerPixel(42, 270, depth);
      const small = leafPixels(SMALLEST, unit);
      const large = leafPixels(LARGEST, unit);
      expect(large).toBeGreaterThan(small);
      expect(large).toBeLessThanOrEqual(LEAF_CEILING_PX);
    }
  });

  it('leaves sizes below the ceiling exactly as the perspective gives them', () => {
    for (const px of [0.2, 1, 3.5, LEAF_MAX_PX]) expect(softCeiling(px)).toBeCloseTo(px, 10);
  });

  it('compresses above the ceiling without ever reaching the asymptote', () => {
    expect(softCeiling(LEAF_MAX_PX * 2)).toBeGreaterThan(LEAF_MAX_PX);
    for (const px of [10, 100, 1e6]) {
      expect(softCeiling(px)).toBeLessThan(LEAF_MAX_PX * (1 + LEAF_HEADROOM));
    }
    // Monotonic across the knee, which is what keeps the ordering meaningful.
    let last = -1;
    for (let px = 0; px < 200; px += 0.37) {
      const v = softCeiling(px);
      expect(v).toBeGreaterThan(last);
      last = v;
    }
  });

  it('returns whole pixels, so a leaf is never a half-lit smear', () => {
    const unit = worldPerPixel(42, 270, 100);
    for (const world of [0.5, 1.1, 2.7, 4.2, 6.9]) {
      const px = leafPixels(world, unit);
      expect(Number.isInteger(px)).toBe(true);
      expect(px).toBeGreaterThanOrEqual(LEAF_MIN_PX);
      expect(px).toBeLessThanOrEqual(LEAF_CEILING_PX);
    }
  });

  it('grows monotonically with the size the layout asked for', () => {
    const unit = worldPerPixel(42, 270, 200);
    let last = 0;
    for (let world = 0; world < 12; world += 0.25) {
      const px = leafPixels(world, unit);
      expect(px).toBeGreaterThanOrEqual(last);
      last = px;
    }
  });

  it('agrees with the arithmetic the vertex shader does', () => {
    // The GLSL is a transcription of leafPixels; if one is edited without the
    // other, the two renderers stop drawing the same tree. Re-implement the
    // shader's expression here, term for term, and compare.
    const glsl = (raw: number, min: number, max: number, headroom: number) => {
      const over = Math.max(0, raw / max - 1);
      const soft = max * (1 + over / (1 + over / headroom));
      return Math.max(min, Math.floor(Math.min(raw, soft) + 0.5));
    };
    const unit = worldPerPixel(42, 270, 140);
    for (const world of [0, 0.01, 0.4, 1.3, 2.9, 7.7, 18, 240]) {
      expect(leafPixels(world, unit)).toBe(
        glsl(world / unit, LEAF_MIN_PX, LEAF_MAX_PX, LEAF_HEADROOM),
      );
    }
  });

  it('measures a pixel against the field of view, which the unfold animates', () => {
    // The flat state is a very narrow field of view pulled far back. If the
    // unit did not follow the field of view, every leaf would jump size at the
    // exact moment the tree unfolds.
    const near = worldPerPixel(8, 270, 1000);
    const wide = worldPerPixel(42, 270, 1000);
    expect(wide).toBeGreaterThan(near * 4);
  });
});

describe('render target', () => {
  it('keeps the width fixed so a pixel is the same size on any viewport', () => {
    expect(targetSize(16 / 9)[0]).toBe(targetSize(4 / 3)[0]);
  });

  it('follows the aspect ratio in height, always even', () => {
    for (const aspect of [0.5, 1, 16 / 9, 21 / 9, 3]) {
      const [w, h] = targetSize(aspect);
      expect(h % 2).toBe(0);
      expect(Math.abs(w / h - aspect)).toBeLessThan(0.05 * aspect);
    }
  });

  it('survives a degenerate aspect ratio rather than allocating nothing', () => {
    const [w, h] = targetSize(0);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
  });
});

/** Just enough of a Document for the probe: canvases that grant, or refuse. */
function fakeDocument(grants: Record<string, unknown>): Document {
  return {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: (name: string) => grants[name] ?? null,
    }),
  } as unknown as Document;
}

describe('renderer selection', () => {
  const webgl2 = { getExtension: () => ({ loseContext: () => {} }) };

  it('reads an explicit override out of the query string', () => {
    expect(forcedRenderer('?renderer=2d')).toBe('canvas2d');
    expect(forcedRenderer('?renderer=CANVAS2D')).toBe('canvas2d');
    expect(forcedRenderer('?renderer=software')).toBe('canvas2d');
    expect(forcedRenderer('?renderer=webgl')).toBe('webgl');
    expect(forcedRenderer('?renderer=gl&lens=author')).toBe('webgl');
  });

  it('ignores an override it does not understand', () => {
    expect(forcedRenderer('?renderer=vulkan')).toBeNull();
    expect(forcedRenderer('?lens=author')).toBeNull();
    expect(forcedRenderer('')).toBeNull();
  });

  it('prefers WebGL when the probe grants a context', () => {
    const caps = detectRenderCapabilities(fakeDocument({ webgl2, '2d': {} }), '');
    expect(caps.webgl2).toBe(true);
    expect(caps.reason).toBeNull();
    expect(preferredRenderer(caps)).toBe('webgl');
  });

  it('falls back when WebGL 2 is refused, and says why', () => {
    const caps = detectRenderCapabilities(fakeDocument({ '2d': {} }), '');
    expect(caps.webgl2).toBe(false);
    expect(caps.canvas2d).toBe(true);
    expect(caps.reason).toMatch(/did not return a WebGL context/);
    expect(preferredRenderer(caps)).toBe('canvas2d');
  });

  it('distinguishes a browser that only has WebGL 1', () => {
    const caps = detectRenderCapabilities(fakeDocument({ webgl: {}, '2d': {} }), '');
    expect(caps.reason).toMatch(/WebGL 1 but not WebGL 2/);
  });

  it('treats a throwing getContext as an absent one', () => {
    const doc = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => {
          throw new Error('blocked by fingerprinting protection');
        },
      }),
    } as unknown as Document;
    const caps = detectRenderCapabilities(doc, '');
    expect(caps.webgl2).toBe(false);
    expect(caps.reason).toMatch(/blocked by fingerprinting protection/);
    expect(preferredRenderer(caps)).toBe('canvas2d');
  });

  it('honours an override even when the other backend is available', () => {
    const caps = detectRenderCapabilities(fakeDocument({ webgl2, '2d': {} }), '?renderer=2d');
    expect(caps.webgl2).toBe(true);
    expect(preferredRenderer(caps)).toBe('canvas2d');
  });

  it('releases the probe context, so it cannot cost the renderer its own', () => {
    let released = false;
    const doc = fakeDocument({
      webgl2: { getExtension: () => ({ loseContext: () => { released = true; } }) },
    });
    detectRenderCapabilities(doc, '');
    expect(released).toBe(true);
  });
});

describe('palette quantization', () => {
  it('maps every palette colour to itself', () => {
    PALETTE.forEach((hex, i) => {
      const [r, g, b] = hexToRgb(hex);
      expect(quantize(r, g, b)).toBe(i);
    });
  });

  it('never returns an index outside the palette, however extreme the input', () => {
    for (const c of [-3, 0, 0.5, 1, 4]) {
      const i = quantize(c, c, c);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(PALETTE.length);
    }
  });

  it('draws lens colours from the same table the shader samples', () => {
    // Nearest sampling on an 8x3 texture: tone picks a whole cell.
    expect(lensRgb(1, 0)).toEqual(lensRgb(1, 0.12));
    expect(lensRgb(1, 0)).not.toEqual(lensRgb(1, 0.99));
    expect(lensRgb(1, 5)).toEqual(lensRgb(1, 1));
    expect(lensRgb(1, -2)).toEqual(lensRgb(1, 0));
  });
});

describe('software rasterizer', () => {
  const raster = () => {
    const r = new Raster();
    r.resize(16, 16);
    return r;
  };

  it('clears to a palette colour', () => {
    const r = raster();
    r.clear(hexToRgb(PALETTE[1]));
    // The vignette darkens the corners, so only the centre is guaranteed exact.
    expect(r.color[8 * 16 + 8]).toBe(1);
    expect(r.depth[8 * 16 + 8]).toBe(0);
  });

  it('fills a triangle and writes its depth', () => {
    const r = raster();
    r.clear(hexToRgb(PALETTE[0]));
    const white = hexToRgb(PALETTE[15]);
    r.fillTri(2, 2, 10, 14, 2, 10, 8, 14, 10, white[0], white[1], white[2]);
    const inside = 6 * 16 + 8;
    expect(r.color[inside]).toBe(15);
    // Reciprocal depth: 1/10 for a vertex ten units in front of the camera.
    expect(r.depth[inside]).toBeCloseTo(0.1, 5);
  });

  it('keeps the nearer surface whichever order it arrives in', () => {
    const near = hexToRgb(PALETTE[15]);
    const far = hexToRgb(PALETTE[8]);
    for (const farFirst of [true, false]) {
      const r = raster();
      r.clear(hexToRgb(PALETTE[0]));
      const drawFar = () => r.fillTri(0, 0, 100, 16, 0, 100, 8, 16, 100, far[0], far[1], far[2]);
      const drawNear = () => r.fillTri(0, 0, 5, 16, 0, 5, 8, 16, 5, near[0], near[1], near[2]);
      if (farFirst) {
        drawFar();
        drawNear();
      } else {
        drawNear();
        drawFar();
      }
      expect(r.color[4 * 16 + 8]).toBe(15);
    }
  });

  it('interpolates depth across a steeply angled triangle', () => {
    // The ground plate is seen almost edge on, spanning a thousand units of
    // depth in a few dozen pixels. Reciprocal depth is the one quantity that is
    // linear in screen space, so a constant step down the rows is exactly the
    // property that stops the near rim losing the depth test to the far one.
    const r = raster();
    r.clear(hexToRgb(PALETTE[0]));
    const c = hexToRgb(PALETTE[8]);
    r.fillTri(0, 0, 1000, 16, 0, 1000, 8, 15, 10, c[0], c[1], c[2]);

    const rows = [1, 4, 7, 10].map((y) => r.depth[y * 16 + 8]);
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeGreaterThan(rows[i - 1]);
    const steps = rows.slice(1).map((v, i) => v - rows[i]);
    for (const step of steps) expect(step).toBeCloseTo(steps[0], 6);
  });

  it('draws a one-pixel leaf as exactly one pixel', () => {
    const r = raster();
    r.clear(hexToRgb(PALETTE[0]));
    const c = hexToRgb(PALETTE[15]);
    r.fillRect(8.5, 8.5, 1, 10, c[0], c[1], c[2]);
    let lit = 0;
    for (let i = 0; i < r.color.length; i++) if (r.color[i] === 15) lit++;
    expect(lit).toBe(1);
  });

  it('clips to the buffer instead of writing outside it', () => {
    const r = raster();
    r.clear(hexToRgb(PALETTE[0]));
    const c = hexToRgb(PALETTE[15]);
    expect(() => {
      r.fillTri(-500, -500, 5, 900, -400, 5, 400, 900, 5, c[0], c[1], c[2]);
      r.fillRect(-40, -40, 6, 5, c[0], c[1], c[2]);
      r.fillRect(9999, 9999, 6, 5, c[0], c[1], c[2]);
    }).not.toThrow();
    expect(r.color.length).toBe(16 * 16);
  });

  it('ignores a degenerate triangle', () => {
    const r = raster();
    r.clear(hexToRgb(PALETTE[0]));
    const c = hexToRgb(PALETTE[15]);
    r.fillTri(4, 4, 5, 4, 4, 5, 4, 4, 5, c[0], c[1], c[2]);
    r.fillTri(0, 8, 5, 8, 8, 5, 16, 8, 5, c[0], c[1], c[2]);
    expect([...r.color].every((v) => v !== 15)).toBe(true);
  });
});
