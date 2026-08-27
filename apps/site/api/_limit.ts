import type { ApiRequest } from './_types.js';

/* -------------------------------------------------------------------------- */
/* Per-IP rate limiting                                                        */
/*                                                                            */
/* Someone scripting random repositories should burn their own quota, not the  */
/* deployment's five thousand points an hour. This is a per-instance window,   */
/* which is best-effort across a fleet of lambdas; the CDN cache in front of   */
/* it does most of the real work, and Vercel KV would make it exact.           */
/* -------------------------------------------------------------------------- */

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 40;

const buckets = new Map<string, { count: number; resetAt: number }>();

export function clientIp(req: ApiRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw ?? 'unknown').split(',')[0].trim();
}

export function rateLimit(req: ApiRequest): { ok: boolean; retryAfter: number } {
  const key = clientIp(req);
  const now = Date.now();
  const b = buckets.get(key);

  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
    }
    return { ok: true, retryAfter: 0 };
  }
  b.count++;
  if (b.count > MAX_REQUESTS) return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}
