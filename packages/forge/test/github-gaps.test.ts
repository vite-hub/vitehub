import { fixtureFetch } from "forges/testing"
import type { Fixture } from "forges/testing"
import { describe, expect, it } from "vitest"

import { forgeBranchRules, forgeMerge, forgeProvider, ForgeTimeoutError, githubBranchRuleDetails, MergeBlockedError, repoRef, retargetPullRequest } from "../src/index.ts"

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

describe("forgeBranchRules()", () => {
  // GitHub's answer on a private repository whose plan has no rulesets or branch protection.
  const planLimit = { message: "Upgrade to GitHub Pro or make this repository public to enable this feature.", status: "403" }
  const unprotected = { name: "main", protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } } }

  it("reads no rules on a private repository whose plan has none", async () => {
    const { provider, repo } = await github([get(branchPath, 200, unprotected), get(rulesPath, 403, planLimit)])
    const rules = await forgeBranchRules(provider, repo, "main")
    expect(rules).toMatchObject({ branch: "main", requiredChecks: [], requiredApprovals: 0 })
    expect(githubBranchRuleDetails(rules)).toEqual({ requiredWorkflows: false, classicSource: "unprotected-branch" })
  })

  it("rejects a 403 that is not the plan limit", async () => {
    const { provider, repo } = await github([get(branchPath, 200, unprotected), get(rulesPath, 403, { message: "Resource not accessible by integration" })])
    await expect(forgeBranchRules(provider, repo, "main")).rejects.toMatchObject({ status: 403 })
  })

  it("rejects the plan limit when the branch summary reports protection", async () => {
    const { provider, repo } = await github([get(branchPath, 200, { ...unprotected, protected: true }), get(rulesPath, 403, planLimit)])
    await expect(forgeBranchRules(provider, repo, "main")).rejects.toMatchObject({ status: 403 })
  })
})

describe("retargetPullRequest()", () => {
  const thread = (provider: Awaited<ReturnType<typeof github>>["provider"]) => ({ ...repoRef(provider, "acme/app"), repo: repoRef(provider, "acme/app"), kind: "pull_request" as const, number: "12" })

  it("changes the base branch of a pull request", async () => {
    const { provider, fixture } = await github([{ request: { method: "PATCH", url: `${api}/repos/acme/app/pulls/12` }, response: { status: 200, body: {} } }])
    await retargetPullRequest(provider, thread(provider), "main")
    expect(fixture.calls[0]?.body).toBe(JSON.stringify({ base: "main" }))
    await expect(retargetPullRequest(provider, thread(provider), " ")).rejects.toMatchObject({ code: "FORGE_R0009" })
  })
})

describe("forgeMerge()", () => {
  const head = "a".repeat(40)
  const thread = (provider: Awaited<ReturnType<typeof github>>["provider"]) => ({ ...repoRef(provider, "acme/app"), repo: repoRef(provider, "acme/app"), kind: "pull_request" as const, number: "12" })
  const mergePath = `${api}/repos/acme/app/pulls/12/merge-async`
  const put = (status: number, body: unknown): Fixture => ({ request: { method: "PUT", url: mergePath }, response: { status, body } })
  const poll = (uuid: string, body: unknown): Fixture => ({ request: { method: "GET", url: `${mergePath}/${uuid}` }, response: { status: 200, body } })
  const pending = (details: Record<string, unknown> = {}) => ({ status: "pending", details: { uuid: "u-1", expected_head_sha: head, merge_method: "squash", merge_action: "direct_merge", bypass_rules: true, ...details } })

  it("asks GitHub to bypass branch rules and waits for the pending merge", async () => {
    const { provider, fixture } = await github([put(202, pending()), poll("u-1", { status: "merged", details: { sha: "b".repeat(40) } })])
    await expect(forgeMerge(provider, thread(provider), { method: "squash", sha: head, bypassRules: true })).resolves.toMatchObject({ status: "merged", sha: "b".repeat(40) })
    expect(JSON.parse(fixture.calls[0]!.body!)).toEqual({ merge_method: "squash", sha: head, merge_action: "direct_merge", bypass_rules: true })
  })

  it("joins a pending request only when it asked for the same bypass merge", async () => {
    const joined = await github([put(409, pending()), poll("u-1", { status: "merged", details: {} })])
    await expect(forgeMerge(joined.provider, thread(joined.provider), { method: "squash", sha: head, bypassRules: true })).resolves.toMatchObject({ status: "merged" })
    const other = await github([put(409, pending({ bypass_rules: false }))])
    await expect(forgeMerge(other.provider, thread(other.provider), { method: "squash", sha: head, bypassRules: true })).rejects.toBeInstanceOf(MergeBlockedError)
  })

  it("rejects a merge GitHub refuses, and names a merge that outlasts the timeout", async () => {
    const failed = await github([put(200, { status: "failed", details: { message: "Rule bypass not allowed" } })])
    await expect(forgeMerge(failed.provider, thread(failed.provider), { method: "squash", sha: head, bypassRules: true })).rejects.toThrow("Rule bypass not allowed")
    const refused = await github([put(400, { message: "Pull Request is not mergeable" })])
    await expect(forgeMerge(refused.provider, thread(refused.provider), { method: "squash", sha: head, bypassRules: true })).rejects.toBeInstanceOf(MergeBlockedError)
    const slow = await github([put(202, pending()), poll("u-1", pending())])
    await expect(forgeMerge(slow.provider, thread(slow.provider), { method: "squash", sha: head, bypassRules: true, timeout: 50 })).rejects.toBeInstanceOf(ForgeTimeoutError)
  })

  it("needs the method and head for a bypass, and leaves other merges to threads.merge()", async () => {
    const { provider, fixture } = await github([put(200, { status: "merged", details: { sha: "b".repeat(40) } })])
    await expect(forgeMerge(provider, thread(provider), { bypassRules: true, sha: head })).rejects.toMatchObject({ code: "FORGE_R0009" })
    expect(fixture.calls).toHaveLength(0)
    await expect(forgeMerge(provider, thread(provider), { method: "squash", sha: head })).resolves.toMatchObject({ status: "merged" })
    expect(JSON.parse(fixture.calls[0]!.body!)).not.toHaveProperty("bypass_rules")
  })
})
