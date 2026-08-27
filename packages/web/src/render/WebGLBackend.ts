import * as THREE from 'three';
import {
  LIMB_RING_VERTS,
  limbSlotCount,
  type LayoutResult,
  type LensAttributes,
  type RingMark,
  type TreeStructure,
} from '@gittree/core';
import { GROUND, SPECIMEN, hexToRgb } from '../palette.js';
import { LeafSystem } from './leaves.js';
import { LimbSystem, ringCenters } from './limbs.js';
import { PixelPass } from './pixelPass.js';
import { TreeCamera } from './camera.js';
import { MorphState } from './morph.js';
import { LENS_ROWS } from './lensPalette.js';
import { LEAF_HEADROOM, LEAF_MAX_PX, LEAF_MIN_PX } from './leafSize.js';
import type { BackendEvent, RenderBackend, RendererKind, TransitionOptions } from './backend.js';

/* -------------------------------------------------------------------------- */
/* The GPU renderer                                                            */
/*                                                                            */
/* It never rebuilds geometry to change a view. Growth, the unfold, sorting,   */
/* filtering and scrubbing are all the same operation: write the target layout */
/* into the idle attribute set and animate one uniform. Geometry is built once */
/* per repository and then only ever interpolated.                            */
/*                                                                            */
/* The A and B attribute sets alternate rather than being copied back, so a    */
/* transition costs one buffer upload and nothing per frame.                  */
/*                                                                            */
/* Three's WebGLRenderer has been WebGL2-only since r163, so this class is a   */
/* WebGL2 renderer whether or not it says so. Everything it cannot serve goes  */
/* to Canvas2DBackend instead; see createRenderer.ts for how that is decided.  */
/* -------------------------------------------------------------------------- */

/** How long a lost context is given to come back before we give up on the GPU. */
const RESTORE_GRACE_MS = 6000;

export class WebGLBackend implements RenderBackend {
  readonly kind: RendererKind = 'webgl';
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cam: TreeCamera;
  readonly pixel = new PixelPass();

  private leaves: LeafSystem | null = null;
  private limbs: LimbSystem | null = null;
  private ground: THREE.Mesh | null = null;
  private palette: THREE.DataTexture;
  private ringTex: THREE.DataTexture;

  private morph = new MorphState();
  private tree: TreeStructure | null = null;
  private slots = 0;
  private segments = 22;

  /** Which attribute set currently holds the live layout. */
  private live: 'A' | 'B' = 'A';
  private transitionStart = 0;
  private transitionDuration = 900;
  private transitioning = false;
  private onTransitionDone: (() => void) | null = null;

  private lastFrame = 0;
  private frameTimes: number[] = [];
  reduceMotion = false;

  private handlers = new Set<(e: BackendEvent) => void>();
  private contextLost = false;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = createGLRenderer(canvas);
    // The scene is rendered into a fixed low-resolution target, so the device
    // pixel ratio only affects the final nearest-neighbour blit.
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(new THREE.Color(GROUND[1]), 1);

    this.scene.background = new THREE.Color(GROUND[1]);
    this.cam = new TreeCamera(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.palette = makePaletteTexture();
    this.ringTex = makeRingTexture();

    canvas.addEventListener('webglcontextlost', this.handleLost, false);
    canvas.addEventListener('webglcontextrestored', this.handleRestored, false);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement as HTMLCanvasElement;
  }

  onEvent(handler: (e: BackendEvent) => void): void {
    this.handlers.add(handler);
  }

  private emit(e: BackendEvent): void {
    for (const h of this.handlers) h(e);
  }

  /* ---------------------------------------------------------------------- */
  /* Context loss                                                           */
  /*                                                                        */
  /* Not an edge case. Mobile Safari and Chrome both drop contexts under     */
  /* memory pressure, a driver reset takes one out on the desktop, and a GPU */
  /* process crash takes out every context on the page. Three restores its   */
  /* own GL state; what it cannot know is that our geometry came from a      */
  /* worker, so the viewer is asked to write it again. If the context never  */
  /* comes back, the 2D renderer takes over rather than leaving a frozen     */
  /* canvas that looks like a hang.                                          */
  /* ---------------------------------------------------------------------- */

  private handleLost = (event: Event): void => {
    // Three registers its own listener and already prevents the default. Doing
    // it again is harmless and does not depend on listener ordering.
    event.preventDefault();
    this.contextLost = true;
    this.emit({ type: 'contextLost' });
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(() => {
      if (this.contextLost && !this.disposed) {
        this.emit({ type: 'fatal', reason: 'the WebGL context was lost and did not come back' });
      }
    }, RESTORE_GRACE_MS);
  };

  private handleRestored = (): void => {
    this.contextLost = false;
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.restoreTimer = null;

    // Three rebuilds every GPU-side cache on restore — buffers, textures,
    // programs, render targets — and re-uploads each from the JavaScript array
    // that owns it on the next frame. So the geometry does not need rebuilding
    // and must not be: disposing it here would ask the new context to delete
    // handles from the old one. What does *not* survive are the settings held
    // on the renderer rather than in a resource, which is this much:
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(new THREE.Color(GROUND[1]), 1);
    this.palette.needsUpdate = true;
    this.ringTex.needsUpdate = true;
    this.emit({ type: 'contextRestored' });
  };

  get lost(): boolean {
    return this.contextLost;
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
    this.morph.setStructure(tree);
    const leafCount = this.morph.leafCount;

    this.leaves = new LeafSystem(leafCount, this.palette, new THREE.Color(GROUND[3]));
    this.limbs = new LimbSystem(this.slots, segments, this.ringTex, {
      bark: new THREE.Color(SPECIMEN[2]),
      barkLit: new THREE.Color(SPECIMEN[6]),
      ring: new THREE.Color(SPECIMEN[7]),
      dim: new THREE.Color(GROUND[3]),
    });
    this.scene.add(this.limbs.mesh, this.leaves.mesh);

    // Delay from limb depth: the tree unfolds trunk-outward rather than at once.
    this.leaves.write('aDelay', this.morph.leafDelay);
    this.leaves.write('aSeed', this.morph.leafSeed);

    const vpl = segments * LIMB_RING_VERTS;
    const limbDelay = new Float32Array(this.slots * vpl);
    const limbGhost = new Float32Array(this.slots * vpl);
    for (let s = 0; s < this.slots; s++) {
      const limb = tree.limbs[s];
      const ghost = limb && (limb.synthesized || !limb.rejoined) ? 1 : 0;
      limbDelay.fill(this.morph.limbDelay(s), s * vpl, (s + 1) * vpl);
      limbGhost.fill(ghost, s * vpl, (s + 1) * vpl);
    }
    this.limbs.write('aDelay', limbDelay);
    this.limbs.write('aGhost', limbGhost);

    this.addGround();
    this.live = 'A';
    this.transitioning = false;
    this.setResolution(this.pixel.resolution);
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
    const span = Math.max(1e-3, result.bounds.max[1] - result.bounds.min[1]);
    for (let s = 0; s < this.slots; s++) {
      for (let j = 0; j < this.segments; j++) {
        const y = result.limbVertices[(s * this.segments + j) * LIMB_RING_VERTS * 3 + 1];
        const h = (y - result.bounds.min[1]) / span;
        limbHeight.fill(h, (s * this.segments + j) * LIMB_RING_VERTS, (s * this.segments + j + 1) * LIMB_RING_VERTS);
      }
    }
    this.limbs.write('aHeight', limbHeight);
    this.updateRings(result.rings);

    this.morph.push(result);

    this.setUniform('uToB', target === 'B' ? 1 : 0);
    this.transitionDuration = Math.max(1, opts.duration ?? (this.reduceMotion ? 180 : 900));
    this.transitionStart = performance.now();
    this.transitioning = true;
    this.onTransitionDone = opts.onDone ?? null;
    this.live = target;
  }

  /** Snap straight to a layout with no animation. Used on first paint. */
  setLayoutImmediate(result: LayoutResult): void {
    this.applyLayout(result, { duration: 1 });
    this.morph.setProgress(1);
    this.transitioning = false;
    this.setUniform('uProgress', 1);
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
    const n = this.morph.leafCount;
    const family = new Float32Array(n);
    for (let i = 0; i < n; i++) family[i] = attrs.family[i] ?? 1;
    this.leaves.write('aFamily', family);
    this.leaves.write('aTone', attrs.tone);
    this.leaves.write('aEmphasis', attrs.emphasis);
  }

  /** Start the fall for the commits the deletions lens marked net-negative. */
  setFalling(falling: Float32Array, now: number): void {
    if (!this.leaves) return;
    const n = this.morph.leafCount;
    const starts = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Stagger, so a thousand leaves do not release on the same frame.
      starts[i] = falling[i] > 0 ? now + ((i * 37) % 900) / 300 : 0;
    }
    this.leaves.write('aFallStart', starts);
  }

  clearFalling(): void {
    if (!this.leaves) return;
    this.leaves.write('aFallStart', new Float32Array(this.morph.leafCount));
  }

  /** Dim non-matching commits for search. Writes one attribute; moves nothing. */
  setDim(match: Set<string> | null): void {
    if (!this.leaves || !this.tree) return;
    const n = this.morph.leafCount;
    const dim = new Float32Array(n);
    if (!match) dim.fill(1);
    else for (let i = 0; i < n; i++) dim[i] = match.has(this.tree.order[i]) ? 1 : 0.12;
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

  pick(ndcX: number, ndcY: number, growth: number): number {
    return this.morph.pick(this.cam, ndcX, ndcY, growth);
  }

  worldPositionOf(index: number): THREE.Vector3 | null {
    return this.morph.worldPositionOf(index);
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
    this.setResolution(this.pixel.resolution);
  }

  /** Raise the render resolution while flying, so a zoom resolves detail. */
  setRenderScale(scale: number): void {
    this.pixel.resize(this.cam.camera.aspect, scale);
    this.setResolution(this.pixel.resolution);
  }

  private setResolution(res: THREE.Vector2): void {
    if (this.leaves) (this.leaves.material.uniforms.uResolution.value as THREE.Vector2).copy(res);
    if (this.limbs) (this.limbs.material.uniforms.uResolution.value as THREE.Vector2).copy(res);
    if (this.ground) {
      const m = this.ground.material as THREE.ShaderMaterial;
      (m.uniforms.uResolution.value as THREE.Vector2).copy(res);
    }
    if (this.leaves) {
      (this.leaves.material.uniforms.uLeafRange.value as THREE.Vector3).set(LEAF_MIN_PX, LEAF_MAX_PX, LEAF_HEADROOM);
      this.updatePixelScale();
    }
  }

  /**
   * World units per render-target pixel, at one unit of depth. The leaf shader
   * multiplies this by a leaf's own depth to size it in whole screen pixels
   * rather than whole world units. It has to be refreshed every frame because
   * the field of view is what the unfold animates.
   */
  private updatePixelScale(): void {
    if (!this.leaves) return;
    const fov = (this.cam.camera.fov * Math.PI) / 180;
    const h = Math.max(1, this.pixel.resolution.y);
    this.leaves.material.uniforms.uPixelScale.value = (2 * Math.tan(fov / 2)) / h;
  }

  render(now: number): void {
    if (this.contextLost) return;
    const dt = this.lastFrame ? Math.min(0.05, (now - this.lastFrame) / 1000) : 0.016;
    this.lastFrame = now;
    const t = now / 1000;

    if (this.transitioning) {
      const p = Math.min(1, (now - this.transitionStart) / this.transitionDuration);
      this.morph.setProgress(p);
      if (p >= 1) {
        this.transitioning = false;
        this.onTransitionDone?.();
        this.onTransitionDone = null;
      }
    }
    this.setUniform('uProgress', this.morph.progress);
    this.setUniform('uTime', t);

    this.cam.update(dt, now);
    this.updatePixelScale();

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
    this.disposed = true;
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    const canvas = this.canvas;
    canvas.removeEventListener('webglcontextlost', this.handleLost);
    canvas.removeEventListener('webglcontextrestored', this.handleRestored);
    this.handlers.clear();
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
    // Deliberately *not* forceContextLoss(). The canvas element outlives this
    // object — React remounts it in development, and a repository change keeps
    // it — and a canvas whose context has been force-lost will never grant
    // another one of any kind, which turns a remount into a blank page. The
    // context goes when the element does, and the element is only ever
    // discarded when we are swapping renderers, which replaces it outright.
  }
}

/**
 * Ask for a context, and keep asking with less. `high-performance` is a hint
 * some drivers treat as a requirement — a machine with a discrete GPU asleep
 * can refuse it and then happily grant the default. Failing over costs one
 * synchronous call and is the difference between the tree drawing and not.
 */
function createGLRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const attempts: THREE.WebGLRendererParameters[] = [
    { canvas, antialias: false, alpha: false, powerPreference: 'high-performance' },
    { canvas, antialias: false, alpha: false, powerPreference: 'default' },
    { canvas },
  ];
  let last: unknown;
  for (const params of attempts) {
    try {
      return new THREE.WebGLRenderer(params);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('WebGL context creation failed');
}

/** Three rows of eight: decay, specimen, categorical. Sampled by family and tone. */
function makePaletteTexture(): THREE.DataTexture {
  const w = 8;
  const h = LENS_ROWS.length;
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

function makeRingTexture(): THREE.DataTexture {
  const w = 512;
  const tex = new THREE.DataTexture(new Uint8Array(w * 4), w, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
