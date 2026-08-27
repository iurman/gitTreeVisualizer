import { parseSnapshot, type Commit, type RepoSnapshot } from '@gittree/core';

/* -------------------------------------------------------------------------- */
/* Repository access                                                           */
/*                                                                            */
/* Everything downstream of this file knows only that it has a RepoSnapshot.   */
/* The `source` field exists for a badge and nothing else. Adding v2's local    */
/* CLI means adding a sibling to this module that emits the same shape.        */
/* -------------------------------------------------------------------------- */

export type RepoRef = { owner: string; name: string };

const SHORTHAND = /^([\w.-]+)\/([\w.-]+)$/;

/** Accepts a full URL, a git remote, or `owner/repo`. */
export function parseRepoInput(raw: string): RepoRef | null {
  const s = raw.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (!s) return null;

  const short = SHORTHAND.exec(s);
  if (short) return { owner: short[1], name: short[2] };

  try {
    const url = new URL(s.startsWith('http') ? s : `https://${s}`);
    if (!/(^|\.)github\.com$/.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], name: parts[1].replace(/\.git$/, '') };
  } catch {
    return null;
  }
}

export class RepoError extends Error {
  constructor(message: string, readonly status: number, readonly hint?: string) {
    super(message);
    this.name = 'RepoError';
  }
}

export type FetchProgress = {
  snapshot: RepoSnapshot;
  /** True once every page has arrived. */
  complete: boolean;
  fetched: number;
};

type Page = {
  snapshot: RepoSnapshot;
  cursor: string | null;
  moreCommits?: Commit[];
};

/**
 * Progressive load. The first page carries enough commits for the seed state to
 * be ready immediately; the rest stream in while the reader takes in the
 * landing copy. Never a blocking spinner.
 */
export async function* fetchRepo(ref: RepoRef, signal?: AbortSignal): AsyncGenerator<FetchProgress> {
  let cursor: string | null = null;
  let merged: RepoSnapshot | null = null;
  let fetched = 0;

  for (let page = 0; page < 24; page++) {
    const url = new URL(`/api/repo/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`, location.origin);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url, { signal });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
      throw new RepoError(body.error ?? 'That repository could not be read.', res.status, body.hint);
    }
    const data = (await res.json()) as Page;
    const snap = parseSnapshot(data.snapshot);

    if (!merged) {
      merged = snap;
    } else {
      const prior: RepoSnapshot = merged;
      const seen = new Set<string>(prior.commits.map((c) => c.oid));
      const next: RepoSnapshot = {
        ...snap,
        commits: [...prior.commits, ...snap.commits.filter((c: Commit) => !seen.has(c.oid))],
        refs: dedupeRefs([...prior.refs, ...snap.refs]),
      };
      merged = next;
    }
    fetched = merged.commits.length;
    cursor = data.cursor;

    yield { snapshot: merged, complete: !cursor, fetched };
    if (!cursor) return;
  }
}

function dedupeRefs(refs: RepoSnapshot['refs']): RepoSnapshot['refs'] {
  const seen = new Set<string>();
  const out: RepoSnapshot['refs'] = [];
  for (const r of refs) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(r);
  }
  return out;
}

export const EXAMPLES: { ref: string; note: string }[] = [
  { ref: 'torvalds/linux', note: 'Merge topology at a scale nothing else reaches.' },
  { ref: 'rails/rails', note: 'Two decades of branches, most of them merged.' },
  { ref: 'python/cpython', note: 'A long trunk with deep, slow-growing limbs.' },
  { ref: 'godotengine/godot', note: 'Wide canopy, heavy churn, thousands of contributors.' },
  { ref: 'jquery/jquery', note: 'A finished tree. Growth stops, the shape stays.' },
  { ref: 'vuejs/core', note: 'Squash-merged. Branches reconstructed from pull requests.' },
];
