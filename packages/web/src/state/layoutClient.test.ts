import { describe, expect, it } from 'vitest';
import type { RepoSnapshot } from '@gittree/core';
import { defaultLayoutOptions, buildTopology } from '@gittree/core';
import { LayoutClient } from './layoutClient.js';
import { LayoutEngine } from './layoutEngine.js';

/* -------------------------------------------------------------------------- */
/* Layout without a worker                                                     */
/*                                                                            */
/* Node has no `Worker`, so constructing one here fails exactly the way it     */
/* fails in a browser that will not give the page a worker thread — which is   */
/* the case this file exists to cover. It used to hang: nothing resolved the   */
/* ready promise, every layout awaited forever, and the seed screen stayed put */
/* with nothing in the console.                                               */
/* -------------------------------------------------------------------------- */

function snapshot(commits = 40): RepoSnapshot {
  const oid = (i: number) => String(i).padStart(40, '0');
  return {
    schemaVersion: 1,
    name: 'acme/repo',
    description: null,
    head: oid(commits - 1),
    defaultBranch: 'main',
    source: 'github',
    truncated: false,
    generatedAt: '2016-03-03T00:00:00.000Z',
    // Newest first, the order the adapter emits.
    commits: Array.from({ length: commits }, (_, k) => {
      const i = commits - 1 - k;
      return {
        oid: oid(i),
        parents: i === 0 ? [] : [oid(i - 1)],
        author: ['Ada', 'Grace', 'Alan'][i % 3],
        authorEmail: 'dev@example.com',
        date: new Date(Date.UTC(2016, 2, 3) + i * 86_400_000).toISOString(),
        subject: `Commit ${i}`,
        additions: 10 + (i % 40),
        deletions: i % 7,
        filesChanged: 1 + (i % 4),
      };
    }),
    refs: [{ name: 'main', oid: oid(commits - 1), kind: 'branch' }],
  };
}

describe('LayoutEngine', () => {
  it('lays out without any worker involved', () => {
    const engine = new LayoutEngine();
    expect(engine.ready).toBe(false);
    expect(engine.layout('tree3d', defaultLayoutOptions(buildTopology(snapshot())))).toBeNull();

    const count = engine.setSnapshot(snapshot(), false);
    expect(count).toBe(40);
    expect(engine.ready).toBe(true);

    const opts = defaultLayoutOptions(buildTopology(snapshot()));
    const r = engine.layout('tree3d', opts)!;
    expect(r.leafPositions.length).toBe(40 * 3);
    expect([...r.leafScales].some((v) => v > 0)).toBe(true);
    expect(r.bounds.max[1]).toBeGreaterThan(r.bounds.min[1]);
  });

  it('computes a lens without a worker too', () => {
    const engine = new LayoutEngine();
    engine.setSnapshot(snapshot(), false);
    const a = engine.lens('author')!;
    expect(a.tone.length).toBe(40);
    expect(a.legend.length).toBeGreaterThan(0);
  });
});

describe('LayoutClient with no worker available', () => {
  it('falls through to the main thread and still returns a layout', async () => {
    const client = new LayoutClient();
    let reason: string | null = null;
    client.observeFallback((r) => {
      reason = r;
    });

    await client.setSnapshot(snapshot(), false);
    expect(client.usingWorker).toBe(false);
    expect(reason).toBeTruthy();

    const opts = defaultLayoutOptions(buildTopology(snapshot()));
    const r = await client.layout('tree3d', opts);
    expect(r.leafPositions.length).toBe(40 * 3);
    expect([...r.leafScales].some((v) => v > 0)).toBe(true);

    const lens = await client.lens('churn');
    expect(lens.tone.length).toBe(40);
    client.dispose();
  });

  it('resolves rather than hanging, which is the whole point', async () => {
    const client = new LayoutClient();
    const opts = defaultLayoutOptions(buildTopology(snapshot()));
    // A timeout that loses the race is the assertion: before the fallback
    // existed, every one of these awaited for good.
    const raced = await Promise.race([
      (async () => {
        await client.setSnapshot(snapshot(), false);
        await client.layout('tree2d', opts);
        await client.lens('recency');
        return 'resolved';
      })(),
      new Promise((res) => setTimeout(() => res('hung'), 4000)),
    ]);
    expect(raced).toBe('resolved');
    client.dispose();
  });

  it('reports the same layout the worker would have produced', async () => {
    // The fallback runs the identical engine, so this is really a guard against
    // the two paths drifting apart in future.
    const client = new LayoutClient();
    await client.setSnapshot(snapshot(), false);
    const opts = defaultLayoutOptions(buildTopology(snapshot()));
    const viaClient = await client.layout('tree3d', opts);

    const engine = new LayoutEngine();
    engine.setSnapshot(snapshot(), false);
    const direct = engine.layout('tree3d', opts)!;

    expect([...viaClient.leafPositions]).toEqual([...direct.leafPositions]);
    expect([...viaClient.limbVisible]).toEqual([...direct.limbVisible]);
    client.dispose();
  });
});
