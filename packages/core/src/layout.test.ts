import { describe, expect, it } from 'vitest';
import { buildTopology } from './topology.js';
import { buildDirectoryTopology } from './directory.js';
import { defaultLayoutOptions, fullWindow, layout, limbSlotCount } from './layout.js';
import { autoRingUnit, buildTimeScale, ringMarks, suggestRingUnit, UNIT_MS } from './time.js';
import { computeLens, lensAvailable } from './lenses.js';
import { pointsOfInterest } from './poi.js';
import { SearchIndex } from './search.js';
import { LIMB_RING_VERTS, type LayoutMode, type RingUnit } from './types.js';
import * as f from './__fixtures__/dags.js';

const MODES: LayoutMode[] = ['tree3d', 'tree2d', 'byAuthor', 'byChurn', 'timeline'];

const tree = buildTopology(f.synthetic(900));
const base = defaultLayoutOptions(tree);

describe('layout array contract', () => {
  it('produces identical array lengths in every mode', () => {
    const results = MODES.map((m) => layout(tree, m, base));
    const shape = (r: (typeof results)[number]) => [
      r.leafPositions.length,
      r.leafScales.length,
      r.limbVertices.length,
      r.limbRadii.length,
      r.limbVisible.length,
    ];
    const first = shape(results[0]);
    for (const r of results) expect(shape(r)).toEqual(first);
  });

  it('produces identical array lengths at every ring granularity', () => {
    const units: RingUnit[] = ['hour', 'day', 'week', 'month', 'year'];
    const lengths = units.map((ringUnit) => layout(tree, 'tree3d', { ...base, ringUnit }).limbVertices.length);
    expect(new Set(lengths).size).toBe(1);
  });

  it('produces identical array lengths at every window and growth setting', () => {
    const full = fullWindow(tree);
    const mid = new Date((tree.timeRange.min + tree.timeRange.max) / 2).toISOString();
    const windows = [full, { start: mid, end: full.end }, { start: full.start, end: mid }];
    const shapes = new Set<string>();
    for (const window of windows) {
      for (const growthCutoff of [0, 0.5, 1]) {
        const r = layout(tree, 'tree3d', { ...base, window, growthCutoff });
        shapes.add(`${r.leafScales.length}:${r.limbVertices.length}:${r.limbRadii.length}`);
      }
    }
    expect(shapes.size).toBe(1);
  });

  it('gives every limb a fixed vertex count regardless of its length', () => {
    const slots = limbSlotCount(tree);
    const r = layout(tree, 'tree3d', base);
    expect(r.limbVertices.length).toBe(slots * base.limbSegments * LIMB_RING_VERTS * 3);
    expect(r.limbRadii.length).toBe(slots * base.limbSegments);
    // A one-commit repo lays out with the same per-limb vertex count.
    const tiny = buildTopology(f.singleCommit());
    const rt = layout(tiny, 'tree3d', defaultLayoutOptions(tiny));
    expect(rt.limbVertices.length % (base.limbSegments * LIMB_RING_VERTS * 3)).toBe(0);
  });

  it('hides commits with scale 0 rather than a shorter array', () => {
    const r0 = layout(tree, 'tree3d', { ...base, growthCutoff: 0 });
    const r1 = layout(tree, 'tree3d', { ...base, growthCutoff: 1 });
    expect(r0.leafScales.length).toBe(r1.leafScales.length);
    expect([...r0.leafScales].filter((s) => s > 0).length).toBeLessThan(
      [...r1.leafScales].filter((s) => s > 0).length,
    );
  });

  it('is byte-identical for identical inputs', () => {
    const a = layout(tree, 'tree3d', base);
    const b = layout(buildTopology(f.synthetic(900)), 'tree3d', base);
    expect(Array.from(a.leafPositions)).toEqual(Array.from(b.leafPositions));
    expect(Array.from(a.limbVertices)).toEqual(Array.from(b.limbVertices));
  });

  it('never emits a non-finite coordinate in any mode', () => {
    for (const m of MODES) {
      const r = layout(tree, m, base);
      for (const v of r.leafPositions) expect(Number.isFinite(v)).toBe(true);
      for (const v of r.limbVertices) expect(Number.isFinite(v)).toBe(true);
      for (const v of r.leafScales) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('lays out degenerate repos without crashing', () => {
    for (const make of [f.empty, f.singleCommit, f.linear, f.shallow]) {
      const t = buildTopology(make());
      const o = defaultLayoutOptions(t);
      for (const m of MODES) {
        const r = layout(t, m, o);
        for (const v of r.leafPositions) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe('growth', () => {
  it('is monotone: raising the cutoff only ever reveals commits', () => {
    let prev = -1;
    for (let g = 0; g <= 1.0001; g += 0.1) {
      const r = layout(tree, 'tree3d', { ...base, growthCutoff: g });
      const visible = [...r.leafScales].filter((s) => s > 0).length;
      expect(visible).toBeGreaterThanOrEqual(prev);
      prev = visible;
    }
  });

  it('shows nothing at 0 and everything in-window at 1', () => {
    const r0 = layout(tree, 'tree3d', { ...base, growthCutoff: 0 });
    const r1 = layout(tree, 'tree3d', { ...base, growthCutoff: 1 });
    expect([...r0.leafScales].filter((s) => s > 0).length).toBeLessThanOrEqual(1);
    expect([...r1.leafScales].filter((s) => s > 0).length).toBe(tree.order.length);
  });

  it('does not sprout a limb before the trunk reaches its attach point', () => {
    const r = layout(tree, 'tree3d', { ...base, growthCutoff: 0.15 });
    // Limbs forking high up the trunk must still be invisible this early.
    const lateLimbs = tree.limbs.filter((l) => {
      const first = tree.nodes.get(l.commits[0]);
      if (!first || l.parentLimb === null) return false;
      return (first.time - tree.timeRange.min) / (tree.timeRange.max - tree.timeRange.min) > 0.7;
    });
    expect(lateLimbs.length).toBeGreaterThan(0);
    for (const l of lateLimbs) expect(r.limbVisible[l.id]).toBe(0);
  });

  it('advances the limb tip continuously rather than stepping', () => {
    const tipAt = (g: number) => {
      const r = layout(tree, 'tree3d', { ...base, growthCutoff: g });
      let maxY = -Infinity;
      for (let i = 1; i < r.limbVertices.length; i += 3) maxY = Math.max(maxY, r.limbVertices[i]);
      return maxY;
    };
    const samples = [0.4, 0.42, 0.44, 0.46, 0.48, 0.5].map(tipAt);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 1e-6);
      // No single 2% step should jump more than a fifth of the tree's height.
      expect(samples[i] - samples[i - 1]).toBeLessThan(base.height * 0.2);
    }
  });
});

describe('the unfold', () => {
  it('collapses depth when thetaCompression reaches 1', () => {
    const spread = (tc: number) => {
      const r = layout(tree, 'tree3d', { ...base, thetaCompression: tc });
      let max = 0;
      for (let i = 2; i < r.leafPositions.length; i += 3) max = Math.max(max, Math.abs(r.leafPositions[i]));
      return max;
    };
    expect(spread(1)).toBeLessThan(spread(0) * 0.35);
  });

  it('treats tree2d as tree3d with the angle collapsed', () => {
    const a = layout(tree, 'tree2d', { ...base, thetaCompression: 0 });
    const b = layout(tree, 'tree3d', { ...base, thetaCompression: 1 });
    expect(Array.from(a.leafPositions)).toEqual(Array.from(b.leafPositions));
  });

  it('moves every leaf continuously across the morph', () => {
    const a = layout(tree, 'tree3d', { ...base, thetaCompression: 0.5 });
    const b = layout(tree, 'tree3d', { ...base, thetaCompression: 0.52 });
    let worst = 0;
    for (let i = 0; i < a.leafPositions.length; i += 3) {
      worst = Math.max(
        worst,
        Math.hypot(
          a.leafPositions[i] - b.leafPositions[i],
          a.leafPositions[i + 1] - b.leafPositions[i + 1],
          a.leafPositions[i + 2] - b.leafPositions[i + 2],
        ),
      );
    }
    expect(worst).toBeLessThan(base.spread * 0.2);
  });
});

describe('time window and rings', () => {
  it('renormalizes height so a narrow window fills the view', () => {
    const full = fullWindow(tree);
    const start = new Date(tree.timeRange.max - UNIT_MS.week * 2).toISOString();
    const narrow = { start, end: full.end };
    const rFull = layout(tree, 'tree3d', base);
    const rNarrow = layout(tree, 'tree3d', { ...base, window: narrow, ringUnit: autoRingUnit(narrow) });

    const yOfVisible = (r: typeof rFull) => {
      const ys: number[] = [];
      for (let i = 0; i < r.leafScales.length; i++) if (r.leafScales[i] > 0) ys.push(r.leafPositions[i * 3 + 1]);
      return ys;
    };
    const narrowYs = yOfVisible(rNarrow);
    expect(narrowYs.length).toBeGreaterThan(0);
    const spanNarrow = Math.max(...narrowYs) - Math.min(...narrowYs);
    // The same fortnight sits in a sliver of the full view but fills a windowed one.
    expect(spanNarrow).toBeGreaterThan(base.height * 0.4);
  });

  it('counts pre-window commits into a stump instead of deleting them', () => {
    const mid = new Date((tree.timeRange.min + tree.timeRange.max) / 2).toISOString();
    const r = layout(tree, 'tree3d', { ...base, window: { start: mid, end: fullWindow(tree).end } });
    expect(r.stumpCommits).toBeGreaterThan(0);
    // Their leaves are hidden, but the array is the same length.
    expect(r.leafScales.length).toBe(tree.order.length);
    // The trunk starts below ground so the tree stays attached to it.
    expect(r.bounds.min[1]).toBeLessThan(0);
  });

  it('cuts commits after the window at the tip', () => {
    const mid = new Date((tree.timeRange.min + tree.timeRange.max) / 2).toISOString();
    const r = layout(tree, 'tree3d', { ...base, window: { start: fullWindow(tree).start, end: mid } });
    expect(r.cutCommits).toBeGreaterThan(0);
  });

  it('clamps dormant gaps instead of mapping time linearly', () => {
    // Six months of work, a three-year silence, then six more months of work.
    const now = Date.UTC(2018, 0, 1);
    const half = UNIT_MS.day * 182;
    const times: number[] = [];
    for (let i = 0; i < 200; i++) times.push(now + (i / 199) * half);
    const resume = now + half + UNIT_MS.year * 3;
    for (let i = 0; i < 200; i++) times.push(resume + (i / 199) * half);

    const w = { start: new Date(times[0]).toISOString(), end: new Date(times[times.length - 1]).toISOString() };
    const scale = buildTimeScale(times, w, 'month');

    const gapStart = now + half;
    const gapShare = scale.height(resume) - scale.height(gapStart);
    const linearShare = (resume - gapStart) / (times[times.length - 1] - times[0]);

    // Linearly the silence would swallow three quarters of the trunk. Clamped to
    // three ring units it reads as a seam, and the two bursts keep their space.
    expect(linearShare).toBeGreaterThan(0.7);
    expect(gapShare).toBeLessThan(0.25);
    expect(gapShare).toBeGreaterThan(0.02);
    expect(scale.height(times[0])).toBe(0);
    expect(scale.height(times[times.length - 1])).toBeCloseTo(1, 5);
  });

  it('couples the gap clamp to the ring unit', () => {
    const now = Date.UTC(2024, 0, 1);
    const times = [now, now + UNIT_MS.day * 30, now + UNIT_MS.day * 31];
    const w = { start: new Date(times[0]).toISOString(), end: new Date(times[2]).toISOString() };
    const coarse = buildTimeScale(times, w, 'month').height(times[1]);
    const fine = buildTimeScale(times, w, 'hour').height(times[1]);
    // At hourly granularity the month-long gap compresses hard; at monthly it does not.
    expect(fine).toBeLessThan(coarse);
  });

  it('inverts height back to a timestamp', () => {
    const times = tree.order.map((oid) => tree.nodes.get(oid)!.time);
    const scale = buildTimeScale(times, fullWindow(tree), base.ringUnit);
    for (const h of [0, 0.25, 0.5, 0.75, 1]) {
      expect(scale.height(scale.timeAt(h))).toBeCloseTo(h, 4);
    }
  });

  it('auto-selects a granularity that yields a readable number of rings', () => {
    const decade = { start: '2014-01-01T00:00:00Z', end: '2024-01-01T00:00:00Z' };
    const threeDays = { start: '2024-01-01T00:00:00Z', end: '2024-01-04T00:00:00Z' };
    expect(autoRingUnit(decade)).toBe('year');
    expect(autoRingUnit(threeDays)).toBe('hour');
  });

  it('never renders rings as a solid band', () => {
    const decade = { start: '2014-01-01T00:00:00Z', end: '2024-01-01T00:00:00Z' };
    const times = [Date.parse(decade.start), Date.parse(decade.end)];
    const scale = buildTimeScale(times, decade, 'day');
    const marks = ringMarks(scale, 'day');
    expect(marks.length).toBeLessThan(400);
    expect(marks.some((m) => m.major)).toBe(true);
  });

  it('suggests stepping the unit when the window changes', () => {
    expect(suggestRingUnit('year', { start: '2024-01-01T00:00:00Z', end: '2024-03-01T00:00:00Z' })).toBe('month');
    expect(suggestRingUnit('hour', { start: '2014-01-01T00:00:00Z', end: '2024-01-01T00:00:00Z' })).toBe('day');
    expect(suggestRingUnit('month', { start: '2020-01-01T00:00:00Z', end: '2022-01-01T00:00:00Z' })).toBe('month');
  });
});

describe('geometry rules', () => {
  it('obeys the pipe model: a limb is never thicker than its parent', () => {
    const r = layout(tree, 'tree3d', base);
    const S = base.limbSegments;
    const baseRadius = (id: number) => r.limbRadii[id * S];
    for (const l of tree.limbs) {
      if (l.parentLimb === null) continue;
      expect(baseRadius(l.id)).toBeLessThanOrEqual(baseRadius(l.parentLimb) + 1e-4);
    }
  });

  it('tapers every limb toward its tip', () => {
    const r = layout(tree, 'tree3d', base);
    const S = base.limbSegments;
    for (const l of tree.limbs) {
      const first = r.limbRadii[l.id * S];
      const last = r.limbRadii[l.id * S + S - 1];
      if (first === 0) continue;
      expect(last).toBeLessThan(first);
      expect(last / first).toBeCloseTo(0.4, 1);
    }
  });

  it('separates sibling limbs by the golden angle', () => {
    const r = layout(tree, 'tree3d', base);
    const S = base.limbSegments;
    const tipAngle = (id: number) => {
      const o = (id * S + S - 1) * LIMB_RING_VERTS * 3;
      return Math.atan2(r.limbVertices[o + 2], r.limbVertices[o]);
    };
    const trunkKids = tree.limbs.filter((l) => l.parentLimb === 0).slice(0, 8);
    const angles = trunkKids.map((l) => tipAngle(l.id));
    for (let i = 0; i < angles.length; i++) {
      for (let j = i + 1; j < angles.length; j++) {
        expect(Math.abs(angles[i] - angles[j])).toBeGreaterThan(0.02);
      }
    }
  });
});

describe('derived data', () => {
  it('offers jump targets covering every kind that applies', () => {
    const pois = pointsOfInterest(tree);
    const kinds = new Set(pois.map((p) => p.kind));
    for (const k of ['oldest', 'newest', 'largestEdit', 'busiestDay', 'firstByAuthor']) {
      expect(kinds.has(k as never)).toBe(true);
    }
    for (const p of pois) expect(tree.nodes.has(p.oid)).toBe(true);
  });

  it('searches subject, author and SHA prefix', () => {
    const idx = new SearchIndex(tree);
    expect(idx.query('Grace').length).toBeGreaterThan(0);
    const someOid = tree.order[10];
    expect(idx.query(someOid.slice(0, 4))[0].oid).toBe(someOid);
    expect(idx.query('a')).toEqual([]);
  });

  it('writes lens attributes without moving anything', () => {
    for (const lens of ['author', 'recency', 'churn', 'deletions'] as const) {
      const a = computeLens(tree, lens);
      expect(a.tone.length).toBe(tree.order.length);
      expect(a.family.length).toBe(tree.order.length);
      for (const v of a.tone) expect(v).toBeGreaterThanOrEqual(0);
    }
    expect([...computeLens(tree, 'deletions').falling].some((v) => v === 1)).toBe(true);
  });

  it('reports the file-type lens as unavailable when the source cannot supply extensions', () => {
    expect(lensAvailable('fileType', tree)).toBe(false);
    const dir = buildDirectoryTopology({
      ...f.linear(),
      tree: [
        { path: 'src/index.ts', size: 100 },
        { path: 'src/lib/util.ts', size: 50 },
        { path: 'README.md', size: 10 },
      ],
    });
    expect(lensAvailable('fileType', dir)).toBe(true);
  });
});

describe('directory fallback', () => {
  const dir = buildDirectoryTopology({
    ...f.squashed(false),
    tree: Array.from({ length: 60 }, (_, i) => ({
      path: `pkg${i % 5}/mod${i % 7}/file${i}.ts`,
      size: 100 + i,
    })),
  });

  it('builds a skeleton from the file tree with directories as limbs', () => {
    expect(dir.limbs.length).toBeGreaterThan(5);
    expect(dir.limbs[0].parentLimb).toBeNull();
    expect(dir.stats.flat).toBe(true);
  });

  it('lays out through the same layout functions', () => {
    const o = defaultLayoutOptions(dir);
    for (const m of MODES) {
      const r = layout(dir, m, o);
      expect(r.leafScales.length).toBe(dir.order.length);
      for (const v of r.leafPositions) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('places every commit on some limb, deterministically', () => {
    const again = buildDirectoryTopology(dir.snapshot);
    expect(again.order).toEqual(dir.order);
    expect([...again.nodes.values()].map((n) => n.limbId)).toEqual([...dir.nodes.values()].map((n) => n.limbId));
    expect(dir.limbs.reduce((n, l) => n + l.commits.length, 0)).toBe(dir.snapshot.commits.length);
  });
});
