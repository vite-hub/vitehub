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
      const pullRequests = JSON.parse(result.stdout) as PullRequest[];
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
        ...(JSON.parse(result.stdout) as PullRequest),
        ...(feedback ? { feedback } : {}),
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
    const [owner, name] = repository.split("/") as [string, string];
    const query = `query($owner:String!,$name:String!,$comments:String,$reviews:String,$threads:String){repository(owner:$owner,name:$name){pullRequests(first:100,states:OPEN){nodes{number ${feedbackFields}}}}}`;
    const result = await github.command(
      ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${query}`],
      { repository },
    );
    const nodes: (FeedbackNode & { number: number })[] = JSON.parse(result.stdout)?.data?.repository
      ?.pullRequests?.nodes;
    if (!Array.isArray(nodes)) throw new Error("GitHub did not return pull request feedback.");
    return new Map<number, PullRequestFeedback>(
      await Promise.all(
        nodes.map(
          async (node) =>
            [
              node.number,
              Object.values(feedbackConnections(node)).some(
                (connection) => connection.pageInfo.hasNextPage,
              ) ||
              node.reviewThreads.nodes.some(
                (thread: FeedbackThread) => thread.comments.pageInfo.hasNextPage,
              )
                ? await readPullRequestFeedback(repository, node.number)
                : digestFeedback(node),
            ] as [number, PullRequestFeedback],
        ),
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
    const [owner, name] = repository.split("/") as [string, string];
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
      const node: FeedbackNode = JSON.parse(result.stdout)?.data?.repository?.pullRequest;
      let more = false;
      for (const [key, connection] of Object.entries(feedbackConnections(node))) {
        const items = collected[key as keyof typeof collected];
        for (const item of connection.nodes)
          (items as Map<string, GitHubPullRequestComment | FeedbackReview | FeedbackThread>).set(
            item.id,
            item,
          );
        if (connection.pageInfo.hasNextPage) {
          cursors.set(key, connection.pageInfo.endCursor);
          more = true;
        }
      }
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
        const page = JSON.parse(result.stdout)?.data?.node?.comments;
        if (!page?.nodes || !page.pageInfo)
          throw new Error("Incomplete GitHub review thread response.");
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
      const result = error as Error & { stderr?: unknown; stdout?: unknown };
      const checks = parseRequiredChecks(
        typeof result.stdout === "string" ? result.stdout : "",
        typeof result.stderr === "string" ? result.stderr : "",
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
    if (!value || typeof value !== "object") {
      pending = true;
      continue;
    }
    const { bucket, conclusion, state, status } = value as Record<string, unknown>;
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
        typeof conclusion === "string" &&
        failedConclusions.has(conclusion))
    )
      return "failed";
    if (status === "COMPLETED") {
      if (typeof conclusion !== "string" || !conclusion) pending = true;
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
