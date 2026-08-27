import type { LayoutMode, LayoutOptions, LayoutResult, LensAttributes, LensName, RepoSnapshot } from '@gittree/core';
import { LayoutEngine } from './layoutEngine.js';

/* -------------------------------------------------------------------------- */
/* Main-thread side of the layout worker                                       */
/*                                                                            */
/* Requests supersede each other: while scrubbing, only the newest matters, so */
/* an in-flight request is allowed to finish and its result discarded rather   */
/* than queueing a backlog the user has already scrolled past.                 */
/*                                                                            */
/* And the worker is optional. It is the piece of this application with the    */
/* narrowest browser support — module workers only reached Firefox in 114,     */
/* years after WebGL 2 — and it can also be forbidden by a content-security    */
/* policy or simply fail to fetch. It used to fail silently and terminally:    */
/* nothing resolved the ready promise, so every layout awaited forever and the */
/* seed screen sat there for good, with nothing in the console. Now a failure  */
/* falls through to running the same engine here on the main thread. That      */
/* makes the growth animation choppy on a large repository and is not the      */
/* intended path, but it draws the tree.                                       */
/* -------------------------------------------------------------------------- */

/** How long the worker gets to answer the first snapshot before we give up on it. */
const READY_TIMEOUT_MS = 4000;

export class LayoutClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pendingLayout = new Map<number, (r: LayoutResult) => void>();
  private pendingLens = new Map<number, (a: LensAttributes) => void>();
  private latestLayout = 0;
  private ready: Promise<void> = Promise.resolve();
  private resolveReady: () => void = () => {};
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set once the worker has proved unusable. Never unset. */
  private inline: LayoutEngine | null = null;
  /** Kept so the inline engine can rebuild the tree if we fall back mid-flight. */
  private lastSnapshot: { snapshot: RepoSnapshot; directory: boolean } | null = null;
  private onFallback: ((reason: string) => void) | null = null;

  /** Told when layout drops to the main thread, so the interface can say so. */
  observeFallback(fn: (reason: string) => void): void {
    this.onFallback = fn;
  }

  get usingWorker(): boolean {
    return this.inline === null;
  }

  /**
   * The worker is spawned on the first snapshot, not on construction. The
   * viewer is built as soon as the application mounts, including on the landing
   * page where there is nothing to lay out — and spawning a module worker there
   * costs a script fetch and a thread that then sits idle until someone types a
   * repository name.
   */
  private spawn(): Worker | null {
    if (this.inline) return null;
    if (this.worker) return this.worker;

    let worker: Worker;
    try {
      worker = new Worker(new URL('./layoutWorker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      // Thrown outright by a browser with no module-worker support, and by a
      // content-security policy that forbids worker-src.
      this.fallBack(`the layout worker could not be created: ${(e as Error)?.message ?? 'unknown error'}`);
      return null;
    }

    worker.onerror = () => this.fallBack('the layout worker script failed to load');
    worker.onmessageerror = () => this.fallBack('the layout worker sent a message that could not be read');
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d.type === 'ready') {
        this.clearReadyTimer();
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

  /**
   * Give up on the worker and do the work here instead. Anything already
   * awaiting is released: a caller blocked on `ready` would otherwise wait for
   * a thread that is never going to answer.
   */
  private fallBack(reason: string): void {
    if (this.inline) return;
    console.warn(`[tree] laying out on the main thread: ${reason}`);
    this.clearReadyTimer();
    this.inline = new LayoutEngine();
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.worker = null;
    if (this.lastSnapshot) {
      this.inline.setSnapshot(this.lastSnapshot.snapshot, this.lastSnapshot.directory);
    }
    this.pendingLayout.clear();
    this.pendingLens.clear();
    this.resolveReady();
    this.onFallback?.(reason);
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  /** Start the worker without giving it anything to do yet. */
  warm(): void {
    this.spawn();
  }

  setSnapshot(snapshot: RepoSnapshot, directory: boolean): Promise<void> {
    this.lastSnapshot = { snapshot, directory };
    if (this.inline) {
      this.inline.setSnapshot(snapshot, directory);
      return Promise.resolve();
    }
    const worker = this.spawn();
    if (!worker) {
      this.inline!.setSnapshot(snapshot, directory);
      return Promise.resolve();
    }

    this.ready = new Promise((res) => {
      this.resolveReady = res;
    });
    // A backstop for the failures that produce no error event at all: a worker
    // that starts and never answers, which is what a blocked fetch looks like
    // in some browsers.
    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => this.fallBack('the layout worker did not respond'), READY_TIMEOUT_MS);
    worker.postMessage({ type: 'snapshot', snapshot, directory });
    return this.ready;
  }

  async layout(mode: LayoutMode, opts: LayoutOptions): Promise<LayoutResult> {
    await this.ready;
    const id = this.nextId++;
    this.latestLayout = id;
    if (this.inline) {
      const r = this.inline.layout(mode, opts);
      // A null result means no snapshot yet, which the worker path answers by
      // simply never replying. Match that rather than resolving with nothing.
      return r ?? new Promise<LayoutResult>(() => {});
    }
    return new Promise((resolve) => {
      this.pendingLayout.set(id, resolve);
      const worker = this.spawn();
      if (worker) worker.postMessage({ type: 'layout', id, mode, opts });
      else {
        const r = this.inline!.layout(mode, opts);
        if (r) resolve(r);
      }
    });
  }

  async lens(lens: LensName): Promise<LensAttributes> {
    await this.ready;
    const id = this.nextId++;
    if (this.inline) {
      const a = this.inline.lens(lens);
      return a ?? new Promise<LensAttributes>(() => {});
    }
    return new Promise((resolve) => {
      this.pendingLens.set(id, resolve);
      const worker = this.spawn();
      if (worker) worker.postMessage({ type: 'lens', id, lens });
      else {
        const a = this.inline!.lens(lens);
        if (a) resolve(a);
      }
    });
  }

  dispose(): void {
    this.clearReadyTimer();
    this.worker?.terminate();
    this.worker = null;
  }
}
