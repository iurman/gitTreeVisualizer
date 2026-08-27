/* The eager surface: everything here must be reachable without loading Three.
 * The backends and the factory are deliberately absent — they live behind
 * load.ts, which is what keeps half a megabyte off the critical path. */
export type { BackendEvent, RenderBackend, RendererKind, TransitionOptions } from './backend.js';
export type { RendererSelection } from './createRenderer.js';
export { loadRenderStack, prefetchRenderStack } from './load.js';
export {
  detectRenderCapabilities,
  forcedRenderer,
  preferredRenderer,
  probeWebGL2,
  type RenderCapabilities,
} from './capabilities.js';
export { LEAF_CEILING_PX, LEAF_MAX_PX, LEAF_MIN_PX, leafPixels, worldPerPixel } from './leafSize.js';
export { BASE_HEIGHT, BASE_WIDTH, targetSize } from './resolution.js';
