import { describe, expect, it } from 'vitest';
import { buildTopology } from './topology.js';
import { defaultLayoutOptions, layout } from './layout.js';
import { synthetic } from './__fixtures__/dags.js';

/**
 * Layout runs on a worker for every transition, so it has to stay well inside a
 * frame budget at the sizes the viewer actually caps at.
 */
describe('performance floor', () => {
  it('builds topology and lays out 5000 commits fast enough to morph', () => {
    const snap = synthetic(5000);
    let t0 = performance.now();
    const tree = buildTopology(snap);
    const topologyMs = performance.now() - t0;

    const opts = defaultLayoutOptions(tree);
    layout(tree, 'tree3d', opts); // warm
    t0 = performance.now();
    const runs = 10;
    for (let i = 0; i < runs; i++) layout(tree, 'tree3d', { ...opts, growthCutoff: i / runs });
    const layoutMs = (performance.now() - t0) / runs;

    // eslint-disable-next-line no-console
    console.log(
      `  ${tree.stats.commitCount} commits, ${tree.stats.limbCount} limbs — topology ${topologyMs.toFixed(1)}ms, layout ${layoutMs.toFixed(1)}ms`,
    );
    expect(tree.stats.commitCount).toBeGreaterThan(4000);
    expect(topologyMs).toBeLessThan(1500);
    expect(layoutMs).toBeLessThan(250);
  });
});
