import { describe, expect, it } from 'vitest';
import { SnapshotError, isSnapshot, parseSnapshot } from './snapshot.js';
import type { RepoSnapshot } from './types.js';

/* -------------------------------------------------------------------------- */
/* The adapter boundary                                                        */
/*                                                                            */
/* This check replaced a schema library, so it is tested the way the library   */
/* was trusted: every field, every wrong type, and the awkward values that a   */
/* hand-written validator gets wrong if it reaches for `typeof x === 'number'` */
/* and stops thinking — NaN, Infinity, 1.5, null where undefined was meant.    */
/* -------------------------------------------------------------------------- */

const commit = () => ({
  oid: 'a'.repeat(40),
  parents: ['b'.repeat(40)],
  author: 'Ada Lovelace',
  authorEmail: 'ada@example.com',
  date: '2016-03-03T00:00:00.000Z',
  subject: 'Add the worker',
  additions: 12,
  deletions: 0,
  filesChanged: 2,
});

const snapshot = (): RepoSnapshot =>
  ({
    schemaVersion: 1,
    name: 'acme/repo',
    description: null,
    head: 'a'.repeat(40),
    defaultBranch: 'main',
    source: 'github',
    truncated: false,
    generatedAt: '2016-03-03T00:00:00.000Z',
    commits: [commit()],
    refs: [{ name: 'main', oid: 'a'.repeat(40), kind: 'branch' }],
  }) as RepoSnapshot;

/** Replace one field, at any depth, and expect the parse to fail there. */
function reject(mutate: (s: Record<string, unknown>) => void, path: string): void {
  const s = snapshot() as unknown as Record<string, unknown>;
  mutate(s);
  expect(() => parseSnapshot(s)).toThrow(SnapshotError);
  try {
    parseSnapshot(s);
  } catch (e) {
    expect((e as SnapshotError).path).toBe(path);
  }
}

describe('parseSnapshot', () => {
  it('accepts a well-formed snapshot and hands back the same object', () => {
    const s = snapshot();
    expect(parseSnapshot(s)).toBe(s);
  });

  it('accepts every optional field, present or absent', () => {
    const s = snapshot() as unknown as Record<string, unknown>;
    s.description = 'A repository';
    s.tree = [{ path: 'src/index.ts', size: 0 }];
    (s.commits as Record<string, unknown>[])[0].prNumber = 4;
    (s.commits as Record<string, unknown>[])[0].prCommitCount = 2;
    (s.commits as Record<string, unknown>[])[0].ext = 'ts';
    expect(() => parseSnapshot(s)).not.toThrow();
  });

  it('accepts a root commit, which has no parents', () => {
    const s = snapshot();
    s.commits[0].parents = [];
    expect(() => parseSnapshot(s)).not.toThrow();
  });

  it('rejects things that are not objects at all', () => {
    for (const v of [null, undefined, 4, 'snapshot', [], true]) {
      expect(() => parseSnapshot(v)).toThrow(SnapshotError);
    }
  });

  it('names the field that failed, so the seam is worth having', () => {
    reject((s) => void (s.schemaVersion = 2), 'snapshot.schemaVersion');
    reject((s) => void delete s.schemaVersion, 'snapshot.schemaVersion');
    reject((s) => void (s.name = 12), 'snapshot.name');
    reject((s) => void (s.description = 12), 'snapshot.description');
    reject((s) => void (s.head = null), 'snapshot.head');
    reject((s) => void (s.source = 'gitlab'), 'snapshot.source');
    reject((s) => void (s.truncated = 'no'), 'snapshot.truncated');
    reject((s) => void (s.commits = {}), 'snapshot.commits');
    reject((s) => void (s.refs = undefined), 'snapshot.refs');
  });

  it('names the failing commit by index', () => {
    reject((s) => {
      (s.commits as unknown[]).push({ ...commit(), oid: '' });
    }, 'snapshot.commits[1].oid');
    reject((s) => {
      (s.commits as unknown[])[0] = { ...commit(), additions: -1 };
    }, 'snapshot.commits[0].additions');
    reject((s) => {
      (s.commits as unknown[])[0] = { ...commit(), parents: ['ok', ''] };
    }, 'snapshot.commits[0].parents[1]');
    reject((s) => {
      (s.commits as unknown[])[0] = { ...commit(), parents: 'abc' };
    }, 'snapshot.commits[0].parents');
  });

  it('rejects counts that are numbers but not whole ones', () => {
    for (const bad of [1.5, NaN, Infinity, -Infinity, '3', null]) {
      reject((s) => {
        (s.commits as unknown[])[0] = { ...commit(), filesChanged: bad };
      }, 'snapshot.commits[0].filesChanged');
    }
  });

  it('treats an optional number as absent-or-valid, never as null', () => {
    const ok = snapshot();
    ok.commits[0].prNumber = undefined;
    expect(() => parseSnapshot(ok)).not.toThrow();
    reject((s) => {
      (s.commits as unknown[])[0] = { ...commit(), prNumber: null };
    }, 'snapshot.commits[0].prNumber');
    reject((s) => {
      (s.commits as unknown[])[0] = { ...commit(), prNumber: 0 };
    }, 'snapshot.commits[0].prNumber');
  });

  it('checks refs, including the kind enum', () => {
    reject((s) => {
      (s.refs as unknown[])[0] = { name: 'main', oid: 'x', kind: 'head' };
    }, 'snapshot.refs[0].kind');
    reject((s) => {
      (s.refs as unknown[])[0] = { name: 'main', oid: '', kind: 'branch' };
    }, 'snapshot.refs[0].oid');
  });

  it('checks the optional file tree only when it is there', () => {
    expect(() => parseSnapshot(snapshot())).not.toThrow();
    reject((s) => void (s.tree = [{ path: 'a', size: -1 }]), 'snapshot.tree[0].size');
    reject((s) => void (s.tree = [{ path: 4, size: 0 }]), 'snapshot.tree[0].path');
    reject((s) => void (s.tree = 'src'), 'snapshot.tree');
  });

  it('reads as a message a person can act on', () => {
    const s = snapshot() as unknown as Record<string, unknown>;
    s.source = 'gitlab';
    expect(() => parseSnapshot(s)).toThrow(/snapshot\.source: expected one of github, local, got "gitlab"/);
  });

  it('narrows rather than throwing, for callers that prefer to branch', () => {
    expect(isSnapshot(snapshot())).toBe(true);
    expect(isSnapshot({ schemaVersion: 1 })).toBe(false);
  });

  it('walks a large snapshot without choking', () => {
    const s = snapshot();
    s.commits = Array.from({ length: 5000 }, (_, i) => ({ ...commit(), oid: String(i).padStart(40, '0') }));
    expect(() => parseSnapshot(s)).not.toThrow();
  });
});
