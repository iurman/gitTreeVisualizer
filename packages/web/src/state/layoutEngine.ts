import {
  buildDirectoryTopology,
  buildTopology,
  computeLens,
  layout,
  type LayoutMode,
  type LayoutOptions,
  type LayoutResult,
  type LensAttributes,
  type LensName,
  type RepoSnapshot,
  type TreeStructure,
} from '@gittree/core';

/* -------------------------------------------------------------------------- */
/* Layout, wherever it happens to be running                                   */
/*                                                                            */
/* The whole of what the layout worker does, with no reference to workers.     */
/* Layout is pure, so the only state is the tree, and topology inference is    */
/* deterministic — which is why the worker can rebuild its own copy from the   */
/* snapshot instead of having a large Map shipped across the boundary.         */
/*                                                                            */
/* It is a module rather than code inside the worker because the worker is not */
/* guaranteed to exist. Module workers only reached Firefox in version 114, a  */
/* content-security policy can forbid them outright, and a script can simply   */
/* fail to load. When that happens the client runs this on the main thread:    */
/* the growth animation gets choppy, which is a great deal better than the     */
/* seed screen sitting there forever, which is what used to happen.            */
/* -------------------------------------------------------------------------- */

export class LayoutEngine {
  private tree: TreeStructure | null = null;

  /** Build the tree. Returns the commit count, which is the worker's ready signal. */
  setSnapshot(snapshot: RepoSnapshot, directory: boolean): number {
    this.tree = directory ? buildDirectoryTopology(snapshot) : buildTopology(snapshot);
    return this.tree.order.length;
  }

  layout(mode: LayoutMode, opts: LayoutOptions): LayoutResult | null {
    return this.tree ? layout(this.tree, mode, opts) : null;
  }

  lens(name: LensName): LensAttributes | null {
    return this.tree ? computeLens(this.tree, name) : null;
  }

  get ready(): boolean {
    return this.tree !== null;
  }
}

/** The buffers worth transferring rather than copying, in message order. */
export function layoutTransferables(r: LayoutResult): ArrayBufferLike[] {
  return [
    r.leafPositions.buffer,
    r.leafScales.buffer,
    r.leafSizes.buffer,
    r.leafHeights.buffer,
    r.limbVertices.buffer,
    r.limbRadii.buffer,
    r.limbVisible.buffer,
  ];
}

export function lensTransferables(a: LensAttributes): ArrayBufferLike[] {
  return [a.family.buffer, a.tone.buffer, a.emphasis.buffer, a.falling.buffer];
}
