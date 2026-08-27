import type { Poi, TreeStructure } from './types.js';

const DAY = 86_400_000;

function fmt(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * Jump targets, precomputed here so the viewer never scans commits at
 * interaction time. Everything is derived from the snapshot, so the same repo
 * always offers the same places to go.
 */
export function pointsOfInterest(tree: TreeStructure): Poi[] {
  const out: Poi[] = [];
  const real = tree.order.map((oid) => tree.nodes.get(oid)!).filter((n) => !n.synthetic);
  if (real.length === 0) return out;

  const oldest = real[0];
  const newest = real[real.length - 1];

  out.push({
    kind: 'oldest',
    oid: oldest.oid,
    title: 'The first commit',
    detail: `${fmt(oldest.time)} — ${oldest.commit.subject}`,
  });
  out.push({
    kind: 'newest',
    oid: newest.oid,
    title: 'The latest commit',
    detail: `${fmt(newest.time)} — ${newest.commit.subject}`,
  });

  let biggest = real[0];
  let deepest = real[0];
  for (const n of real) {
    if (n.commit.additions + n.commit.deletions > biggest.commit.additions + biggest.commit.deletions) biggest = n;
    if (n.commit.deletions > deepest.commit.deletions) deepest = n;
  }
  if (biggest.commit.additions + biggest.commit.deletions > 0) {
    out.push({
      kind: 'largestEdit',
      oid: biggest.oid,
      title: 'The largest edit',
      detail: `${plural(biggest.commit.additions + biggest.commit.deletions, 'line')} across ${plural(biggest.commit.filesChanged, 'file')}`,
    });
  }
  if (deepest.commit.deletions > 0) {
    out.push({
      kind: 'largestDeletion',
      oid: deepest.oid,
      title: 'The heaviest deletion',
      detail: `${plural(deepest.commit.deletions, 'line')} removed — ${deepest.commit.subject}`,
    });
  }

  // Longest-lived branch: the limb whose commits span the most wall-clock time.
  let bestLimb: { id: number; span: number; tip: string; label: string } | null = null;
  for (const limb of tree.limbs) {
    if (limb.parentLimb === null || limb.commits.length < 2) continue;
    const first = tree.nodes.get(limb.commits[0]);
    const last = tree.nodes.get(limb.commits[limb.commits.length - 1]);
    if (!first || !last) continue;
    const span = last.time - first.time;
    if (!bestLimb || span > bestLimb.span) bestLimb = { id: limb.id, span, tip: last.oid, label: limb.label };
  }
  if (bestLimb && bestLimb.span > 0) {
    out.push({
      kind: 'longestBranch',
      oid: bestLimb.tip,
      title: 'The longest-lived branch',
      detail: `${bestLimb.label} — open for ${plural(Math.round(bestLimb.span / DAY), 'day')}`,
    });
  }

  // Busiest day, by commit count.
  const byDay = new Map<string, { count: number; oid: string }>();
  for (const n of real) {
    const key = fmt(n.time);
    const cur = byDay.get(key) ?? { count: 0, oid: n.oid };
    cur.count++;
    byDay.set(key, cur);
  }
  let busiest: { day: string; count: number; oid: string } | null = null;
  for (const [day, v] of byDay) {
    if (!busiest || v.count > busiest.count) busiest = { day, count: v.count, oid: v.oid };
  }
  if (busiest && busiest.count > 1) {
    out.push({
      kind: 'busiestDay',
      oid: busiest.oid,
      title: 'The busiest day',
      detail: `${busiest.day} — ${plural(busiest.count, 'commit')}`,
    });
  }

  // First commit by each contributor, capped so the list stays navigable.
  const firstBy = new Map<string, { oid: string; time: number }>();
  for (const n of real) {
    const prev = firstBy.get(n.commit.author);
    if (!prev || n.time < prev.time) firstBy.set(n.commit.author, { oid: n.oid, time: n.time });
  }
  const arrivals = [...firstBy.entries()].sort((a, b) => a[1].time - b[1].time).slice(0, 12);
  for (const [author, v] of arrivals) {
    out.push({
      kind: 'firstByAuthor',
      oid: v.oid,
      title: `${author} arrives`,
      detail: `First commit, ${fmt(v.time)}`,
    });
  }

  return out;
}
