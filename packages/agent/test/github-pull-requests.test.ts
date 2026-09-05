import { describe, expect, it, vi } from "vitest";
import {
  createGitHubPullRequests,
  parseRequiredChecks,
  pullRequestCheckState,
} from "../src/server/github-pull-requests.ts";

const connection = <T>(nodes: T[] = []) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const feedback = (body = "hello", login = "reviewer") => ({
  comments: connection([{ id: "c1", body, updatedAt: "now", author: { login } }]),
  reviews: connection(),
  reviewThreads: connection(),
});

function host(node = feedback()) {
  const settle = vi.fn();
  const command = vi.fn(async (args: string[]) => ({
    stderr: "",
    stdout: JSON.stringify(
      args[0] === "pr"
        ? { number: 1, baseRefOid: "base", baseRefName: "main", body: "", headRefName: "feature", headRefOid: "head", headRepository: null, isDraft: false, mergeStateStatus: "CLEAN", reviewDecision: null, state: "OPEN", title: "Title", updatedAt: "now", url: "https://github.com/acme/app/pull/1", statusCheckRollup: [{ state: "SUCCESS" }] }
        : { data: { repository: { pullRequest: node } } },
    ),
  }));
  return {
    command,
    ensureGraphQLBudget: vi.fn(async () => ({ submit: vi.fn(), settle, release: vi.fn(), checkedAt: 0, remaining: 5000, resetAt: 9999999 })),
    settle,
  };
}

describe("GitHub pull request snapshots", () => {
  it("keeps failures actionable when another check is pending", () => {
    expect(pullRequestCheckState([{ bucket: "pending" }, { bucket: "fail" }])).toBe("failed");
    expect(pullRequestCheckState([{ state: "SUCCESS" }])).toBe("passed");
    expect(parseRequiredChecks("", "no required checks reported on the 'main' branch")).toEqual([]);
    expect(parseRequiredChecks("invalid", "")).toBeUndefined();
  });

  it("ignores activity only from configured identities", async () => {
    const first = host(feedback("<!-- vitehub-agent-activity:one -->", "agent[bot]"));
    const second = host(feedback("<!-- vitehub-agent-activity:two -->", "agent[bot]"));
    const options = { activityAuthors: ["agent[bot]"] };
    expect((await createGitHubPullRequests(first, options).read("acme/app", 1)).feedback).toEqual(
      (await createGitHubPullRequests(second, options).read("acme/app", 1)).feedback,
    );
    expect((await createGitHubPullRequests(first).read("acme/app", 1)).feedback).not.toEqual(
      (await createGitHubPullRequests(second).read("acme/app", 1)).feedback,
    );
    expect(first.settle).toHaveBeenCalledWith(16);
  });

  it("propagates transport failures and settles admission", async () => {
    const github = host();
    github.command.mockRejectedValue(new Error("network unavailable"));
    await expect(createGitHubPullRequests(github).read("acme/app", 1)).rejects.toThrow(
      "network unavailable",
    );
    expect(github.settle).toHaveBeenCalledOnce();
  });
});

it("retains discussions for conservative scheduler wait decisions", async () => {
  expect((await createGitHubPullRequests(host()).read("acme/app", 1)).feedback?.hasDiscussion).toBe(
    true,
  );
});

it('ignores timestamp-only edits while retaining changed feedback', async () => {
  const node = feedback()
  const first = await createGitHubPullRequests(host(node)).read('acme/app', 1)
  node.comments.nodes[0]!.updatedAt = 'later'
  const second = await createGitHubPullRequests(host(node)).read('acme/app', 1)
  expect(first.feedback).toEqual(second.feedback)
  node.comments.nodes[0]!.body = 'Fix this defect'
  const third = await createGitHubPullRequests(host(node)).read('acme/app', 1)
  expect(third.feedback).not.toEqual(second.feedback)
})
