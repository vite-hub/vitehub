import { describe, expect, it, vi } from "vitest";
import type { BranchRules } from "@vite-hub/forge";
import {
  createGitHubRequiredCheckPolicyReader,
  evaluateGitHubRequiredChecks,
  type GitHubRequiredCheckPolicy,
} from "../src/server/github-required-checks.ts";

const rules = (overrides: Partial<BranchRules> = {}): BranchRules => ({
  requiredChecks: [{ context: "CI", appId: 42 }],
  requiredWorkflows: false,
  classicSource: "protection-endpoint",
  ...overrides,
});
function reader(value: BranchRules = rules()) {
  return vi.fn(async (_repository: string, _branch: string) => structuredClone(value));
}
const policy: GitHubRequiredCheckPolicy = {
  repository: "acme/app",
  branch: "main",
  status: "known",
  source: "github-rest-rules-and-protection",
  fetchedAt: "",
  required: [{ context: "CI", appId: 42 }],
};
const evidence = {
  repository: "acme/app",
  branch: "main",
  headSha: "head",
  checkRuns: [],
  statuses: [],
};
const run = {
  id: 1,
  head_sha: "head",
  name: "CI",
  app: { id: 42 },
  status: "completed",
  conclusion: "success",
};

describe("required check policy", () => {
  it("reports the branch rules of the requested branch", async () => {
    const read = reader(rules({ requiredChecks: [{ context: "CI", appId: 42 }, { context: "lint", appId: null }], classicSource: "branch-summary" }));
    expect(await createGitHubRequiredCheckPolicyReader(read).read("acme/app", "release/v1")).toMatchObject({
      status: "known",
      classicSource: "branch-summary",
      required: [{ context: "CI", appId: 42 }, { context: "lint", appId: null }],
    });
    expect(read).toHaveBeenCalledWith("acme/app", "release/v1");
  });
  it("treats unreadable rules and required workflows as unknown", async () => {
    expect((await createGitHubRequiredCheckPolicyReader(reader(rules({ requiredChecks: [] }))).read("acme/app", "main")).status).toBe("known");
    expect(await createGitHubRequiredCheckPolicyReader(reader(rules({ requiredWorkflows: true }))).read("acme/app", "main"))
      .toMatchObject({ status: "unknown", required: [], reason: "Required workflow rules cannot be reduced to check contexts" });
    const failing = reader();
    failing.mockRejectedValue(new Error("Active branch rules unavailable (HTTP 403)."));
    expect(await createGitHubRequiredCheckPolicyReader(failing).read("acme/app", "main"))
      .toMatchObject({ status: "unknown", required: [], reason: "Active branch rules unavailable (HTTP 403)." });
  });
  it("caches, clones, coalesces and expires results", async () => {
    let now = 0;
    const read = reader();
    const cache = createGitHubRequiredCheckPolicyReader(read, { clock: () => now, ttlMs: 10 });
    const [a, b] = await Promise.all([
      cache.read("acme/app", "main"),
      cache.read("ACME/APP", "main"),
    ]);
    a.required.length = 0;
    expect(b.required).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    await cache.read("acme/app", "main");
    expect(read).toHaveBeenCalledTimes(1);
    now = 10;
    await cache.read("acme/app", "main");
    expect(read).toHaveBeenCalledTimes(2);
    cache.invalidate("ACME/APP", "main");
    await cache.read("acme/app", "main");
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("caches transport failures only for the failure TTL", async () => {
    let now = 0;
    const read = reader();
    read.mockRejectedValueOnce(new Error("network unavailable"));
    const cache = createGitHubRequiredCheckPolicyReader(read, {
      clock: () => now,
      failureTtlMs: 5,
    });
    expect((await cache.read("acme/app", "main")).status).toBe("unknown");
    now = 4;
    expect((await cache.read("acme/app", "main")).status).toBe("unknown");
    expect(read).toHaveBeenCalledTimes(1);
    now = 5;
    expect((await cache.read("acme/app", "main")).status).toBe("known");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not repopulate the cache from an invalidated in-flight request", async () => {
    let release!: (value: BranchRules) => void;
    const read = reader();
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const cache = createGitHubRequiredCheckPolicyReader(read);
    const old = cache.read("acme/app", "main");
    cache.invalidate();
    await cache.read("acme/app", "main");
    release(rules({ requiredChecks: [] }));
    await old;
    expect((await cache.read("acme/app", "main")).required).toHaveLength(1);
  });
});

describe("required check evidence", () => {
  it("requires exact head and app and identifies absent checks", () => {
    for (const value of [
      { ...run, head_sha: "old" },
      { ...run, app: { id: 1 } },
    ]) {
      expect(
        evaluateGitHubRequiredChecks(policy, { ...evidence, checkRuns: [value] }),
      ).toMatchObject({ state: "pending", missing: ["CI"] });
    }
    expect(
      evaluateGitHubRequiredChecks(policy, {
        ...evidence,
        statuses: [{ id: 1, sha: "head", context: "CI", state: "success" }],
      }).state,
    ).toBe("unknown");
    expect(
      evaluateGitHubRequiredChecks(policy, {
        ...evidence,
        checkRuns: [run, { ...run, name: "optional", conclusion: "failure" }],
      }).state,
    ).toBe("passed");
  });
  it("preserves blocking App-bound statuses without trusting successful source identity", () => {
    for (const state of ["success", "failure", "error", "pending"]) {
      for (const checkRuns of [[], [run]]) {
        expect(
          evaluateGitHubRequiredChecks(policy, {
            ...evidence,
            checkRuns,
            statuses: [{ id: 2, sha: "head", context: "CI", state }],
          }),
        ).toMatchObject({
          state: state === "success" ? "unknown" : state === "pending" ? "pending" : "failed",
          missing: [],
        });
      }
    }
    expect(
      evaluateGitHubRequiredChecks(policy, {
        ...evidence,
        checkRuns: [run],
        statuses: [
          { id: 2, sha: "old", context: "CI", state: "failure" },
          { id: 3, sha: "head", context: "optional", state: "failure" },
        ],
      }).state,
    ).toBe("passed");
  });
  it("selects latest rerun and requires same-name legacy statuses as well", () => {
    const unbound = { ...policy, required: [{ context: "CI", appId: null }] };
    expect(
      evaluateGitHubRequiredChecks(unbound, {
        ...evidence,
        checkRuns: [run],
        statuses: [{ id: 2, sha: "head", context: "CI", state: "failure" }],
      }).state,
    ).toBe("failed");
    expect(
      evaluateGitHubRequiredChecks(policy, {
        ...evidence,
        checkRuns: [
          { ...run, started_at: "2026-09-16T01:00:00Z" },
          { ...run, id: 2, status: "queued", conclusion: null, started_at: null },
        ],
      }).state,
    ).toBe("pending");
    expect(
      evaluateGitHubRequiredChecks(policy, {
        ...evidence,
        checkRuns: [{ ...run, conclusion: "new-state" }],
      }).state,
    ).toBe("unknown");
  });
  it("gates a branch without required checks on the newest run of every current-head check", () => {
    const unprotected = { ...policy, required: [] };
    const abandoned = { ...run, id: 10, name: "Workers Builds", app: { id: 1 }, status: "in_progress", conclusion: null };
    const finished = { ...abandoned, id: 11, status: "completed", conclusion: "success" };
    const state = (checkRuns: (typeof run | typeof abandoned)[], statuses: { id: number; sha: string; context: string; state: string }[] = []) =>
      evaluateGitHubRequiredChecks(unprotected, { ...evidence, checkRuns, statuses }).state;
    expect(state([abandoned])).toBe("pending");
    expect(state([abandoned, finished])).toBe("passed");
    expect(state([{ ...abandoned, head_sha: "old" }])).toBe("passed");
    // Failures need an assessment from the merge gate, not another wait.
    expect(state([{ ...finished, conclusion: "failure" }])).toBe("passed");
    expect(state([], [{ id: 1, sha: "head", context: "deploy", state: "pending" }])).toBe("pending");
  });
  it("never treats unknown or mismatched policy as passing", () => {
    for (const value of [
      { ...policy, status: "unknown" as const },
      { ...policy, branch: "other" },
      { ...policy, repository: "other/app" },
    ]) {
      expect(evaluateGitHubRequiredChecks(value, evidence).state).toBe("unknown");
    }
    expect(evaluateGitHubRequiredChecks({ ...policy, required: [] }, evidence).state).toBe(
      "passed",
    );
  });
});
