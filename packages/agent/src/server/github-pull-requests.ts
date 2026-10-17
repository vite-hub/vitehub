import * as v from "valibot"
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts"
import { createHash } from "node:crypto";
import { consoleInvocationUrl, resolvePublicUrl } from "@vite-hub/runtime";
import type { GitHubHost } from "./github-host.ts";

export type PullRequestFeedback = {
  comments: string;
  reviews: string;
  threads: string;
  hasDiscussion: boolean;
};

export type PullRequest = {
  baseRefOid: string;
  baseRefName: string;
  body: string;
  feedback?: PullRequestFeedback;
  headRefName: string;
  headRefOid: string;
  headRepository: { nameWithOwner: string } | null;
  isDraft: boolean;
  labels: { name: string }[];
  mergeStateStatus: string;
  number: number;
  reviewDecision: string | null;
  /** Required checks and statuses of the head commit, read when the full rollup has not passed. */
  requiredStatusCheckRollup?: unknown[];
  state: string;
  /** Check runs (`name`, `status`, `conclusion`) and statuses (`context`, `state`) of the head commit. */
  statusCheckRollup: unknown[];
  title: string;
  updatedAt: string;
  url: string;
};

type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
export type GitHubPullRequestComment = {
  id: string;
  body: string;
  updatedAt: string;
  author?: { login: string } | null;
};
type FeedbackReview = {
  id: string;
  body: string;
  updatedAt: string;
  state: string;
  commit: { oid: string } | null;
};
type FeedbackThread = { id: string; isResolved: boolean; comments: Connection<GitHubPullRequestComment> };
type FeedbackNode = {
  comments: Connection<GitHubPullRequestComment>;
  reviews: Connection<FeedbackReview>;
  reviewThreads: Connection<FeedbackThread>;
};

const rollupFields = "commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}";
const pullRequestFields = `baseRefOid baseRefName body headRefName headRefOid headRepository{nameWithOwner} isDraft labels(first:100){nodes{name}} mergeStateStatus number reviewDecision state title updatedAt url ${rollupFields}`;
const feedbackFields = "comments(first:100,after:$comments){nodes{id body updatedAt author{login}} pageInfo{hasNextPage endCursor}} reviews(first:100,after:$reviews){nodes{id body updatedAt state commit{oid}} pageInfo{hasNextPage endCursor}} reviewThreads(first:100,after:$threads){nodes{id isResolved comments(first:20){nodes{id body updatedAt} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}";

const rollupSchema = v.object({
  nodes: v.array(v.object({ commit: v.object({ statusCheckRollup: v.nullable(v.object({ contexts: v.object({ nodes: v.array(v.unknown()) }) })) }) })),
});
const pullRequestSchema = v.pipe(v.object({
  baseRefOid: v.string(),
  baseRefName: v.string(),
  body: v.string(),
  headRefName: v.string(),
  headRefOid: v.string(),
  headRepository: v.nullable(v.object({ nameWithOwner: v.string() })),
  isDraft: v.boolean(),
  labels: v.object({ nodes: v.array(v.object({ name: v.string() })) }),
  mergeStateStatus: v.string(),
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  reviewDecision: v.nullable(v.string()),
  state: v.string(),
  commits: rollupSchema,
  title: v.string(),
  updatedAt: v.string(),
  url: v.string(),
}), v.transform(({ commits, labels, ...pullRequest }): PullRequest => ({
  ...pullRequest,
  labels: labels.nodes,
  statusCheckRollup: commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [],
})));

function repositoryParts(repository: string) {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra !== undefined) throw new Error("Expected a GitHub owner/repository.");
  return { owner, name };
}

function record(value: unknown): Record<string, unknown> {
  if (!isRuntimeRecord(value)) throw new Error("Incomplete GitHub response.")
  return value
}
function text(value: unknown): string {
  if (!hasRuntimeType(value, "string")) throw new Error("GitHub returned an invalid string field.")
  return value
}
function boolean(value: unknown): boolean {
  if (!hasRuntimeType(value, "boolean")) throw new Error("GitHub returned an invalid boolean field.")
  return value
}
function field(value: unknown, ...path: string[]): unknown {
  for (const key of path) value = record(value)[key]
  return value
}
function parseConnection<T>(value: unknown, parse: (item: unknown) => T): Connection<T> {
  const connection = record(value)
  if (!Array.isArray(connection.nodes)) throw new Error("Incomplete GitHub connection.")
  const page = record(connection.pageInfo)
  const hasNextPage = boolean(page.hasNextPage)
  const endCursor = page.endCursor === null ? "" : text(page.endCursor)
  if (hasNextPage && !endCursor) throw new Error("GitHub omitted a pagination cursor.")
  return { nodes: connection.nodes.map(parse), pageInfo: { hasNextPage, endCursor } }
}
function parseComment(value: unknown): GitHubPullRequestComment {
  const item = record(value)
  return { id: text(item.id), body: text(item.body), updatedAt: text(item.updatedAt), author: item.author == null ? null : { login: text(record(item.author).login) } }
}
function parseFeedback(value: unknown): FeedbackNode {
  const node = record(value)
  return {
    comments: parseConnection(node.comments, parseComment),
    reviews: parseConnection(node.reviews, value => {
      const item = record(value)
      return { id: text(item.id), body: text(item.body), updatedAt: text(item.updatedAt), state: text(item.state), commit: item.commit === null ? null : { oid: text(record(item.commit).oid) } }
    }),
    reviewThreads: parseConnection(node.reviewThreads, value => {
      const item = record(value)
      return { id: text(item.id), isResolved: boolean(item.isResolved), comments: parseConnection(item.comments, parseComment) }
    }),
  }
}

/** Read PR state and fully paginated feedback with the host's Forge credentials. */
export function createGitHubPullRequests(
  github: Pick<GitHubHost, "forge">,
  options: { activityAuthors?: readonly string[], ignoreComment?: (comment: GitHubPullRequestComment) => boolean } = {},
): {
  list(repository: string): Promise<PullRequest[]>;
  read(repository: string, number: number): Promise<PullRequest>;
} {
  async function graphql(repository: string, query: string, variables: Record<string, string | number | null>): Promise<unknown> {
    const forge = await github.forge({ repository });
    const operationName = /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query)?.[1]
    const response = (await forge.request<unknown>("POST", "/graphql", { body: { query, variables, ...(operationName ? { operationName } : {}) } })).data
    if (isRuntimeRecord(response) && Array.isArray(response.errors) && response.errors.length) throw new Error("GitHub could not complete the pull request query.")
    return isRuntimeRecord(response) && "data" in response ? response.data : response
  }

  async function listPullRequests(repository: string) {
    // Bulk first pages keep discovery cheap; large discussions fall back to pagination.
    const data = await graphql(repository, `query PullRequestList($owner:String!,$name:String!,$comments:String,$reviews:String,$threads:String){repository(owner:$owner,name:$name){pullRequests(first:100,states:OPEN){nodes{${pullRequestFields} ${feedbackFields}}}}}`, { ...repositoryParts(repository), comments: null, reviews: null, threads: null });
    const nodes = field(data, "repository", "pullRequests", "nodes");
    if (!Array.isArray(nodes)) throw new Error("GitHub did not return a PR list.");
    return await Promise.all(nodes.map(async (value) => {
      const pullRequest = v.parse(pullRequestSchema, value);
      const node = parseFeedback(value);
      const more = Object.values(feedbackConnections(node)).some(connection => connection.pageInfo.hasNextPage)
        || node.reviewThreads.nodes.some(thread => thread.comments.pageInfo.hasNextPage);
      const feedback = more ? await readPullRequestFeedback(repository, pullRequest.number) : digestFeedback(node);
      return await readRequiredCheckState(repository, { ...pullRequest, feedback });
    }));
  }

  async function readPullRequest(repository: string, number: number) {
    const [data, feedback] = await Promise.all([
      graphql(repository, `query PullRequestSnapshot($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){${pullRequestFields}}}}`, { ...repositoryParts(repository), number }),
      readPullRequestFeedback(repository, number),
    ]);
    return await readRequiredCheckState(repository, { ...v.parse(pullRequestSchema, field(data, "repository", "pullRequest")), feedback });
  }

  function feedbackConnections(
    node: FeedbackNode,
  ): Record<string, Connection<GitHubPullRequestComment | FeedbackReview | FeedbackThread>> {
    if (!node?.comments?.nodes || !node?.reviews?.nodes || !node?.reviewThreads?.nodes)
      throw new Error("Incomplete GitHub feedback response.");
    return { comments: node.comments, reviews: node.reviews, threads: node.reviewThreads };
  }

  function digestFeedback(node: {
    comments: { nodes: GitHubPullRequestComment[] };
    reviews: { nodes: FeedbackReview[] };
    reviewThreads: { nodes: FeedbackThread[] };
  }): PullRequestFeedback {
    const comments = node.comments.nodes.filter(comment => !(
      options.activityAuthors?.some(author => author.trim().toLowerCase() === (comment.author?.login ?? "").trim().toLowerCase()) && (comment.body.startsWith("<!-- vitehub-agent-activity:") || comment.body.startsWith("<!-- vitehub-babysitter-repair:"))
    ) && !options.ignoreComment?.(comment))
    const digest = (items: { id: string }[]) => createHash("sha256")
      .update(JSON.stringify([...items].sort((a, b) => a.id.localeCompare(b.id)), (key, value) => key === "updatedAt" || key === "pageInfo" ? undefined : value))
      .digest("hex")
    return {
      hasDiscussion: comments.some(comment => !!comment.body.trim())
        || node.reviews.nodes.some(review => !!review.body.trim() || review.state === "CHANGES_REQUESTED")
        || node.reviewThreads.nodes.some(thread => !thread.isResolved),
      comments: digest(comments),
      reviews: digest(node.reviews.nodes),
      threads: digest(node.reviewThreads.nodes),
    };
  }

  async function readPullRequestFeedback(
    repository: string,
    number: number,
  ): Promise<PullRequestFeedback> {
    const query = `query PullRequestFeedback($owner:String!,$name:String!,$number:Int!,$comments:String,$reviews:String,$threads:String){repository(owner:$owner,name:$name){pullRequest(number:$number){${feedbackFields}}}}`;
    const cursors = new Map<string, string>();
    const collected = {
      comments: new Map<string, GitHubPullRequestComment>(),
      reviews: new Map<string, FeedbackReview>(),
      threads: new Map<string, FeedbackThread>(),
    };
    let more = true;
    do {
      const node = parseFeedback(field(await graphql(repository, query, {
        ...repositoryParts(repository),
        number,
        comments: cursors.get("comments") ?? null,
        reviews: cursors.get("reviews") ?? null,
        threads: cursors.get("threads") ?? null,
      }), "repository", "pullRequest"));
      more = false;
      function collect<T extends { id: string }>(key: string, items: Map<string, T>, connection: Connection<T>) {
        for (const item of connection.nodes) items.set(item.id, item)
        if (connection.pageInfo.hasNextPage) {
          if (cursors.get(key) === connection.pageInfo.endCursor) throw new Error("GitHub pagination did not advance.")
          cursors.set(key, connection.pageInfo.endCursor)
          more = true
        }
      }
      collect("comments", collected.comments, node.comments)
      collect("reviews", collected.reviews, node.reviews)
      collect("threads", collected.threads, node.reviewThreads)
    } while (more);
    for (const thread of collected.threads.values()) {
      while (thread.comments.pageInfo.hasNextPage) {
        const query =
          "query PullRequestThreadComments($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){nodes{id body updatedAt} pageInfo{hasNextPage endCursor}}}}}";
        const page = parseConnection(field(await graphql(repository, query, { id: thread.id, after: thread.comments.pageInfo.endCursor }), "node", "comments"), parseComment);
        if (page.pageInfo.hasNextPage && page.pageInfo.endCursor === thread.comments.pageInfo.endCursor) throw new Error("GitHub thread pagination did not advance.");
        thread.comments.nodes.push(...page.nodes);
        thread.comments.pageInfo = page.pageInfo;
      }
    }
    return digestFeedback({
      comments: { nodes: [...collected.comments.values()] },
      reviews: { nodes: [...collected.reviews.values()] },
      reviewThreads: { nodes: [...collected.threads.values()] },
    });
  }

  async function readRequiredCheckState(repository: string, pullRequest: PullRequest): Promise<PullRequest> {
    if (pullRequestCheckState(pullRequest.statusCheckRollup) === "passed") return pullRequest;
    const query = "query PullRequestRequiredChecks($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion isRequired(pullRequestNumber:$number)} ... on StatusContext{context state isRequired(pullRequestNumber:$number)}}}}}}}}}}";
    const data = await graphql(repository, query, { ...repositoryParts(repository), number: pullRequest.number });
    const commits = v.parse(rollupSchema, field(data, "repository", "pullRequest", "commits"));
    const contexts = commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
    return { ...pullRequest, requiredStatusCheckRollup: contexts.filter(context => isRuntimeRecord(context) && context.isRequired === true) };
  }

  return { list: listPullRequests, read: readPullRequest };
}

/** The combined state of check runs (`status`, `conclusion`) and statuses (`state`). */
export function pullRequestCheckState(
  statusCheckRollup: unknown,
  empty: "passed" | "pending" = "pending",
): "failed" | "passed" | "pending" {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) return empty;
  const failedConclusions = new Set([
    "ACTION_REQUIRED",
    "CANCELLED",
    "FAILURE",
    "STALE",
    "STARTUP_FAILURE",
    "TIMED_OUT",
  ]);
  let pending = false;
  for (const value of statusCheckRollup) {
    if (!isRuntimeRecord(value)) {
      pending = true;
      continue;
    }
    const { conclusion, state, status } = value;
    if (
      state === "ERROR" ||
      state === "FAILURE" ||
      (status === "COMPLETED" &&
        hasRuntimeType(conclusion, "string") &&
        failedConclusions.has(conclusion))
    )
      return "failed";
    if (status === "COMPLETED") {
      if (!hasRuntimeType(conclusion, "string") || !conclusion) pending = true;
    } else if (status !== undefined || state !== "SUCCESS") pending = true;
  }
  return pending ? "pending" : "passed";
}

/** Derive stable PR thread identity, inspection annotations, and a session link. */
export async function createGitHubPullRequestRun(
  repository: string,
  pullRequest: Pick<PullRequest, 'number' | 'headRefOid' | 'title' | 'url'>,
  options: { agentName: string, runId: string, publicUrl?: string },
): Promise<import('../types.ts').AgentRunMetadata> {
  const { agentInvocationId } = await import('../invocations.ts')
  const publicUrl = options.publicUrl ?? resolvePublicUrl({ agentName: options.agentName })
  const sessionUrl = publicUrl
    ? consoleInvocationUrl(publicUrl, options.agentName, await agentInvocationId(options.runId, options.agentName))
    : undefined
  return {
    runId: options.runId,
    channelId: 'github',
    threadId: `github:${repository.toLowerCase()}:pull-request:${pullRequest.number}`,
    annotations: { 'github.head': pullRequest.headRefOid, 'github.pullRequest': pullRequest.number, 'github.repository': repository, 'github.title': pullRequest.title, 'github.url': pullRequest.url },
    activity: { target: { repository, issue: pullRequest.number }, links: sessionUrl ? [{ label: 'Current session', url: sessionUrl }] : [] },
  }
}
