import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Viewer, ViewerState } from '../state/viewer.js';

export const ViewerContext = createContext<Viewer | null>(null);

export function useViewer(): Viewer {
  const v = useContext(ViewerContext);
  if (!v) throw new Error('Viewer is not mounted');
  return v;
}

export function useViewerState(): ViewerState {
  const v = useViewer();
  return useSyncExternalStore(v.subscribe, v.getSnapshot, v.getSnapshot);
}
