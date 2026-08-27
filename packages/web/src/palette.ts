/* -------------------------------------------------------------------------- */
/* Palette: cyanotype specimen plate                                           */
/*                                                                            */
/* Twenty-four colours in three tonal families. The render target quantizes to */
/* exactly these, so this file is the entire colour vocabulary of the product; */
/* a colour that is not here cannot appear on the canvas.                      */
/*                                                                            */
/* Ground: the plate. Prussian blues, from the deepest wash to the point where */
/* light has almost bleached the paper. Atmosphere, ground plane, UI chrome.   */
/*                                                                            */
/* Specimen: the tree. A ramp from blue-shadowed to bone, because a pressed    */
/* specimen on a cyanotype is the part the light never reached — it comes out  */
/* pale against the blue, and its shadows borrow the plate's colour.           */
/*                                                                            */
/* Reaction: what the chemistry does when something happens. Verdigris,        */
/* sulfur, iron oxide, ferric blue, iron-violet. This is the family the lenses */
/* recolour within, and it exists because the process itself has more than one */
/* reagent — not because a palette needs an accent.                            */
/*                                                                            */
/* The reasoning, and what changed during self-critique, is in DESIGN.md.      */
/* -------------------------------------------------------------------------- */

export const GROUND = [
  '#050912',
  '#0A1424',
  '#102138',
  '#17304E',
  '#1F4166',
  '#2A5480',
  '#38689A',
  '#4C82B6',
] as const;

export const SPECIMEN = [
  '#1E2C3A',
  '#324152',
  '#4C5A6A',
  '#6C7681',
  '#8D9490',
  '#B0AFA0',
  '#D3CCB6',
  '#F3EFDE',
] as const;

export const REACTION = [
  '#1E7F6A',
  '#2FA98C',
  '#5CCBAE',
  '#A99A3C',
  '#D6C356',
  '#EFE08A',
  '#A8482E',
  '#D9714B',
] as const;

/** The quantization target. Order matters only for the shader's uniform array. */
export const PALETTE: string[] = [...GROUND, ...SPECIMEN, ...REACTION];

export const FAMILY_RANGES: Record<number, [number, number]> = {
  0: [16, 24], // reaction, used for decay and net-negative work
  1: [8, 16], // specimen, the tree itself
  2: [16, 24], // reaction, used for categorical hues
};

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** sRGB to linear. Quantization has to happen in linear space or the ramps band. */
export function toLinear([r, g, b]: RGB): RGB {
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [f(r), f(g), f(b)];
}

export const PALETTE_LINEAR: RGB[] = PALETTE.map((h) => toLinear(hexToRgb(h)));

/** Flat Float32Array of the linear palette, for the post shader uniform. */
export function paletteUniform(): Float32Array {
  const out = new Float32Array(PALETTE_LINEAR.length * 3);
  PALETTE_LINEAR.forEach((c, i) => {
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  });
  return out;
}

/**
 * Map a lens family plus a 0..1 tone onto a colour. Lenses recolour inside one
 * family, so a lens can never break the cohesion of the plate.
 */
export function lensColor(family: number, tone: number): RGB {
  const [lo, hi] = FAMILY_RANGES[family] ?? FAMILY_RANGES[1];
  const span = hi - lo;
  const idx = lo + Math.min(span - 1, Math.max(0, Math.floor(tone * span)));
  return hexToRgb(PALETTE[idx]);
}

export const CANVAS_BG = GROUND[1];
export const INK = SPECIMEN[7];
