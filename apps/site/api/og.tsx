import { ImageResponse } from '@vercel/og';
import {
  autoRingUnit,
  buildDirectoryTopology,
  buildTopology,
  defaultLayoutOptions,
  layout,
  silhouetteSvg,
} from '@gittree/core';
import { fetchSnapshot, fetchTree, looksFlat } from './_github.js';

export const config = { runtime: 'edge' };

/* -------------------------------------------------------------------------- */
/* Share image                                                                 */
/*                                                                            */
/* A per-repository card showing that repository's own silhouette, drawn from  */
/* the same layout the viewer uses and honouring the window and granularity in */
/* the link. This is the share loop, so it is worth the request.               */
/* -------------------------------------------------------------------------- */

const GROUND = '#0A1424';
const INK = '#F3EFDE';
const MUTED = '#8D9490';
const ACCENT = '#2FA98C';

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const repo = url.searchParams.get('repo');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const ring = url.searchParams.get('ring');

  let art: string | null = null;
  let title = 'Every repository is a tree';
  let subtitle = 'Git history, grown from a seed';
  let detail = 'tree.isaacurman.com';

  const parts = repo?.split('/') ?? [];
  if (parts.length === 2) {
    try {
      const { snapshot, headSha } = await fetchSnapshot(parts[0], parts[1], null);
      if (looksFlat(snapshot.commits)) {
        const t = await fetchTree(parts[0], parts[1], headSha);
        if (t?.length) snapshot.tree = t;
      }
      let tree = buildTopology(snapshot);
      if (tree.stats.flat && snapshot.tree?.length) tree = buildDirectoryTopology(snapshot);

      const opts = defaultLayoutOptions(tree);
      const window = from && to ? { start: from, end: to } : opts.window;
      const result = layout(tree, 'tree2d', {
        ...opts,
        window,
        ringUnit: (ring as never) ?? autoRingUnit(window),
        growthCutoff: 1,
      });

      // The tree is portrait and the card is landscape, so the drawing takes
      // the right half at full height and the label sits beside it, the way a
      // specimen plate carries its own label.
      art = silhouetteSvg(tree, result, { width: 660, height: 630, caption: false });
      title = snapshot.name;
      const windowNote =
        from && to ? `${from.slice(0, 10)} → ${to.slice(0, 10)}` : 'full history';
      subtitle = `${tree.stats.commitCount.toLocaleString('en-US')} commits`;
      detail = `${tree.stats.limbCount.toLocaleString('en-US')} limbs · ${tree.stats.authors.length} contributors · ${windowNote}`;
    } catch {
      title = repo ?? title;
      subtitle = 'Repository not found, or it is private.';
      detail = 'Only public repositories are supported.';
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'row',
          background: GROUND,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            width: 540,
            height: 630,
            padding: '0 56px',
          }}
        >
          <div style={{ fontSize: 20, color: ACCENT, letterSpacing: '0.18em' }}>SPECIMEN</div>
          <div style={{ fontSize: 56, color: INK, marginTop: 14, lineHeight: 1.1 }}>{title}</div>
          <div style={{ fontSize: 30, color: MUTED, marginTop: 16 }}>{subtitle}</div>
          <div style={{ fontSize: 22, color: MUTED, marginTop: 8 }}>{detail}</div>
          <div style={{ fontSize: 22, color: ACCENT, marginTop: 34 }}>tree.isaacurman.com</div>
        </div>
        {art ? (
          <img
            width={660}
            height={630}
            src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(art)))}`}
            style={{ width: 660, height: 630 }}
          />
        ) : (
          <div style={{ display: 'flex', width: 660, height: 630 }} />
        )}
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: { 'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400' },
    },
  );
}
