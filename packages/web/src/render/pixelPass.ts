import * as THREE from 'three';
import { PALETTE_LINEAR } from '../palette.js';
import { BASE_HEIGHT, BASE_WIDTH, targetSize } from './resolution.js';

/* -------------------------------------------------------------------------- */
/* The pixel pipeline                                                          */
/*                                                                            */
/* Render into a small target with nearest filtering, then quantize to the     */
/* fixed palette in linear space with an ordered dither. This is not a filter  */
/* on top of a normal render: it does real work. It forces honest aggregation  */
/* at high commit counts instead of pretending five thousand individually      */
/* shaded leaves are legible, and it makes the flat two-dimensional growth     */
/* state the native look rather than a degraded version of the three-          */
/* dimensional one.                                                            */
/* -------------------------------------------------------------------------- */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform vec3 uPalette[${PALETTE_LINEAR.length}];
uniform vec2 uResolution;
uniform float uDither;
uniform float uVignette;

// 4x4 Bayer, evaluated rather than looked up. Ordered dither breaks the
// banding that any fixed palette produces across a gradient, and it is the
// only kind of noise that stays still while the camera moves, which matters
// when the whole point is stable pixels.
//
// Written as arithmetic on purpose. A float[16](...) initializer is GLSL ES
// 3.00 syntax and only compiled here because Three rewrites every
// ShaderMaterial to '#version 300 es' behind our backs - an internal detail of
// one library version, in the one file whose job is to be portable. This form
// is valid under both shading languages and needs no uniform upload.
float m2(float a, float b) {
  return a * 2.0 + b * 3.0 - a * b * 4.0;
}

float bayer4(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  vec2 lo = mod(q, 2.0);
  vec2 hi = floor(q * 0.5);
  return 4.0 * m2(lo.x, lo.y) + m2(hi.x, hi.y);
}

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 src = texture2D(uScene, vUv).rgb;
  vec3 lin = toLinear(src);

  float threshold = (bayer4(vUv * uResolution) / 16.0) - 0.5;
  lin += threshold * uDither;

  // Radial falloff toward the plate edge, applied before quantization so it
  // resolves into palette steps rather than a smooth gradient.
  float r = distance(vUv, vec2(0.5)) * 1.42;
  lin *= 1.0 - uVignette * r * r;

  float bestD = 1e9;
  vec3 best = uPalette[0];
  for (int i = 0; i < ${PALETTE_LINEAR.length}; i++) {
    vec3 c = uPalette[i];
    vec3 d = c - lin;
    float dist = dot(d, d);
    if (dist < bestD) {
      bestD = dist;
      best = c;
    }
  }
  gl_FragColor = vec4(toSrgb(best), 1.0);
}
`;

export class PixelPass {
  readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  width = BASE_WIDTH;
  height = BASE_HEIGHT;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(BASE_WIDTH, BASE_HEIGHT, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    this.target.texture.colorSpace = THREE.SRGBColorSpace;

    const palette: THREE.Vector3[] = PALETTE_LINEAR.map((c) => new THREE.Vector3(c[0], c[1], c[2]));

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uScene: { value: this.target.texture },
        uPalette: { value: palette },
        uResolution: { value: new THREE.Vector2(BASE_WIDTH, BASE_HEIGHT) },
        uDither: { value: 0.035 },
        uVignette: { value: 0.34 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** Aspect-adjusted low-resolution size, shared with the 2D backend. */
  resize(aspect: number, scale = 1): void {
    const [w, h] = targetSize(aspect, scale);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.target.setSize(w, h);
    (this.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
  }

  render(renderer: THREE.WebGLRenderer): void {
    const old = renderer.getRenderTarget();
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(old);
  }

  get resolution(): THREE.Vector2 {
    return this.material.uniforms.uResolution.value as THREE.Vector2;
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
