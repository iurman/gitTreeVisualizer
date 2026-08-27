/* Shared GLSL. Two techniques here do the heavy lifting for the whole look. */

/**
 * Grid snapping. Without it, orbiting makes every edge crawl at sub-pixel
 * scale and the result reads as a broken video stream rather than pixel art.
 * Snapping clip-space XY to the low-resolution grid before the perspective
 * divide is the single thing that separates convincing pixel art from a
 * blurry downscale.
 */
export const SNAP = /* glsl */ `
vec4 snapToGrid(vec4 clip, vec2 res) {
  vec2 grid = res * 0.5;
  clip.xy = floor(clip.xy / clip.w * grid) / grid * clip.w;
  return clip;
}
`;

/**
 * The morph. Every view change is an interpolation between two position
 * buffers, delayed by node depth so the tree unfolds trunk-outward instead of
 * all at once.
 */
export const MORPH = /* glsl */ `
uniform float uProgress;
uniform float uToB;
float morphT(float delay) {
  float s = smoothstep(delay, delay + 0.6, uProgress);
  return mix(1.0 - s, s, uToB);
}
`;

/**
 * Depth haze in the ground family. Applied before quantization so it resolves
 * into palette steps and reads as the wash on a plate rather than as fog.
 */
export const HAZE = /* glsl */ `
uniform vec3 uHaze;
uniform vec2 uHazeRange;
vec3 haze(vec3 col, float depth) {
  return mix(col, uHaze, smoothstep(uHazeRange.x, uHazeRange.y, depth));
}
`;

export const PALETTE_LOOKUP = /* glsl */ `
uniform sampler2D uPalette;
vec3 paletteColor(float family, float tone) {
  return texture2D(uPalette, vec2(clamp(tone, 0.0, 0.999), (family + 0.5) / 3.0)).rgb;
}
`;

/** A fixed key light, low and to the left, the way a specimen plate is lit. */
export const LIGHT = /* glsl */ `
const vec3 KEY = normalize(vec3(-0.55, 0.72, 0.42));
float lambert(vec3 n) {
  return 0.42 + 0.58 * max(dot(normalize(n), KEY), 0.0);
}
`;
