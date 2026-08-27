import { describe, expect, it } from 'vitest';
import { buildTopology } from './topology.js';
import { defaultLayoutOptions, layout } from './layout.js';
import { silhouetteSvg } from './svg.js';
import { synthetic } from './__fixtures__/dags.js';

describe('flat silhouette', () => {
  const tree = buildTopology(synthetic(600));
  const result = layout(tree, 'tree2d', defaultLayoutOptions(tree));

  it('draws the same tree the renderer would', () => {
    const svg = silhouetteSvg(tree, result, { width: 1200, height: 630, caption: true });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 1200 630"');
    // Every visible leaf and every visible limb makes it into the drawing.
    const leaves = [...result.leafScales].filter((s) => s > 0).length;
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThanOrEqual(leaves);
    expect((svg.match(/<polygon /g) ?? []).length).toBeGreaterThan(3);
    expect(svg).toContain(tree.snapshot.name);
    expect(svg).not.toContain('NaN');
  });

  it('omits the caption band for the in-page fallback', () => {
    const svg = silhouetteSvg(tree, result, { width: 900, height: 600, caption: false });
    expect(svg).not.toContain('<text');
  });

  it('escapes repository names rather than injecting markup', () => {
    const evil = { ...tree, snapshot: { ...tree.snapshot, name: 'a<script>/b"c' } };
    const svg = silhouetteSvg(evil, result, { width: 400, height: 300, caption: true });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('survives an empty repository', () => {
    const empty = buildTopology({
      schemaVersion: 1, name: 'a/b', description: null, head: '', defaultBranch: 'main',
      source: 'github', truncated: false, generatedAt: new Date(0).toISOString(), commits: [], refs: [],
    });
    const r = layout(empty, 'tree2d', defaultLayoutOptions(empty));
    const svg = silhouetteSvg(empty, r, { width: 400, height: 300, caption: true });
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('NaN');
  });
});
