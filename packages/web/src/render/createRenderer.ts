import { Canvas2DBackend } from './Canvas2DBackend.js';
import { WebGLBackend } from './WebGLBackend.js';
import { detectRenderCapabilities, preferredRenderer, type RenderCapabilities } from './capabilities.js';
import type { RenderBackend, RendererKind } from './backend.js';

/* -------------------------------------------------------------------------- */
/* Choosing a renderer                                                         */
/*                                                                            */
/* In order: an explicit `?renderer=` override, then WebGL if the probe said   */
/* it exists, then the software renderer. Every step down is reported rather   */
/* than silently taken — a viewer running on the CPU should say so, both       */
/* because the reader can often fix it in a browser setting and because a      */
/* bug report that does not say which renderer drew the picture is useless.    */
/* -------------------------------------------------------------------------- */

export type RendererSelection = {
  backend: RenderBackend;
  kind: RendererKind;
  caps: RenderCapabilities;
  /** Set when WebGL was wanted and could not be had. */
  degradedReason: string | null;
};

export function createRenderer(
  canvas: HTMLCanvasElement,
  caps: RenderCapabilities = detectRenderCapabilities(),
): RendererSelection {
  const wanted = preferredRenderer(caps);

  if (wanted === 'webgl') {
    try {
      const backend = new WebGLBackend(canvas);
      return { backend, kind: 'webgl', caps, degradedReason: null };
    } catch (e) {
      // The probe passing and the real context failing is not a contradiction:
      // the page may already hold as many contexts as the browser allows, or
      // the driver may have been blocklisted between the two calls.
      const reason = (e as Error)?.message ?? 'unknown error';
      console.warn('[tree] WebGL was available but would not start, falling back to the 2D renderer:', e);
      return { backend: new Canvas2DBackend(canvas), kind: 'canvas2d', caps, degradedReason: reason };
    }
  }

  const reason = caps.forced === 'canvas2d' ? null : (caps.reason ?? 'WebGL 2 is unavailable');
  if (reason) console.info(`[tree] drawing on the CPU: ${reason}`);
  return { backend: new Canvas2DBackend(canvas), kind: 'canvas2d', caps, degradedReason: reason };
}
