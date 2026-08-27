import type { LayoutMode, LayoutOptions, LayoutResult, LensAttributes, LensName, RepoSnapshot } from '@gittree/core';

/**
 * Main-thread side of the layout worker. Requests supersede each other: while
 * scrubbing, only the newest matters, so an in-flight request is allowed to
 * finish and its result discarded rather than queueing a backlog the user has
 * already scrolled past.
 */
export class LayoutClient {
  private worker: Worker;
  private nextId = 1;
  private pendingLayout = new Map<number, (r: LayoutResult) => void>();
  private pendingLens = new Map<number, (a: LensAttributes) => void>();
  private latestLayout = 0;
  private ready: Promise<void>;
  private resolveReady!: () => void;

  constructor() {
    this.worker = new Worker(new URL('./layoutWorker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((res) => {
      this.resolveReady = res;
    });
    this.worker.onmessage = (e: MessageEvent) => {
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
  }

  setSnapshot(snapshot: RepoSnapshot, directory: boolean): Promise<void> {
    this.ready = new Promise((res) => {
      this.resolveReady = res;
    });
    this.worker.postMessage({ type: 'snapshot', snapshot, directory });
    return this.ready;
  }

  async layout(mode: LayoutMode, opts: LayoutOptions): Promise<LayoutResult> {
    await this.ready;
    const id = this.nextId++;
    this.latestLayout = id;
    return new Promise((resolve) => {
      this.pendingLayout.set(id, resolve);
      this.worker.postMessage({ type: 'layout', id, mode, opts });
    });
  }

  async lens(lens: LensName): Promise<LensAttributes> {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pendingLens.set(id, resolve);
      this.worker.postMessage({ type: 'lens', id, lens });
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
