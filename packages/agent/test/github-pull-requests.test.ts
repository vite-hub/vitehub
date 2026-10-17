import { describe, expect, it, vi } from "vitest";
import {
  createGitHubPullRequestRun,
  createGitHubPullRequests,
  pullRequestCheckState,
} from "../src/server/github-pull-requests.ts";
import { githubForge, type GitHubTestRequest } from "./fixtures/github-forge.ts";

const connection = <T>(nodes: T[] = []) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null as string | null },
});
const feedback = (body = "hello", login = "reviewer") => ({
  comments: connection([{ id: "c1", body, updatedAt: "now", author: { login } }]),
  reviews: connection(),
  reviewThreads: connection(),
});
const rollup = (contexts: unknown[]) => ({ nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] });

const snapshot = {
  number: 1, baseRefOid: "base", baseRefName: "main", body: "", headRefName: "feature",
  headRefOid: "head", headRepository: { nameWithOwner: "acme/app" }, isDraft: false,
  mergeStateStatus: "CLEAN", reviewDecision: null, state: "OPEN", title: "Change",
  updatedAt: "now", url: "https://github.com/acme/app/pull/1", labels: { nodes: [] }, commits: rollup([{ state: "SUCCESS" }]),
};

async function host(node: unknown = feedback(), pullRequest: unknown = snapshot, route?: (request: GitHubTestRequest) => unknown) {
  const github = await githubForge(request => route?.(request) ?? (request.operationName === "PullRequestSnapshot"
    ? { repository: { pullRequest } }
    : { repository: { pullRequest: node } }));
  return { forge: vi.fn(async () => github.provider), calls: github.calls };
}

describe("GitHub pull request snapshots", () => {
  it("links non-slug Agent names to the Console invocation", async () => {
    const { agentInvocationId } = await import("../src/invocations.ts")
    const run = await createGitHubPullRequestRun("acme/app", snapshot, {
      agentName: "team/support",
      publicUrl: "https://agent.example.test",
      runId: "delivery-1",
    })
    const id = await agentInvocationId("delivery-1", "team/support")
    expect(run.activity?.links).toEqual([{
      label: "Current session",
      url: `https://agent.example.test/_vitehub/agents/~007400650061006d002f0073007500700070006f00720074/invocations/${id}`,
    }])
  })

  it("defaults the session link to vitehub({ publicUrl })", async () => {
    const { agentInvocationId } = await import("../src/invocations.ts")
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: { babysitter: "https://agents.example.test" } })
    try {
      const linked = await createGitHubPullRequestRun("acme/app", snapshot, { agentName: "babysitter", runId: "delivery-2" })
      expect(linked.activity?.links).toEqual([{
        label: "Current session",
        url: `https://agents.example.test/_vitehub/agents/babysitter/invocations/${await agentInvocationId("delivery-2", "babysitter")}`,
      }])
      const unlinked = await createGitHubPullRequestRun("acme/app", snapshot, { agentName: "other", runId: "delivery-2" })
      expect(unlinked.activity?.links).toEqual([])
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it("keeps failures actionable when another check is pending", () => {
    expect(pullRequestCheckState([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }])).toBe("failed");
    expect(pullRequestCheckState([{ state: "SUCCESS" }])).toBe("passed");
  });

  it("reads required checks only when the full rollup has not passed", async () => {
    const pending = { ...snapshot, commits: rollup([{ name: "optional", status: "IN_PROGRESS" }]) }
    const github = await host(feedback(), pending, request => request.operationName === "PullRequestRequiredChecks"
      ? { repository: { pullRequest: { commits: rollup([{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true }, { name: "optional", status: "IN_PROGRESS", isRequired: false }]) } } }
      : undefined)
    const pullRequest = await createGitHubPullRequests(github).read("acme/app", 1)
    expect(pullRequest.requiredStatusCheckRollup).toEqual([{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true }])
    expect(pullRequestCheckState(pullRequest.requiredStatusCheckRollup, "passed")).toBe("passed")
    expect(github.calls.find(call => call.operationName === "PullRequestRequiredChecks")?.variables).toEqual({ owner: "acme", name: "app", number: 1 })
    const passed = await host()
    await createGitHubPullRequests(passed).read("acme/app", 1)
    expect(passed.calls.some(call => call.operationName === "PullRequestRequiredChecks")).toBe(false)
  });

  it("ignores activity only from configured identities", async () => {
    const first = await host(feedback("<!-- vitehub-agent-activity:one -->", "agent[bot]"));
    const second = await host(feedback("<!-- vitehub-agent-activity:two -->", "agent[bot]"));
    const options = { activityAuthors: ["agent[bot]"] };
    expect((await createGitHubPullRequests(first, options).read("acme/app", 1)).feedback).toEqual(
      (await createGitHubPullRequests(second, options).read("acme/app", 1)).feedback,
    );
    expect((await createGitHubPullRequests(first).read("acme/app", 1)).feedback).not.toEqual(
      (await createGitHubPullRequests(second).read("acme/app", 1)).feedback,
    );
  });

  it("propagates transport failures", async () => {
    const github = await host();
    github.forge.mockRejectedValue(new Error("network unavailable"));
    await expect(createGitHubPullRequests(github).read("acme/app", 1)).rejects.toThrow(
      "network unavailable",
    );
  });
});

it("retains discussions for conservative scheduler wait decisions", async () => {
  expect((await createGitHubPullRequests(await host()).read("acme/app", 1)).feedback?.hasDiscussion).toBe(
    true,
  );
});

it('ignores timestamp-only edits while retaining changed feedback', async () => {
  const node = feedback()
  const first = await createGitHubPullRequests(await host(node)).read('acme/app', 1)
  node.comments.nodes[0]!.updatedAt = 'later'
  const second = await createGitHubPullRequests(await host(node)).read('acme/app', 1)
  expect(first.feedback).toEqual(second.feedback)
  node.comments.nodes[0]!.body = 'Fix this defect'
  const third = await createGitHubPullRequests(await host(node)).read('acme/app', 1)
  expect(third.feedback).not.toEqual(second.feedback)
})


it("rejects malformed snapshots", async () => {
  for (const invalid of [null, { ...snapshot, number: "1" }, { ...snapshot, headRefOid: null }]) {
    await expect(createGitHubPullRequests(await host(feedback(), invalid)).read("acme/app", 1)).rejects.toThrow();
  }
});

it("validates every listed snapshot in one bulk query", async () => {
  const github = await host(undefined, undefined, request => request.operationName === "PullRequestList"
    ? { repository: { pullRequests: { nodes: [{ ...snapshot, ...feedback() }] } } }
    : undefined);
  expect(await createGitHubPullRequests(github).list("acme/app")).toEqual([
    expect.objectContaining({ number: 1, headRefOid: "head", labels: [], statusCheckRollup: [{ state: "SUCCESS" }] }),
  ]);
  expect(github.calls.map(call => call.operationName)).toEqual(["PullRequestList"]);
});


it("collects each feedback connection across pages", async () => {
  const first = feedback();
  const second = feedback("Second comment");
  second.comments.nodes[0]!.id = "c2";
  const github = await host(undefined, undefined, request => request.operationName === "PullRequestFeedback"
    ? { repository: { pullRequest: request.variables?.comments === "cursor" ? second : {
      ...first,
      comments: { ...first.comments, pageInfo: { hasNextPage: true, endCursor: "cursor" } },
    } } }
    : undefined);
  const combined = feedback();
  combined.comments.nodes.push(...second.comments.nodes);
  const expected = await createGitHubPullRequests(await host(combined)).read("acme/app", 1);
  const actual = await createGitHubPullRequests(github).read("acme/app", 1);
  expect(actual.feedback).toEqual(expected.feedback);
  expect(github.calls.map(call => call.operationName).sort()).toEqual(["PullRequestFeedback", "PullRequestFeedback", "PullRequestSnapshot"]);
});
