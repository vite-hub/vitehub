import { describe, expect, it, vi } from "vitest";
import {
  createGitHubRequiredCheckPolicyReader,
  evaluateGitHubRequiredChecks,
  type GitHubCheckPolicyResponse,
  type GitHubRequiredCheckPolicy,
} from "../src/server/github-required-checks.ts";

const rule = (context = "CI", integration_id: number | null = 42) => ({
  type: "required_status_checks",
  parameters: { required_status_checks: [{ context, integration_id }] },
});
function reader(
  rules: GitHubCheckPolicyResponse = { status: 200, data: [rule()], nextPage: null },
  classic: GitHubCheckPolicyResponse = { status: 200, data: { contexts: [], checks: [] } },
  branch: GitHubCheckPolicyResponse = { status: 200, data: { protected: false } },
) {
  return vi.fn(async (path: string) =>
    path.includes("/rules/") ? rules : path.endsWith("/required_status_checks") ? classic : branch,
  );
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
  it("combines active rules and classic app bindings without weakening them", async () => {
    const read = reader(undefined, {
      status: 200,
      data: { contexts: ["CI", "lint"], checks: [{ context: "CI", app_id: 42 }] },
    });
    expect(
      (await createGitHubRequiredCheckPolicyReader(read).read("acme/app", "release/v1")).required,
    ).toEqual([
      { context: "CI", appId: 42 },
      { context: "lint", appId: null },
    ]);
    expect(read.mock.calls[0]?.[0]).toContain("release%2Fv1");
  });
  it("distinguishes no requirements from inaccessible policy and unsupported workflows", async () => {
    expect(
      (
        await createGitHubRequiredCheckPolicyReader(
          reader({ status: 200, data: [], nextPage: null }, { status: 404 }),
        ).read("acme/app", "main")
      ).status,
    ).toBe("known");
    for (const response of [
      { status: 404 },
      { status: 403 },
      { status: 200, data: [{ type: "workflows" }], nextPage: null },
      { status: 200, data: [rule("CI", -3)], nextPage: null },
    ]) {
      expect(
        (await createGitHubRequiredCheckPolicyReader(reader(response)).read("acme/app", "main"))
          .status,
      ).toBe("unknown");
    }
    expect(
      (
        await createGitHubRequiredCheckPolicyReader(
          reader(undefined, { status: 404 }, { status: 404 }),
        ).read("acme/app", "main")
      ).status,
    ).toBe("unknown");
  });
  it("reads later rule pages before declaring a policy known", async () => {
    for (const later of [[rule("later")], [{ type: "workflows" }]]) {
      const read = reader();
      read.mockImplementation(async (path) => {
        if (!path.includes("/rules/")) return { status: 200, data: { contexts: [] } };
        return {
          status: 200,
          data: path.endsWith("page=1") ? [{ type: "deletion" }] : later,
          nextPage: path.endsWith("page=1")
            ? "repositories/123/rules/branches/main?per_page=100&page=3"
            : null,
        };
      });
      const result = await createGitHubRequiredCheckPolicyReader(read).read("acme/app", "main");
      expect(read).toHaveBeenCalledWith("repositories/123/rules/branches/main?per_page=100&page=3");
      expect(result.status).toBe(later[0]?.type === "workflows" ? "unknown" : "known");
      if (result.status === "known")
        expect(result.required).toEqual([{ context: "later", appId: 42 }]);
    }
  });
  it("follows Enterprise continuation URLs relative to the complete API base", async () => {
    const apiBase = "https://host/api/v3/";
    function normalizeNextPage(nextUrl: string, apiBase: string): string {
      const base = new URL(apiBase);
      const prefix = base.pathname.replace(/\/$/, "") + "/";
      const next = new URL(nextUrl);
      if (next.origin !== base.origin || !next.pathname.startsWith(prefix)) {
        throw new Error("Pagination URL is outside the GitHub API base");
      }
      return next.pathname.slice(prefix.length) + next.search;
    }
    for (const target of [
      "https://host/api/v3/repositories/123/rules/branches/main?page=2",
      "https://host/repositories/123/rules/branches/main?page=2",
      "https://host/api/v30/repositories/123/rules/branches/main?page=2",
      "https://other/api/v3/repositories/123/rules/branches/main?page=2",
    ]) {
      const requested: string[] = [];
      const read = async (path: string): Promise<GitHubCheckPolicyResponse> => {
        requested.push(new URL(path, apiBase).href);
        if (!path.includes("/rules/")) return { status: 200, data: { contexts: [] } };
        return path.endsWith("page=1")
          ? { status: 200, data: [], nextPage: normalizeNextPage(target, apiBase) }
          : { status: 200, data: [rule()], nextPage: null };
      };
      const result = await createGitHubRequiredCheckPolicyReader(read).read("acme/app", "main");
      if (target.startsWith(apiBase)) {
        expect(result).toMatchObject({ status: "known", required: [{ context: "CI", appId: 42 }] });
        expect(requested).toContain(target);
      } else {
        expect(result.status).toBe("unknown");
        expect(requested).toHaveLength(2);
      }
    }
  });
  it("requires explicit completion and rejects invalid or repeated targets", async () => {
    for (const nextPage of [
      undefined,
      "",
      "https://other.example/rules?page=2",
      "//other.example/rules?page=2",
      "\\\\other.example/rules?page=2",
      "repos/acme/app/rules/branches/main?per_page=100&page=1",
    ]) {
      const read = reader({ status: 200, data: [rule()], nextPage });
      expect(
        await createGitHubRequiredCheckPolicyReader(read).read("acme/app", "main"),
      ).toMatchObject({ status: "unknown", required: [] });
      expect(read).toHaveBeenCalledTimes(2);
    }
  });
  it("accepts a full final page when GitHub supplies no next relation", async () => {
    const read = reader({
      status: 200,
      data: Array.from({ length: 100 }, () => rule()),
      nextPage: null,
    });
    expect(
      await createGitHubRequiredCheckPolicyReader(read).read("acme/app", "main"),
    ).toMatchObject({ status: "known", required: [{ context: "CI", appId: 42 }] });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not cache a partial policy when a later rule page fails", async () => {
    const read = reader();
    read.mockImplementation(async (path) => {
      if (!path.includes("/rules/")) return { status: 200, data: { contexts: [] } };
      return path.endsWith("page=1")
        ? { status: 200, data: [rule()], nextPage: "repos/acme/app/rules/branches/main?page=2" }
        : { status: 403 };
    });
    expect(
      await createGitHubRequiredCheckPolicyReader(read).read("acme/app", "main"),
    ).toMatchObject({ status: "unknown", required: [] });
  });
  it("accepts absent classic checks but rejects malformed protection summaries", async () => {
    for (const protection of [
      { enabled: true },
      { enabled: true, required_status_checks: null },
      { enabled: true, required_status_checks: [] },
      { enabled: true, required_status_checks: {} },
      {},
      null,
    ]) {
      const read = reader(
        undefined,
        { status: 404 },
        {
          status: 200,
          data: { protected: true, protection },
        },
      );
      const result = await createGitHubRequiredCheckPolicyReader(read).read("acme/app", "main");
      expect(result.status).toBe(
        protection?.enabled === true && !("required_status_checks" in protection)
          ? "known"
          : "unknown",
      );
      if (result.status === "known")
        expect(result.required).toEqual([{ context: "CI", appId: 42 }]);
    }
  });
  it("requires complete bindings in the branch protection fallback", async () => {
    const protection = {
      enabled: true,
      required_status_checks: {
        contexts: ["CI"],
        checks: [{ context: "CI", app_id: 42 }],
        enforcement_level: "everyone",
      },
    };
    const read = reader(
      undefined,
      { status: 403 },
      { status: 200, data: { protected: true, protection } },
    );
    expect(
      (await createGitHubRequiredCheckPolicyReader(read).read("acme/app", "main")).classicSource,
    ).toBe("branch-summary");
    protection.required_status_checks.checks = [];
    expect(
      (await createGitHubRequiredCheckPolicyReader(read).read("acme/app", "main")).status,
    ).toBe("unknown");
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
    expect(read).toHaveBeenCalledTimes(2);
    await cache.read("acme/app", "main");
    expect(read).toHaveBeenCalledTimes(2);
    now = 10;
    await cache.read("acme/app", "main");
    expect(read).toHaveBeenCalledTimes(4);
    cache.invalidate("ACME/APP", "main");
    await cache.read("acme/app", "main");
    expect(read).toHaveBeenCalledTimes(6);
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
    expect(read).toHaveBeenCalledTimes(2);
    now = 5;
    expect((await cache.read("acme/app", "main")).status).toBe("known");
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("does not repopulate the cache from an invalidated in-flight request", async () => {
    let release!: (response: GitHubCheckPolicyResponse) => void;
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
    release({ status: 200, data: [], nextPage: null });
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
