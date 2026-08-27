export type { BackendEvent, RenderBackend, RendererKind, TransitionOptions } from './backend.js';
export { Canvas2DBackend } from './Canvas2DBackend.js';
export { WebGLBackend } from './WebGLBackend.js';
export { createRenderer, type RendererSelection } from './createRenderer.js';
export {
  detectRenderCapabilities,
  forcedRenderer,
  preferredRenderer,
  probeWebGL2,
  type RenderCapabilities,
} from './capabilities.js';
export { LEAF_MAX_PX, LEAF_MIN_PX, leafPixels, worldPerPixel } from './leafSize.js';
export { BASE_HEIGHT, BASE_WIDTH, targetSize } from './resolution.js';
