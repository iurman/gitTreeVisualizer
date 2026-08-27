export { App } from './ui/App.jsx';
export { Viewer } from './state/viewer.js';
export type { ViewerState } from './state/viewer.js';
// The rendering stack, for embedders that need to force a backend or report
// which one is running. Value exports here are three-free by construction; the
// backends themselves are behind loadRenderStack so they stay a lazy chunk.
export {
  detectRenderCapabilities,
  forcedRenderer,
  loadRenderStack,
  preferredRenderer,
  prefetchRenderStack,
  probeWebGL2,
  type RenderBackend,
  type RenderCapabilities,
  type RendererKind,
  type RendererSelection,
} from './render/index.js';
export { parseRepoInput, EXAMPLES } from './state/repo.js';
export * from './palette.js';
export { silhouetteSvg } from '@gittree/core';
