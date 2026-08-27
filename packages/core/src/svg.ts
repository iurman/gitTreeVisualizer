import { LIMB_RING_VERTS, type LayoutResult, type TreeStructure } from './types.js';
import { limbSlotCount } from './layout.js';

/* -------------------------------------------------------------------------- */
/* Flat silhouette                                                             */
/*                                                                            */
/* One drawing, two jobs: the share image, and what a browser without WebGL    */
/* gets instead of an error screen. It reads the same LayoutResult the GPU     */
/* does, so the picture on a social card is the same tree, at the same window  */
/* and the same granularity, as the link it points at.                         */
/* -------------------------------------------------------------------------- */

export type SilhouetteColors = {
  background: string;
  ground: string;
  bark: string;
  barkGhost: string;
  leaf: string;
  leafAlt: string;
  ring: string;
  text: string;
};

export const DEFAULT_SILHOUETTE_COLORS: SilhouetteColors = {
  background: '#0A1424',
  ground: '#102138',
  bark: '#4C5A6A',
  barkGhost: '#324152',
  leaf: '#D3CCB6',
  leafAlt: '#2FA98C',
  ring: '#8D9490',
  text: '#F3EFDE',
};

export type SilhouetteOptions = {
  width: number;
  height: number;
  colors?: Partial<SilhouetteColors>;
  title?: string;
  subtitle?: string;
  /** Draw the caption band. Off for the in-page fallback, on for the share card. */
  caption?: boolean;
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function silhouetteSvg(
  tree: TreeStructure,
  result: LayoutResult,
  opts: SilhouetteOptions,
): string {
  const c = { ...DEFAULT_SILHOUETTE_COLORS, ...(opts.colors ?? {}) };
  const { width: W, height: H } = opts;
  const pad = opts.caption ? 96 : 24;

  const [minX, minY] = result.bounds.min;
  const [maxX, maxY] = result.bounds.max;
  const spanX = Math.max(1e-3, maxX - minX);
  const spanY = Math.max(1e-3, maxY - minY);
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const ox = W / 2 - ((minX + maxX) / 2) * scale;
  const oy = H - pad - -minY * scale;

  const px = (x: number) => ox + x * scale;
  const py = (y: number) => oy - y * scale;

  const slots = limbSlotCount(tree);
  const segments = result.limbRadii.length / Math.max(1, slots);
  const parts: string[] = [];

  parts.push(`<rect width="${W}" height="${H}" fill="${c.background}"/>`);
  parts.push(
    `<rect x="0" y="${py(0).toFixed(1)}" width="${W}" height="${Math.max(0, H - py(0)).toFixed(1)}" fill="${c.ground}"/>`,
  );

  // Limbs: a tapered ribbon per limb, drawn from the ring centres and radii.
  for (let s = 0; s < slots; s++) {
    if ((result.limbVisible[s] ?? 0) <= 0.02) continue;
    const limb = tree.limbs[s];
    const ghost = limb ? limb.synthesized || !limb.rejoined : false;
    const left: string[] = [];
    const right: string[] = [];
    for (let j = 0; j < segments; j++) {
      const base = (s * segments + j) * LIMB_RING_VERTS * 3;
      let cx = 0;
      let cy = 0;
      for (let k = 0; k < LIMB_RING_VERTS; k++) {
        cx += result.limbVertices[base + k * 3];
        cy += result.limbVertices[base + k * 3 + 1];
      }
      cx /= LIMB_RING_VERTS;
      cy /= LIMB_RING_VERTS;
      const r = Math.max(0.35, (result.limbRadii[s * segments + j] ?? 0) * scale);
      left.push(`${(px(cx) - r).toFixed(1)},${py(cy).toFixed(1)}`);
      right.unshift(`${(px(cx) + r).toFixed(1)},${py(cy).toFixed(1)}`);
    }
    if (!left.length) continue;
    parts.push(
      `<polygon points="${[...left, ...right].join(' ')}" fill="${ghost ? c.barkGhost : c.bark}"${
        ghost ? ' opacity="0.55"' : ''
      }/>`,
    );
  }

  // Rings across the trunk, so the granularity is legible in a still image.
  for (const ring of result.rings) {
    if (!ring.major) continue;
    const y = py(minY + ring.t * spanY);
    parts.push(
      `<line x1="${(W / 2 - 26).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(W / 2 + 26).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${c.ring}" stroke-width="1" opacity="0.5"/>`,
    );
  }

  // Leaves, back to front so the near ones win.
  const order = Array.from({ length: tree.order.length }, (_, i) => i).sort(
    (a, b) => result.leafPositions[a * 3 + 2] - result.leafPositions[b * 3 + 2],
  );
  for (const i of order) {
    const sz = result.leafScales[i];
    if (sz <= 0) continue;
    const x = px(result.leafPositions[i * 3]);
    const y = py(result.leafPositions[i * 3 + 1]);
    const node = tree.nodes.get(tree.order[i]);
    const r = Math.max(1, sz * scale * 0.7);
    const fill = node?.isMerge ? c.leafAlt : c.leaf;
    parts.push(`<rect x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${(r * 2).toFixed(1)}" height="${(r * 2).toFixed(1)}" fill="${fill}"/>`);
  }

  if (opts.caption) {
    parts.push(
      `<text x="${pad}" y="${H - 46}" fill="${c.text}" font-family="Georgia, 'Times New Roman', serif" font-size="42">${esc(opts.title ?? tree.snapshot.name)}</text>`,
    );
    parts.push(
      `<text x="${pad}" y="${H - 18}" fill="${c.ring}" font-family="ui-monospace, monospace" font-size="19">${esc(
        opts.subtitle ??
          `${tree.stats.commitCount.toLocaleString('en-US')} commits · ${tree.stats.limbCount.toLocaleString('en-US')} limbs · ${tree.stats.authors.length} contributors`,
      )}</text>`,
    );
    parts.push(
      `<text x="${W - pad}" y="${H - 18}" text-anchor="end" fill="${c.ring}" font-family="ui-monospace, monospace" font-size="19">tree.isaacurman.com</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(tree.snapshot.name)} drawn as a tree">${parts.join('')}</svg>`;
}
