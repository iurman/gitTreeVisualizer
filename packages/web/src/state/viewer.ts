import {
  SearchIndex,
  autoRingUnit,
  buildDirectoryTopology,
  buildTopology,
  defaultLayoutOptions,
  fullWindow,
  lensAvailable,
  pointsOfInterest,
  ringUnitEnabled,
  suggestRingUnit,
  UNIT_ORDER,
  type LayoutMode,
  type LayoutOptions,
  type LayoutResult,
  type LensName,
  type Poi,
  type RepoSnapshot,
  type RingUnit,
  type TimeWindow,
  type TreeStructure,
} from '@gittree/core';
import { loadRenderStack, prefetchRenderStack } from '../render/load.js';
import { detectRenderCapabilities, type RenderCapabilities } from '../render/capabilities.js';
import type { RendererSelection } from '../render/createRenderer.js';
import type { BackendEvent, RenderBackend, RendererKind } from '../render/backend.js';
import { GrowthSonifier, SoundEngine, type GrowthEvent } from '../audio/engine.js';
import { LayoutClient } from './layoutClient.js';
import { buildUrl, readUrl, writeUrl } from './url.js';
import { fetchRepo, RepoError, type RepoRef } from './repo.js';

export type Phase = 'idle' | 'loading' | 'seed' | 'growing' | 'ready' | 'error';

type RenderStackFactory = (canvas: HTMLCanvasElement, caps?: RenderCapabilities) => RendererSelection;

export type ViewerState = {
  phase: Phase;
  repo: RepoRef | null;
  snapshotName: string;
  description: string | null;
  source: 'github' | 'local' | null;
  truncated: boolean;
  fetched: number;
  total: number;
  error: { message: string; hint?: string } | null;

  mode: LayoutMode;
  lens: LensName;
  fileTypeAvailable: boolean;
  ringUnit: RingUnit;
  ringAuto: RingUnit;
  ringUserSet: boolean;
  window: TimeWindow;
  fullWindow: TimeWindow;
  growth: number;

  selected: string | null;
  hovered: string | null;
  search: string;
  searchHits: number;

  pois: Poi[];
  stats: { commits: number; limbs: number; merges: number; authors: number } | null;
  squashReconstructed: boolean;
  directoryMode: boolean;
  stumpCommits: number;
  cutCommits: number;
  rings: { t: number; major: boolean; label: string }[];
  density: number[];

  muted: boolean;
  volume: number;
  reduceMotion: boolean;
  orbitEnabled: boolean;
  narrow: boolean;
  /** Which renderer is drawing, or null before the canvas mounts. */
  renderer: RendererKind | null;
  /** Why the GPU renderer is not being used, when it is not. */
  rendererNote: string | null;
  /** True only when no renderer at all could be started. */
  rendererFailed: boolean;
  /** Bumped to make the interface hand us a fresh canvas. */
  rendererGeneration: number;
  /** The GPU context is gone and we are waiting to see whether it comes back. */
  contextLost: boolean;
  fps: number;
};

const GROWTH_SECONDS = (commits: number) => Math.min(26, Math.max(9, 6 + commits / 260));
const KEYFRAME_MS = 55;

export class Viewer {
  private renderer: RenderBackend | null = null;
  /** Set once a backend has proved itself unusable, so we never retry it. */
  private forcedKind: RendererKind | null = null;
  /** Why we stopped using the GPU, kept across the remount that swaps renderers. */
  private demotionReason: string | null = null;
  /**
   * Bumped by every mount and unmount. The renderer arrives asynchronously now,
   * and React mounts the canvas twice in development, so a load that resolves
   * after its canvas has gone has to know to throw the result away rather than
   * attach a renderer to a detached element.
   */
  private mountToken = 0;
  private sound = new SoundEngine();
  private sonifier = new GrowthSonifier();
  private layoutClient = new LayoutClient();

  private tree: TreeStructure | null = null;
  private searchIndex: SearchIndex | null = null;
  private opts: LayoutOptions | null = null;
  private current: LayoutResult | null = null;
  private lensAttrs: import('@gittree/core').LensAttributes | null = null;

  private raf = 0;
  private lastKeyframe = 0;
  private layoutInFlight = false;
  private layoutDirty = false;
  private growthStart = 0;
  private growthDuration = 16000;
  private unfold = 1;
  private unfoldTarget = 1;
  private renderScale = 1;
  private abort: AbortController | null = null;

  private listeners = new Set<() => void>();
  private snapshotCache: ViewerState;

  state: ViewerState = {
    phase: 'idle',
    repo: null,
    snapshotName: '',
    description: null,
    source: null,
    truncated: false,
    fetched: 0,
    total: 0,
    error: null,
    mode: 'tree3d',
    lens: 'recency',
    fileTypeAvailable: false,
    ringUnit: 'month',
    ringAuto: 'month',
    ringUserSet: false,
    window: { start: '', end: '' },
    fullWindow: { start: '', end: '' },
    growth: 1,
    selected: null,
    hovered: null,
    search: '',
    searchHits: 0,
    pois: [],
    stats: null,
    squashReconstructed: false,
    directoryMode: false,
    stumpCommits: 0,
    cutCommits: 0,
    rings: [],
    density: [],
    muted: false,
    volume: 0.7,
    reduceMotion: false,
    orbitEnabled: true,
    narrow: false,
    renderer: null,
    rendererNote: null,
    rendererFailed: false,
    rendererGeneration: 0,
    contextLost: false,
    fps: 60,
  };

  constructor() {
    this.snapshotCache = this.state;
    const stored = readStored();
    this.state = { ...this.state, muted: stored.muted, volume: stored.volume };
    this.sound.setMuted(stored.muted);
    this.sound.setVolume(stored.volume);

    if (typeof window !== 'undefined') {
      const narrow = window.matchMedia('(max-width: 760px)').matches;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Narrow viewports open flat and keep orbit as an opt-in; the unfold is
      // the reveal, not the only way to read the tree.
      this.state = { ...this.state, narrow, reduceMotion: reduce, orbitEnabled: !narrow, mode: narrow ? 'tree2d' : 'tree3d' };
      document.addEventListener('visibilitychange', () => this.sound.setHidden(document.hidden));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Subscription                                                           */
  /* ---------------------------------------------------------------------- */

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): ViewerState => this.snapshotCache;

  private set(patch: Partial<ViewerState>): void {
    this.state = { ...this.state, ...patch };
    this.snapshotCache = this.state;
    for (const l of this.listeners) l();
  }

  /* ---------------------------------------------------------------------- */
  /* Mount                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Start downloading the renderer without waiting for it. Called as soon as a
   * repository route is known, so the chunk arrives alongside the first page of
   * history rather than after it.
   */
  preloadRenderer(): void {
    prefetchRenderStack();
    // Same reasoning for the layout worker: it is spawned on demand so the
    // landing page does not pay for it, and a repository route wants it warm
    // before the first page of history lands.
    this.layoutClient.warm();
  }

  mount(canvas: HTMLCanvasElement): void {
    const token = ++this.mountToken;
    void this.startRenderer(canvas, token);
  }

  private async startRenderer(canvas: HTMLCanvasElement, token: number): Promise<void> {
    let createRenderer: RenderStackFactory;
    try {
      ({ createRenderer } = await loadRenderStack());
    } catch (e) {
      console.error('[tree] the renderer could not be downloaded', e);
      if (token === this.mountToken) {
        this.set({ rendererFailed: true, renderer: null, rendererNote: (e as Error)?.message ?? null });
      }
      return;
    }
    // Unmounted, or remounted onto a different canvas, while the chunk loaded.
    if (token !== this.mountToken) return;

    const caps: RenderCapabilities = {
      ...detectRenderCapabilities(),
      // A backend that has already failed on this page is never offered again.
      ...(this.forcedKind ? { forced: this.forcedKind } : {}),
    };

    let selection: RendererSelection;
    try {
      selection = createRenderer(canvas, caps);
    } catch (e) {
      const message = (e as Error)?.message ?? 'unknown error';
      // A canvas holds exactly one kind of context for its whole life. If WebGL
      // claimed this one and then failed, no 2D context will ever be granted on
      // it, and the only way forward is a different element — which is what the
      // generation bump asks the interface for.
      if (this.forcedKind !== 'canvas2d') {
        console.warn('[tree] the GPU renderer would not start, asking for a fresh canvas:', e);
        this.demoteToSoftware(message);
        return;
      }
      // Both backends refused. That takes a browser with WebGL blocked *and*
      // canvas drawing blocked, which is rare enough to be worth saying plainly
      // rather than papering over; the real error goes to the console.
      console.error('[tree] no renderer could be started', e);
      this.set({ rendererFailed: true, renderer: null, rendererNote: message });
      return;
    }

    this.renderer = selection.backend;
    this.set({
      renderer: selection.kind,
      // A demotion carries its own reason across the remount; the factory only
      // knows about failures it saw itself.
      rendererNote: selection.degradedReason ?? this.demotionReason,
      rendererFailed: false,
      contextLost: false,
    });
    this.renderer.onEvent(this.onBackendEvent);

    // A handle for poking at the running viewer from a console or a test. It is
    // set on mount, not construction, so it is always the instance on screen.
    (window as unknown as { __viewer?: Viewer }).__viewer = this;
    this.renderer.setReduceMotion(this.state.reduceMotion);
    this.resize(canvas.clientWidth || this.pendingSize[0], canvas.clientHeight || this.pendingSize[1]);
    // The canvas can mount after the data has already arrived, and in
    // development it mounts twice. Either way the renderer is rebuilt from the
    // state the viewer already holds rather than waiting for another fetch.
    this.rehydrateRenderer();
    this.loop();
  }

  /**
   * A lost GPU context is not an error state on its own — the browser usually
   * hands one back within a second or two, and Three re-uploads everything from
   * the arrays it already holds. It becomes an error only when the context does
   * not come back, and then the answer is the other renderer rather than a
   * frozen canvas that looks like a hang.
   */
  private onBackendEvent = (e: BackendEvent): void => {
    if (e.type === 'contextLost') {
      this.set({ contextLost: true });
      return;
    }
    if (e.type === 'contextRestored') {
      // Nothing to rewrite: the backend's buffers are JavaScript arrays and
      // Three re-uploads all of them on the next frame. Rebuilding here would
      // hand the new context handles belonging to the old one.
      this.set({ contextLost: false });
      return;
    }
    console.warn(`[tree] the GPU renderer gave up: ${e.reason}`);
    this.demoteToSoftware(e.reason);
  };

  /**
   * Hand the work to the software renderer. A canvas can only ever have one
   * kind of context, so the interface has to give us a new element; bumping the
   * generation is what asks for it, and the remount runs the normal path.
   */
  private demoteToSoftware(reason: string): void {
    if (this.forcedKind === 'canvas2d') return;
    this.forcedKind = 'canvas2d';
    this.demotionReason = reason;
    this.unmount();
    this.set({
      renderer: null,
      rendererNote: reason,
      contextLost: false,
      rendererGeneration: this.state.rendererGeneration + 1,
    });
  }

  private rehydrateRenderer(): void {
    const r = this.renderer;
    if (!r || !this.tree || !this.opts || !this.current) return;
    r.setStructure(this.tree, this.opts.limbSegments);
    r.setLayoutImmediate(this.current);
    r.setGrowth(this.state.growth);
    r.setUnfold(this.unfold);
    this.applyBounds(this.current);
    if (this.lensAttrs) r.setLens(this.lensAttrs);
    if (this.state.selected) r.setHighlight(this.tree.indexOf.get(this.state.selected) ?? -1, -1);
  }

  /** The last size the interface reported, for a renderer that arrives after it. */
  private pendingSize: [number, number] = [1, 1];

  resize(w: number, h: number): void {
    this.pendingSize = [w, h];
    this.renderer?.resize(w, h);
    if (this.current) this.renderer?.cam.frame(this.current.bounds, w / Math.max(1, h));
  }

  /**
   * Tear down the canvas only. The worker, the audio context and the loaded
   * repository outlive it, because in development the canvas is mounted twice
   * and disposing the worker here would leave the second mount with nothing to
   * lay out.
   */
  unmount(): void {
    this.mountToken++;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.renderer?.dispose();
    this.renderer = null;
  }

  /** The real teardown. Nothing in the app calls this; it exists for embedders. */
  destroy(): void {
    this.unmount();
    this.abort?.abort();
    this.layoutClient.dispose();
    this.sound.dispose();
  }

  /* ---------------------------------------------------------------------- */
  /* Loading                                                                */
  /* ---------------------------------------------------------------------- */

  async load(ref: RepoRef): Promise<void> {
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.set({ phase: 'loading', repo: ref, error: null, fetched: 0, snapshotName: `${ref.owner}/${ref.name}` });

    try {
      let first = true;
      for await (const progress of fetchRepo(ref, ac.signal)) {
        if (ac.signal.aborted) return;
        await this.ingest(progress.snapshot, first);
        this.set({ fetched: progress.fetched, total: progress.snapshot.commits.length });
        first = false;
        if (progress.complete) break;
      }
      if (this.state.phase === 'loading') this.set({ phase: 'seed' });
    } catch (e) {
      if (ac.signal.aborted) return;
      const err = e as RepoError;
      this.set({
        phase: 'error',
        error: {
          message:
            err.status === 404
              ? 'Repository not found, or it is private. Only public repositories are supported.'
              : (err.message ?? 'That repository could not be read.'),
          hint: err.hint,
        },
      });
    }
  }

  /** Build the tree, hand the same snapshot to the worker, lay out the seed. */
  private async ingest(snapshot: RepoSnapshot, first: boolean): Promise<void> {
    let tree = buildTopology(snapshot);
    let directory = false;

    // No recoverable branch structure and no pull request data to rebuild from:
    // switch to the file tree at HEAD and say so in the interface.
    if (tree.stats.flat && snapshot.tree && snapshot.tree.length > 4) {
      tree = buildDirectoryTopology(snapshot);
      directory = true;
    }

    this.tree = tree;
    this.searchIndex = new SearchIndex(tree);
    const full = fullWindow(tree);
    const url = readUrl();

    const windowSel: TimeWindow =
      url.from && url.to ? { start: url.from, end: url.to } : full;
    const auto = autoRingUnit(windowSel);
    const ringUnit = url.ring ?? (this.state.ringUserSet ? this.state.ringUnit : auto);

    this.opts = {
      ...defaultLayoutOptions(tree),
      window: windowSel,
      ringUnit,
      thetaCompression: this.state.mode === 'tree2d' ? 1 : 0,
      growthCutoff: first ? 0 : this.state.growth,
    };

    this.set({
      snapshotName: snapshot.name,
      description: snapshot.description,
      source: snapshot.source,
      truncated: snapshot.truncated,
      window: windowSel,
      fullWindow: full,
      ringUnit,
      ringAuto: auto,
      ringUserSet: url.ring !== null,
      mode: first ? (this.state.narrow ? 'tree2d' : url.mode) : this.state.mode,
      lens: first ? url.lens : this.state.lens,
      fileTypeAvailable: lensAvailable('fileType', tree),
      pois: pointsOfInterest(tree),
      stats: {
        commits: tree.stats.commitCount,
        limbs: tree.stats.limbCount,
        merges: tree.stats.mergeCount,
        authors: tree.stats.authors.length,
      },
      squashReconstructed: tree.stats.squashReconstructed,
      directoryMode: directory,
      density: densityHistogram(tree, 180),
      growth: first ? 0 : this.state.growth,
    });

    await this.layoutClient.setSnapshot(snapshot, directory);
    this.renderer?.setStructure(tree, this.opts.limbSegments);

    const result = await this.layoutClient.layout(this.state.mode, this.opts);
    this.current = result;
    // Scored from the same normalized-time cursor the shader gates leaves
    // against, so sound and picture cannot drift.
    this.loadScore(tree, result);
    this.renderer?.setLayoutImmediate(result);
    this.renderer?.setGrowth(this.opts.growthCutoff);
    this.applyBounds(result);
    await this.applyLens(this.state.lens);
    this.set({ rings: result.rings, stumpCommits: result.stumpCommits, cutCommits: result.cutCommits });

    if (first) {
      this.unfold = this.state.mode === 'tree2d' ? 0 : 1;
      this.unfoldTarget = this.unfold;
      this.renderer?.setUnfold(this.unfold);
    }
    if (url.at && tree.nodes.has(url.at)) this.set({ selected: url.at });
  }

  /**
   * Build the sonification score against a layout, so every event carries the
   * same normalized height the vertex shader gates its leaf against. It has to
   * take the result rather than read `this.current`, which is not assigned
   * until after the first layout resolves — reading it early gave every event a
   * height of zero, and seeking to the start then skipped the entire score.
   */
  private loadScore(tree: TreeStructure, result: LayoutResult): void {
    const events: { h: number; ev: GrowthEvent }[] = [];
    const churnMax = Math.max(
      1,
      ...tree.order.map((oid) => {
        const c = tree.nodes.get(oid)!.commit;
        return c.additions + c.deletions;
      }),
    );
    const heights = result.leafHeights;
    tree.order.forEach((oid, i) => {
      const node = tree.nodes.get(oid)!;
      const h = heights[i] ?? 0;
      events.push({
        h,
        ev: {
          kind: 'leaf',
          leaf: {
            size: Math.sqrt(Math.min(1, (node.commit.additions + node.commit.deletions) / churnMax)),
            depth: tree.limbs[node.limbId]?.depth ?? 0,
            isMerge: node.isMerge,
          },
        },
      });
    });

    for (const limb of tree.limbs) {
      if (limb.parentLimb === null) continue;
      const first = limb.commits[0];
      const idx = first ? tree.indexOf.get(first) : undefined;
      if (idx === undefined) continue;
      events.push({ h: heights[idx] ?? 0, ev: { kind: 'limb', depth: limb.depth } });
    }

    for (const r of result.rings) {
      events.push({ h: r.t, ev: { kind: 'ring', major: r.major } });
    }

    const minorCount = result.rings.filter((r) => !r.major).length;
    this.sonifier.load(events, minorCount > 24);
    // Streamed pages rebuild the score mid-growth. Seek to where growth has
    // already reached, or everything below the cursor fires at once as a burst.
    this.sonifier.reset(this.state.growth);
  }

  /* ---------------------------------------------------------------------- */
  /* Growth                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * The one click that starts everything. It is also the gesture that unlocks
   * audio, which is why deep links present a seed rather than auto-growing.
   */
  begin(): void {
    if (!this.tree || !this.opts) return;
    this.sound.unlock();
    const url = readUrl();
    if (url.t < 0.999) {
      // A link to a moment mid-growth arrives there directly.
      this.setGrowth(url.t);
      this.set({ phase: 'ready' });
      return;
    }
    this.growthDuration = (this.state.reduceMotion ? 4 : GROWTH_SECONDS(this.tree.order.length)) * 1000;
    this.growthStart = performance.now();
    this.sonifier.reset(0);
    this.set({ phase: 'growing', growth: 0 });
    this.renderer?.setGrowth(0);
  }

  /** Any interaction jumps to the fully grown state. Growth is never a wall. */
  skipGrowth(): void {
    if (this.state.phase !== 'growing') return;
    this.setGrowth(1);
    this.set({ phase: 'ready' });
  }

  setGrowth(v: number): void {
    const g = Math.max(0, Math.min(1, v));
    this.set({ growth: g, phase: this.state.phase === 'growing' ? 'growing' : this.state.phase });
    this.renderer?.setGrowth(g);
    if (this.opts) this.opts = { ...this.opts, growthCutoff: g };
    this.layoutDirty = true;
    this.syncUrl();
  }

  /* ---------------------------------------------------------------------- */
  /* View changes: every one of these is a layout, never a renderer change   */
  /* ---------------------------------------------------------------------- */

  setMode(mode: LayoutMode): void {
    if (!this.opts || mode === this.state.mode) return;
    const index = ['tree3d', 'tree2d', 'byAuthor', 'byChurn', 'timeline'].indexOf(mode);
    this.sound.modeChange(Math.max(0, index));
    this.set({ mode });
    this.opts = { ...this.opts, thetaCompression: mode === 'tree2d' ? 1 : 0 };
    this.unfoldTarget = mode === 'tree2d' || mode === 'timeline' ? 0 : 1;
    this.requestLayout(this.state.reduceMotion ? 200 : 900);
    this.syncUrl();
  }

  async setLens(lens: LensName): Promise<void> {
    if (lens === 'fileType' && !this.state.fileTypeAvailable) return;
    this.set({ lens });
    this.sound.click();
    await this.applyLens(lens);
    this.syncUrl();
  }

  private async applyLens(lens: LensName): Promise<void> {
    const attrs = await this.layoutClient.lens(lens);
    this.lensAttrs = attrs;
    this.renderer?.setLens(attrs);
    if (lens === 'deletions') {
      this.renderer?.setFalling(attrs.falling, performance.now() / 1000);
      this.sound.fall();
    } else {
      this.renderer?.clearFalling();
    }
  }

  setRingUnit(unit: RingUnit, userInitiated = true): void {
    if (!this.opts || unit === this.state.ringUnit) return;
    if (!ringUnitEnabled(unit, this.state.window)) return;
    const finer = UNIT_ORDER.indexOf(unit) < UNIT_ORDER.indexOf(this.state.ringUnit);
    this.sound.granularity(finer);
    this.set({ ringUnit: unit, ringUserSet: userInitiated || this.state.ringUserSet });
    this.opts = { ...this.opts, ringUnit: unit };
    this.requestLayout(this.state.reduceMotion ? 200 : 700);
    this.syncUrl();
  }

  stepRingUnit(delta: number): void {
    const i = UNIT_ORDER.indexOf(this.state.ringUnit);
    const next = UNIT_ORDER[Math.max(0, Math.min(UNIT_ORDER.length - 1, i + delta))];
    if (next) this.setRingUnit(next);
  }

  setWindow(window: TimeWindow): void {
    if (!this.opts) return;
    const auto = autoRingUnit(window);
    // Suggest a granularity, do not lock one: once a reader has chosen a unit,
    // stop fighting them for it.
    const suggested = this.state.ringUserSet ? suggestRingUnit(this.state.ringUnit, window) : auto;
    this.set({ window, ringAuto: auto, ringUnit: suggested });
    this.opts = { ...this.opts, window, ringUnit: suggested };
    this.requestLayout(this.state.reduceMotion ? 220 : 850);
    this.syncUrl();
  }

  resetWindow(): void {
    this.set({ ringUserSet: false });
    this.setWindow(this.state.fullWindow);
  }

  private requestLayout(duration: number): void {
    if (!this.opts) return;
    this.layoutDirty = false;
    this.layoutInFlight = true;
    const mode = this.state.mode;
    const opts = this.opts;
    void this.layoutClient.layout(mode, opts).then((result) => {
      this.layoutInFlight = false;
      this.current = result;
      this.renderer?.applyLayout(result, { duration });
      this.applyBounds(result);
      this.set({ rings: result.rings, stumpCommits: result.stumpCommits, cutCommits: result.cutCommits });
    });
  }

  private applyBounds(result: LayoutResult): void {
    const r = this.renderer;
    if (!r) return;
    const el = r.canvas;
    r.cam.frame(result.bounds, el.clientWidth / Math.max(1, el.clientHeight));
    r.setGroundY(result.bounds.min[1]);
  }

  /* ---------------------------------------------------------------------- */
  /* Picking, search, navigation                                            */
  /* ---------------------------------------------------------------------- */

  pointerMove(ndcX: number, ndcY: number): void {
    if (!this.renderer || !this.tree) return;
    const idx = this.renderer.pick(ndcX, ndcY, this.state.growth);
    const oid = idx >= 0 ? this.tree.order[idx] : null;
    if (oid !== this.state.hovered) {
      if (oid) this.sound.hover();
      this.set({ hovered: oid });
      this.renderer.setHighlight(
        this.state.selected ? (this.tree.indexOf.get(this.state.selected) ?? -1) : -1,
        idx,
      );
    }
  }

  pointerClick(ndcX: number, ndcY: number): void {
    if (!this.renderer || !this.tree) return;
    const idx = this.renderer.pick(ndcX, ndcY, this.state.growth);
    if (idx < 0) {
      this.select(null);
      return;
    }
    this.sound.click();
    this.select(this.tree.order[idx]);
  }

  select(oid: string | null, fly = false): void {
    if (!this.tree || !this.renderer) return;
    this.set({ selected: oid });
    const idx = oid ? (this.tree.indexOf.get(oid) ?? -1) : -1;
    this.renderer.setHighlight(idx, -1);
    if (fly && idx >= 0) this.flyToIndex(idx);
    this.syncUrl();
  }

  private flyToIndex(idx: number): void {
    const r = this.renderer;
    if (!r) return;
    const p = r.worldPositionOf(idx);
    if (!p) return;
    // Raise the render resolution while travelling, so the zoom reads as
    // resolving detail rather than scaling a small image up.
    this.renderScale = 2;
    r.setRenderScale(this.renderScale);
    r.cam.flyTo(p, performance.now(), this.state.reduceMotion ? 260 : 1200, () => {
      this.renderScale = 1;
      r.setRenderScale(1);
    });
  }

  goToPoi(poi: Poi): void {
    if (!this.tree) return;
    this.sound.click();
    // A jump target beyond the growth cursor grows the tree to reach it.
    const idx = this.tree.indexOf.get(poi.oid);
    if (idx !== undefined && this.current && this.current.leafHeights[idx] > this.state.growth) {
      this.setGrowth(Math.min(1, this.current.leafHeights[idx] + 0.02));
    }
    this.select(poi.oid, true);
  }

  setSearch(q: string): void {
    this.set({ search: q });
    if (!this.searchIndex || !this.renderer) return;
    if (q.trim().length < 2) {
      this.renderer.setDim(null);
      this.set({ searchHits: 0 });
      return;
    }
    const match = this.searchIndex.matchSet(q);
    this.renderer.setDim(match);
    this.set({ searchHits: match.size });
  }

  submitSearch(): void {
    if (!this.searchIndex) return;
    const hits = this.searchIndex.query(this.state.search, 1);
    if (hits.length) this.select(hits[0].oid, true);
  }

  /**
   * Walking the graph with the arrow keys. Almost nobody implements this and it
   * is unreasonably satisfying; it is also the accessible path through the tree
   * for anyone not using a pointer.
   */
  walk(direction: 'parent' | 'child' | 'prev' | 'next'): void {
    if (!this.tree) return;
    const cur = this.state.selected ?? this.tree.order[this.tree.order.length - 1];
    const node = this.tree.nodes.get(cur);
    if (!node) return;

    let target: string | undefined;
    if (direction === 'parent') {
      target = node.commit.parents.find((p) => this.tree!.nodes.has(p));
    } else if (direction === 'child') {
      target = node.children.find((c) => this.tree!.nodes.has(c));
    } else {
      const limb = this.tree.limbs[node.limbId];
      const i = node.indexInLimb;
      target = direction === 'next' ? limb?.commits[i + 1] : limb?.commits[i - 1];
      if (!target) {
        // At the end of a limb, step to the sibling limb rather than stopping.
        const siblings = this.tree.limbs.filter((l) => l.parentLimb === limb?.parentLimb);
        const si = siblings.findIndex((l) => l.id === limb?.id);
        const sib = siblings[si + (direction === 'next' ? 1 : -1)];
        target = sib?.commits[0];
      }
    }
    if (target) {
      this.sound.hover();
      this.select(target, true);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Audio and motion preferences                                           */
  /* ---------------------------------------------------------------------- */

  toggleMute(): void {
    const muted = !this.state.muted;
    this.sound.setMuted(muted);
    this.set({ muted });
    writeStored({ muted, volume: this.state.volume });
  }

  setVolume(v: number): void {
    this.sound.setVolume(v);
    this.set({ volume: v });
    writeStored({ muted: this.state.muted, volume: v });
  }

  setReduceMotion(v: boolean): void {
    this.set({ reduceMotion: v });
    this.renderer?.setReduceMotion(v);
  }

  setOrbitEnabled(v: boolean): void {
    this.set({ orbitEnabled: v });
  }

  /* ---------------------------------------------------------------------- */
  /* Camera input                                                           */
  /* ---------------------------------------------------------------------- */

  onPointerDown(x: number, y: number): void {
    this.skipGrowth();
    this.renderer?.cam.onPointerDown(x, y);
  }

  onPointerDrag(x: number, y: number): void {
    this.renderer?.cam.onPointerMove(x, y, this.state.orbitEnabled && this.state.mode !== 'timeline');
  }

  onPointerUp(): void {
    this.renderer?.cam.onPointerUp();
  }

  onWheel(delta: number): void {
    this.skipGrowth();
    this.renderer?.cam.onWheel(delta);
  }

  nudgeCamera(dAz: number, dEl: number): void {
    this.renderer?.cam.nudge(dAz, dEl);
  }

  /* ---------------------------------------------------------------------- */
  /* Frame loop                                                             */
  /* ---------------------------------------------------------------------- */

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const r = this.renderer;
    if (!r) return;

    if (this.state.phase === 'growing') {
      const p = Math.min(1, (now - this.growthStart) / this.growthDuration);
      // Ease out, so the last commits land with a little more space around them.
      const g = 1 - Math.pow(1 - p, 1.6);
      this.state = { ...this.state, growth: g };
      this.snapshotCache = this.state;
      r.setGrowth(g);
      this.sonifier.advance(g, this.sound);
      if (this.opts) this.opts = { ...this.opts, growthCutoff: g };
      if (now - this.lastKeyframe > KEYFRAME_MS && !this.layoutInFlight) {
        this.lastKeyframe = now;
        this.requestLayout(KEYFRAME_MS);
      }
      if (p >= 1) {
        this.set({ phase: 'ready', growth: 1 });
        this.requestLayout(120);
        this.syncUrl();
      } else if (now % 400 < 17) {
        for (const l of this.listeners) l();
      }
    } else if (this.layoutDirty && !this.layoutInFlight) {
      this.lastKeyframe = now;
      this.requestLayout(90);
    }

    // The unfold: one scalar, animated alongside the position morph.
    if (Math.abs(this.unfold - this.unfoldTarget) > 0.001) {
      const rate = this.state.reduceMotion ? 0.3 : 0.055;
      this.unfold += (this.unfoldTarget - this.unfold) * rate;
      r.setUnfold(this.unfold);
    }

    if (this.current) this.sound.setCameraHeight(r.cam.heightFactor(this.current.bounds));
    r.render(now);

    if (now % 500 < 17 && Math.abs(r.fps - this.state.fps) > 2) this.set({ fps: Math.round(r.fps) });
  };

  private syncUrl(): void {
    const s = this.state;
    if (!s.repo) return;
    writeUrl(
      buildUrl(
        {
          owner: s.repo.owner,
          name: s.repo.name,
          mode: s.mode,
          lens: s.lens,
          at: s.selected,
          t: s.growth,
          ring: s.ringUserSet ? s.ringUnit : null,
          from: s.window.start,
          to: s.window.end,
        },
        s.fullWindow,
      ),
    );
  }

  /** Diagnostics, for development and for the automated visual checks. */
  debug() {
    const r = this.renderer;
    return {
      mode: this.state.mode,
      lens: this.state.lens,
      ringUnit: this.state.ringUnit,
      window: this.state.window,
      growth: this.state.growth,
      unfold: this.unfold,
      bounds: this.current?.bounds ?? null,
      visibleLeaves: this.current ? [...this.current.leafScales].filter((v) => v > 0).length : 0,
      visibleLimbs: this.current ? [...this.current.limbVisible].filter((v) => v > 0).length : 0,
      renderer: r?.kind ?? null,
      camera: r ? { pos: r.cam.camera.position.toArray(), fov: r.cam.camera.fov, target: r.cam.target.toArray() } : null,
      fps: r?.fps ?? 0,
    };
  }

  nodeFor(oid: string) {
    return this.tree?.nodes.get(oid) ?? null;
  }

  limbFor(oid: string) {
    const n = this.tree?.nodes.get(oid);
    return n ? (this.tree?.limbs[n.limbId] ?? null) : null;
  }
}

/** Commit density across the repository's whole life, for the range brush. */
function densityHistogram(tree: TreeStructure, buckets: number): number[] {
  const out = new Array<number>(buckets).fill(0);
  const span = Math.max(1, tree.timeRange.max - tree.timeRange.min);
  for (const oid of tree.order) {
    const n = tree.nodes.get(oid)!;
    const i = Math.min(buckets - 1, Math.floor(((n.time - tree.timeRange.min) / span) * buckets));
    out[i]++;
  }
  const max = Math.max(1, ...out);
  return out.map((v) => v / max);
}

type Stored = { muted: boolean; volume: number };

function readStored(): Stored {
  try {
    const raw = localStorage.getItem('gittree.audio');
    if (!raw) return { muted: false, volume: 0.7 };
    const p = JSON.parse(raw) as Partial<Stored>;
    return { muted: !!p.muted, volume: typeof p.volume === 'number' ? p.volume : 0.7 };
  } catch {
    return { muted: false, volume: 0.7 };
  }
}

function writeStored(s: Stored): void {
  try {
    localStorage.setItem('gittree.audio', JSON.stringify(s));
  } catch {
    /* private mode; the toggle still works for this session */
  }
}
