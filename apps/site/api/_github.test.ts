import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterError, FIRST_PAGE_COMMITS, PAGE_SIZE, fetchSnapshot, looksFlat } from './_github.js';

/* -------------------------------------------------------------------------- */
/* The adapter is the one place that talks to something we do not control, so  */
/* every way GitHub can answer badly gets a test. Two production incidents     */
/* came out of this file; both are pinned below.                               */
/* -------------------------------------------------------------------------- */

type Node = { oid: string; cursor: string };

const commitNode = (oid: string) => ({
  oid,
  committedDate: '2021-01-01T00:00:00Z',
  messageHeadline: `commit ${oid}`,
  additions: 1,
  deletions: 0,
  changedFilesIfAvailable: 1,
  parents: { nodes: [] },
  author: { name: 'Ada', email: 'ada@example.com' },
  associatedPullRequests: { nodes: [] },
});

/** A well-formed reply carrying `count` commits. */
function ok(count: number, { hasNextPage = false, endCursor = 'CUR', totalCount = 1000 } = {}) {
  return {
    data: {
      repository: {
        description: 'a repo',
        diskUsage: 100,
        defaultBranchRef: {
          name: 'main',
          target: {
            oid: 'head',
            history: {
              totalCount,
              pageInfo: { hasNextPage, endCursor },
              nodes: Array.from({ length: count }, (_, i) => commitNode(`c${i}`)),
            },
          },
        },
        refs: { nodes: [{ name: 'main', target: { oid: 'head' } }] },
      },
    },
  };
}

const requests: { page: number; cursor: string | null }[] = [];

function mockGitHub(replies: unknown[]) {
  requests.length = 0;
  let i = 0;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const { variables } = JSON.parse(init.body);
    requests.push({ page: variables.page, cursor: variables.cursor });
    const body = replies[Math.min(i++, replies.length - 1)];
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
}

process.env.GITHUB_TOKEN = 'test-token';

afterEach(() => vi.unstubAllGlobals());

describe('the GitHub adapter', () => {
  it('never asks for more than GitHub allows on a connection', async () => {
    mockGitHub([ok(PAGE_SIZE, { hasNextPage: true, endCursor: 'a' }), ok(PAGE_SIZE, { hasNextPage: true, endCursor: 'b' }), ok(PAGE_SIZE)]);
    await fetchSnapshot('acme', 'demo', null);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r.page).toBeLessThanOrEqual(100);
  });

  it('fills the first response over several queries', async () => {
    mockGitHub([
      ok(PAGE_SIZE, { hasNextPage: true, endCursor: 'a' }),
      ok(PAGE_SIZE, { hasNextPage: true, endCursor: 'b' }),
      ok(PAGE_SIZE, { hasNextPage: true, endCursor: 'c' }),
    ]);
    const { snapshot, cursor } = await fetchSnapshot('acme', 'demo', null);
    expect(snapshot.commits).toHaveLength(FIRST_PAGE_COMMITS);
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.cursor)).toEqual([null, 'a', 'b']);
    expect(cursor).toBe('c');
  });

  it('takes one query per later page', async () => {
    mockGitHub([ok(PAGE_SIZE, { hasNextPage: true, endCursor: 'z' })]);
    const { snapshot } = await fetchSnapshot('acme', 'demo', 'y');
    expect(requests).toHaveLength(1);
    expect(requests[0].cursor).toBe('y');
    expect(snapshot.commits).toHaveLength(PAGE_SIZE);
  });

  it('stops early when the history runs out', async () => {
    mockGitHub([ok(40, { hasNextPage: false })]);
    const { snapshot, cursor } = await fetchSnapshot('acme', 'demo', null);
    expect(snapshot.commits).toHaveLength(40);
    expect(cursor).toBeNull();
    expect(requests).toHaveLength(1);
  });

  /* The incident: `first: 300` is over GitHub's cap, so it nulls the field and
   * explains itself in `errors`. That was reported as an empty repository. */
  it('reports a field-level GraphQL error instead of calling the repository empty', async () => {
    mockGitHub([
      {
        data: { repository: { description: null, diskUsage: 1, defaultBranchRef: { name: 'main', target: null }, refs: { nodes: [] } } },
        errors: [{ message: 'first: must be less than or equal to 100' }],
      },
    ]);
    await expect(fetchSnapshot('vuejs', 'core', null)).rejects.toMatchObject({
      status: 502,
      hint: 'first: must be less than or equal to 100',
    });
  });

  it('still calls a genuinely empty repository empty', async () => {
    mockGitHub([{ data: { repository: { description: null, diskUsage: 1, defaultBranchRef: null, refs: { nodes: [] } } } }]);
    await expect(fetchSnapshot('acme', 'fresh', null)).rejects.toMatchObject({ status: 422 });
  });

  it('reports a missing repository as missing', async () => {
    mockGitHub([{ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] }]);
    await expect(fetchSnapshot('acme', 'nope', null)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an absurdly large repository rather than timing out', async () => {
    const huge = ok(PAGE_SIZE);
    huge.data.repository.diskUsage = 99_000_000;
    mockGitHub([huge]);
    await expect(fetchSnapshot('acme', 'huge', null)).rejects.toMatchObject({ status: 413 });
  });

  it('surfaces a refused token as a server-side problem', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response);
    await expect(fetchSnapshot('acme', 'demo', null)).rejects.toBeInstanceOf(AdapterError);
  });

  it('spots a squash-merged history', () => {
    const linear = Array.from({ length: 60 }, (_, i) => ({
      oid: `c${i}`, parents: i ? [`c${i - 1}`] : [], author: 'a', authorEmail: 'a@b.c',
      date: '2021-01-01T00:00:00Z', subject: 's', additions: 1, deletions: 0, filesChanged: 1,
    }));
    expect(looksFlat(linear)).toBe(true);
    const merged = linear.map((c, i) => (i % 5 === 0 ? { ...c, parents: [...c.parents, 'x'] } : c));
    expect(looksFlat(merged)).toBe(false);
  });
});
