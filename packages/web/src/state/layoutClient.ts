import type { LayoutMode, LayoutOptions, LayoutResult, LensAttributes, LensName, RepoSnapshot } from '@gittree/core';

/**
 * Main-thread side of the layout worker. Requests supersede each other: while
 * scrubbing, only the newest matters, so an in-flight request is allowed to
 * finish and its result discarded rather than queueing a backlog the user has
 * already scrolled past.
 */
export class LayoutClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pendingLayout = new Map<number, (r: LayoutResult) => void>();
  private pendingLens = new Map<number, (a: LensAttributes) => void>();
  private latestLayout = 0;
  private ready: Promise<void> = Promise.resolve();
  private resolveReady: () => void = () => {};

  /**
   * The worker is spawned on the first snapshot, not on construction. The
   * viewer is built as soon as the application mounts, including on the landing
   * page where there is nothing to lay out — and spawning a module worker there
   * costs a script fetch and a thread that then sits idle until someone types a
   * repository name.
   */
  private spawn(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./layoutWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d.type === 'ready') {
        this.resolveReady();
        return;
      }
      if (d.type === 'layout') {
        const cb = this.pendingLayout.get(d.id);
        this.pendingLayout.delete(d.id);
        if (cb && d.id === this.latestLayout) cb(d as LayoutResult);
        return;
      }
      if (d.type === 'lens') {
        const cb = this.pendingLens.get(d.id);
        this.pendingLens.delete(d.id);
        cb?.(d as LensAttributes);
      }
    };
    this.worker = worker;
    return worker;
  }

  /** Start the worker without giving it anything to do yet. */
  warm(): void {
    this.spawn();
  }

  setSnapshot(snapshot: RepoSnapshot, directory: boolean): Promise<void> {
    const worker = this.spawn();
    this.ready = new Promise((res) => {
      this.resolveReady = res;
    });
    worker.postMessage({ type: 'snapshot', snapshot, directory });
    return this.ready;
  }

  async layout(mode: LayoutMode, opts: LayoutOptions): Promise<LayoutResult> {
    await this.ready;
    const id = this.nextId++;
    this.latestLayout = id;
    return new Promise((resolve) => {
      this.pendingLayout.set(id, resolve);
      this.spawn().postMessage({ type: 'layout', id, mode, opts });
    });
  }

  async lens(lens: LensName): Promise<LensAttributes> {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pendingLens.set(id, resolve);
      this.spawn().postMessage({ type: 'lens', id, lens });
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
