import { Resvg } from '@resvg/resvg-js';
import {
  autoRingUnit,
  buildDirectoryTopology,
  buildTopology,
  defaultLayoutOptions,
  layout,
  silhouetteSvg,
} from '@gittree/core';
import { fetchSnapshot, fetchTree, looksFlat } from './_github.js';

/* -------------------------------------------------------------------------- */
/* Share image                                                                 */
/*                                                                            */
/* A per-repository card showing that repository's own silhouette, drawn from  */
/* the same layout the viewer uses and honouring the window and granularity in */
/* the link. This is the share loop, so it is worth the request.               */
/*                                                                            */
/* The card carries no text. Every platform renders og:title and              */
/* og:description as type beside the image, so baking the repository name into */
/* the picture only duplicates it — and leaving it out means the renderer      */
/* needs no fonts at all, which is what lets this be a plain SVG rasterized by */
/* resvg rather than a layout engine with an asset bundle behind it.           */
/* -------------------------------------------------------------------------- */

const WIDTH = 1200;
const HEIGHT = 630;
const GROUND = '#0A1424';

function toPng(svg: string): Buffer {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    // There is no text in the card, so there is nothing to resolve a font for.
    font: { loadSystemFonts: false },
  });
  return Buffer.from(r.render().asPng());
}

/** The plate with nothing on it, for a repository that could not be read. */
function blankPlate(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="${GROUND}"/></svg>`;
}

export default async function handler(req: { url?: string }): Promise<Response> {
  const url = new URL(req.url ?? '/', 'https://tree.isaacurman.com');
  const repo = url.searchParams.get('repo');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const ring = url.searchParams.get('ring');

  let svg = blankPlate();
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
      svg = silhouetteSvg(tree, result, { width: WIDTH, height: HEIGHT, caption: false, plateMarks: true });
    } catch {
      // A private or missing repository still gets a plate rather than a 500:
      // a broken image in a shared link is worse than an empty one.
      svg = blankPlate();
    }
  }

  return new Response(new Uint8Array(toPng(svg)), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
