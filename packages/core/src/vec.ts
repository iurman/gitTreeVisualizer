export type Vec3 = [number, number, number];

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Interpolate two angles the short way round, so the unfold never spins the long way. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** An orthonormal basis around `dir`, stable enough for limb ring extrusion. */
export function frame(dir: Vec3): { t: Vec3; n: Vec3; b: Vec3 } {
  const t = normalize(dir);
  const up: Vec3 = Math.abs(t[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const n = normalize(cross(up, t));
  const b = normalize(cross(t, n));
  return { t, n, b };
}
