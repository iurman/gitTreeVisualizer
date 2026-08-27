/**
 * Stable hashing. Every jitter, angle offset and phyllotaxis rotation in the
 * layout is seeded from one of these, which is what makes a given repo produce
 * a byte-identical tree on every machine and every reload.
 */

/** FNV-1a, 32 bit. Deterministic across engines; no Math.random anywhere in core. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic float in [0,1) from a seed and a salt, without allocating a generator. */
export function hashFloat(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Deterministic float in [lo,hi). */
export function hashRange(seed: number, salt: number, lo: number, hi: number): number {
  return lo + hashFloat(seed, salt) * (hi - lo);
}

/** Small mulberry32 PRNG for the rare place that wants a sequence rather than a lookup. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
