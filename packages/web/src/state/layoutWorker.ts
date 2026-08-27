/// <reference lib="webworker" />
import type { LayoutMode, LayoutOptions, LensName, RepoSnapshot } from '@gittree/core';
import { LayoutEngine, layoutTransferables, lensTransferables } from './layoutEngine.js';

/* -------------------------------------------------------------------------- */
/* Layout worker                                                               */
/*                                                                            */
/* A postMessage wrapper around LayoutEngine and nothing else. Everything that */
/* actually computes lives in the engine, because the client runs the same     */
/* code on the main thread when a worker cannot be had.                        */
/* -------------------------------------------------------------------------- */

type InMessage =
  | { type: 'snapshot'; snapshot: RepoSnapshot; directory: boolean }
  | { type: 'layout'; id: number; mode: LayoutMode; opts: LayoutOptions }
  | { type: 'lens'; id: number; lens: LensName };

const engine = new LayoutEngine();
const post = (msg: object, transfer?: ArrayBufferLike[]) =>
  (self as unknown as Worker).postMessage(msg, (transfer ?? []) as Transferable[]);

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;

  if (msg.type === 'snapshot') {
    post({ type: 'ready', commits: engine.setSnapshot(msg.snapshot, msg.directory) });
    return;
  }

  if (msg.type === 'layout') {
    const r = engine.layout(msg.mode, msg.opts);
    if (!r) return;
    post(
      {
        type: 'layout',
        id: msg.id,
        leafPositions: r.leafPositions,
        leafScales: r.leafScales,
        leafSizes: r.leafSizes,
        leafHeights: r.leafHeights,
        limbVertices: r.limbVertices,
        limbRadii: r.limbRadii,
        limbVisible: r.limbVisible,
        rings: r.rings,
        stumpCommits: r.stumpCommits,
        cutCommits: r.cutCommits,
        bounds: r.bounds,
      },
      layoutTransferables(r),
    );
    return;
  }

  if (msg.type === 'lens') {
    const a = engine.lens(msg.lens);
    if (!a) return;
    post(
      {
        type: 'lens',
        id: msg.id,
        family: a.family,
        tone: a.tone,
        emphasis: a.emphasis,
        falling: a.falling,
        legend: a.legend,
      },
      lensTransferables(a),
    );
  }
};
