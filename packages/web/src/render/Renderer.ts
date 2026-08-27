import * as THREE from 'three';
import {
  LIMB_RING_VERTS,
  MAX_LEAVES,
  limbSlotCount,
  type LayoutResult,
  type LensAttributes,
  type RingMark,
  type TreeStructure,
} from '@gittree/core';
import { GROUND, PALETTE, SPECIMEN, hexToRgb } from '../palette.js';
import { LeafSystem } from './leaves.js';
import { LimbSystem, ringCenters } from './limbs.js';
import { PixelPass } from './pixelPass.js';
import { TreeCamera } from './camera.js';

/* -------------------------------------------------------------------------- */
/* The renderer                                                                */
/*                                                                            */
/* It never rebuilds geometry to change a view. Growth, the unfold, sorting,   */
/* filtering and scrubbing are all the same operation: write the target layout */
/* into the idle attribute set and animate one uniform. Geometry is built once */
/* per repository and then only ever interpolated.                             */
/*                                                                            */
/* The A and B attribute sets alternate rather than being copied back, so a    */
/* transition costs one buffer upload and nothing per frame.                   */
/* -------------------------------------------------------------------------- */

const LENS_ROWS = [
  // Decay: specimen shadow running into iron oxide.
  ['#1E2C3A', '#324152', '#4C5A6A', '#A8482E', '#A8482E', '#D9714B', '#D9714B', '#D9714B'],
  // The specimen ramp itself.
  [...SPECIMEN],
  // Categorical: every reagent the process has, spaced for maximum separation.
  ['#2FA98C', '#D6C356', '#D9714B', '#4C82B6', '#5CCBAE', '#A99A3C', '#A8482E', '#38689A'],
];

export type TransitionOptions = {
  duration?: number;
  onDone?: () => void;
};

export class TreeRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cam: TreeCamera;
  readonly pixel = new PixelPass();

  private leaves: LeafSystem | null = null;
  private limbs: LimbSystem | null = null;
  private ground: THREE.Mesh | null = null;
  private palette: THREE.DataTexture;
  private ringTex: THREE.DataTexture;

  private tree: TreeStructure | null = null;
  private slots = 0;
  private segments = 22;
  private leafCount = 0;

  /** Which attribute set currently holds the live layout. */
  private live: 'A' | 'B' = 'A';
  private progress = 1;
  private transitionStart = 0;
  private transitionDuration = 900;
  private transitioning = false;
  private onTransitionDone: (() => void) | null = null;

  private current: LayoutResult | null = null;
  private previous: LayoutResult | null = null;
  /** World positions at the current morph value, for picking. */
  private pickPositions = new Float32Array(0);
  private pickDirty = true;

  private clock = new THREE.Clock();
  private frameTimes: number[] = [];
  reduceMotion = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    // The scene is rendered into a fixed low-resolution target, so the device
    // pixel ratio only affects the final nearest-neighbour blit.
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(new THREE.Color(GROUND[1]), 1);

    this.scene.background = new THREE.Color(GROUND[1]);
    this.cam = new TreeCamera(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.palette = makePaletteTexture();
    this.ringTex = makeRingTexture([]);
  }

  /* ---------------------------------------------------------------------- */
  /* Structure                                                              */
  /* ---------------------------------------------------------------------- */

  /** Called once per repository. Everything after this is attribute writes. */
  setStructure(tree: TreeStructure, segments: number): void {
    this.disposeSystems();
    this.tree = tree;
    this.slots = limbSlotCount(tree);
    this.segments = segments;
    this.leafCount = Math.min(tree.order.length, MAX_LEAVES);

    this.leaves = new LeafSystem(this.leafCount, this.palette, new THREE.Color(GROUND[3]));
    this.limbs = new LimbSystem(this.slots, segments, this.ringTex, {
      bark: new THREE.Color(SPECIMEN[2]),
      barkLit: new THREE.Color(SPECIMEN[6]),
      ring: new THREE.Color(SPECIMEN[7]),
      dim: new THREE.Color(GROUND[3]),
    });
    this.scene.add(this.limbs.mesh, this.leaves.mesh);

    // Delay from limb depth: the tree unfolds trunk-outward rather than at once.
    const maxDepth = Math.max(1, tree.stats.maxDepth);
    const leafDelay = new Float32Array(this.leafCount);
    const leafSeed = new Float32Array(this.leafCount);
    for (let i = 0; i < this.leafCount; i++) {
      const node = tree.nodes.get(tree.order[i])!;
      const depth = tree.limbs[node.limbId]?.depth ?? 0;
      leafDelay[i] = (depth / maxDepth) * 0.34;
      leafSeed[i] = (hashOid(node.oid) % 10007) / 10007;
    }
    this.leaves.write('aDelay', leafDelay);
    this.leaves.write('aSeed', leafSeed);

    const vpl = segments * LIMB_RING_VERTS;
    const limbDelay = new Float32Array(this.slots * vpl);
    const limbGhost = new Float32Array(this.slots * vpl);
    for (let s = 0; s < this.slots; s++) {
      const limb = tree.limbs[s];
      const depth = limb?.depth ?? 0;
      const ghost = limb && (limb.synthesized || !limb.rejoined) ? 1 : 0;
      limbDelay.fill((depth / maxDepth) * 0.34, s * vpl, (s + 1) * vpl);
      limbGhost.fill(ghost, s * vpl, (s + 1) * vpl);
    }
    this.limbs.write('aDelay', limbDelay);
    this.limbs.write('aGhost', limbGhost);

    this.pickPositions = new Float32Array(this.leafCount * 3);
    this.addGround();
    this.live = 'A';
    this.progress = 1;
    this.transitioning = false;
  }

  private addGround(): void {
    if (this.ground) {
      this.scene.remove(this.ground);
      this.ground.geometry.dispose();
      (this.ground.material as THREE.Material).dispose();
    }
    const geo = new THREE.CircleGeometry(520, 48);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vP;
        varying float vDepth;
        uniform vec2 uResolution;
        void main() {
          vP = position.xz;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mv.z;
          vec4 clip = projectionMatrix * mv;
          vec2 grid = uResolution * 0.5;
          clip.xy = floor(clip.xy / clip.w * grid) / grid * clip.w;
          gl_Position = clip;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vP;
        varying float vDepth;
        uniform vec3 uNear;
        uniform vec3 uFar;
        void main() {
          float r = length(vP) / 520.0;
          gl_FragColor = vec4(mix(uNear, uFar, smoothstep(0.0, 0.75, r)), 1.0);
        }`,
      uniforms: {
        uResolution: { value: this.pixel.resolution },
        uNear: { value: new THREE.Color(GROUND[2]) },
        uFar: { value: new THREE.Color(GROUND[1]) },
      },
      depthWrite: true,
    });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.frustumCulled = false;
    this.scene.add(this.ground);
  }

  /* ---------------------------------------------------------------------- */
  /* Transitions                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Write a layout into whichever attribute set is idle and animate across.
   * The layout came from a worker; this is the only place it touches the GPU.
   */
  applyLayout(result: LayoutResult, opts: TransitionOptions = {}): void {
    if (!this.leaves || !this.limbs) return;
    const target: 'A' | 'B' = this.live === 'A' ? 'B' : 'A';

    this.leaves.write(`aPosition${target}` as never, result.leafPositions);
    this.leaves.write(`aScale${target}` as never, result.leafSizes);
    this.leaves.write('aHeight', result.leafHeights);
    this.limbs.writeGeometry(
      target,
      result.limbVertices,
      result.limbVisible,
      ringCenters(result.limbVertices, this.slots, this.segments),
    );

    const limbHeight = new Float32Array(this.slots * this.segments * LIMB_RING_VERTS);
    for (let s = 0; s < this.slots; s++) {
      for (let j = 0; j < this.segments; j++) {
        const y = result.limbVertices[(s * this.segments + j) * LIMB_RING_VERTS * 3 + 1];
        const h = (y - result.bounds.min[1]) / Math.max(1e-3, result.bounds.max[1] - result.bounds.min[1]);
        limbHeight.fill(h, (s * this.segments + j) * LIMB_RING_VERTS, (s * this.segments + j + 1) * LIMB_RING_VERTS);
      }
    }
    this.limbs.write('aHeight', limbHeight);
    this.updateRings(result.rings);

    this.previous = this.current;
    this.current = result;

    const toB = target === 'B' ? 1 : 0;
    this.setUniform('uToB', toB);
    this.transitionDuration = Math.max(1, opts.duration ?? (this.reduceMotion ? 180 : 900));
    this.transitionStart = performance.now();
    this.progress = 0;
    this.transitioning = true;
    this.onTransitionDone = opts.onDone ?? null;
    this.live = target;
    this.pickDirty = true;
  }

  /** Snap straight to a layout with no animation. Used on first paint. */
  setLayoutImmediate(result: LayoutResult): void {
    this.applyLayout(result, { duration: 1 });
    this.progress = 1;
    this.transitioning = false;
    this.setUniform('uProgress', 1);
    this.pickDirty = true;
  }

  private updateRings(rings: RingMark[]): void {
    const w = 512;
    const data = new Uint8Array(w * 4);
    for (const r of rings) {
      const x = Math.round(Math.min(1, Math.max(0, r.t)) * (w - 1));
      const weight = r.major ? 255 : 96;
      for (let d = -1; d <= 1; d++) {
        const i = x + d;
        if (i < 0 || i >= w) continue;
        const v = d === 0 ? weight : Math.round(weight * 0.35);
        if (v > data[i * 4]) data[i * 4] = v;
      }
    }
    this.ringTex.image.data = data;
    this.ringTex.needsUpdate = true;
  }

  setLens(attrs: LensAttributes): void {
    if (!this.leaves) return;
    const n = this.leafCount;
    const family = new Float32Array(n);
    for (let i = 0; i < n; i++) family[i] = attrs.family[i] ?? 1;
    this.leaves.write('aFamily', family);
    this.leaves.write('aTone', attrs.tone);
    this.leaves.write('aEmphasis', attrs.emphasis);
  }

  /** Start the fall for the commits the deletions lens marked net-negative. */
  setFalling(falling: Float32Array, now: number): void {
    if (!this.leaves) return;
    const n = this.leafCount;
    const starts = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Stagger, so a thousand leaves do not release on the same frame.
      starts[i] = falling[i] > 0 ? now + ((i * 37) % 900) / 300 : 0;
    }
    this.leaves.write('aFallStart', starts);
  }

  clearFalling(): void {
    if (!this.leaves) return;
    this.leaves.write('aFallStart', new Float32Array(this.leafCount));
  }

  /** Dim non-matching commits for search. Writes one attribute; moves nothing. */
  setDim(match: Set<string> | null): void {
    if (!this.leaves || !this.tree) return;
    const dim = new Float32Array(this.leafCount);
    if (!match) dim.fill(1);
    else for (let i = 0; i < this.leafCount; i++) dim[i] = match.has(this.tree.order[i]) ? 1 : 0.12;
    this.leaves.write('aDim', dim);
  }

  setGrowth(v: number): void {
    this.setUniform('uGrowth', v);
  }

  private setHazeRange(near: number, far: number): void {
    if (this.leaves) (this.leaves.material.uniforms.uHazeRange.value as THREE.Vector2).set(near, far);
    if (this.limbs) (this.limbs.material.uniforms.uHazeRange.value as THREE.Vector2).set(near, far);
  }

  /** Where fallen leaves come to rest, and where the plate's ground plane sits. */
  setGroundY(y: number): void {
    if (this.leaves) this.leaves.material.uniforms.uGroundY.value = y;
    if (this.ground) this.ground.position.y = y - 0.4;
  }

  setUnfold(morph: number): void {
    this.cam.setUnfold(morph);
  }

  setHighlight(selected: number, hovered: number): void {
    if (!this.leaves) return;
    this.leaves.material.uniforms.uSelected.value = selected;
    this.leaves.material.uniforms.uHovered.value = hovered;
  }

  setReduceMotion(v: boolean): void {
    this.reduceMotion = v;
    this.cam.setReduceMotion(v);
    this.setUniform('uSway', v ? 0 : 0.22, 0.12);
  }

  private setUniform(name: string, leafValue: number, limbValue = leafValue): void {
    if (this.leaves && name in this.leaves.material.uniforms) {
      this.leaves.material.uniforms[name].value = leafValue;
    }
    if (this.limbs && name in this.limbs.material.uniforms) {
      this.limbs.material.uniforms[name].value = limbValue;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Picking                                                                */
  /* ---------------------------------------------------------------------- */

  private refreshPickPositions(): void {
    if (!this.current || !this.tree) return;
    const a = this.previous ?? this.current;
    const b = this.current;
    const n = this.leafCount;
    const p = this.progress;
    const maxDepth = Math.max(1, this.tree.stats.maxDepth);
    for (let i = 0; i < n; i++) {
      const node = this.tree.nodes.get(this.tree.order[i])!;
      const depth = this.tree.limbs[node.limbId]?.depth ?? 0;
      const delay = (depth / maxDepth) * 0.34;
      const s = smoothstep(delay, delay + 0.6, p);
      for (let k = 0; k < 3; k++) {
        const av = a.leafPositions[i * 3 + k];
        const bv = b.leafPositions[i * 3 + k];
        this.pickPositions[i * 3 + k] = av + (bv - av) * s;
      }
    }
    this.pickDirty = false;
  }

  /**
   * Raycast against the leaves analytically. Three's instanced raycasting reads
   * an instance matrix we deliberately never write, and 20,000 point-to-ray
   * distances are cheaper than the matrices would have been anyway.
   */
  pick(ndcX: number, ndcY: number, growth: number): number {
    if (!this.current || !this.tree) return -1;
    if (this.pickDirty) this.refreshPickPositions();

    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.cam.camera);
    const origin = ray.ray.origin;
    const dir = ray.ray.direction;

    let bestIdx = -1;
    let bestT = Infinity;
    const p = new THREE.Vector3();
    for (let i = 0; i < this.leafCount; i++) {
      const size = this.current.leafSizes[i];
      if (size <= 0) continue;
      if (this.current.leafHeights[i] > growth) continue;
      p.set(this.pickPositions[i * 3], this.pickPositions[i * 3 + 1], this.pickPositions[i * 3 + 2]);
      p.sub(origin);
      const t = p.dot(dir);
      if (t <= 0 || t >= bestT) continue;
      const perp = p.addScaledVector(dir, -t).lengthSq();
      const r = size * 1.5;
      if (perp <= r * r) {
        bestT = t;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  worldPositionOf(index: number): THREE.Vector3 | null {
    if (!this.current || index < 0 || index >= this.leafCount) return null;
    if (this.pickDirty) this.refreshPickPositions();
    return new THREE.Vector3(
      this.pickPositions[index * 3],
      this.pickPositions[index * 3 + 1],
      this.pickPositions[index * 3 + 2],
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    const aspect = width / Math.max(1, height);
    this.cam.camera.aspect = aspect;
    this.cam.camera.updateProjectionMatrix();
    this.pixel.resize(aspect);
    const res = this.pixel.resolution;
    this.setResolution(res);
  }

  /** Raise the render resolution while flying, so a zoom resolves detail. */
  setRenderScale(scale: number): void {
    const aspect = this.cam.camera.aspect;
    this.pixel.resize(aspect, scale);
    this.setResolution(this.pixel.resolution);
  }

  private setResolution(res: THREE.Vector2): void {
    if (this.leaves) (this.leaves.material.uniforms.uResolution.value as THREE.Vector2).copy(res);
    if (this.limbs) (this.limbs.material.uniforms.uResolution.value as THREE.Vector2).copy(res);
    if (this.ground) {
      const m = this.ground.material as THREE.ShaderMaterial;
      (m.uniforms.uResolution.value as THREE.Vector2).copy(res);
    }
    // Leaf size is quantized to whole low-resolution pixels; the unit follows
    // the target size so leaves stay the same physical size on screen.
    if (this.leaves) {
      this.leaves.material.uniforms.uPixelUnit.value = Math.max(0.08, 168 / res.y);
    }
  }

  render(now: number): void {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = now / 1000;

    if (this.transitioning) {
      const p = Math.min(1, (now - this.transitionStart) / this.transitionDuration);
      this.progress = p;
      this.pickDirty = true;
      if (p >= 1) {
        this.transitioning = false;
        this.onTransitionDone?.();
        this.onTransitionDone = null;
      }
    }
    this.setUniform('uProgress', this.progress);
    this.setUniform('uTime', t);

    this.cam.update(dt, now);

    // Haze has to be measured against how far away the camera actually is. The
    // flat state pulls back to a few hundred units to fake an orthographic
    // projection, and a fixed range would wash the entire tree out to the
    // background colour at exactly the moment the unfold lands.
    const d = this.cam.camera.position.distanceTo(this.cam.target);
    this.setHazeRange(d * 0.74, d * 1.95);

    this.renderer.setRenderTarget(this.pixel.target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.cam.camera);
    this.renderer.setRenderTarget(null);
    this.pixel.render(this.renderer);

    this.frameTimes.push(dt);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
  }

  get fps(): number {
    if (this.frameTimes.length < 10) return 60;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return avg > 0 ? 1 / avg : 60;
  }

  get transitionActive(): boolean {
    return this.transitioning;
  }

  private disposeSystems(): void {
    if (this.leaves) {
      this.scene.remove(this.leaves.mesh);
      this.leaves.dispose();
      this.leaves = null;
    }
    if (this.limbs) {
      this.scene.remove(this.limbs.mesh);
      this.limbs.dispose();
      this.limbs = null;
    }
  }

  dispose(): void {
    this.disposeSystems();
    if (this.ground) {
      this.scene.remove(this.ground);
      this.ground.geometry.dispose();
      (this.ground.material as THREE.Material).dispose();
      this.ground = null;
    }
    this.pixel.dispose();
    this.palette.dispose();
    this.ringTex.dispose();
    this.renderer.dispose();
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

function hashOid(oid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < oid.length; i++) {
    h ^= oid.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Three rows of eight: decay, specimen, categorical. Sampled by family and tone. */
function makePaletteTexture(): THREE.DataTexture {
  const w = 8;
  const h = 3;
  const data = new Uint8Array(w * h * 4);
  LENS_ROWS.forEach((row, y) => {
    row.forEach((hex, x) => {
      const [r, g, b] = hexToRgb(hex);
      const i = (y * w + x) * 4;
      data[i] = Math.round(r * 255);
      data[i + 1] = Math.round(g * 255);
      data[i + 2] = Math.round(b * 255);
      data[i + 3] = 255;
    });
  });
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeRingTexture(rings: RingMark[]): THREE.DataTexture {
  const w = 512;
  const data = new Uint8Array(w * 4);
  for (const r of rings) {
    const x = Math.round(Math.min(1, Math.max(0, r.t)) * (w - 1));
    data[x * 4] = r.major ? 255 : 96;
  }
  const tex = new THREE.DataTexture(data, w, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export { PALETTE };
