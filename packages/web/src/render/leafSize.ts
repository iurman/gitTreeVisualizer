/* -------------------------------------------------------------------------- */
/* How big a commit is on screen                                               */
/*                                                                            */
/* This used to be a world-space quantum applied as a view-space offset, which */
/* meant a leaf held a fixed size in world units and therefore an unbounded    */
/* one on screen. Flying to a commit grew it into a sixty-pixel diamond, and a */
/* forty-commit repository drew its whole history below one pixel. Both are    */
/* the same bug: nothing tied leaf size to the thing that has to stay legible, */
/* which is the pixel grid.                                                    */
/*                                                                            */
/* So the size is computed in low-resolution pixels, clamped, and snapped to a */
/* whole pixel — the floor is what makes a small repository readable, the      */
/* ceiling is what keeps a close-up from becoming abstract, and the snap is    */
/* what stops a leaf rendering as a half-lit smear. Both backends use these    */
/* numbers; the WebGL one does the arithmetic again in GLSL against the same   */
/* uniforms, and the test asserts the two agree.                              */
/* -------------------------------------------------------------------------- */

/** A leaf never falls below one whole pixel of the render target. */
export const LEAF_MIN_PX = 1;
/** Above this the size stops being literal and starts being compressed. */
export const LEAF_MAX_PX = 6;
/**
 * How far past the ceiling the largest commit in the world may reach, as a
 * fraction of it. A hard clamp would be simpler, and wrong: it makes every leaf
 * in a close-up exactly the same size, which quietly deletes the one thing a
 * leaf is supposed to tell you. A soft knee keeps a bigger commit bigger at
 * every zoom while still bounding the result.
 */
export const LEAF_HEADROOM = 1.5;

/**
 * World units spanned by one vertical pixel of the render target, at `depth`
 * units in front of the camera.
 */
export function worldPerPixel(fovDegrees: number, targetHeightPx: number, depth: number): number {
  const fov = (fovDegrees * Math.PI) / 180;
  return (2 * Math.tan(fov / 2) * Math.max(1e-4, depth)) / Math.max(1, targetHeightPx);
}

/**
 * Compress everything above the ceiling into the headroom above it. Identity
 * below the ceiling, monotonic everywhere, and asymptotic to
 * `LEAF_MAX_PX * (1 + LEAF_HEADROOM)` however large the input.
 */
export function softCeiling(px: number, max = LEAF_MAX_PX, headroom = LEAF_HEADROOM): number {
  const over = Math.max(0, px / max - 1);
  return Math.min(px, max * (1 + over / (1 + over / headroom)));
}

/** Screen size of a leaf, in whole render-target pixels. */
export function leafPixels(worldSize: number, unit: number): number {
  const px = worldSize / Math.max(1e-6, unit);
  return Math.max(LEAF_MIN_PX, Math.round(softCeiling(px)));
}

/** The largest a leaf can ever be, for culling and scratch sizing. */
export const LEAF_CEILING_PX = Math.ceil(LEAF_MAX_PX * (1 + LEAF_HEADROOM));
