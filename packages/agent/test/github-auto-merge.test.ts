import { describe, expect, it, vi } from "vitest"
import { createGitHubPullRequestOperations, type GitHubPullRequestOperationsOptions } from "../src/server/github-auto-merge.ts"

const head = "a".repeat(40)
const page = () => ({ hasNextPage: false, endCursor: null as string | null })
function fixture(options: Partial<GitHubPullRequestOperationsOptions> = {}) {
  const pullRequest = {
    id: "PR_123", number: 12, state: "OPEN", isDraft: false,
    headRefOid: head, headRefName: "fix/bug", baseRefName: "main",
    title: "Fix bug", body: "Details", authorAssociation: "MEMBER", isCrossRepository: false, author: { login: "author", __typename: "User" },
    headRepository: { nameWithOwner: "acme/app" },
    labels: { nodes: [{ name: "babysit" }], pageInfo: page() },
    reviewDecision: null as string | null,
    autoMergeRequest: null as { enabledAt: string } | null,
    latestOpinionatedReviews: { nodes: [] as { author: { login: string, __typename: string } | null, state: string }[], pageInfo: page() },
  }
  const repository = {
    autoMergeAllowed: true, squashMergeAllowed: true, mergeCommitAllowed: true,
    rebaseMergeAllowed: true, deleteBranchOnMerge: false, pullRequest,
  }
  const state = {
    rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }] as unknown[],
    protection: null as { requiresStatusChecks: boolean, requiredStatusCheckContexts: string[] } | null,
    children: 0,
    thread: { pullRequest: { id: "PR_123" }, isResolved: false },
    reviewPage: { nodes: [] as typeof pullRequest.latestOpinionatedReviews.nodes, pageInfo: page() },
    labelPage: { nodes: [] as { name: string }[], pageInfo: page() },
    run: { head_sha: head, repository: { full_name: "acme/app" }, pull_requests: [] as { number: number, head: { sha: string } }[] },
    logs: "CI failure",
    mutationError: false,
    merged: false,
    beforeRead: () => {},
  }
  const command = vi.fn(async (args: string[]) => {
    if (args[1]?.includes("/actions/runs/")) return { stdout: JSON.stringify(state.run), stderr: "" }
    if (args[0] === "run") return { stdout: state.logs, stderr: "" }
    if (args[1]?.includes("/rules/branches/")) return { stdout: JSON.stringify(state.rules), stderr: "" }
    if (args[1] !== "graphql") return { stdout: "{}", stderr: "" }
    const query = args.find(arg => arg.startsWith("query="))!
    let data: unknown
    if (query.includes("mutation(")) {
      if (state.mutationError) return { stdout: JSON.stringify({ data: null, errors: [{ message: "Head oid mismatch" }] }), stderr: "" }
      data = { enablePullRequestAutoMerge: { pullRequest: { id: pullRequest.id, state: state.merged ? "MERGED" : "OPEN", headRefOid: pullRequest.headRefOid, autoMergeRequest: state.merged ? null : { enabledAt: "2026-09-13T00:00:00Z" } } } }
    }
    else if (query.includes("branchProtectionRule")) data = { repository: { ref: { branchProtectionRule: state.protection } } }
    else if (query.includes("baseRefName:$base")) data = { repository: { pullRequests: { totalCount: state.children } } }
    else if (query.includes("PullRequestReviewThread")) data = { node: state.thread }
    else if (query.includes("labels(first:100,after:")) data = { node: { labels: state.labelPage } }
    else if (query.includes("latestOpinionatedReviews(first:100,after:")) data = { node: { latestOpinionatedReviews: state.reviewPage } }
    else { state.beforeRead(); data = { repository } }
    return { stdout: JSON.stringify({ data }), stderr: "" }
  })
  const release = vi.fn()
  const settle = vi.fn()
  const ensureGraphQLBudget = vi.fn(async () => {
    let submitted = false
    return {
      checkedAt: 0, remaining: 1000, resetAt: 0,
      release: () => { if (submitted) throw new Error("Cannot release submitted reservation"); release() },
      settle: (cost: number) => { if (!submitted) throw new Error("Reservation not submitted"); settle(cost) },
      submit: () => { submitted = true },
    }
  })
  const operations = createGitHubPullRequestOperations({ command, ensureGraphQLBudget }, { repository: "acme/app", number: 12, expectedHeadOid: head, ...options })
  const mutations = () => command.mock.calls.filter(([args]) => args.some(arg => arg.includes("mutation(")))
  return { operations, command, ensureGraphQLBudget, release, settle, mutations, repository, pullRequest, state }
}

describe("native auto-merge", () => {
  it("is disabled without touching credentials, reads or writes", async () => {
    const f = fixture()
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason: "disabled" })
    expect(f.command).not.toHaveBeenCalled()
    expect(f.ensureGraphQLBudget).not.toHaveBeenCalled()
  })

  it("enables GitHub auto-merge with an atomic expected-head check and no direct merge or self-approval", async () => {
    const eligible = vi.fn(() => true)
    const f = fixture({ autoMerge: true, eligible })
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
    expect(f.mutations()).toHaveLength(1)
    const args = f.mutations()[0]![0]
    expect(args).toContain(`head=${head}`)
    expect(args).toContain("method=SQUASH")
    expect(args.find(arg => arg.startsWith("query="))).toContain("expectedHeadOid:$head")
    expect(eligible).toHaveBeenCalledWith(expect.objectContaining({ repository: "acme/app", labels: ["babysit"], author: { login: "author", __typename: "User" } }))
    expect(f.command.mock.calls.every(([command]) => !command.some(arg => /mergePullRequest\(|addPullRequestReview\(|deleteRef\(/.test(arg)))).toBe(true)
    expect(f.settle).toHaveBeenCalledTimes(f.ensureGraphQLBudget.mock.calls.length)
    expect(f.release).not.toHaveBeenCalled()
  })

  it.each([
    ["draft", (f: ReturnType<typeof fixture>) => { f.pullRequest.isDraft = true }],
    ["repository-disabled", (f: ReturnType<typeof fixture>) => { f.repository.autoMergeAllowed = false }],
    ["required-checks-missing", (f: ReturnType<typeof fixture>) => { f.state.rules = [] }],
    ["changes-requested", (f: ReturnType<typeof fixture>) => { f.pullRequest.reviewDecision = "CHANGES_REQUESTED" }],
    ["merge-method-unavailable", (f: ReturnType<typeof fixture>) => { f.repository.squashMergeAllowed = false; f.repository.mergeCommitAllowed = false; f.repository.rebaseMergeAllowed = false }],
    ["stacked-branch-cleanup", (f: ReturnType<typeof fixture>) => { f.repository.deleteBranchOnMerge = true; f.state.children = 1 }],
  ] as const)("blocks %s without a mutation", async (reason, prepare) => {
    const f = fixture({ autoMerge: true })
    prepare(f)
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason })
    expect(f.mutations()).toHaveLength(0)
  })

  it("accepts classic branch protection with required checks", async () => {
    const f = fixture({ autoMerge: true })
    f.state.rules = []
    f.state.protection = { requiresStatusChecks: true, requiredStatusCheckContexts: ["CI"] }
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
  })

  it("blocks human changes requested on later review pages", async () => {
    const f = fixture({ autoMerge: true })
    f.pullRequest.latestOpinionatedReviews.pageInfo = { hasNextPage: true, endCursor: "next" }
    f.state.reviewPage.nodes = [{ author: { login: "reviewer", __typename: "User" }, state: "CHANGES_REQUESTED" }]
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason: "changes-requested" })
    expect(f.mutations()).toHaveLength(0)
  })

  it("filters using all current PR labels", async () => {
    const f = fixture({ autoMerge: true, eligible: pr => !pr.labels.includes("do-not-touch") })
    f.pullRequest.labels.pageInfo = { hasNextPage: true, endCursor: "next" }
    f.state.labelPage.nodes = [{ name: "do-not-touch" }]
    await expect(f.operations.requestAutoMerge()).rejects.toThrow("configured filter")
    expect(f.mutations()).toHaveLength(0)
  })

  it("rechecks head and admission after eligibility reads", async () => {
    const f = fixture({ autoMerge: true })
    let reads = 0
    f.state.beforeRead = () => { if (++reads === 2) f.pullRequest.headRefOid = "b".repeat(40) }
    await expect(f.operations.requestAutoMerge()).rejects.toThrow("head changed")
    expect(f.mutations()).toHaveLength(0)
  })

  it("does not transfer an in-flight merge request to a concurrent own push", async () => {
    let admitted = 0
    const nextHead = "b".repeat(40)
    const f = fixture({
      autoMerge: true,
      push: async () => { f.pullRequest.headRefOid = nextHead; return nextHead },
      eligible: async () => { if (++admitted === 1) await f.operations.push(); return true },
    })
    await expect(f.operations.requestAutoMerge()).rejects.toThrow("head changed during")
    expect(f.mutations()).toHaveLength(0)
  })

  it("blocks new human change requests observed during the final admission read", async () => {
    const f = fixture({ autoMerge: true })
    let reads = 0
    f.state.beforeRead = () => {
      if (++reads === 2) f.pullRequest.latestOpinionatedReviews.nodes = [{ author: { login: "reviewer", __typename: "User" }, state: "CHANGES_REQUESTED" }]
    }
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason: "changes-requested" })
    expect(f.mutations()).toHaveLength(0)
  })

  it("does not fall back to direct merging when GitHub rejects enabling", async () => {
    const f = fixture({ autoMerge: true })
    f.state.mutationError = true
    await expect(f.operations.requestAutoMerge()).rejects.toThrow("could not complete")
    expect(f.mutations()).toHaveLength(1)
  })

  it("accepts immediate completion by GitHub native auto-merge", async () => {
    const f = fixture({ autoMerge: true })
    f.state.merged = true
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "merged" })
    expect(f.mutations()).toHaveLength(1)
  })

  it("recognizes existing auto-merge only after checking current policy", async () => {
    const f = fixture({ autoMerge: true })
    f.pullRequest.autoMergeRequest = { enabledAt: "2026-09-13T00:00:00Z" }
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "already-enabled" })
    expect(f.mutations()).toHaveLength(0)
    f.pullRequest.reviewDecision = "CHANGES_REQUESTED"
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason: "changes-requested" })
  })
})

describe("host-owned repair operations", () => {
  it("binds comments and metadata to the selected PR, treating content as literal fields", async () => {
    const f = fixture()
    await f.operations.comment("$(touch /tmp/never) @secret-file")
    await f.operations.updateMetadata({ title: "New title", body: "" })
    expect(f.command).toHaveBeenCalledWith(["api", "/repos/acme/app/issues/12/comments", "--method", "POST", "-f", "body=$(touch /tmp/never) @secret-file"], expect.anything())
    expect(f.command).toHaveBeenCalledWith(["api", "/repos/acme/app/issues/12", "--method", "PATCH", "-f", "title=New title", "-f", "body="], expect.anything())
  })

  it("reads bounded failure logs only for a run at the admitted head", async () => {
    const f = fixture()
    expect(await f.operations.readCheckLogs(123)).toEqual({ text: "CI failure", truncated: false })
    expect(f.command).toHaveBeenCalledWith(["run", "view", "123", "--repo", "acme/app", "--log-failed"], expect.anything())
    f.state.logs = "x".repeat(200_001)
    expect(await f.operations.readCheckLogs(123)).toEqual({ text: "x".repeat(200_000), truncated: true })
    f.state.run.head_sha = "b".repeat(40)
    await expect(f.operations.readCheckLogs(123)).rejects.toThrow("does not belong")
    expect(f.command.mock.calls.filter(([args]) => args[0] === "run")).toHaveLength(2)
  })

  it("accepts a synthetic merge workflow run linked to the expected PR head", async () => {
    const f = fixture()
    f.state.run.head_sha = "b".repeat(40)
    f.state.run.pull_requests = [{ number: 12, head: { sha: head } }]
    expect(await f.operations.readCheckLogs(123)).toEqual({ text: "CI failure", truncated: false })
  })

  it("rejects thread IDs owned by another PR", async () => {
    const f = fixture()
    f.state.thread.pullRequest.id = "PR_other"
    await expect(f.operations.resolveThread("THREAD_other")).rejects.toThrow("does not belong")
    expect(f.mutations()).toHaveLength(0)
  })

  it("resolves an owned thread and skips already resolved threads", async () => {
    const f = fixture()
    await f.operations.resolveThread("THREAD_1")
    expect(f.mutations()).toHaveLength(1)
    expect(f.mutations()[0]![0]).toContain("id=THREAD_1")
    f.state.thread.isResolved = true
    await f.operations.resolveThread("THREAD_1")
    expect(f.mutations()).toHaveLength(1)
  })

  it.each(["closed", "head", "filter"])("rejects %s work before allowing a host push", async condition => {
    const push = vi.fn(async () => head)
    const f = fixture({ push, eligible: () => condition !== "filter" })
    if (condition === "closed") f.pullRequest.state = "CLOSED"
    if (condition === "head") f.pullRequest.headRefOid = "b".repeat(40)
    await expect(f.operations.push()).rejects.toThrow()
    expect(push).not.toHaveBeenCalled()
  })

  it("allows repairs on drafts admitted by the configured filter", async () => {
    const push = vi.fn(async () => head)
    const f = fixture({ push, eligible: pr => pr.isDraft })
    f.pullRequest.isDraft = true
    await f.operations.push()
    await f.operations.comment("Draft repaired.")
    expect(push).toHaveBeenCalledOnce()
  })

  it("calls the bound host push without accepting a worker-selected target", async () => {
    const push = vi.fn(async () => head)
    const f = fixture({ push })
    await f.operations.push()
    expect(push).toHaveBeenCalledWith()
  })

  it("uses the host-verified pushed SHA for subsequent comment, thread and merge operations", async () => {
    const nextHead = "b".repeat(40)
    const push = vi.fn(async () => { f.pullRequest.headRefOid = nextHead; return nextHead })
    const f = fixture({ autoMerge: true, push })
    await f.operations.push()
    await f.operations.resolveThread("THREAD_1")
    await f.operations.updateMetadata({ title: "Repaired" })
    await f.operations.comment("Repair pushed.")
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
    expect(f.mutations().at(-1)![0]).toContain(`head=${nextHead}`)
    f.pullRequest.headRefOid = "c".repeat(40)
    await expect(f.operations.comment("Obsolete")).rejects.toThrow("head changed")
  })

  it("rejects missing push authority", async () => {
    const f = fixture()
    await expect(f.operations.push()).rejects.toThrow("no host-owned push")
    expect(f.command).not.toHaveBeenCalled()
  })

  it("honors cancellation before resolving credentials", async () => {
    const controller = new AbortController()
    controller.abort(new Error("obsolete"))
    const f = fixture({ signal: controller.signal })
    await expect(f.operations.comment("Update")).rejects.toThrow("obsolete")
    expect(f.ensureGraphQLBudget).not.toHaveBeenCalled()
    expect(f.command).not.toHaveBeenCalled()
  })
})
