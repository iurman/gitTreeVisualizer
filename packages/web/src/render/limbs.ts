import * as THREE from 'three';
import { LIMB_RING_VERTS } from '@gittree/core';
import { HAZE, LIGHT, MORPH, SNAP } from './shaders.js';

/* -------------------------------------------------------------------------- */
/* Limbs                                                                       */
/*                                                                            */
/* One merged BufferGeometry for every limb in the tree, built once. Not one   */
/* TubeGeometry per limb: that is 500 draw calls before a single leaf is       */
/* drawn. Every limb carries a fixed vertex count regardless of its length or  */
/* commit count, which is what lets limb geometry morph in the vertex shader   */
/* alongside the leaves instead of being regenerated on the CPU.               */
/* -------------------------------------------------------------------------- */

const VERT = /* glsl */ `
${MORPH}
${SNAP}
attribute vec3 aPositionA;
attribute vec3 aPositionB;
attribute vec3 aCenterA;
attribute vec3 aCenterB;
attribute float aDelay;
attribute float aVisibleA;
attribute float aVisibleB;
attribute float aGhost;
attribute float aHeight;
attribute float aDim;

uniform vec2 uResolution;
uniform float uTime;
uniform float uSway;

varying vec3 vNormal;
varying float vGhost;
varying float vHeight;
varying float vDim;
varying float vVisible;
varying float vDepth;

void main() {
  float t = morphT(aDelay);
  vec3 p = mix(aPositionA, aPositionB, t);
  vec3 c = mix(aCenterA, aCenterB, t);
  vVisible = mix(aVisibleA, aVisibleB, t);

  float sway = uSway * (0.15 + aHeight * 1.6);
  p.x += sin(uTime * 0.5 + aHeight * 3.1) * sway;
  p.z += cos(uTime * 0.41 + aHeight * 2.7) * sway;

  // The ring centre travels with the surface, so the normal stays correct
  // through every morph without a CPU normal pass.
  vNormal = normalize(p - c + vec3(0.0, 0.0001, 0.0));
  vGhost = aGhost;
  vHeight = aHeight;
  vDim = aDim;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDepth = -mv.z;
  vec4 clip = snapToGrid(projectionMatrix * mv, uResolution);
  if (vVisible < 0.02) clip = vec4(2.0, 2.0, 2.0, 1.0);
  gl_Position = clip;
}
`;

const FRAG = /* glsl */ `
precision highp float;
${LIGHT}
${HAZE}
varying vec3 vNormal;
varying float vGhost;
varying float vHeight;
varying float vDim;
varying float vVisible;
varying float vDepth;

uniform vec3 uBark;
uniform vec3 uBarkLit;
uniform vec3 uRingColor;
uniform vec3 uDimColor;
uniform sampler2D uRings;
uniform float uGrowth;

void main() {
  float l = lambert(vNormal);
  vec3 col = mix(uBark, uBarkLit, l);

  // Growth rings, sampled from a one-dimensional map of the whole trunk. Major
  // boundaries carry more weight, so there is a readable hierarchy at any
  // granularity and dense minor rings degrade into texture rather than a band.
  float ring = texture2D(uRings, vec2(clamp(vHeight, 0.0, 1.0), 0.5)).r;
  col = mix(col, uRingColor, ring * 0.55 * l);

  // A limb reconstructed from pull request data, or one that never merged back,
  // is drawn ghosted and dashed. Inferred structure never looks like recorded structure.
  if (vGhost > 0.5) {
    float dash = step(0.5, fract(vHeight * 90.0));
    if (dash < 0.5) discard;
    col = mix(col, uRingColor, 0.45);
  }

  // The freshly grown tip is paler, the way new wood is.
  col = mix(col, uBarkLit, smoothstep(uGrowth - 0.03, uGrowth, vHeight) * 0.5);
  col = mix(uDimColor, col, vDim);
  col = haze(col, vDepth);
  gl_FragColor = vec4(col, 1.0);
}
`;

export type LimbAttributeName =
  | 'aPositionA'
  | 'aPositionB'
  | 'aCenterA'
  | 'aCenterB'
  | 'aDelay'
  | 'aVisibleA'
  | 'aVisibleB'
  | 'aGhost'
  | 'aHeight'
  | 'aDim';

export class LimbSystem {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly slots: number;
  readonly segments: number;
  readonly vertsPerLimb: number;

  constructor(slots: number, segments: number, rings: THREE.DataTexture, colors: {
    bark: THREE.Color;
    barkLit: THREE.Color;
    ring: THREE.Color;
    dim: THREE.Color;
  }) {
    this.slots = slots;
    this.segments = segments;
    this.vertsPerLimb = segments * LIMB_RING_VERTS;
    const total = slots * this.vertsPerLimb;

    const geo = new THREE.BufferGeometry();
    const f1 = () => new THREE.BufferAttribute(new Float32Array(total), 1);
    const f3 = () => new THREE.BufferAttribute(new Float32Array(total * 3), 3);

    geo.setAttribute('position', f3()); // unused by the shader, keeps three happy
    geo.setAttribute('aPositionA', f3());
    geo.setAttribute('aPositionB', f3());
    geo.setAttribute('aCenterA', f3());
    geo.setAttribute('aCenterB', f3());
    geo.setAttribute('aDelay', f1());
    geo.setAttribute('aVisibleA', f1());
    geo.setAttribute('aVisibleB', f1());
    geo.setAttribute('aGhost', f1());
    geo.setAttribute('aHeight', f1());
    const dim = f1();
    (dim.array as Float32Array).fill(1);
    geo.setAttribute('aDim', dim);

    // Index buffer: built once, never touched again. Two triangles per pair of
    // adjacent ring vertices, wrapping the ring closed.
    const quadsPerLimb = (segments - 1) * LIMB_RING_VERTS;
    const indices = new Uint32Array(slots * quadsPerLimb * 6);
    let w = 0;
    for (let s = 0; s < slots; s++) {
      const base = s * this.vertsPerLimb;
      for (let j = 0; j < segments - 1; j++) {
        for (let k = 0; k < LIMB_RING_VERTS; k++) {
          const k2 = (k + 1) % LIMB_RING_VERTS;
          const a = base + j * LIMB_RING_VERTS + k;
          const b = base + j * LIMB_RING_VERTS + k2;
          const c = base + (j + 1) * LIMB_RING_VERTS + k;
          const d = base + (j + 1) * LIMB_RING_VERTS + k2;
          indices[w++] = a;
          indices[w++] = c;
          indices[w++] = b;
          indices[w++] = b;
          indices[w++] = c;
          indices[w++] = d;
        }
      }
    }
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 50, 0), 1e6);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uProgress: { value: 1 },
        uToB: { value: 1 },
        uHaze: { value: new THREE.Color('#0A1424') },
        uHazeRange: { value: new THREE.Vector2(120, 620) },
        uResolution: { value: new THREE.Vector2(480, 270) },
        uTime: { value: 0 },
        uSway: { value: 0.12 },
        uGrowth: { value: 1 },
        uBark: { value: colors.bark },
        uBarkLit: { value: colors.barkLit },
        uRingColor: { value: colors.ring },
        uDimColor: { value: colors.dim },
        uRings: { value: rings },
      },
      side: THREE.FrontSide,
      depthWrite: true,
      depthTest: true,
    });

    this.geometry = geo;
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  attr(name: LimbAttributeName): THREE.BufferAttribute {
    return this.geometry.getAttribute(name) as THREE.BufferAttribute;
  }

  write(name: LimbAttributeName, data: Float32Array): void {
    const a = this.attr(name);
    (a.array as Float32Array).set(data.subarray(0, a.array.length));
    a.needsUpdate = true;
  }

  /**
   * Expand the per-limb visibility from layout into per-vertex, and copy the
   * ring centres out of the vertex stream so the shader can rebuild normals.
   */
  writeGeometry(
    which: 'A' | 'B',
    limbVertices: Float32Array,
    limbVisible: Float32Array,
    centers: Float32Array,
  ): void {
    this.write(`aPosition${which}` as LimbAttributeName, limbVertices);
    this.write(`aCenter${which}` as LimbAttributeName, centers);
    const vis = this.attr(`aVisible${which}` as LimbAttributeName).array as Float32Array;
    for (let s = 0; s < this.slots; s++) {
      const v = limbVisible[s] ?? 0;
      vis.fill(v, s * this.vertsPerLimb, (s + 1) * this.vertsPerLimb);
    }
    this.attr(`aVisible${which}` as LimbAttributeName).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Ring centres, derived from the six vertices of each ring. */
export function ringCenters(limbVertices: Float32Array, slots: number, segments: number): Float32Array {
  const out = new Float32Array(slots * segments * LIMB_RING_VERTS * 3);
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
    cx /= LIMB_RING_VERTS;
    cy /= LIMB_RING_VERTS;
    cz /= LIMB_RING_VERTS;
    for (let k = 0; k < LIMB_RING_VERTS; k++) {
      out[base + k * 3] = cx;
      out[base + k * 3 + 1] = cy;
      out[base + k * 3 + 2] = cz;
    }
  }
  return out;
}
