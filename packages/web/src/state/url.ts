import { autoRingUnit, type LayoutMode, type LensName, type RingUnit, type TimeWindow } from '@gittree/core';

/* -------------------------------------------------------------------------- */
/* URL state                                                                   */
/*                                                                            */
/* Every state is linkable. Two things are omitted deliberately: the window,   */
/* when it covers the whole history, so the common link stays short; and the   */
/* ring unit, when it matches the auto-selected default, so a shared link stays */
/* correct if the repository gains commits later.                              */
/* -------------------------------------------------------------------------- */

export type UrlState = {
  owner: string | null;
  name: string | null;
  mode: LayoutMode;
  lens: LensName;
  at: string | null;
  t: number;
  ring: RingUnit | null;
  from: string | null;
  to: string | null;
};

const MODES: LayoutMode[] = ['tree3d', 'tree2d', 'byAuthor', 'byChurn', 'timeline'];
const LENSES: LensName[] = ['author', 'recency', 'churn', 'deletions', 'fileType'];
const RINGS: RingUnit[] = ['hour', 'day', 'week', 'month', 'year'];

export function readUrl(loc: Location = location): UrlState {
  const parts = loc.pathname.split('/').filter(Boolean);
  const q = new URLSearchParams(loc.search);
  const pick = <T extends string>(key: string, allowed: T[], fallback: T): T => {
    const v = q.get(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  };
  const ringRaw = q.get('ring') as RingUnit | null;
  // A missing `t` means the whole history, not zero. Number(null) is 0, which
  // is both finite and in range, so the presence check has to come first.
  const t = q.has('t') ? Number(q.get('t')) : 1;

  return {
    owner: parts[0] ?? null,
    name: parts[1] ?? null,
    mode: pick('mode', MODES, 'tree3d'),
    lens: pick('lens', LENSES, 'recency'),
    at: q.get('at'),
    t: Number.isFinite(t) && t >= 0 && t <= 1 ? t : 1,
    ring: ringRaw && RINGS.includes(ringRaw) ? ringRaw : null,
    from: q.get('from'),
    to: q.get('to'),
  };
}

export function buildUrl(s: UrlState, fullWindow: TimeWindow): string {
  const q = new URLSearchParams();
  if (s.mode !== 'tree3d') q.set('mode', s.mode);
  if (s.lens !== 'recency') q.set('lens', s.lens);
  if (s.at) q.set('at', s.at);
  if (s.t < 0.999) q.set('t', s.t.toFixed(3));

  const windowed = s.from !== null && s.to !== null && (s.from !== fullWindow.start || s.to !== fullWindow.end);
  if (windowed) {
    q.set('from', s.from!);
    q.set('to', s.to!);
  }
  // Only pin the ring unit when the reader chose something other than the default.
  const auto = autoRingUnit(windowed ? { start: s.from!, end: s.to! } : fullWindow);
  if (s.ring && s.ring !== auto) q.set('ring', s.ring);

  const path = s.owner && s.name ? `/${s.owner}/${s.name}` : '/';
  const query = q.toString();
  return query ? `${path}?${query}` : path;
}

let writeTimer: number | undefined;

/** Debounced, and always a replace: scrubbing must not fill the back button. */
export function writeUrl(url: string): void {
  window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(() => {
    if (location.pathname + location.search !== url) history.replaceState(null, '', url);
  }, 220);
}
