import type { Commit, Ref, RepoSnapshot } from './types.js';

/* -------------------------------------------------------------------------- */
/* The adapter boundary                                                        */
/*                                                                            */
/* Anything claiming to be a RepoSnapshot passes through here first, so         */
/* malformed data fails at the seam instead of deep inside layout code where   */
/* the stack trace means nothing.                                              */
/*                                                                            */
/* This used to be a Zod schema, and Zod was the largest single thing in the   */
/* browser bundle — around 250 kB of source, pulling in a JSON-Schema exporter */
/* and a regex library that this project never calls, to validate a response   */
/* from an API in the same repository. A schema library earns that when the    */
/* shape is negotiated with someone else or changes often. This one is neither: */
/* it is eleven fields, it is ours at both ends, and the check below is the     */
/* whole of it with better messages, no dependency, and roughly a tenth of the  */
/* time on a phone parsing two thousand commits.                               */
/*                                                                            */
/* It validates rather than coerces, and returns the input rather than a copy: */
/* copying two thousand commit objects to strip fields nobody reads is work    */
/* for its own sake.                                                           */
/* -------------------------------------------------------------------------- */

export class SnapshotError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'SnapshotError';
  }
}

type Obj = Record<string, unknown>;

function object(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new SnapshotError(path, `expected an object, got ${describe(v)}`);
  }
  return v as Obj;
}

function array(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new SnapshotError(path, `expected an array, got ${describe(v)}`);
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new SnapshotError(path, `expected a string, got ${describe(v)}`);
  return v;
}

function nonEmpty(v: unknown, path: string): string {
  const s = str(v, path);
  if (s.length === 0) throw new SnapshotError(path, 'expected a non-empty string');
  return s;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new SnapshotError(path, `expected a boolean, got ${describe(v)}`);
  return v;
}

/** A whole number at or above `min`. NaN and Infinity are not integers. */
function int(v: unknown, path: string, min: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new SnapshotError(path, `expected a whole number, got ${describe(v)}`);
  }
  if (v < min) throw new SnapshotError(path, `expected at least ${min}, got ${v}`);
  return v;
}

function optionalInt(v: unknown, path: string, min: number): number | undefined {
  return v === undefined ? undefined : int(v, path, min);
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  const s = str(v, path);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new SnapshotError(path, `expected one of ${allowed.join(', ')}, got ${JSON.stringify(s)}`);
  }
  return s as T;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (Number.isNaN(v)) return 'NaN';
  return typeof v;
}

function checkCommit(v: unknown, path: string): void {
  const c = object(v, path);
  nonEmpty(c.oid, `${path}.oid`);
  const parents = array(c.parents, `${path}.parents`);
  for (let i = 0; i < parents.length; i++) nonEmpty(parents[i], `${path}.parents[${i}]`);
  str(c.author, `${path}.author`);
  str(c.authorEmail, `${path}.authorEmail`);
  str(c.date, `${path}.date`);
  str(c.subject, `${path}.subject`);
  int(c.additions, `${path}.additions`, 0);
  int(c.deletions, `${path}.deletions`, 0);
  int(c.filesChanged, `${path}.filesChanged`, 0);
  optionalInt(c.prNumber, `${path}.prNumber`, 1);
  optionalInt(c.prCommitCount, `${path}.prCommitCount`, 1);
  if (c.ext !== undefined) str(c.ext, `${path}.ext`);
}

function checkRef(v: unknown, path: string): void {
  const r = object(v, path);
  str(r.name, `${path}.name`);
  nonEmpty(r.oid, `${path}.oid`);
  oneOf(r.kind, `${path}.kind`, ['branch', 'tag', 'remote'] as const);
}

/**
 * Validate an untrusted value as a RepoSnapshot, throwing SnapshotError with
 * the path of the first field that does not hold up.
 */
export function parseSnapshot(input: unknown): RepoSnapshot {
  const s = object(input, 'snapshot');

  if (s.schemaVersion !== 1) {
    throw new SnapshotError('snapshot.schemaVersion', `expected 1, got ${JSON.stringify(s.schemaVersion)}`);
  }
  str(s.name, 'snapshot.name');
  if (s.description !== null) str(s.description, 'snapshot.description');
  str(s.head, 'snapshot.head');
  str(s.defaultBranch, 'snapshot.defaultBranch');
  oneOf(s.source, 'snapshot.source', ['github', 'local'] as const);
  bool(s.truncated, 'snapshot.truncated');
  str(s.generatedAt, 'snapshot.generatedAt');

  const commits = array(s.commits, 'snapshot.commits');
  for (let i = 0; i < commits.length; i++) checkCommit(commits[i], `snapshot.commits[${i}]`);

  const refs = array(s.refs, 'snapshot.refs');
  for (let i = 0; i < refs.length; i++) checkRef(refs[i], `snapshot.refs[${i}]`);

  if (s.tree !== undefined) {
    const tree = array(s.tree, 'snapshot.tree');
    for (let i = 0; i < tree.length; i++) {
      const entry = object(tree[i], `snapshot.tree[${i}]`);
      str(entry.path, `snapshot.tree[${i}].path`);
      const size = entry.size;
      if (typeof size !== 'number' || Number.isNaN(size) || size < 0) {
        throw new SnapshotError(`snapshot.tree[${i}].size`, `expected a non-negative number, got ${describe(size)}`);
      }
    }
  }

  return input as RepoSnapshot;
}

/** Narrowing form, for callers that would rather branch than catch. */
export function isSnapshot(input: unknown): input is RepoSnapshot {
  try {
    parseSnapshot(input);
    return true;
  } catch {
    return false;
  }
}

export type { Commit, Ref, RepoSnapshot };
