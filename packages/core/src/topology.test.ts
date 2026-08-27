import { describe, expect, it } from 'vitest';
import { buildTopology } from './topology.js';
import { TopologyError } from './types.js';
import { parseSnapshot } from './snapshot.js';
import * as f from './__fixtures__/dags.js';

const trunkOf = (t: ReturnType<typeof buildTopology>) => t.limbs[0];

describe('buildTopology', () => {
  it('walks the first-parent chain from HEAD to a parentless root', () => {
    const t = buildTopology(f.linear());
    expect(trunkOf(t).commits).toEqual(['a', 'b', 'c', 'd']);
    expect(trunkOf(t).depth).toBe(0);
    expect(trunkOf(t).parentLimb).toBeNull();
    expect(t.limbs).toHaveLength(1);
    expect(t.stats.mergeCount).toBe(0);
  });

  it('claims every commit exactly once', () => {
    for (const make of [f.linear, f.singleMerge, f.nestedMerges, f.octopus, f.dangling, f.multipleRoots]) {
      const t = buildTopology(make());
      const seen = new Set<string>();
      for (const limb of t.limbs) {
        for (const oid of limb.commits) {
          expect(seen.has(oid), `${oid} claimed twice`).toBe(false);
          seen.add(oid);
        }
      }
      expect(seen.size).toBe(make().commits.length);
    }
  });

  it('turns a merge into a limb attached at the merge commit', () => {
    const t = buildTopology(f.singleMerge());
    expect(trunkOf(t).commits).toEqual(['a', 'b', 'm', 'e']);
    const limb = t.limbs[1];
    expect(limb.commits).toEqual(['f1', 'f2']);
    expect(limb.attachPoint).toBe('m');
    expect(limb.depth).toBe(1);
    expect(limb.rejoined).toBe(true);
    expect(limb.label).toBe('feature');
  });

  it('recurses so a merge into a limb produces a sub-limb', () => {
    const t = buildTopology(f.nestedMerges());
    const outer = t.limbs.find((l) => l.commits.includes('f1'))!;
    const inner = t.limbs.find((l) => l.commits.includes('g1'))!;
    expect(outer.depth).toBe(1);
    expect(inner.depth).toBe(2);
    expect(inner.parentLimb).toBe(outer.id);
    expect(inner.attachPoint).toBe('f2');
  });

  it('handles octopus merges with more than two parents', () => {
    const t = buildTopology(f.octopus());
    const limbs = t.limbs.filter((l) => l.depth === 1);
    expect(limbs).toHaveLength(3);
    expect(limbs.map((l) => l.commits[0]).sort()).toEqual(['x1', 'y1', 'z1']);
    for (const l of limbs) expect(l.attachPoint).toBe('oct');
  });

  it('marks an unmerged ref as a limb that never rejoins', () => {
    const t = buildTopology(f.dangling());
    const limb = t.limbs.find((l) => l.label === 'wip/abandoned')!;
    expect(limb).toBeDefined();
    expect(limb.commits).toEqual(['w1', 'w2']);
    expect(limb.rejoined).toBe(false);
    expect(limb.attachPoint).toBe('b');
  });

  it('puts the second root of a grafted history on its own limb', () => {
    const t = buildTopology(f.multipleRoots());
    expect(trunkOf(t).commits).toEqual(['r1', 'a', 'm']);
    const graft = t.limbs.find((l) => l.commits.includes('r2'))!;
    expect(graft.commits).toEqual(['r2', 'b']);
    expect(graft.attachPoint).toBe('m');
    expect(t.roots.sort()).toEqual(['r1', 'r2']);
  });

  it('terminates the walk when a shallow clone omits a parent', () => {
    const t = buildTopology(f.shallow());
    expect(trunkOf(t).commits).toEqual(['c', 'd', 'e']);
    expect(t.nodes.has('MISSING')).toBe(false);
  });

  it('renders a single-commit repo as a sprout', () => {
    const t = buildTopology(f.singleCommit());
    expect(t.limbs).toHaveLength(1);
    expect(t.order).toEqual(['only']);
    expect(t.stats.flat).toBe(true);
  });

  it('survives an empty repo', () => {
    const t = buildTopology(f.empty());
    expect(t.limbs).toHaveLength(0);
    expect(t.order).toHaveLength(0);
    expect(t.stats.commitCount).toBe(0);
    expect(t.timeRange.max).toBeGreaterThan(t.timeRange.min);
  });

  it('fails with a clear error on a cycle rather than hanging', () => {
    expect(() => buildTopology(f.cyclic())).toThrow(TopologyError);
    try {
      buildTopology(f.cyclic());
    } catch (e) {
      expect((e as TopologyError).code).toBe('CYCLE');
    }
  });

  it('reconstructs limbs from pull requests when the repo squash-merges', () => {
    const t = buildTopology(f.squashed(true));
    expect(t.stats.squashReconstructed).toBe(true);
    const synth = t.limbs.filter((l) => l.synthesized);
    expect(synth.length).toBeGreaterThan(10);
    for (const l of synth) {
      expect(l.depth).toBe(1);
      for (const oid of l.commits) expect(t.nodes.get(oid)!.synthetic).toBe(true);
    }
    // The trunk itself is never synthesized.
    expect(trunkOf(t).synthesized).toBe(false);
  });

  it('falls through to the flat-history flag when there is no PR data to rebuild from', () => {
    const t = buildTopology(f.squashed(false));
    expect(t.stats.squashReconstructed).toBe(false);
    expect(t.stats.flat).toBe(true);
  });

  it('caps limb depth at 6 and folds deeper chains into their parent', () => {
    // A chain of merges 9 levels deep.
    const commits: f.CommitSpec[] = [{ oid: 'base', h: 0 }];
    let anchor = 'base';
    let h = 1;
    for (let d = 1; d <= 9; d++) {
      const tip = `d${d}`;
      commits.push({ oid: tip, parents: [anchor], h: h++ });
      const merge = `m${d}`;
      commits.push({ oid: merge, parents: [anchor, tip], h: h++, subject: `Merge branch 'd${d}'` });
      anchor = merge;
    }
    // Rebuild as nested: each level merges into the previous level's limb.
    const nested: f.CommitSpec[] = [{ oid: 'root', h: 0 }];
    let parentTip = 'root';
    let hh = 1;
    const tips: string[] = [];
    for (let d = 1; d <= 9; d++) {
      const a = `l${d}a`;
      const b = `l${d}b`;
      nested.push({ oid: a, parents: [parentTip], h: hh++ });
      nested.push({ oid: b, parents: [a], h: hh++ });
      tips.push(b);
      parentTip = a;
    }
    // Merge them back innermost-first so depth accumulates.
    let mergeTarget = tips[tips.length - 1];
    for (let d = tips.length - 2; d >= 0; d--) {
      const m = `mm${d}`;
      nested.push({ oid: m, parents: [tips[d], mergeTarget], h: hh++, subject: `Merge branch 'l${d}'` });
      mergeTarget = m;
    }
    nested.push({ oid: 'head', parents: ['root', mergeTarget], h: hh++, subject: "Merge branch 'all'" });
    const t = buildTopology(f.snapshot({ head: 'head', commits: nested }));
    expect(t.stats.maxDepth).toBeLessThanOrEqual(6);
    const claimed = new Set(t.limbs.flatMap((l) => l.commits));
    expect(claimed.size).toBe(nested.length);
  });

  it('is deterministic: the same snapshot yields identical limb seeds and order', () => {
    const snap = f.synthetic(400);
    const a = buildTopology(snap);
    const b = buildTopology(snap);
    expect(a.order).toEqual(b.order);
    expect(a.limbs.map((l) => `${l.id}:${l.label}:${l.seed}`)).toEqual(
      b.limbs.map((l) => `${l.id}:${l.label}:${l.seed}`),
    );
  });

  it('validates at the adapter boundary', () => {
    expect(() => parseSnapshot(f.linear())).not.toThrow();
    expect(() => parseSnapshot({ ...f.linear(), commits: [{ oid: 'x' }] })).toThrow();
    expect(() => parseSnapshot({ ...f.linear(), schemaVersion: 2 })).toThrow();
  });

  it('indexes every node by SHA with a stable instance index', () => {
    const t = buildTopology(f.synthetic(200));
    expect(t.indexOf.size).toBe(t.order.length);
    t.order.forEach((oid, i) => expect(t.indexOf.get(oid)).toBe(i));
    for (const oid of t.order) expect(t.nodes.has(oid)).toBe(true);
  });
});
