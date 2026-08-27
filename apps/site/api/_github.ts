import type { Commit, Ref, RepoSnapshot } from '@gittree/core';

/* -------------------------------------------------------------------------- */
/* The GitHub adapter                                                          */
/*                                                                            */
/* GraphQL, not REST: REST needs one request per commit to get diff stats,     */
/* which is a thousand round trips for a medium repository. Everything here    */
/* exists to produce one RepoSnapshot; nothing downstream knows this file      */
/* exists. v2's local CLI is a sibling of this module, not a change to it.     */
/* -------------------------------------------------------------------------- */

export const PAGE_SIZE = 100;
export const FIRST_PAGE_COMMITS = 300;
export const MAX_COMMITS = 2000;

/** A repository this large is refused with clear copy rather than timing out. */
const MAX_DISK_USAGE_KB = 20_000_000;

const QUERY = `
query($owner:String!, $name:String!, $cursor:String, $page:Int!) {
  rateLimit { remaining resetAt }
  repository(owner:$owner, name:$name) {
    description
    diskUsage
    defaultBranchRef {
      name
      target { ... on Commit {
        oid
        history(first:$page, after:$cursor) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            oid committedDate messageHeadline
            additions deletions changedFilesIfAvailable
            parents(first:8) { nodes { oid } }
            author { name email }
            associatedPullRequests(first:1) { nodes { number commits { totalCount } } }
          }
        }
      }}
    }
    refs(refPrefix:"refs/heads/", first:100) {
      nodes { name target { ... on Commit { oid } } }
    }
  }
}`;

type GqlCommit = {
  oid: string;
  committedDate: string;
  messageHeadline: string;
  additions: number | null;
  deletions: number | null;
  changedFilesIfAvailable: number | null;
  parents: { nodes: { oid: string }[] };
  author: { name: string | null; email: string | null } | null;
  associatedPullRequests: { nodes: { number: number; commits: { totalCount: number } }[] };
};

type GqlResponse = {
  data?: {
    rateLimit?: { remaining: number; resetAt: string };
    repository: {
      description: string | null;
      diskUsage: number | null;
      defaultBranchRef: {
        name: string;
        target: {
          oid: string;
          history: {
            totalCount: number;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: GqlCommit[];
          };
        } | null;
      } | null;
      refs: { nodes: { name: string; target: { oid: string } | null }[] } | null;
    } | null;
  };
  errors?: { type?: string; message: string }[];
};

export class AdapterError extends Error {
  constructor(readonly status: number, message: string, readonly hint?: string) {
    super(message);
  }
}

export type FetchResult = {
  snapshot: RepoSnapshot;
  cursor: string | null;
  headSha: string;
};

export async function fetchSnapshot(
  owner: string,
  name: string,
  cursor: string | null,
): Promise<FetchResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new AdapterError(500, 'The server is missing its GitHub credentials.', 'Set GITHUB_TOKEN and redeploy.');
  }

  // The first page is deliberately smaller so the seed state is ready fast; the
  // rest streams in while the reader takes in the landing copy.
  const page = cursor ? PAGE_SIZE : Math.min(FIRST_PAGE_COMMITS, MAX_COMMITS);

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'tree.isaacurman.com',
    },
    body: JSON.stringify({ query: QUERY, variables: { owner, name, cursor, page } }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new AdapterError(503, 'GitHub turned the request away.', 'This usually means the API budget is spent. Try again shortly.');
  }
  if (!res.ok) {
    throw new AdapterError(502, 'GitHub did not answer.', `It replied ${res.status}.`);
  }

  const body = (await res.json()) as GqlResponse;
  const notFound = body.errors?.some((e) => e.type === 'NOT_FOUND');
  const repo = body.data?.repository;
  if (notFound || !repo) {
    throw new AdapterError(404, 'Repository not found, or it is private. Only public repositories are supported.');
  }
  if ((repo.diskUsage ?? 0) > MAX_DISK_USAGE_KB) {
    throw new AdapterError(
      413,
      'That repository is too large to read here.',
      'Repositories over about twenty gigabytes are refused rather than timing out.',
    );
  }

  const branch = repo.defaultBranchRef;
  const history = branch?.target?.history;
  if (!branch || !history) {
    throw new AdapterError(422, 'That repository has no commits yet.', 'There is nothing to grow from an empty history.');
  }

  const commits: Commit[] = history.nodes.map(toCommit);
  const refs: Ref[] = (repo.refs?.nodes ?? [])
    .filter((r): r is { name: string; target: { oid: string } } => !!r.target)
    .map((r) => ({ name: r.name, oid: r.target.oid, kind: 'branch' as const }));

  const truncated = history.totalCount > MAX_COMMITS;
  const nextCursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;

  const snapshot: RepoSnapshot = {
    schemaVersion: 1,
    name: `${owner}/${name}`,
    description: repo.description,
    head: branch.target?.oid ?? commits[0]?.oid ?? '',
    defaultBranch: branch.name,
    source: 'github',
    truncated,
    generatedAt: new Date().toISOString(),
    commits,
    refs,
  };

  return { snapshot, cursor: nextCursor, headSha: snapshot.head };
}

function toCommit(n: GqlCommit): Commit {
  const pr = n.associatedPullRequests.nodes[0];
  return {
    oid: n.oid,
    parents: n.parents.nodes.map((p) => p.oid),
    author: n.author?.name ?? 'unknown',
    authorEmail: n.author?.email ?? '',
    date: n.committedDate,
    subject: n.messageHeadline,
    additions: Math.max(0, n.additions ?? 0),
    deletions: Math.max(0, n.deletions ?? 0),
    filesChanged: Math.max(0, n.changedFilesIfAvailable ?? 0),
    ...(pr ? { prNumber: pr.number, prCommitCount: pr.commits.totalCount } : {}),
  };
}

/**
 * The file tree at HEAD, fetched only when the history has no recoverable
 * branch structure and directory mode is going to be needed. One REST call,
 * because GraphQL has no recursive tree traversal and this is a single request
 * either way.
 */
export async function fetchTree(owner: string, name: string, sha: string): Promise<RepoSnapshot['tree']> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return undefined;
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${name}/git/trees/${sha}?recursive=1`, {
      headers: {
        authorization: `bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'tree.isaacurman.com',
      },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { tree?: { path: string; type: string; size?: number }[] };
    return (body.tree ?? [])
      .filter((e) => e.type === 'blob')
      .slice(0, 3000)
      .map((e) => ({ path: e.path, size: e.size ?? 0 }));
  } catch {
    return undefined;
  }
}

/** True when the history looks squash-merged and directory mode may be needed. */
export function looksFlat(commits: Commit[]): boolean {
  if (commits.length < 20) return true;
  const merges = commits.filter((c) => c.parents.length >= 2).length;
  const withPr = commits.filter((c) => c.prNumber && (c.prCommitCount ?? 0) > 1).length;
  return merges / commits.length < 0.02 && withPr / commits.length < 0.1;
}
