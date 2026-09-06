import * as v from "valibot"
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts"
import { createHash } from "node:crypto";
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
  comments?: unknown;
  feedback?: PullRequestFeedback;
  headRefName: string;
  headRefOid: string;
  headRepository: { nameWithOwner: string } | null;
  isDraft: boolean;
  labels?: unknown;
  mergeStateStatus: string;
  number: number;
  reviewDecision: string | null;
  reviews?: unknown;
  requiredStatusCheckRollup?: unknown;
  state: string;
  statusCheckRollup: unknown;
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

const pullRequestSchema = v.object({
  baseRefOid: v.string(),
  baseRefName: v.string(),
  body: v.string(),
  headRefName: v.string(),
  headRefOid: v.string(),
  headRepository: v.nullable(v.object({ nameWithOwner: v.string() })),
  isDraft: v.boolean(),
  labels: v.optional(v.unknown()),
  mergeStateStatus: v.string(),
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  reviewDecision: v.nullable(v.string()),
  state: v.string(),
  statusCheckRollup: v.unknown(),
  title: v.string(),
  updatedAt: v.string(),
  url: v.string(),
});

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
function number(value: unknown): number {
  if (!hasRuntimeType(value, "number") || !Number.isInteger(value) || value <= 0) throw new Error("GitHub returned an invalid PR number.")
  return value
}
function boolean(value: unknown): boolean {
  if (!hasRuntimeType(value, "boolean")) throw new Error("GitHub returned an invalid boolean field.")
  return value
}
function graphQL(stdout: string, ...path: string[]): unknown {
  let value: unknown = JSON.parse(stdout)
  for (const key of path) value = record(value)[key]
  return value
}
function parsePullRequest(value: unknown): PullRequest {
  return v.parse(pullRequestSchema, value)
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

/** Read PR state and fully paginated feedback through the host's credentials and budget. */
export function createGitHubPullRequests(
  github: Pick<GitHubHost, "command" | "ensureGraphQLBudget">,
  options: { activityAuthors?: readonly string[], ignoreComment?: (comment: GitHubPullRequestComment) => boolean } = {},
): {
  list(repository: string): Promise<PullRequest[]>;
  read(repository: string, number: number): Promise<PullRequest>;
} {
  const pullRequestFields =
    "baseRefOid,baseRefName,body,headRefName,headRefOid,headRepository,isDraft,labels,mergeStateStatus,number,reviewDecision,state,statusCheckRollup,title,updatedAt,url";
  async function listPullRequests(repository: string) {
    return await withGraphQLBudget(repository, 256, async () => {
      const [result, feedback] = await Promise.all([
        github.command(
          [
            "pr",
            "list",
            "--repo",
            repository,
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            pullRequestFields,
          ],
          { repository },
        ),
        readOpenPullRequestFeedback(repository),
      ]);
      const payload: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(payload)) throw new Error("GitHub did not return a PR list.");
      const pullRequests = payload.map(parsePullRequest);
      return await Promise.all(
        pullRequests.map((pullRequest) =>
          readRequiredCheckState(repository, {
            ...pullRequest,
            ...(feedback.has(pullRequest.number)
              ? { feedback: feedback.get(pullRequest.number) }
              : {}),
          }),
        ),
      );
    });
  }

  async function readPullRequest(repository: string, number: number) {
    return await withGraphQLBudget(repository, 16, async () => {
      const [result, feedback] = await Promise.all([
        github.command(
          ["pr", "view", String(number), "--repo", repository, "--json", pullRequestFields],
          { repository },
        ),
        readPullRequestFeedback(repository, number),
      ]);
      return await readRequiredCheckState(repository, {
        ...parsePullRequest(JSON.parse(result.stdout)),
        feedback,
      });
    });
  }

  async function withGraphQLBudget<T>(repository: string, cost: number, run: () => Promise<T>) {
    const reservation = await github.ensureGraphQLBudget(repository, { cost });
    reservation.submit();
    try {
      return await run();
    } finally {
      // The gh CLI does not expose actual query cost, so settle the reserved upper bound.
      reservation.settle(cost);
    }
  }

  const feedbackFields = `comments(first:100,after:$comments){nodes{id body updatedAt author{login}} pageInfo{hasNextPage endCursor}} reviews(first:100,after:$reviews){nodes{id body updatedAt state commit{oid}} pageInfo{hasNextPage endCursor}} reviewThreads(first:100,after:$threads){nodes{id isResolved comments(first:20){nodes{id body updatedAt} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}`;

  async function readOpenPullRequestFeedback(repository: string) {
    // Bulk first pages keep discovery cheap; large discussions fall back to pagination.
    const { owner, name } = repositoryParts(repository);
    const query = `query($owner:String!,$name:String!,$comments:String,$reviews:String,$threads:String){repository(owner:$owner,name:$name){pullRequests(first:100,states:OPEN){nodes{number ${feedbackFields}}}}}`;
    const result = await github.command(
      ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${query}`],
      { repository },
    );
    const nodes = graphQL(result.stdout, "data", "repository", "pullRequests", "nodes");
    if (!Array.isArray(nodes)) throw new Error("GitHub did not return pull request feedback.");
    return new Map<number, PullRequestFeedback>(
      await Promise.all(
        nodes.map(async (value): Promise<[number, PullRequestFeedback]> => {
          const node = parseFeedback(value)
          const prNumber = number(record(value).number)
          const more = Object.values(feedbackConnections(node)).some(connection => connection.pageInfo.hasNextPage)
            || node.reviewThreads.nodes.some(thread => thread.comments.pageInfo.hasNextPage)
          return [prNumber, more ? await readPullRequestFeedback(repository, prNumber) : digestFeedback(node)]
        }),
      ),
    );
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
      options.activityAuthors?.includes(comment.author?.login ?? "") && comment.body.startsWith("<!-- vitehub-agent-activity:")
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
    const { owner, name } = repositoryParts(repository);
    const query = `query($owner:String!,$name:String!,$number:Int!,$comments:String,$reviews:String,$threads:String){repository(owner:$owner,name:$name){pullRequest(number:$number){${feedbackFields}}}}`;
    const cursors = new Map<string, string>();
    const collected = {
      comments: new Map<string, GitHubPullRequestComment>(),
      reviews: new Map<string, FeedbackReview>(),
      threads: new Map<string, FeedbackThread>(),
    };
    do {
      const result = await github.command(
        [
          "api",
          "graphql",
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-F",
          `number=${number}`,
          "-f",
          `query=${query}`,
          ...[...cursors].flatMap(([key, value]) => ["-f", `${key}=${value}`]),
        ],
        { repository },
      );
      const node = parseFeedback(graphQL(result.stdout, "data", "repository", "pullRequest"));
      let more = false;
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
      if (!more) break;
    } while (true);
    for (const thread of collected.threads.values()) {
      while (thread.comments.pageInfo.hasNextPage) {
        const query =
          "query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){nodes{id body updatedAt} pageInfo{hasNextPage endCursor}}}}}";
        const result = await github.command(
          [
            "api",
            "graphql",
            "-f",
            `id=${thread.id}`,
            "-f",
            `after=${thread.comments.pageInfo.endCursor}`,
            "-f",
            `query=${query}`,
          ],
          { repository },
        );
        const page = parseConnection(graphQL(result.stdout, "data", "node", "comments"), parseComment);
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

  async function readRequiredCheckState(repository: string, pullRequest: PullRequest) {
    if (pullRequestCheckState(pullRequest.statusCheckRollup) === "passed") return pullRequest;
    const requiredStatusCheckRollup = await readRequiredChecks(repository, pullRequest.number);
    return requiredStatusCheckRollup === undefined
      ? pullRequest
      : { ...pullRequest, requiredStatusCheckRollup };
  }

  async function readRequiredChecks(repository: string, number: number) {
    const args = [
      "pr",
      "checks",
      String(number),
      "--repo",
      repository,
      "--required",
      "--json",
      "bucket,name,state,workflow",
    ];
    try {
      const result = await github.command(args, { repository });
      return parseRequiredChecks(result.stdout, result.stderr);
    } catch (error) {
      const result = isRuntimeRecord(error) ? error : {};
      const checks = parseRequiredChecks(
        hasRuntimeType(result.stdout, "string") ? result.stdout : "",
        hasRuntimeType(result.stderr, "string") ? result.stderr : "",
      );
      if (checks !== undefined) return checks;
      throw new Error(`Failed to read required checks for ${repository}#${number}.`, {
        cause: error,
      });
    }
  }

  return { list: listPullRequests, read: readPullRequest };
}

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
    const { bucket, conclusion, state, status } = value;
    if (bucket === "fail" || bucket === "cancel") return "failed";
    if (bucket === "pending") {
      pending = true;
      continue;
    }
    if (bucket === "pass" || bucket === "skipping") continue;
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

export function parseRequiredChecks(stdout: string, stderr: string): unknown[] | undefined {
  if (stdout.trim()) {
    try {
      const checks: unknown = JSON.parse(stdout);
      return Array.isArray(checks) ? checks : undefined;
    } catch {
      return undefined;
    }
  }
  const message = stderr.trim();
  return /^no (?:required )?checks reported on the '.+' branch$/.test(message) ? [] : undefined;
}

/** Derive stable PR thread identity, inspection annotations, and a session link. */
export async function createGitHubPullRequestRun(
  repository: string,
  pullRequest: Pick<PullRequest, 'number' | 'headRefOid' | 'title' | 'url'>,
  options: { agentName: string, runId: string, publicUrl?: string, sessionUrl?: string },
): Promise<import('../types.ts').AgentRunMetadata> {
  const { agentInvocationId } = await import('../invocations.ts')
  const sessionUrl = options.publicUrl
    ? new URL(`/_vitehub/agents/${encodeURIComponent(options.agentName)}/invocations/${encodeURIComponent(await agentInvocationId(options.runId, options.agentName))}`, options.publicUrl).href
    : options.sessionUrl
  return {
    runId: options.runId,
    channelId: 'github',
    threadId: `github:${repository.toLowerCase()}:pull-request:${pullRequest.number}`,
    annotations: { 'github.head': pullRequest.headRefOid, 'github.pullRequest': pullRequest.number, 'github.repository': repository, 'github.title': pullRequest.title, 'github.url': pullRequest.url },
    activity: { target: { repository, issue: pullRequest.number }, links: sessionUrl ? [{ label: 'Current session', url: sessionUrl }] : [] },
  }
}
