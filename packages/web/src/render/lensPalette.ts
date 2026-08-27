import { SPECIMEN, hexToRgb, type RGB } from '../palette.js';

/* Three rows of eight: decay, specimen, categorical. The WebGL backend uploads
 * this as an 8x3 nearest-filtered texture and samples it in the fragment
 * shader; the 2D backend indexes the same table directly. One definition, so a
 * lens cannot look like two different things depending on the renderer. */
export const LENS_ROWS: readonly (readonly string[])[] = [
  // Decay: specimen shadow running into iron oxide.
  ['#1E2C3A', '#324152', '#4C5A6A', '#A8482E', '#A8482E', '#D9714B', '#D9714B', '#D9714B'],
  // The specimen ramp itself.
  [...SPECIMEN],
  // Categorical: every reagent the process has, spaced for maximum separation.
  ['#2FA98C', '#D6C356', '#D9714B', '#4C82B6', '#5CCBAE', '#A99A3C', '#A8482E', '#38689A'],
];

const LENS_RGB: RGB[][] = LENS_ROWS.map((row) => row.map((hex) => hexToRgb(hex)));

/** The exact colour `paletteColor(family, tone)` returns in the fragment shader. */
export function lensRgb(family: number, tone: number): RGB {
  const row = LENS_RGB[Math.max(0, Math.min(LENS_RGB.length - 1, Math.round(family)))] ?? LENS_RGB[1];
  const i = Math.max(0, Math.min(row.length - 1, Math.floor(Math.min(0.999, Math.max(0, tone)) * row.length)));
  return row[i];
}
