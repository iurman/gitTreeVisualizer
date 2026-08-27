/// <reference lib="webworker" />
import {
  buildDirectoryTopology,
  buildTopology,
  computeLens,
  layout,
  type LayoutMode,
  type LayoutOptions,
  type LensName,
  type RepoSnapshot,
  type TreeStructure,
} from '@gittree/core';

/* -------------------------------------------------------------------------- */
/* Layout worker                                                               */
/*                                                                            */
/* Layout is pure, so putting it on a worker is trivial and the main thread    */
/* never computes a position. The worker owns its own copy of the tree, built  */
/* from the same snapshot: topology inference is deterministic, so the two     */
/* copies are identical without shipping a large Map across the boundary.      */
/* -------------------------------------------------------------------------- */

type InMessage =
  | { type: 'snapshot'; snapshot: RepoSnapshot; directory: boolean }
  | { type: 'layout'; id: number; mode: LayoutMode; opts: LayoutOptions }
  | { type: 'lens'; id: number; lens: LensName };

let tree: TreeStructure | null = null;

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;

  if (msg.type === 'snapshot') {
    tree = msg.directory ? buildDirectoryTopology(msg.snapshot) : buildTopology(msg.snapshot);
    (self as unknown as Worker).postMessage({ type: 'ready', commits: tree.order.length });
    return;
  }

  if (!tree) return;

  if (msg.type === 'layout') {
    const r = layout(tree, msg.mode, msg.opts);
    (self as unknown as Worker).postMessage(
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
      [
        r.leafPositions.buffer,
        r.leafScales.buffer,
        r.leafSizes.buffer,
        r.leafHeights.buffer,
        r.limbVertices.buffer,
        r.limbRadii.buffer,
        r.limbVisible.buffer,
      ],
    );
    return;
  }

  if (msg.type === 'lens') {
    const a = computeLens(tree, msg.lens);
    (self as unknown as Worker).postMessage(
      {
        type: 'lens',
        id: msg.id,
        family: a.family,
        tone: a.tone,
        emphasis: a.emphasis,
        falling: a.falling,
        legend: a.legend,
      },
      [a.family.buffer, a.tone.buffer, a.emphasis.buffer, a.falling.buffer],
    );
  }
};
