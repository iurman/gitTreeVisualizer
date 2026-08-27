export { App } from './ui/App.jsx';
export { Viewer } from './state/viewer.js';
export type { ViewerState } from './state/viewer.js';
// The rendering stack, for embedders that need to force a backend or report
// which one is running.
export {
  createRenderer,
  detectRenderCapabilities,
  forcedRenderer,
  preferredRenderer,
  probeWebGL2,
  Canvas2DBackend,
  WebGLBackend,
  type RenderBackend,
  type RenderCapabilities,
  type RendererKind,
  type RendererSelection,
} from './render/index.js';
export { parseRepoInput, EXAMPLES } from './state/repo.js';
export * from './palette.js';
export { silhouetteSvg } from '@gittree/core';
