import type { RendererSelection } from './createRenderer.js';
import type { RenderCapabilities } from './capabilities.js';

/* -------------------------------------------------------------------------- */
/* Loading the renderer                                                        */
/*                                                                            */
/* Three.js is half a megabyte, and it is the only thing in this application   */
/* that large. Nothing on the landing page needs it — there is no canvas there */
/* — and on a repository page the first two seconds go to fetching history, so */
/* fetching Three alongside that costs nothing and fetching it before anything */
/* renders costs a lot.                                                        */
/*                                                                            */
/* This module is the seam. It imports nothing from Three itself, only types,  */
/* so it can sit in the eager bundle while everything behind it is a separate  */
/* chunk. The promise is memoized because the interface asks for the chunk as  */
/* soon as it knows a repository is being opened, and the canvas asks for it   */
/* again when it mounts; those must be one request.                           */
/* -------------------------------------------------------------------------- */

type RenderStack = {
  createRenderer(canvas: HTMLCanvasElement, caps?: RenderCapabilities): RendererSelection;
};

let pending: Promise<RenderStack> | null = null;

export function loadRenderStack(): Promise<RenderStack> {
  pending ??= import('./createRenderer.js');
  return pending;
}

/** Start the download without waiting for it. Failures surface at mount. */
export function prefetchRenderStack(): void {
  void loadRenderStack().catch(() => {});
}
