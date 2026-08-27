import type { RingUnit, TimeWindow, RingMark } from './types.js';

/* All calendar maths runs in UTC. Local time zones would make the same repo
 * render differently in Berlin and San Francisco, which breaks the promise that
 * a repo has one canonical shape. */

export const UNIT_MS: Record<RingUnit, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_629_746_000, // mean Gregorian month
  year: 31_556_952_000, // mean Gregorian year
};

export const UNIT_ORDER: RingUnit[] = ['hour', 'day', 'week', 'month', 'year'];

/** The unit whose boundaries get the heavier weight, so there is always a hierarchy. */
export const MAJOR_OF: Record<RingUnit, RingUnit | 'decade'> = {
  hour: 'day',
  day: 'month',
  week: 'month',
  month: 'year',
  year: 'decade',
};

/** Above this, minor rings are decimated so they never fuse into a solid band. */
export const MAX_RINGS = 160;

export function parseISO(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export function windowMs(w: TimeWindow): { start: number; end: number } {
  const start = parseISO(w.start);
  const end = parseISO(w.end);
  return end > start ? { start, end } : { start, end: start + UNIT_MS.hour };
}

/**
 * Finest unit that yields roughly 8 to 60 rings across the window. Never open at
 * a fixed granularity: a decade-old repo asked for hourly rings wants 87,000 of them.
 */
export function autoRingUnit(window: TimeWindow): RingUnit {
  const { start, end } = windowMs(window);
  const span = Math.max(1, end - start);
  for (const unit of UNIT_ORDER) {
    const rings = span / UNIT_MS[unit];
    if (rings >= 8 && rings <= 60) return unit;
  }
  // Nothing lands inside the band: take the unit that misses it by least, on a
  // log scale, so a three-day window opens at hours rather than falling all the
  // way through to years.
  let best: RingUnit = 'day';
  let bestMiss = Infinity;
  for (const unit of UNIT_ORDER) {
    const rings = span / UNIT_MS[unit];
    const miss = rings < 8 ? Math.log(8 / Math.max(rings, 1e-6)) : rings > 60 ? Math.log(rings / 60) : 0;
    if (miss < bestMiss) {
      bestMiss = miss;
      best = unit;
    }
  }
  return best;
}

/** Units that would render as a solid band across this window are offered disabled, not hidden. */
export function ringUnitEnabled(unit: RingUnit, window: TimeWindow): boolean {
  const { start, end } = windowMs(window);
  const rings = Math.max(1, end - start) / UNIT_MS[unit];
  return rings <= 4000;
}

/** Suggest stepping a unit finer or coarser. Returns the same unit when nothing should change. */
export function suggestRingUnit(current: RingUnit, window: TimeWindow): RingUnit {
  const { start, end } = windowMs(window);
  const rings = Math.max(1, end - start) / UNIT_MS[current];
  const i = UNIT_ORDER.indexOf(current);
  if (rings < 6 && i > 0) return UNIT_ORDER[i - 1];
  if (rings > 90 && i < UNIT_ORDER.length - 1) return UNIT_ORDER[i + 1];
  return current;
}

/* -------------------------------------------------------------------------- */
/* Compressed time                                                             */
/*                                                                            */
/* Never map timestamps linearly: a repo with a two-year dormant gap becomes a */
/* bare pole. Gaps longer than three ring units collapse to three ring units,  */
/* so bursts read as dense clusters and dead periods read as a short seam.     */
/* The clamp is tied to the ring unit because the right amount of compression  */
/* depends entirely on the timescale being viewed.                             */
/* -------------------------------------------------------------------------- */

export type TimeScale = {
  /** Real epoch ms -> normalized 0..1 height within the window. */
  height(t: number): number;
  /** Normalized 0..1 -> real epoch ms. Inverse of `height`, used by the scrubber readout. */
  timeAt(h: number): number;
  window: { start: number; end: number };
  maxGap: number;
};

/**
 * Build the scale from the commit timestamps that fall inside the window.
 * `times` need not be sorted; it is copied.
 */
export function buildTimeScale(times: number[], window: TimeWindow, ringUnit: RingUnit): TimeScale {
  const { start, end } = windowMs(window);
  const maxGap = UNIT_MS[ringUnit] * 3;

  // Knots are the window edges plus every distinct commit time inside it.
  const inside = times.filter((t) => t >= start && t <= end);
  const knots = Array.from(new Set([start, ...inside, end])).sort((a, b) => a - b);

  // Compressed axis: advance by min(realGap, maxGap) between consecutive knots.
  const compressed = new Float64Array(knots.length);
  for (let i = 1; i < knots.length; i++) {
    compressed[i] = compressed[i - 1] + Math.min(knots[i] - knots[i - 1], maxGap);
  }
  const totalCompressed = compressed[compressed.length - 1] || 1;
  const totalRoot = Math.sqrt(totalCompressed);

  const compressAt = (t: number): number => {
    if (t <= knots[0]) return 0;
    if (t >= knots[knots.length - 1]) return totalCompressed;
    let lo = 0;
    let hi = knots.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (knots[mid] <= t) lo = mid;
      else hi = mid;
    }
    const spanReal = knots[hi] - knots[lo];
    const spanComp = compressed[hi] - compressed[lo];
    const f = spanReal > 0 ? (t - knots[lo]) / spanReal : 0;
    return compressed[lo] + spanComp * f;
  };

  const expandAt = (c: number): number => {
    if (c <= 0) return knots[0];
    if (c >= totalCompressed) return knots[knots.length - 1];
    let lo = 0;
    let hi = compressed.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (compressed[mid] <= c) lo = mid;
      else hi = mid;
    }
    const spanComp = compressed[hi] - compressed[lo];
    const f = spanComp > 0 ? (c - compressed[lo]) / spanComp : 0;
    return knots[lo] + (knots[hi] - knots[lo]) * f;
  };

  return {
    window: { start, end },
    maxGap,
    height(t: number): number {
      const h = Math.sqrt(compressAt(t)) / totalRoot;
      return h < 0 ? 0 : h > 1 ? 1 : h;
    },
    timeAt(h: number): number {
      const clamped = h < 0 ? 0 : h > 1 ? 1 : h;
      return expandAt(Math.pow(clamped * totalRoot, 2));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Ring boundaries                                                             */
/* -------------------------------------------------------------------------- */

function floorTo(t: number, unit: RingUnit): number {
  const d = new Date(t);
  switch (unit) {
    case 'hour':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
    case 'day':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case 'week': {
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
      return day - dow * UNIT_MS.day;
    }
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case 'year':
      return Date.UTC(d.getUTCFullYear(), 0, 1);
  }
}

function advance(t: number, unit: RingUnit): number {
  const d = new Date(t);
  switch (unit) {
    case 'hour':
      return t + UNIT_MS.hour;
    case 'day':
      return t + UNIT_MS.day;
    case 'week':
      return t + UNIT_MS.week;
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    case 'year':
      return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function labelFor(t: number, unit: RingUnit): string {
  const d = new Date(t);
  switch (unit) {
    case 'hour':
      return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
    case 'day':
      return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    case 'week':
      return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    case 'month':
      // The apostrophe matters: "Jan 26" at month granularity would read as a
      // day of the month, which is the neighbouring unit's label.
      return `${MONTHS[d.getUTCMonth()]} ’${String(d.getUTCFullYear()).slice(2)}`;
    case 'year':
      return String(d.getUTCFullYear());
  }
}

function isMajor(t: number, unit: RingUnit): boolean {
  const major = MAJOR_OF[unit];
  const d = new Date(t);
  if (major === 'decade') return d.getUTCFullYear() % 10 === 0;
  return floorTo(t, major) === t;
}

/**
 * Ring boundaries within the window, placed on the compressed height axis.
 * Minor rings are decimated once they exceed MAX_RINGS so they never fuse into
 * a solid band; major rings always survive, which keeps the hierarchy readable
 * at any granularity.
 */
export function ringMarks(scale: TimeScale, unit: RingUnit): RingMark[] {
  const { start, end } = scale.window;
  const raw: { t: number; major: boolean; label: string }[] = [];
  let cursor = floorTo(start, unit);
  if (cursor < start) cursor = advance(cursor, unit);
  let guard = 0;
  while (cursor <= end && guard++ < 200_000) {
    raw.push({ t: cursor, major: isMajor(cursor, unit), label: labelFor(cursor, unit) });
    cursor = advance(cursor, unit);
  }

  const minorCount = raw.filter((r) => !r.major).length;
  const stride = minorCount > MAX_RINGS ? Math.ceil(minorCount / MAX_RINGS) : 1;

  const out: RingMark[] = [];
  let minorSeen = 0;
  for (const r of raw) {
    if (!r.major) {
      const keep = minorSeen % stride === 0;
      minorSeen++;
      if (!keep) continue;
    }
    const h = scale.height(r.t);
    // Boundaries that land on top of each other after compression add nothing.
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - h) < 0.0015 && !r.major) continue;
    out.push({ t: h, major: r.major, label: r.label });
  }
  return out;
}
