import { fixtureFetch } from "forges/testing"
import type { Fixture } from "forges/testing"
import { describe, expect, it } from "vitest"

import { branchRules, forgeProvider, getReviewThread, listReviewThreads, repoRef, retargetPullRequest } from "../src/index.ts"

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
const classicPath = "/repos/acme/app/branches/main/protection/required_status_checks"
const branchPath = "/repos/acme/app/branches/main"

async function github(fixtures: Fixture[]) {
  const fixture = fixtureFetch(fixtures)
  const provider = await forgeProvider({ forge: "github", token: "token", fetch: fixture.fetch as typeof fetch })
  return { fixture, provider, repo: repoRef(provider, "acme/app") }
}

describe("branchRules()", () => {
  it("combines active rules and classic App bindings without weakening them", async () => {
    const { provider, repo, fixture } = await github([
      get("/repos/acme/app/rules/branches/release%2Fv1?per_page=100", 200, [rule(), { type: "pull_request", parameters: { allowed_merge_methods: ["squash", "merge"] } }]),
      get("/repos/acme/app/branches/release%2Fv1/protection/required_status_checks", 200, { contexts: ["CI", "lint"], checks: [{ context: "CI", app_id: 42 }] }),
    ])
    await expect(branchRules(provider, repo, "release/v1")).resolves.toEqual({
      requiredChecks: [{ context: "CI", appId: 42 }, { context: "lint", appId: null }],
      requiredWorkflows: false,
      mergeMethods: ["squash", "merge"],
      classicSource: "protection-endpoint",
    })
    expect(fixture.calls).toHaveLength(2)
  })

  it("reports required workflows and reads later rule pages", async () => {
    const { provider, repo } = await github([
      get(rulesPath, 200, [{ type: "deletion" }], { link: `<${api}/repositories/1/rules/branches/main?per_page=100&page=2>; rel="next"` }),
      get("/repositories/1/rules/branches/main?per_page=100&page=2", 200, [{ type: "workflows", parameters: { workflows: [{ path: "ci.yml" }] } }, rule("later")]),
      get(classicPath, 404),
      get(branchPath, 200, { protected: false }),
    ])
    await expect(branchRules(provider, repo, "main")).resolves.toEqual({
      requiredChecks: [{ context: "later", appId: 42 }],
      requiredWorkflows: true,
      classicSource: "unprotected-branch",
    })
  })

  it("throws instead of returning unknown rules as no rules", async () => {
    for (const fixtures of [
      [get(rulesPath, 403), get(classicPath, 200, { contexts: [] })],
      [get(rulesPath, 200, [rule("CI", -3)]), get(classicPath, 200, { contexts: [] })],
      [get(rulesPath, 200, []), get(classicPath, 404), get(branchPath, 404)],
      [get(rulesPath, 200, []), get(classicPath, 500)],
      [get(rulesPath, 200, [], { link: `<https://other.example/rules?page=2>; rel="next"` }), get(classicPath, 200, { contexts: [] })],
    ]) {
      const { provider, repo } = await github(fixtures)
      await expect(branchRules(provider, repo, "main")).rejects.toMatchObject({ code: "FORGE_R0007" })
    }
  })

  it("reads the branch summary when the protection endpoint is not readable", async () => {
    const protection = { enabled: true, required_status_checks: { contexts: ["CI"], checks: [{ context: "CI", app_id: 42 }], enforcement_level: "everyone" } }
    const { provider, repo } = await github([get(rulesPath, 200, []), get(classicPath, 403), get(branchPath, 200, { protected: true, protection })])
    await expect(branchRules(provider, repo, "main")).resolves.toMatchObject({ requiredChecks: [{ context: "CI", appId: 42 }], classicSource: "branch-summary" })
    for (const malformed of [
      { enabled: true, required_status_checks: null },
      { enabled: true, required_status_checks: { contexts: ["CI"], checks: [], enforcement_level: "everyone" } },
      {},
    ]) {
      const { provider, repo } = await github([get(rulesPath, 200, []), get(classicPath, 403), get(branchPath, 200, { protected: true, protection: malformed })])
      await expect(branchRules(provider, repo, "main")).rejects.toMatchObject({ code: "FORGE_R0007" })
    }
  })

  it("is GitHub-only", async () => {
    const provider = await forgeProvider({ forge: "gitlab", token: "token" })
    await expect(branchRules(provider, repoRef(provider, "acme/app"), "main")).rejects.toMatchObject({ code: "FORGE_R0006" })
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
