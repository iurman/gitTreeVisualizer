import { buildDirectoryTopology, buildTopology, defaultLayoutOptions, layout, silhouetteSvg, autoRingUnit } from '@gittree/core';
import { AdapterError, fetchSnapshot, fetchTree, looksFlat } from '../../_github.js';
import { rateLimit } from '../../_limit.js';
import { first, type ApiRequest, type ApiResponse } from '../../_types.js';

/**
 * The flat drawing. A browser without WebGL gets this instead of an error
 * screen, and it respects the same window and granularity parameters a shared
 * link carries, so the picture matches what the link points at.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const owner = first(req.query.owner);
  const name = first(req.query.name);
  if (!owner || !name) {
    res.status(400).send('Name a repository as owner and repo.');
    return;
  }
  if (!rateLimit(req).ok) {
    res.status(429).send('Too many requests.');
    return;
  }

  try {
    const { snapshot, headSha } = await fetchSnapshot(owner, name, null);
    if (looksFlat(snapshot.commits)) {
      const tree = await fetchTree(owner, name, headSha);
      if (tree?.length) snapshot.tree = tree;
    }

    let tree = buildTopology(snapshot);
    if (tree.stats.flat && snapshot.tree?.length) tree = buildDirectoryTopology(snapshot);

    const opts = defaultLayoutOptions(tree);
    const from = first(req.query.from);
    const to = first(req.query.to);
    const window = from && to ? { start: from, end: to } : opts.window;
    const ring = first(req.query.ring);
    const result = layout(tree, 'tree2d', {
      ...opts,
      window,
      ringUnit: (ring as never) ?? autoRingUnit(window),
      growthCutoff: 1,
    });

    const svg = silhouetteSvg(tree, result, {
      width: Number(first(req.query.w) ?? 1200),
      height: Number(first(req.query.h) ?? 700),
      caption: first(req.query.caption) !== '0',
    });

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(svg);
  } catch (e) {
    const err = e as AdapterError;
    res.setHeader('Cache-Control', 'no-store');
    res.status(err.status ?? 500).send(err.message ?? 'That repository could not be drawn.');
  }
}
