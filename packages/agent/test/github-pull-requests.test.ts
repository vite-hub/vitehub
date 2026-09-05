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

const snapshot = {
  number: 1, baseRefOid: "base", baseRefName: "main", body: "", headRefName: "feature",
  headRefOid: "head", headRepository: { nameWithOwner: "acme/app" }, isDraft: false,
  mergeStateStatus: "CLEAN", reviewDecision: null, state: "OPEN", title: "Change",
  updatedAt: "now", url: "https://github.com/acme/app/pull/1", statusCheckRollup: [{ state: "SUCCESS" }],
};

function host(node = feedback(), pullRequest: unknown = snapshot) {
  const settle = vi.fn();
  const command = vi.fn(async (args: string[]) => ({
    stderr: "",
    stdout: JSON.stringify(
      args[0] === "pr"
        ? pullRequest
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


it("rejects malformed snapshots and settles admission", async () => {
  for (const invalid of [null, { ...snapshot, number: "1" }, { ...snapshot, headRefOid: null }]) {
    const github = host(feedback(), invalid);
    await expect(createGitHubPullRequests(github).read("acme/app", 1)).rejects.toThrow();
    expect(github.settle).toHaveBeenCalledWith(16);
  }
});

it("validates every listed snapshot", async () => {
  const github = host();
  github.command.mockImplementation(async (args: string[]) => ({ stderr: "", stdout: JSON.stringify(
    args[0] === "pr" ? [snapshot] : { data: { repository: { pullRequests: { nodes: [{ number: 1, ...feedback() }] } } } },
  ) }));
  expect(await createGitHubPullRequests(github).list("acme/app")).toEqual([
    expect.objectContaining({ number: 1, headRefOid: "head" }),
  ]);
});


it("collects each feedback connection across pages", async () => {
  const first = feedback();
  const second = feedback("Second comment");
  second.comments.nodes[0]!.id = "c2";
  const github = host();
  github.command.mockImplementation(async (args: string[]) => ({ stderr: "", stdout: JSON.stringify(
    args[0] === "pr" ? snapshot : { data: { repository: { pullRequest: args.includes("comments=cursor") ? second : {
      ...first,
      comments: { ...first.comments, pageInfo: { hasNextPage: true, endCursor: "cursor" } },
    } } } },
  ) }));
  const combined = feedback();
  combined.comments.nodes.push(...second.comments.nodes);
  const expected = await createGitHubPullRequests(host(combined)).read("acme/app", 1);
  const actual = await createGitHubPullRequests(github).read("acme/app", 1);
  expect(actual.feedback).toEqual(expected.feedback);
  expect(github.command).toHaveBeenCalledTimes(3);
});
