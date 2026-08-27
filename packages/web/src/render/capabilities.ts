import type { RendererKind } from './backend.js';

/* -------------------------------------------------------------------------- */
/* What this browser can actually do                                           */
/*                                                                            */
/* Feature detection only. No user-agent parsing: the browsers that matter for */
/* this question are precisely the ones that lie about who they are, or that   */
/* have WebGL turned off behind a shield while reporting a stock Chrome build. */
/* Asking for a context and seeing what comes back is the only honest test.    */
/*                                                                            */
/* Three's WebGLRenderer has been WebGL2-only since r163, so WebGL2 — not      */
/* WebGL1 — is the line. That line is Chrome 56, Edge 79, Firefox 51 and       */
/* Safari 15, which is why the fallback below has to be a real renderer and    */
/* not an apology: what is left over is not old browsers, it is current ones   */
/* with acceleration unavailable or disabled.                                  */
/* -------------------------------------------------------------------------- */

export type RenderCapabilities = {
  /** A WebGL2 context was successfully created and released. */
  webgl2: boolean;
  /** A 2D context was successfully created. False only in exotic lockdowns. */
  canvas2d: boolean;
  /** Human-readable reason WebGL2 is unavailable, for the console and the badge. */
  reason: string | null;
  /** An explicit override from `?renderer=`, if one was given. */
  forced: RendererKind | null;
};

/** Parse `?renderer=2d|canvas2d|webgl`. Anything else is ignored. */
export function forcedRenderer(search: string): RendererKind | null {
  const raw = new URLSearchParams(search).get('renderer');
  if (!raw) return null;
  const v = raw.toLowerCase();
  if (v === '2d' || v === 'canvas2d' || v === 'canvas' || v === 'software') return 'canvas2d';
  if (v === 'webgl' || v === 'webgl2' || v === '3d' || v === 'gl') return 'webgl';
  return null;
}

/**
 * Probe for a WebGL2 context and hand it straight back. The probe context is
 * released explicitly through WEBGL_lose_context, because browsers cap the
 * number of live contexts per page and a leaked probe can cost the real
 * renderer its own context on a tab that has already been used for a while.
 */
export function probeWebGL2(doc: Document = document): { ok: boolean; reason: string | null } {
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = doc.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) as WebGL2RenderingContext | null;
    if (!gl) {
      // Distinguish "no WebGL at all" from "WebGL1 only", because the two get
      // different advice: the first is usually a setting, the second is age.
      const legacy = canvas.getContext('webgl');
      return {
        ok: false,
        reason: legacy
          ? 'this browser has WebGL 1 but not WebGL 2'
          : 'this browser did not return a WebGL context',
      };
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: `creating a WebGL context threw: ${(e as Error)?.message ?? 'unknown error'}` };
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

function probeCanvas2D(doc: Document = document): boolean {
  try {
    const c = doc.createElement('canvas');
    c.width = 1;
    c.height = 1;
    return !!c.getContext('2d');
  } catch {
    return false;
  }
}

export function detectRenderCapabilities(
  doc: Document = document,
  search = typeof location === 'undefined' ? '' : location.search,
): RenderCapabilities {
  const gl = probeWebGL2(doc);
  return {
    webgl2: gl.ok,
    canvas2d: probeCanvas2D(doc),
    reason: gl.reason,
    forced: forcedRenderer(search),
  };
}

/** The backend to try first. A forced choice wins even when it is the slow one. */
export function preferredRenderer(caps: RenderCapabilities): RendererKind {
  if (caps.forced) return caps.forced;
  return caps.webgl2 ? 'webgl' : 'canvas2d';
}
