import type { TreeStructure } from './types.js';
import { hash32 } from './hash.js';

/* -------------------------------------------------------------------------- */
/* Lenses                                                                      */
/*                                                                            */
/* Lenses move nothing. They write per-instance colour and scale attributes    */
/* only, so they are nearly free and always preserve the real topology. Core    */
/* emits a family index and a normalized tone; the palette that turns those    */
/* into colours lives in the web package, so art direction can change without  */
/* touching data code.                                                         */
/* -------------------------------------------------------------------------- */

export type LensName = 'author' | 'recency' | 'churn' | 'deletions' | 'fileType';

export const LENSES: { name: LensName; label: string; caption: string }[] = [
  { name: 'recency', label: 'Age', caption: 'Older growth darkens, recent work stays bright.' },
  { name: 'author', label: 'Author', caption: 'One hue per contributor.' },
  { name: 'churn', label: 'Churn', caption: 'Lines changed, brightest at the largest edits.' },
  { name: 'deletions', label: 'Deletions', caption: 'Net-negative commits fall as dead leaves.' },
  { name: 'fileType', label: 'File type', caption: 'Colour by the extension a commit touched.' },
];

export type LensAttributes = {
  /** Which tonal family to draw from, 0..2. */
  family: Uint8Array;
  /** Position within the family, 0..1. */
  tone: Float32Array;
  /** Extra emphasis, 0..1. Drives scale and brightness. */
  emphasis: Float32Array;
  /** 1 where the commit should be treated as falling. */
  falling: Float32Array;
  /** Legend rows for the UI, already ordered. */
  legend: { label: string; family: number; tone: number }[];
};

/** The file-type lens needs per-commit extensions, which GitHub's GraphQL API does not expose. */
export function lensAvailable(lens: LensName, tree: TreeStructure): boolean {
  if (lens !== 'fileType') return true;
  for (const oid of tree.order) if (tree.nodes.get(oid)!.commit.ext) return true;
  return false;
}

export function computeLens(tree: TreeStructure, lens: LensName): LensAttributes {
  const n = tree.order.length;
  const family = new Uint8Array(n);
  const tone = new Float32Array(n);
  const emphasis = new Float32Array(n);
  const falling = new Float32Array(n);
  const legend: { label: string; family: number; tone: number }[] = [];

  if (n === 0) return { family, tone, emphasis, falling, legend };

  const nodes = tree.order.map((oid) => tree.nodes.get(oid)!);
  const tMin = tree.timeRange.min;
  const tSpan = Math.max(1, tree.timeRange.max - tMin);
  const churnMax = Math.max(1, ...nodes.map((x) => x.commit.additions + x.commit.deletions));

  switch (lens) {
    case 'recency': {
      for (let i = 0; i < n; i++) {
        const age = (nodes[i].time - tMin) / tSpan;
        family[i] = 1;
        tone[i] = age;
        emphasis[i] = age * age;
      }
      legend.push({ label: 'First commit', family: 1, tone: 0 }, { label: 'Latest', family: 1, tone: 1 });
      break;
    }
    case 'author': {
      const authors = tree.stats.authors;
      const slot = new Map(authors.map((a, i) => [a, i]));
      for (let i = 0; i < n; i++) {
        const idx = slot.get(nodes[i].commit.author) ?? 0;
        // Golden-ratio spacing over the family so neighbouring contributors
        // never land on adjacent tones.
        family[i] = 2;
        tone[i] = ((idx * 0.61803398875) % 1 + 1) % 1;
        emphasis[i] = 0.5;
      }
      for (const a of authors.slice(0, 14)) {
        const idx = slot.get(a)!;
        legend.push({ label: a, family: 2, tone: ((idx * 0.61803398875) % 1 + 1) % 1 });
      }
      break;
    }
    case 'churn': {
      for (let i = 0; i < n; i++) {
        const churn = nodes[i].commit.additions + nodes[i].commit.deletions;
        const v = Math.sqrt(churn / churnMax);
        family[i] = 1;
        tone[i] = v;
        emphasis[i] = v;
      }
      legend.push({ label: 'Small edit', family: 1, tone: 0.1 }, { label: `${churnMax.toLocaleString('en-US')} lines`, family: 1, tone: 1 });
      break;
    }
    case 'deletions': {
      for (let i = 0; i < n; i++) {
        const c = nodes[i].commit;
        const net = c.additions - c.deletions;
        const mag = Math.sqrt(Math.min(1, Math.abs(net) / churnMax));
        family[i] = net < 0 ? 0 : 1;
        tone[i] = mag;
        emphasis[i] = net < 0 ? 0.85 : 0.25;
        // Net-negative commits are the ones that fall. The vertex shader does
        // the rest from a per-instance start time; no physics engine involved.
        falling[i] = net < 0 ? 1 : 0;
      }
      legend.push({ label: 'Net additions', family: 1, tone: 0.7 }, { label: 'Net deletions — falls', family: 0, tone: 0.7 });
      break;
    }
    case 'fileType': {
      const counts = new Map<string, number>();
      for (const node of nodes) {
        const e = node.commit.ext ?? 'unknown';
        counts.set(e, (counts.get(e) ?? 0) + 1);
      }
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
      const slot = new Map(ranked.map((e, i) => [e, i]));
      for (let i = 0; i < n; i++) {
        const e = nodes[i].commit.ext ?? 'unknown';
        const idx = slot.get(e) ?? 0;
        family[i] = 2;
        tone[i] = ((hash32(e) % 997) / 997 + idx * 0.13) % 1;
        emphasis[i] = 0.5;
      }
      for (const e of ranked.slice(0, 12)) {
        const idx = slot.get(e)!;
        legend.push({ label: e === 'none' ? 'no extension' : `.${e}`, family: 2, tone: ((hash32(e) % 997) / 997 + idx * 0.13) % 1 });
      }
      break;
    }
  }

  return { family, tone, emphasis, falling, legend };
}
