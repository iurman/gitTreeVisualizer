import { AdapterError, fetchSnapshot, fetchTree, looksFlat } from '../../_github.js';
import { rateLimit } from '../../_limit.js';
import { first, type ApiRequest, type ApiResponse } from '../../_types.js';

/**
 * One page of history. Cached at the edge keyed on the URL, and the key
 * includes the cursor, so a repository that gains commits invalidates only the
 * first page rather than the whole history.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const owner = first(req.query.owner);
  const name = first(req.query.name);
  const cursor = first(req.query.cursor) ?? null;

  if (!owner || !name) {
    res.status(400).json({ error: 'Name a repository as owner and repo.' });
    return;
  }

  const limit = rateLimit(req);
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    res.status(429).json({
      error: 'Too many repositories, too quickly.',
      hint: `Wait ${limit.retryAfter} seconds and try again.`,
    });
    return;
  }

  try {
    const { snapshot, cursor: next, headSha } = await fetchSnapshot(owner, name, cursor);

    // Only the first page decides whether directory mode is going to be needed,
    // and only then does it cost an extra request.
    if (!cursor && looksFlat(snapshot.commits)) {
      const tree = await fetchTree(owner, name, headSha);
      if (tree?.length) snapshot.tree = tree;
    }

    // Vercel's CDN then serves most of this for free, and the stale window
    // means a popular repository never waits on GitHub twice.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({ snapshot, cursor: next });
  } catch (e) {
    const err = e as AdapterError;
    const status = err.status ?? 500;
    res.setHeader('Cache-Control', status === 404 ? 's-maxage=300' : 'no-store');
    res.status(status).json({ error: err.message ?? 'That repository could not be read.', hint: err.hint });
  }
}
