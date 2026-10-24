import { fixtureFetch } from "forges/testing"
import type { Fixture } from "forges/testing"
import { describe, expect, it } from "vitest"

import { forgeProvider, getReviewThread, githubBranchRuleDetails, listReviewThreads, repoRef, retargetPullRequest } from "../src/index.ts"

const api = "https://api.github.com"
const rule = (context = "CI", integration_id: number | null = 42) => ({
  type: "required_status_checks",
  parameters: { required_status_checks: [{ context, integration_id }] },
})
const get = (path: string, status: number, body?: unknown, headers?: Record<string, string>): Fixture => ({
  request: { method: "GET", url: `${api}${path}` },
  response: { status, body: body ?? { message: "status" }, ...(headers ? { headers } : {}) },
})
const rulesPath = "/repos/acme/app/rules/branches/main?per_page=100"
const branchPath = "/repos/acme/app/branches/main"

async function github(fixtures: Fixture[]) {
  const fixture = fixtureFetch(fixtures)
  const provider = await forgeProvider({ forge: "github", token: "token", fetch: fixture.fetch as typeof fetch })
  return { fixture, provider, repo: repoRef(provider, "acme/app") }
}

describe("githubBranchRuleDetails()", () => {
  const unprotected = { name: "main", protected: false }
  const protectedBranch = (checks: unknown = { enforcement_level: "everyone", contexts: ["CI"], checks: [{ context: "CI", app_id: 42 }] }) => ({ name: "main", protected: true, protection: { enabled: true, required_status_checks: checks } })

  it("reads required workflows and ruleset merge methods from every rules page", async () => {
    const { provider, repo } = await github([
      get(branchPath, 200, unprotected),
      get(rulesPath, 200, [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash", "merge"] } }], { link: `<${api}/repositories/1/rules/branches/main?per_page=100&page=2>; rel="next"` }),
      get("/repositories/1/rules/branches/main?per_page=100&page=2", 200, [{ type: "workflows", parameters: { workflows: [{ path: "ci.yml" }] } }, rule("later"), { type: "pull_request", parameters: { allowed_merge_methods: ["merge", "rebase"] } }]),
    ])
    const rules = await provider.repos.branchRules(repo, "main")
    expect(rules.requiredChecks).toEqual([{ name: "later", appId: "42" }])
    expect(githubBranchRuleDetails(rules)).toEqual({ requiredWorkflows: true, mergeMethods: ["merge"], classicSource: "unprotected-branch" })
  })

  it("does not count an empty workflow list", async () => {
    const { provider, repo } = await github([get(branchPath, 200, unprotected), get(rulesPath, 200, [{ type: "workflows", parameters: { workflows: [] } }])])
    expect(githubBranchRuleDetails(await provider.repos.branchRules(repo, "main"))).toEqual({ requiredWorkflows: false, classicSource: "unprotected-branch" })
  })

  it("maps a protection endpoint without admin access to the branch summary source", async () => {
    const readable = await github([get(branchPath, 200, protectedBranch()), get(rulesPath, 200, []), get(`${branchPath}/protection`, 200, {})])
    const rules = await readable.provider.repos.branchRules(readable.repo, "main")
    expect(rules.requiredChecks).toEqual([{ name: "CI", appId: "42" }])
    expect(githubBranchRuleDetails(rules).classicSource).toBe("protection-endpoint")
    // forges reads the checks from the branch summary and warns that it cannot read the approvals.
    const limited = await github([get(branchPath, 200, protectedBranch()), get(rulesPath, 200, []), get(`${branchPath}/protection`, 403, { message: "Resource not accessible by integration" })])
    const summary = await limited.provider.repos.branchRules(limited.repo, "main")
    expect(summary.requiredChecks).toEqual([{ name: "CI", appId: "42" }])
    expect(summary.warnings).toMatchObject([{ code: "insufficient_scope" }])
    expect(githubBranchRuleDetails(summary).classicSource).toBe("branch-summary")
  })

  it("throws instead of returning unknown rules as no rules", async () => {
    const cases: Array<[unknown, unknown[]]> = [
      [unprotected, [{ type: "workflows" }]],
      [unprotected, [{ type: "workflows", parameters: { workflows: "ci" } }]],
      [unprotected, [{ type: "required_status_checks", parameters: {} }]],
      [unprotected, [{ type: "pull_request", parameters: { allowed_merge_methods: "squash" } }]],
      [unprotected, [{ parameters: {} }]],
      [{ name: "main", protected: true }, []],
      [protectedBranch(null), []],
      [protectedBranch({ contexts: ["CI"], checks: [] }), []],
      [protectedBranch({ enforcement_level: "unknown", contexts: ["CI"], checks: [] }), []],
      [protectedBranch({ enforcement_level: "off", contexts: ["CI"], checks: [] }), []],
    ]
    for (const [branch, rules] of cases) {
      const { provider, repo } = await github([get(branchPath, 200, branch), get(rulesPath, 200, rules), get(`${branchPath}/protection`, 200, {})])
      const result = await provider.repos.branchRules(repo, "main")
      expect(() => githubBranchRuleDetails(result)).toThrow(expect.objectContaining({ code: "FORGE_R0007" }))
    }
    expect(() => githubBranchRuleDetails({ branch: "main", requiredChecks: [], raw: {} })).toThrow(expect.objectContaining({ code: "FORGE_R0007" }))
  })

  it("accepts classic contexts when App bindings are absent or empty", async () => {
    for (const checks of [{ enforcement_level: "everyone", contexts: ["CI"] }, { enforcement_level: "everyone", contexts: ["CI"], checks: [] }]) {
      const { provider, repo } = await github([get(branchPath, 200, protectedBranch(checks)), get(rulesPath, 200, []), get(`${branchPath}/protection`, 200, {})])
      const result = await provider.repos.branchRules(repo, "main")
      expect(result.requiredChecks).toEqual([{ name: "CI" }])
      expect(githubBranchRuleDetails(result).classicSource).toBe("protection-endpoint")
    }
  })
})

describe("review threads", () => {
  const thread = (provider: Awaited<ReturnType<typeof github>>["provider"]) => ({ ...repoRef(provider, "acme/app"), repo: repoRef(provider, "acme/app"), kind: "pull_request" as const, number: "12" })

  it("lists every conversation and every comment identity", async () => {
    const graphql = (operationName: string, variables: Record<string, unknown>, data: unknown): Fixture => ({
      request: { method: "POST", url: `${api}/graphql`, operationName, variables },
      response: { status: 200, body: { data } },
    })
    const page = (hasNextPage: boolean, endCursor: string | null) => ({ hasNextPage, endCursor })
    const node = (id: string, comments: unknown[], next: boolean) => ({
      id, isResolved: false, isOutdated: false, path: "src/a.ts", line: 3, originalLine: 3, startLine: null, originalStartLine: null,
      comments: { nodes: comments, pageInfo: page(next, next ? "c1" : null) },
    })
    const { provider, fixture } = await github([
      graphql("ForgeReviewThreads", { owner: "acme", name: "app", number: 12, after: null }, { repository: { pullRequest: { reviewThreads: { nodes: [node("T1", [{ id: "C1", databaseId: 1 }], true)], pageInfo: page(true, "t1") } } } }),
      graphql("ForgeReviewThreads", { owner: "acme", name: "app", number: 12, after: "t1" }, { repository: { pullRequest: { reviewThreads: { nodes: [node("T2", [], false)], pageInfo: page(false, null) } } } }),
      graphql("ForgeReviewThreadComments", { id: "T1", after: "c1" }, { node: { comments: { nodes: [{ id: "C2", databaseId: null }], pageInfo: page(false, null) } } }),
    ])
    const threads = await listReviewThreads(provider, thread(provider))
    expect(threads.map(item => ({ id: item.id, comments: item.comments, line: item.line, path: item.path }))).toEqual([
      { id: "T1", comments: [{ id: "C1", restId: "1" }, { id: "C2" }], line: 3, path: "src/a.ts" },
      { id: "T2", comments: [], line: 3, path: "src/a.ts" },
    ])
    expect(threads[0]?.raw).not.toHaveProperty("comments")
    expect(fixture.calls).toHaveLength(3)
  })

  it("looks up the pull request of one conversation", async () => {
    const { provider } = await github([
      { request: { method: "POST", url: `${api}/graphql`, operationName: "ForgeReviewThread", variables: { id: "T1" } }, response: { status: 200, body: { data: { node: { id: "T1", isResolved: true, pullRequest: { id: "PR_1" } } } } } },
      { request: { method: "POST", url: `${api}/graphql`, operationName: "ForgeReviewThread", variables: { id: "X" } }, response: { status: 200, body: { data: { node: {} } } } },
    ])
    await expect(getReviewThread(provider, "T1")).resolves.toEqual({ id: "T1", resolved: true, pullRequestId: "PR_1" })
    await expect(getReviewThread(provider, "X")).resolves.toBeUndefined()
  })

  it("changes the base branch of a pull request", async () => {
    const { provider, fixture } = await github([{ request: { method: "PATCH", url: `${api}/repos/acme/app/pulls/12` }, response: { status: 200, body: {} } }])
    await retargetPullRequest(provider, thread(provider), "main")
    expect(fixture.calls[0]?.body).toBe(JSON.stringify({ base: "main" }))
    await expect(retargetPullRequest(provider, thread(provider), " ")).rejects.toMatchObject({ code: "FORGE_R0009" })
  })
})
