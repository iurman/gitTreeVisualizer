import * as THREE from 'three';
import { HAZE, MORPH, PALETTE_LOOKUP, SNAP } from './shaders.js';
import { LEAF_HEADROOM, LEAF_MAX_PX, LEAF_MIN_PX } from './leafSize.js';

/* -------------------------------------------------------------------------- */
/* Leaves                                                                      */
/*                                                                            */
/* One instanced quad per commit, capped at MAX_LEAVES. Every view change is   */
/* an interpolation between the A and B attribute sets; nothing here is ever   */
/* rebuilt to change a view. Growth is gated per-instance against the leaf's   */
/* own normalized time, so a leaf appears at exactly its moment rather than at */
/* the next worker keyframe — which is what keeps it locked to its sound.      */
/* -------------------------------------------------------------------------- */

const VERT = /* glsl */ `
${MORPH}
${SNAP}
attribute vec3 aPositionA;
attribute vec3 aPositionB;
attribute float aScaleA;
attribute float aScaleB;
attribute float aHeight;
attribute float aIndex;
attribute float aDelay;
attribute float aSeed;
attribute float aTone;
attribute float aFamily;
attribute float aEmphasis;
attribute float aFallStart;
attribute float aDim;

uniform float uTime;
uniform float uGrowth;
uniform vec2 uResolution;
uniform float uGravity;
uniform float uGroundY;
uniform float uSway;
uniform float uPixelScale;
uniform vec3 uLeafRange;
uniform float uSelected;
uniform float uHovered;

varying float vTone;
varying float vFamily;
varying float vEmphasis;
varying float vDim;
varying float vShade;
varying vec2 vCorner;
varying float vMark;
varying float vDepth;

void main() {
  float t = morphT(aDelay);
  vec3 p = mix(aPositionA, aPositionB, t);
  float size = mix(aScaleA, aScaleB, t);

  // The growth gate. A short ramp plus a small overshoot, so a commit reads as
  // opening rather than switching on.
  float lead = uGrowth - aHeight;
  float appear = smoothstep(0.0, 0.006, lead);
  float pop = 1.0 + 0.55 * exp(-90.0 * max(lead, 0.0));
  float s = size * appear * pop;

  // Ambient sway. Disabled entirely under prefers-reduced-motion by zeroing uSway.
  float phase = aSeed * 6.2831853;
  p.x += sin(uTime * 0.6 + phase) * uSway * (0.4 + aHeight);
  p.z += cos(uTime * 0.47 + phase) * uSway * (0.4 + aHeight);

  // Falling leaves. No physics engine: a per-instance start time and a parabola.
  float age = uTime - aFallStart;
  if (aFallStart > 0.0 && age > 0.0) {
    float fall = 0.5 * uGravity * age * age;
    p.y = max(uGroundY, p.y - fall);
    p.x += sin(age * 2.0 + phase) * 0.35 * min(age, 2.0);
    p.z += cos(age * 1.7 + phase) * 0.35 * min(age, 2.0);
    s *= 0.85;
  }

  vTone = aTone;
  vFamily = aFamily;
  vEmphasis = aEmphasis;
  vDim = aDim;
  vCorner = position.xy;
  vMark = max(uSelected == aIndex ? 1.0 : 0.0, uHovered == aIndex ? 0.6 : 0.0);
  vShade = 0.72 + 0.28 * sin(phase);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDepth = -mv.z;

  // Billboard, sized in whole render-target pixels rather than whole world
  // units. uPixelScale is how many world units one pixel spans at unit depth,
  // so multiplying by this leaf's own depth gives the size of a pixel where the
  // leaf actually is. Clamping that ratio is what stops a forty-commit
  // repository drawing below one pixel and a fly-to filling the frame with one
  // diamond; snapping it is what stops a leaf rendering as a half-lit smear.
  float unit = max(1e-5, vDepth * uPixelScale);
  float raw = (s * (1.0 + vMark * 0.4)) / unit;
  // Identity below the ceiling, compressed into the headroom above it, so a
  // bigger commit still reads as bigger in a close-up instead of every leaf
  // saturating at the same size. This is leafPixels() in leafSize.ts, and the
  // test asserts the two agree.
  float over = max(0.0, raw / uLeafRange.y - 1.0);
  float soft = uLeafRange.y * (1.0 + over / (1.0 + over / uLeafRange.z));
  float sizePx = max(uLeafRange.x, floor(min(raw, soft) + 0.5)) * unit;
  mv.xy += position.xy * sizePx;

  gl_Position = snapToGrid(projectionMatrix * mv, uResolution);
  if (s <= 0.0001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
${PALETTE_LOOKUP}
${HAZE}
varying float vTone;
varying float vFamily;
varying float vEmphasis;
varying float vDim;
varying float vShade;
varying vec2 vCorner;
varying float vMark;
varying float vDepth;
uniform vec3 uDimColor;

void main() {
  // A rhombic leaf. Cheap, and it reads as a leaf at four pixels across.
  float d = abs(vCorner.x) + abs(vCorner.y);
  if (d > 0.5) discard;

  vec3 col = paletteColor(vFamily, vTone);
  col *= vShade + vEmphasis * 0.25;
  // Lit edge on the upper left, shadowed on the lower right.
  col *= 1.0 + 0.35 * clamp(-vCorner.x + vCorner.y, -1.0, 1.0);
  col = mix(uDimColor, col, vDim);
  col = mix(col, vec3(1.0, 0.98, 0.92), vMark * 0.55);
  col = haze(col, vDepth);
  gl_FragColor = vec4(col, 1.0);
}
`;

export type LeafAttributeName =
  | 'aPositionA'
  | 'aPositionB'
  | 'aScaleA'
  | 'aScaleB'
  | 'aHeight'
  | 'aIndex'
  | 'aDelay'
  | 'aSeed'
  | 'aTone'
  | 'aFamily'
  | 'aEmphasis'
  | 'aFallStart'
  | 'aDim';

export class LeafSystem {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly count: number;

  constructor(count: number, palette: THREE.DataTexture, dimColor: THREE.Color) {
    this.count = count;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.instanceCount = count;

    const f1 = () => new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    const f3 = () => new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    geo.setAttribute('aPositionA', f3());
    geo.setAttribute('aPositionB', f3());
    geo.setAttribute('aScaleA', f1());
    geo.setAttribute('aScaleB', f1());
    geo.setAttribute('aHeight', f1());
    const index = f1();
    for (let i = 0; i < count; i++) (index.array as Float32Array)[i] = i;
    geo.setAttribute('aIndex', index);
    geo.setAttribute('aDelay', f1());
    geo.setAttribute('aSeed', f1());
    geo.setAttribute('aTone', f1());
    geo.setAttribute('aFamily', f1());
    geo.setAttribute('aEmphasis', f1());
    geo.setAttribute('aFallStart', f1());
    const dim = f1();
    dim.array.fill(1);
    geo.setAttribute('aDim', dim);

    // The tree is always in view; a bounding sphere would only cost us a
    // per-frame recompute as positions morph.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 50, 0), 1e6);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uProgress: { value: 1 },
        uToB: { value: 1 },
        uTime: { value: 0 },
        uGrowth: { value: 1 },
        uHaze: { value: new THREE.Color('#0A1424') },
        uHazeRange: { value: new THREE.Vector2(120, 620) },
        uResolution: { value: new THREE.Vector2(480, 270) },
        uGravity: { value: 9.4 },
        uGroundY: { value: 0 },
        uSway: { value: 0.22 },
        uPixelScale: { value: 0.004 },
        uLeafRange: { value: new THREE.Vector3(LEAF_MIN_PX, LEAF_MAX_PX, LEAF_HEADROOM) },
        uPalette: { value: palette },
        uDimColor: { value: dimColor },
        uSelected: { value: -1 },
        uHovered: { value: -1 },
      },
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.geometry = geo;
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    quad.dispose();
  }

  attr(name: LeafAttributeName): THREE.InstancedBufferAttribute {
    return this.geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
  }

  write(name: LeafAttributeName, data: Float32Array): void {
    const a = this.attr(name);
    (a.array as Float32Array).set(data.subarray(0, a.array.length));
    a.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
