import type * as THREE from 'three';
import type { LayoutResult, LensAttributes, TreeStructure } from '@gittree/core';
import type { TreeCamera } from './camera.js';

/* -------------------------------------------------------------------------- */
/* The renderer contract                                                       */
/*                                                                            */
/* Everything above this line — the viewer, the interface, the sound engine —  */
/* knows only that it has something satisfying RenderBackend. Below it there   */
/* are two implementations that draw the same tree by very different means:    */
/*                                                                            */
/*   WebGLBackend   Three.js on WebGL2. The whole tree in two draw calls, all  */
/*                  morphing done on the GPU. This is the path essentially     */
/*                  every current browser takes.                              */
/*                                                                            */
/*   Canvas2DBackend  A software rasterizer on a 2D context, using Three's     */
/*                  own matrix maths for projection. Slower, and it drops the  */
/*                  ambient sway, but it needs nothing beyond a canvas, so it  */
/*                  covers browsers with WebGL disabled, blocklisted drivers,  */
/*                  fingerprinting shields, and anything older than WebGL2.   */
/*                                                                            */
/* Both draw into the same low-resolution grid and quantize to the same        */
/* twenty-four colours, so the fallback is a slightly quieter version of the   */
/* same picture rather than a different product.                              */
/* -------------------------------------------------------------------------- */

export type RendererKind = 'webgl' | 'canvas2d';

export type TransitionOptions = {
  duration?: number;
  onDone?: () => void;
};

/** Why a backend gave up, so the viewer can escalate to the next one down. */
export type BackendEvent =
  | { type: 'contextLost' }
  | { type: 'contextRestored' }
  | { type: 'fatal'; reason: string };

export interface RenderBackend {
  /** Which implementation this is. Surfaced in the interface and in diagnostics. */
  readonly kind: RendererKind;
  /** The canvas being drawn into. The viewer measures framing from it. */
  readonly canvas: HTMLCanvasElement;
  /** Shared orbit/flight state. Pure maths, identical in both backends. */
  readonly cam: TreeCamera;
  readonly fps: number;
  readonly transitionActive: boolean;
  reduceMotion: boolean;

  /** Called once per repository; everything after is buffer writes. */
  setStructure(tree: TreeStructure, segments: number): void;
  /** Write a layout into the idle buffer set and animate across to it. */
  applyLayout(result: LayoutResult, opts?: TransitionOptions): void;
  /** Snap straight to a layout with no animation. */
  setLayoutImmediate(result: LayoutResult): void;

  setLens(attrs: LensAttributes): void;
  setFalling(falling: Float32Array, now: number): void;
  clearFalling(): void;
  setDim(match: Set<string> | null): void;
  setGrowth(v: number): void;
  setGroundY(y: number): void;
  setUnfold(morph: number): void;
  setHighlight(selected: number, hovered: number): void;
  setReduceMotion(v: boolean): void;
  setRenderScale(scale: number): void;

  resize(width: number, height: number): void;
  render(now: number): void;

  /** Index into TreeStructure.order, or -1. Analytic, never a GPU readback. */
  pick(ndcX: number, ndcY: number, growth: number): number;
  worldPositionOf(index: number): THREE.Vector3 | null;

  /** Told about context loss, restore, and unrecoverable failure. */
  onEvent(handler: (e: BackendEvent) => void): void;

  dispose(): void;
}
