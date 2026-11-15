import { describe, expect, it, vi } from "vitest"
import { createGitHubPullRequestOperations, reviewerLabeledSevere, type GitHubPullRequestOperationsOptions } from "../src/github/auto-merge.ts"

import { githubError, githubForge, type GitHubTestRequest } from "./fixtures/github-forge.ts"

const head = "a".repeat(40)
const reviewComment = { databaseId: 501, body: "P2: config spread", author: { login: "pullfrog", __typename: "Bot" }, createdAt: "2026-11-07T00:00:00Z", url: "https://github.com/acme/app/pull/12#discussion_r501" }
const page = () => ({ hasNextPage: false, endCursor: null as string | null })
async function fixture(options: Partial<GitHubPullRequestOperationsOptions> = {}) {
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
    additionalRulePages: [] as unknown[][],
    /** Classic required status checks, or null when the branch has none. */
    protection: null as { contexts: string[] } | null,
    /** Whether the credential can read classic protection, which needs admin access. */
    protectionReadable: true,
    children: 0,
    thread: { id: "THREAD_1", isResolved: false },
    threadComments: [] as { databaseId: number, body: string, author: { login: string, __typename: string }, createdAt: string, url: string }[],
    threadCommentPages: [] as (typeof reviewComment)[][],
    reviewPage: { nodes: [] as typeof pullRequest.latestOpinionatedReviews.nodes, pageInfo: page() },
    labelPage: { nodes: [] as { name: string }[], pageInfo: page() },
    run: { id: 123, head_sha: head, repository: { full_name: "acme/app" }, pull_requests: [] as { number: number, head: { sha: string } }[] },
    logs: "CI failure",
    mutationError: false,
    threadFailure: undefined as "reply-result-lost" | "resolve-failed" | "resolve-result-lost" | undefined,
    merged: false,
    beforeRead: () => {},
    compare: { status: "ahead", behind_by: 0 },
  }
  const route = (request: GitHubTestRequest): unknown => {
    switch (request.operationName) {
      case "EnablePullRequestAutoMerge":
        if (state.mutationError) return Response.json({ data: null, errors: [{ message: "Head oid mismatch" }] })
        return { enablePullRequestAutoMerge: { pullRequest: { id: pullRequest.id, state: state.merged ? "MERGED" : "OPEN", headRefOid: pullRequest.headRefOid, autoMergeRequest: state.merged ? null : { enabledAt: "2026-09-13T00:00:00Z" } } } }
      case "PullRequestOperationChildren": return { repository: { pullRequests: { totalCount: state.children } } }
      case "ReviewThreadPage": return { repository: { pullRequest: { reviewThreads: { nodes: [{ ...state.thread, comments: { nodes: state.threadComments } }], pageInfo: page() } } } }
      case "ReviewThreadOutcomeComments": {
        const index = Number(request.variables?.after ?? 0)
        const pages = [state.threadComments, ...state.threadCommentPages]
        return { viewer: { login: "worker[bot]" }, node: { comments: { nodes: pages[index], pageInfo: { hasNextPage: index < pages.length - 1, endCursor: index < pages.length - 1 ? String(index + 1) : null } } } }
      }
      case "ResolveReviewThread":
        if (state.threadFailure !== "resolve-failed") state.thread.isResolved = true
        if (state.threadFailure?.startsWith("resolve-")) return Response.json({ errors: [{ message: "Resolution failed" }] })
        return { resolveReviewThread: { thread: { isResolved: true } } }
      case "PullRequestOperationLabels": return { node: { labels: state.labelPage } }
      case "PullRequestOperationReviews": return { node: { latestOpinionatedReviews: state.reviewPage } }
      case "PullRequestOperationSnapshot": state.beforeRead(); return { repository }
    }
    const path = request.path
    if (path === "/repos/acme/app/rules/branches/main") {
      if (request.url.searchParams.get("page") === "2") return state.additionalRulePages.flat()
      const next = state.additionalRulePages.length ? { link: '<https://api.github.com/repos/acme/app/rules/branches/main?per_page=100&page=2>; rel="next"' } : undefined
      return Response.json(state.rules, next ? { headers: next } : {})
    }
    if (path === "/repos/acme/app/branches/main/protection") {
      if (!state.protectionReadable) return githubError(403, "Resource not accessible by integration")
      return state.protection ? {} : githubError(404, "Branch not protected")
    }
    if (path === "/repos/acme/app/branches/main") {
      if (!state.protection) return { name: "main", protected: false }
      return { name: "main", protected: true, protection: { enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: state.protection.contexts, checks: state.protection.contexts.map(context => ({ context, app_id: null })) } } }
    }
    if (path.startsWith("/repos/acme/app/compare/")) return state.compare
    if (/^\/repos\/acme\/app\/commits\/[a-f\d]{40}\/check-runs$/.test(path)) return { total_count: 0, check_runs: [] }
    if (/^\/repos\/acme\/app\/commits\/[a-f\d]{40}\/status(es)?$/.test(path)) return path.endsWith("statuses") ? [] : { state: "success", statuses: [], total_count: 0 }
    if (path === "/repos/acme/app/actions/runs") return { total_count: 0, workflow_runs: [] }
    if (path === "/repos/acme/app/actions/runs/123") return state.run
    if (path === "/repos/acme/app/actions/runs/123/jobs") return { total_count: 2, jobs: [{ id: 7, name: "test", status: "completed", conclusion: "failure" }, { id: 8, name: "lint", status: "completed", conclusion: "success" }] }
    if (path === "/repos/acme/app/actions/jobs/7/logs") return state.logs
    if (request.method === "POST" && path === "/repos/acme/app/issues/12/comments") return { id: 1, body: (request.body as { body: string }).body }
    if (request.method === "POST" && path === "/repos/acme/app/pulls/12/comments/501/replies") {
      const body = (request.body as { body: string }).body
      state.threadComments.push({ ...reviewComment, databaseId: 502, body, author: { login: "worker[bot]", __typename: "Bot" } })
      if (state.threadFailure === "reply-result-lost") throw new Error("Reply result lost")
      return { id: 502, body, user: { login: "worker[bot]", type: "Bot" }, created_at: "2026-11-07T00:00:00Z", html_url: "https://github.com/acme/app/pull/12#discussion_r502", in_reply_to_id: 501 }
    }
    if (request.method === "PATCH" && path === "/repos/acme/app/pulls/12") return { number: 12, title: "Fix bug", state: "open", head: { sha: head } }
    return undefined
  }
  const github = await githubForge(route)
  const forge = vi.fn(async () => github.provider)
  const operations = createGitHubPullRequestOperations({ forge }, { repository: "acme/app", number: 12, expectedHeadOid: head, ...options })
  const calls = github.calls
  const mutations = () => calls.filter(call => call.operationName === "EnablePullRequestAutoMerge" || call.operationName === "ResolveReviewThread")
  const comments = () => calls.filter(call => call.method === "POST" && call.path === "/repos/acme/app/issues/12/comments").map(call => (call.body as { body: string }).body)
  const updates = () => calls.filter(call => call.method === "PATCH" && call.path === "/repos/acme/app/pulls/12").map(call => call.body)
  return { operations, forge, calls, mutations, comments, updates, repository, pullRequest, state }
}


describe("native auto-merge", () => {
  it("marks both comments and mentions as host-authored repair activity", async () => {
    const commentPrefix = "<!-- vitehub-babysitter-repair:repair -->\n"
    const f = await fixture({ mentionAllowlist: ["stefina"], commentPrefix })
    await f.operations.comment("Verified blocker.")
    await f.operations.mention("stefina", "Please restore the service.")
    expect(f.comments()).toEqual([
      `${commentPrefix}Verified blocker.`,
      `${commentPrefix}@stefina\n\nPlease restore the service.`,
    ])
  })

  it("exposes a guarded explicit mention operation", async () => {
    const f = await fixture({ mentionAllowlist: ["stefina"] })
    await f.operations.mention("Stefina", "Please confirm the product decision.")
    expect(f.comments()).toEqual(["@Stefina\n\nPlease confirm the product decision."])
    await expect(f.operations.mention("someone-else", "Please review this.")).rejects.toThrow(/allowlist/)
    await expect(f.operations.mention("stefina", "Also notify @another.")).rejects.toThrow(/another mention/)
  })

  it("does not let ordinary Babysitter comments bypass the mention allowlist", async () => {
    const f = await fixture({ mentionAllowlist: ["stefina"], restrictCommentMentions: true })
    await expect(f.operations.comment("Please ask @stefina to confirm.")).rejects.toThrow(/guarded mention capability/)
    await expect(f.operations.comment("Please ask @other-user to confirm.")).rejects.toThrow(/guarded mention capability/)
    await expect(f.operations.comment("Please ask @stefina and @other-user to confirm.")).rejects.toThrow(/guarded mention capability/)
    await expect(f.operations.comment("Please ask @acme/ops to confirm.")).rejects.toThrow(/guarded mention capability/)
    await expect(f.operations.resolveThread("THREAD_1", { outcome: "fixed", reason: "Please ask @other-user to confirm." })).rejects.toThrow(/guarded mention capability/)
  })

  it.each([
    "Contact ops@example.com to restore service.",
    "Contact ops+alerts@example.com to restore service.",
    "Contact ops._+-@example.com to restore service.",
    "Open https://example.com/@someone for details.",
    'See https://example.com/"@other-user',
    "See https://example.com/'@other-user",
    'See www.example.com/"@other-user',
    'See https://example.com/&quot;@other-user',
    "See www.example.com/@other-user",
    "See https://example.com/&#34;@other-user",
    "See https://example.com/&#x22;@other-user",
    "See https://example.com/&apos;@other-user",
    "See https://example.com/&#39;@other-user",
    "See https://example.com/&#x27;@other-user",
    "Use @@someone as the delimiter.",
    "Use @ as the delimiter.",
    "Contact ops+@example.com to restore service.",
    "Contact ops-@example.com to restore service.",
    "foo <!-- @other-user --> bar",
    "foo <!-- first line\n@other-user --> bar",
    "foo <!-- @first --> bar <!-- @second --> baz",
    "<!-- @other-user -->",
    '<span title="notify @other-user">status</span>',
    "<https://example.com/?assignee=@other-user>",
    "<https://example.com/#@other-user>",
    "Use `@someone` in the configuration.",
    "Use `` `@someone` `` in the configuration.",
    "Use `first line\n@someone` in the configuration.",
    "```text\n@someone\n```",
    "~~~text\n@/ent:platform-sre\n~~~~",
    "```text\n@someone",
    "    @someone\n    @acme/ops",
    "> ```text\n> @someone\n> ```",
    "- Example:\n\n  ```text\n  @someone\n  ```",
  ])("allows non-mention at-signs in %s", async (body) => {
    const f = await fixture({ mentionAllowlist: ["stefina"], restrictCommentMentions: true })
    await f.operations.comment(body)
    await f.operations.mention("stefina", body)
    expect(f.comments()).toEqual([body, `@stefina\n\n${body}`])
  })

  it.each([
    "foo+@bar_baz.example",
    "foo+@bar.example_test",
    "foo+@bar_.example",
    "foo+@bar-.example",
    "foo+@bar.example.",
  ])("allows GFM email domain %s across comment and metadata operations", async (email) => {
    const body = `Contact ${email} for details.`
    const f = await fixture({ mentionAllowlist: ["stefina"], restrictCommentMentions: true })
    await f.operations.comment(body)
    await f.operations.mention("stefina", body)
    await f.operations.updateMetadata({ body })
    expect(f.comments()).toHaveLength(2)
    expect(f.updates()).toEqual([{ body }])
  })

  it.each(["foo+@onmax.example-", "foo+@onmax.example_", "foo+@onmax.example-.", "foo+@onmax.example_."])("guards invalid email domain %s across comment and metadata operations", async (email) => {
    const body = `Contact ${email} for details.`
    const f = await fixture({ mentionAllowlist: ["stefina"], restrictCommentMentions: true })
    await expect(f.operations.comment(body)).rejects.toThrow(/guarded mention capability/)
    await expect(f.operations.mention("stefina", body)).rejects.toThrow(/another mention/)
    expect(f.forge).not.toHaveBeenCalled()
    await expect(f.operations.updateMetadata({ body })).rejects.toThrow(/cannot add GitHub mentions/)
    expect(f.updates()).toEqual([])
  })

  it.each(["!", "#", "$", "%", "&", "=", "?", "/"])("guards email-like text with %s before a live mention", async (punctuation) => {
    const body = `Contact foo${punctuation}@unapproved.com`
    const f = await fixture({ mentionAllowlist: ["stefina"], restrictCommentMentions: true })
    await expect(f.operations.comment(body)).rejects.toThrow(/guarded mention capability/)
    await expect(f.operations.mention("stefina", body)).rejects.toThrow(/another mention/)
    expect(f.forge).not.toHaveBeenCalled()
    await expect(f.operations.updateMetadata({ body })).rejects.toThrow(/cannot add GitHub mentions/)
    expect(f.updates()).toEqual([])
  })

  it.each([
    "-@other-user", "+@other-user", ".@other-user", "/@other-user",
    "See https://example.com/ @other-user",
    "See www.example.com/ @other-user",
    'See https://example.com/"@inside @other-user',
    "See https://example.com/'@inside @other-user",
    'See www.example.com/"@inside @other-user',
    "See example.com/@other-user",
    "@acme/ent:platform-sre",
    '<span title="ignored @example">@other-user</span>',
    "<!-- @example --> @other-user",
    "foo @other-user <!-- @example --> bar",
    "foo <!-- @example --> @other-user bar",
    "foo \\<!-- @other-user --> bar",
    "foo &lt;!-- @other-user --&gt; bar",
    "[@other-user](https://example.com)",
    "[@other-user](@other-user)",
    "**@other-user**", "*@other-user*", "_@other-user_", "~~@other-user~~",
    "> @other-user", ">@other-user", '"@other-user"', "'@other-user'",
    "&quot;@other-user&quot;", "(@other-user)", "**@acme/ops**",
    "@/ent:platform-sre", "**@/ent:platform-sre**",
    "`@example` then @other-user",
    "```text\n@example\n```\n@other-user",
    "~~~text\n@example\n~~~~\n@other-user",
    "Use `unclosed @other-user",
    "Use \\`@other-user\\` as text",
  ])("rejects wrapped mention %s before making GitHub calls", async (body) => {
    const f = await fixture({ restrictCommentMentions: true })
    await expect(f.operations.comment(body)).rejects.toThrow(/guarded mention capability/)
    await expect(f.operations.resolveThread("THREAD_1", { outcome: "declined", reason: body })).rejects.toThrow(/guarded mention capability/)
    expect(f.forge).not.toHaveBeenCalled()
    const explicit = await fixture({ mentionAllowlist: ["stefina"] })
    await expect(explicit.operations.mention("stefina", body)).rejects.toThrow(/another mention/)
    expect(explicit.forge).not.toHaveBeenCalled()
  })

  it.each(["octocat-", "octo--cat", "octo_cat_", "octo__cat", "_octo", "octo_", "octo_ab", "octo_abcdefghi", "octo_a-b"])("rejects malformed allowlisted login %s before contacting GitHub", async (login) => {
    const f = await fixture({ mentionAllowlist: [login] })
    await expect(f.operations.mention(login, "Please restore the service.")).rejects.toThrow(/login|allowlist/)
    expect(f.forge).not.toHaveBeenCalled()
  })

  it.each(["mona-cat_octo", "mona-cat_abc", "mona-cat_abc12345", "octo_admin", "ab_admin"])("accepts managed-user login %s in the mention allowlist", async login => {
    const f = await fixture({ mentionAllowlist: [login] })
    await f.operations.mention(login, "Please restore the service.")
    expect(f.comments()).toEqual([`@${login}\n\nPlease restore the service.`])
  })

  it("is disabled without touching credentials, reads or writes", async () => {
    const f = await fixture()
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason: "disabled" })
    expect(f.forge).not.toHaveBeenCalled()
  })

  it("enables GitHub auto-merge with an atomic expected-head check and no direct merge or self-approval", async () => {
    const eligible = vi.fn(() => true)
    const f = await fixture({ autoMerge: true, eligible })
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
    expect(f.mutations()).toHaveLength(1)
    const mutation = f.mutations()[0]!
    expect(mutation.variables).toMatchObject({ head, method: "SQUASH" })
    expect(mutation.query).toContain("expectedHeadOid")
    expect(eligible).toHaveBeenCalledWith(expect.objectContaining({ repository: "acme/app", labels: ["babysit"], author: { login: "author", __typename: "User" } }))
    expect(f.calls.every(call => !/mergePullRequest\(|addPullRequestReview\(|deleteRef\(/.test(call.query ?? "") && !call.path.endsWith("/merge"))).toBe(true)
  })

  it.each([
    ["draft", (f: Awaited<ReturnType<typeof fixture>>) => { f.pullRequest.isDraft = true }],
    ["repository-disabled", (f: Awaited<ReturnType<typeof fixture>>) => { f.repository.autoMergeAllowed = false }],
    ["required-checks-missing", (f: Awaited<ReturnType<typeof fixture>>) => { f.state.rules = [] }],
    ["changes-requested", (f: Awaited<ReturnType<typeof fixture>>) => { f.pullRequest.reviewDecision = "CHANGES_REQUESTED" }],
    ["merge-method-unavailable", (f: Awaited<ReturnType<typeof fixture>>) => { f.repository.squashMergeAllowed = false; f.repository.mergeCommitAllowed = false; f.repository.rebaseMergeAllowed = false }],
    ["stacked-branch-cleanup", (f: Awaited<ReturnType<typeof fixture>>) => { f.repository.deleteBranchOnMerge = true; f.state.children = 1 }],
  ] as const)("blocks %s without a mutation", async (reason, prepare) => {
    const f = await fixture({ autoMerge: true })
    prepare(f)
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason })
    expect(f.mutations()).toHaveLength(0)
  })

  it("accepts required checks returned on a later branch rules page", async () => {
    const f = await fixture({ autoMerge: true })
    f.state.additionalRulePages = [f.state.rules]
    f.state.rules = [{ type: "required_signatures" }]
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
    expect(f.calls.filter(call => call.path === "/repos/acme/app/rules/branches/main").map(call => call.url.search)).toEqual(["?per_page=100", "?per_page=100&page=2"])
  })

  it.each([false, true])("accepts required workflows with later-page rules: %s", async (laterPage) => {
    const f = await fixture({ autoMerge: true })
    const rules = [{ type: "workflows", parameters: { workflows: [{ path: ".github/workflows/ci.yml", repository_id: 123 }] } }]
    f.state.rules = laterPage ? [] : rules
    f.state.additionalRulePages = laterPage ? [rules] : []
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
    expect(f.mutations()).toHaveLength(1)
  })

  it("does not count an empty required workflow list", async () => {
    const f = await fixture({ autoMerge: true })
    f.state.rules = [{ type: "workflows", parameters: { workflows: [] } }]
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason: "required-checks-missing" })
    expect(f.mutations()).toHaveLength(0)
  })

  it.each([undefined, {}, { workflows: "ci" }])("rejects incomplete required workflows: %j", async (parameters) => {
    const f = await fixture({ autoMerge: true })
    f.state.rules = [{ type: "workflows", parameters }]
    await expect(f.operations.requestAutoMerge()).rejects.toMatchObject({ code: "FORGE_R0007" })
    expect(f.mutations()).toHaveLength(0)
  })

  it("selects a method allowed by every active ruleset, including later pages", async () => {
    const f = await fixture({ autoMerge: true })
    f.state.rules.push({ type: "pull_request", parameters: { allowed_merge_methods: ["squash", "rebase"] } })
    f.state.additionalRulePages = [[{ type: "pull_request", parameters: { allowed_merge_methods: ["merge", "rebase"] } }]]
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
    expect(f.mutations()[0]!.variables).toMatchObject({ method: "REBASE" })
  })

  it("blocks when repository and ruleset merge methods have no intersection", async () => {
    const f = await fixture({ autoMerge: true })
    f.repository.rebaseMergeAllowed = false
    f.state.rules.push({ type: "pull_request", parameters: { allowed_merge_methods: ["rebase"] } })
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason: "merge-method-unavailable" })
    expect(f.mutations()).toHaveLength(0)
  })

  it("accepts classic branch protection with required checks", async () => {
    const f = await fixture({ autoMerge: true })
    f.state.rules = []
    f.state.protection = { contexts: ["CI"] }
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
  })

  it("reads classic required checks from the branch summary without admin access", async () => {
    const f = await fixture({ autoMerge: true })
    f.state.rules = []
    f.state.protection = { contexts: ["CI"] }
    f.state.protectionReadable = false
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
  })

  it("blocks human changes requested on later review pages", async () => {
    const f = await fixture({ autoMerge: true })
    f.pullRequest.latestOpinionatedReviews.pageInfo = { hasNextPage: true, endCursor: "next" }
    f.state.reviewPage.nodes = [{ author: { login: "reviewer", __typename: "User" }, state: "CHANGES_REQUESTED" }]
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason: "changes-requested" })
    expect(f.mutations()).toHaveLength(0)
  })

  it("filters using all current PR labels", async () => {
    const f = await fixture({ autoMerge: true, eligible: pr => !pr.labels.includes("do-not-touch") })
    f.pullRequest.labels.pageInfo = { hasNextPage: true, endCursor: "next" }
    f.state.labelPage.nodes = [{ name: "do-not-touch" }]
    await expect(f.operations.requestAutoMerge()).rejects.toThrow("configured filter")
    expect(f.mutations()).toHaveLength(0)
  })

  it("rechecks head and admission after eligibility reads", async () => {
    const f = await fixture({ autoMerge: true })
    let reads = 0
    f.state.beforeRead = () => { if (++reads === 2) f.pullRequest.headRefOid = "b".repeat(40) }
    await expect(f.operations.requestAutoMerge()).rejects.toThrow("head changed")
    expect(f.mutations()).toHaveLength(0)
  })

  it("does not transfer an in-flight merge request to a concurrent own push", async () => {
    let admitted = 0
    const nextHead = "b".repeat(40)
    const f = await fixture({
      autoMerge: true,
      push: async () => { f.pullRequest.headRefOid = nextHead; return nextHead },
      eligible: async () => { if (++admitted === 1) await f.operations.push(); return true },
    })
    await expect(f.operations.requestAutoMerge()).rejects.toThrow("Pull request ref changed")
    expect(f.mutations()).toHaveLength(0)
  })

  it("blocks new human change requests observed during the final admission read", async () => {
    const f = await fixture({ autoMerge: true })
    let reads = 0
    f.state.beforeRead = () => {
      if (++reads === 2) f.pullRequest.latestOpinionatedReviews.nodes = [{ author: { login: "reviewer", __typename: "User" }, state: "CHANGES_REQUESTED" }]
    }
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason: "changes-requested" })
    expect(f.mutations()).toHaveLength(0)
  })

  it("does not fall back to direct merging when GitHub rejects enabling", async () => {
    const f = await fixture({ autoMerge: true })
    f.state.mutationError = true
    await expect(f.operations.requestAutoMerge()).rejects.toThrow("Head oid mismatch")
    expect(f.mutations()).toHaveLength(1)
  })

  it("accepts immediate completion by GitHub native auto-merge", async () => {
    const f = await fixture({ autoMerge: true })
    f.state.merged = true
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "merged" })
    expect(f.mutations()).toHaveLength(1)
  })

  it("recognizes existing auto-merge only after checking current policy", async () => {
    const f = await fixture({ autoMerge: true })
    f.pullRequest.autoMergeRequest = { enabledAt: "2026-09-13T00:00:00Z" }
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "already-enabled" })
    expect(f.mutations()).toHaveLength(0)
    f.pullRequest.reviewDecision = "CHANGES_REQUESTED"
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason: "changes-requested" })
  })
})

describe("host-owned repair operations", () => {
  it.each([
    'See https://example.com/"@other-user',
    "See www.example.com/@other-user",
    "See https://example.com/&quot;@other-user",
  ])("allows URL-only labels in pull request body updates: %s", async (body) => {
    const f = await fixture({ restrictCommentMentions: true })
    await f.operations.updateMetadata({ body })
    expect(f.updates()).toEqual([{ body }])
  })

  it("rejects a body mention outside a URL", async () => {
    const f = await fixture({ restrictCommentMentions: true })
    await expect(f.operations.updateMetadata({ body: "See https://example.com/ @other-user" })).rejects.toThrow(/cannot add GitHub mentions/)
    expect(f.updates()).toEqual([])
  })
  it("binds comments and metadata to the selected PR, treating content as literal fields", async () => {
    const f = await fixture()
    await f.operations.comment("$(touch /tmp/never) @secret-file")
    await f.operations.updateMetadata({ title: "New title", body: "" })
    expect(f.comments()).toEqual(["$(touch /tmp/never) @secret-file"])
    expect(f.updates()).toEqual([{ title: "New title", body: "" }])
  })

  it("guards new mentions in pull request body updates while preserving existing ones", async () => {
    const f = await fixture({ restrictCommentMentions: true })
    f.pullRequest.body = "Please contact @existing-user."
    await expect(f.operations.updateMetadata({ body: "Please contact @new-user." })).rejects.toThrow(/cannot add GitHub mentions/)
    expect(f.updates()).toEqual([])

    await f.operations.updateMetadata({ body: "Updated details for @existing-user." })
    expect(f.updates()).toEqual([{ body: "Updated details for @existing-user." }])
  })

  it("does not conflate organization enterprise team mentions", async () => {
    const f = await fixture({ restrictCommentMentions: true })
    f.pullRequest.body = "Contact @acme/ent:platform-sre."
    await expect(f.operations.updateMetadata({ body: "Contact @acme/ent:security." })).rejects.toThrow(/cannot add GitHub mentions/)
    expect(f.updates()).toEqual([])
    await f.operations.updateMetadata({ body: "Updated details for @acme/ent:platform-sre." })
  })

  it("does not conflate long regular team mentions", async () => {
    const f = await fixture({ restrictCommentMentions: true })
    const original = `@acme/${"platform".repeat(8)}`
    const replacement = `@acme/${"security".repeat(8)}`
    f.pullRequest.body = `Contact ${original}.`
    await expect(f.operations.updateMetadata({ body: `Contact ${replacement}.` })).rejects.toThrow(/cannot add GitHub mentions/)
    expect(f.updates()).toEqual([])
    await f.operations.updateMetadata({ body: `Updated details for ${original}.` })
  })

  it("rejects body updates when a concurrent edit removes a validated mention", async () => {
    const f = await fixture({ restrictCommentMentions: true })
    f.pullRequest.body = "Contact @existing-user."
    let reads = 0
    f.state.beforeRead = () => {
      if (++reads === 2) f.pullRequest.body = "Mention removed by maintainer."
    }
    await expect(f.operations.updateMetadata({ body: "Updated details for @existing-user." })).rejects.toThrow(/body changed/)
    expect(f.updates()).toEqual([])
  })

  it("reads bounded failure logs only for a run at the admitted head", async () => {
    const f = await fixture()
    expect(await f.operations.readCheckLogs(123)).toEqual({ text: "## test\nCI failure", truncated: false, totalLines: 2, includedLineRanges: [[1, 2]] })
    f.state.run.head_sha = "b".repeat(40)
    await expect(f.operations.readCheckLogs(123)).rejects.toThrow("does not belong")
    expect(f.calls.filter(call => call.path === "/repos/acme/app/actions/jobs/7/logs")).toHaveLength(1)
  })

  it("returns the failure from a long colored log instead of its first 200,000 characters", async () => {
    const f = await fixture()
    const build = Array.from({ length: 20_000 }, (_, n) => `test\tbuild\t2026-11-01T00:00:00Z \u001b[32m✓\u001b[39m built chunk ${n}`)
    const fetch = "test\tcheckout\t2026-11-01T00:00:00Z  * [new branch]          fix/agent-error -> origin/fix/agent-error"
    const failure = "test\ttest\t2026-11-01T00:10:00Z \u001b[31mFAIL\u001b[39m TypeCheckError: 'details' does not exist in type"
    f.state.logs = [fetch, ...build, failure].join("\n")
    const excerpt = await f.operations.readCheckLogs(123)
    expect(excerpt.truncated).toBe(true)
    expect(excerpt.text).toContain("FAIL TypeCheckError: 'details' does not exist in type")
    expect(excerpt.text).not.toContain("\u001b")
    expect(excerpt.totalLines).toBe(20_002)
    expect(excerpt.includedLineRanges.at(-1)).toEqual([19_998, 20_002])
  })

  it("reads a requested tail or line range from a failed-job log", async () => {
    const f = await fixture()
    const lines = Array.from({ length: 7229 }, (_, n) => `docs\tBuild docs\t2026-11-07T06:43:10Z ${n + 1} ${"build output ".repeat(8)}`)
    lines[7135] = "docs\tBuild docs\tBroken docs links: /docs/getting-started/ai-resources links to /mcp, which has no page or file"
    f.state.logs = lines.join("\n")
    const log = ["## test", ...lines]
    const tail = await f.operations.readCheckLogs(123, { tailLines: 100 })
    expect(tail).toEqual({ text: log.slice(-100).join("\n"), truncated: true, totalLines: 7230, includedLineRanges: [[7131, 7230]] })
    expect(tail.text).toContain("Broken docs links")
    const range = await f.operations.readCheckLogs(123, { startLine: 7134, endLine: 7141 })
    expect(range).toEqual({ text: log.slice(7133, 7141).join("\n"), truncated: true, totalLines: 7230, includedLineRanges: [[7134, 7141]], nextLine: 7142 })
    await expect(f.operations.readCheckLogs(123, { startLine: 20, endLine: 10 })).rejects.toMatchObject({ code: "PRESETS_CHECK_LOG_SELECTION_INVALID", why: expect.stringContaining("1 to 1000") })
    await expect(f.operations.readCheckLogs(123, { tailLines: 100, startLine: 1 })).rejects.toMatchObject({ code: "PRESETS_CHECK_LOG_SELECTION_INVALID", why: expect.stringContaining("Choose tailLines") })
    await expect(f.operations.readCheckLogs(123, { startLine: 8000 })).rejects.toMatchObject({ code: "PRESETS_CHECK_LOG_START_PAST_END", why: "startLine 8000 is past the log's 7230 lines." })
  })

  it("accepts a synthetic merge workflow run linked to the expected PR head", async () => {
    const f = await fixture()
    f.state.run.head_sha = "b".repeat(40)
    f.state.run.pull_requests = [{ number: 12, head: { sha: head } }]
    expect(await f.operations.readCheckLogs(123)).toMatchObject({ text: "## test\nCI failure", truncated: false })
  })

  it("rejects thread IDs owned by another PR", async () => {
    const f = await fixture()
    await expect(f.operations.resolveThread("THREAD_other")).rejects.toThrow("does not belong")
    expect(f.mutations()).toHaveLength(0)
  })

  it("resolves an owned thread and skips already resolved threads", async () => {
    const f = await fixture()
    await f.operations.resolveThread("THREAD_1")
    expect(f.mutations()).toHaveLength(1)
    expect(f.mutations()[0]!.variables).toEqual({ id: "THREAD_1" })
    f.state.thread.isResolved = true
    await f.operations.resolveThread("THREAD_1")
    expect(f.mutations()).toHaveLength(1)
  })

  it("posts a declined thread's outcome and reason as a reply before resolving it", async () => {
    const commentPrefix = "<!-- vitehub-babysitter-repair:repair -->\n"
    const f = await fixture({ commentPrefix })
    f.state.threadComments = [{ databaseId: 501, body: "P2: config spread", author: { login: "pullfrog", __typename: "Bot" }, createdAt: "2026-11-07T00:00:00Z", url: "https://github.com/acme/app/pull/12#discussion_r501" }]
    await f.operations.resolveThread("THREAD_1", { outcome: "declined", reason: "P2: outside this PR's scope." })
    const replies = f.calls.filter(call => call.method === "POST" && call.path === "/repos/acme/app/pulls/12/comments/501/replies")
    expect(replies.map(call => (call.body as { body: string }).body)).toEqual([`${commentPrefix}<!-- vitehub-babysitter-outcome:declined -->\n**Declined.** P2: outside this PR's scope.`])
    expect(f.calls.indexOf(replies[0]!)).toBeLessThan(f.calls.findIndex(call => call.operationName === "ResolveReviewThread"))
    expect(f.mutations()).toHaveLength(1)
  })

  it("refuses to decline a P0 or P1 finding", async () => {
    const f = await fixture()
    f.state.threadComments = [reviewComment]
    for (const reason of ["P1: the review push budget is spent.", "**P0**: out of scope."]) {
      await expect(f.operations.resolveThread("THREAD_1", { outcome: "declined", reason })).rejects.toMatchObject({ code: "PRESETS_REVIEW_SEVERE_DECLINED" })
    }
    expect(f.calls.filter(call => call.path.endsWith("/501/replies"))).toHaveLength(0)
    expect(f.mutations()).toHaveLength(0)
  })

  it("posts a downgraded decline of a reviewer's P0 or P1 and leaves the thread open until a person replies", async () => {
    const f = await fixture()
    const codex = "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Verify ownership before granting admin**"
    f.state.threadComments = [{ ...reviewComment, body: codex, author: { login: "chatgpt-codex-connector", __typename: "Bot" } }]
    expect(await f.operations.resolveThread("THREAD_1", { outcome: "declined", reason: "P2: bootstrap only." })).toEqual({ held: true })
    expect(f.calls.filter(call => call.path.endsWith("/501/replies"))).toHaveLength(1)
    expect(f.mutations()).toHaveLength(0)
    // A retry posts nothing new and keeps holding.
    expect(await f.operations.resolveThread("THREAD_1", { outcome: "declined", reason: "P2: bootstrap only." })).toEqual({ held: true })
    expect(f.calls.filter(call => call.path.endsWith("/501/replies"))).toHaveLength(1)
    // Any other outcome resolves it.
    expect(await f.operations.resolveThread("THREAD_1", { outcome: "fixed" })).toEqual({ held: false })
    expect(f.mutations()).toHaveLength(1)
  })

  it("resolves a downgraded decline once a person replied in the thread", async () => {
    const f = await fixture()
    f.state.threadComments = [
      { ...reviewComment, body: "**P1 · Class: lost MAIL_KEY.**", author: { login: "pullfrog", __typename: "Bot" } },
      { ...reviewComment, databaseId: 504, body: "Fine as P2, ship it.", author: { login: "maintainer", __typename: "User" } },
    ]
    expect(await f.operations.resolveThread("THREAD_1", { outcome: "declined", reason: "P2: the maintainer accepted it." })).toEqual({ held: false })
    expect(f.mutations()).toHaveLength(1)
  })

  it.each([
    ["**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Title", true],
    ["**P0 · Class: data loss.**", true],
    ["P1: broken contract", true],
    ["**P2 · Class: alias.**", false],
    ["**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Title", false],
    ["P10 is a page size", false],
    ["This breaks the P1 path.", false],
  ])("reads a reviewer's severity label from %j", (body, severe) => {
    expect(reviewerLabeledSevere(body)).toBe(severe)
  })

  it("requires a reason for every outcome except fixed", async () => {
    const f = await fixture()
    f.state.threadComments = [reviewComment]
    await expect(f.operations.resolveThread("THREAD_1", { outcome: "disproved", reason: " " })).rejects.toMatchObject({
      code: "PRESETS_REVIEW_REASON_REQUIRED",
      why: "A disproved review thread needs a one-sentence reason.",
      fix: expect.stringContaining("non-empty reason"),
      docs: "https://vitehub.dev/docs/agents/diagnostics/presets_review_reason_required",
    })
    expect(f.mutations()).toHaveLength(0)
    await f.operations.resolveThread("THREAD_1", { outcome: "fixed" })
    expect(f.mutations()).toHaveLength(1)
  })

  it.each(["reply-result-lost", "resolve-failed", "resolve-result-lost"] as const)("retries an outcome after %s with one reply", async failure => {
    const f = await fixture()
    f.state.threadComments = [reviewComment]
    f.state.threadFailure = failure
    const answer = { outcome: "declined", reason: "P2: outside this PR's scope." } as const
    await expect(f.operations.resolveThread("THREAD_1", answer)).rejects.toThrow()
    f.state.threadFailure = undefined
    const retry = createGitHubPullRequestOperations({ forge: f.forge }, { repository: "acme/app", number: 12, expectedHeadOid: head })
    await retry.resolveThread("THREAD_1", answer)
    expect(f.calls.filter(call => call.path.endsWith("/501/replies"))).toHaveLength(1)
    expect(f.state.thread.isResolved).toBe(true)
  })

  it("answers an already resolved thread and ignores outcome markers from other authors", async () => {
    const f = await fixture()
    const body = "<!-- vitehub-babysitter-outcome:fixed -->\n**Fixed.**"
    f.state.thread.isResolved = true
    f.state.threadComments = [reviewComment, { ...reviewComment, databaseId: 503, body }]
    await f.operations.resolveThread("THREAD_1", { outcome: "fixed" })
    expect(f.calls.filter(call => call.path.endsWith("/501/replies"))).toHaveLength(1)
    expect(f.mutations()).toHaveLength(0)
    await f.operations.resolveThread("THREAD_1", { outcome: "fixed" })
    expect(f.calls.filter(call => call.path.endsWith("/501/replies"))).toHaveLength(1)
  })

  it("refuses to record an outcome when the thread has no comment to reply to", async () => {
    const f = await fixture()
    await expect(f.operations.resolveThread("THREAD_1", { outcome: "fixed" })).rejects.toThrow(/comment/)
    expect(f.mutations()).toHaveLength(0)
  })

  it("finds an authenticated outcome on later comment pages", async () => {
    const f = await fixture()
    f.state.threadComments = [reviewComment]
    f.state.threadCommentPages = [[{ ...reviewComment, databaseId: 502, body: "<!-- vitehub-babysitter-outcome:fixed -->\n**Fixed.**", author: { login: "worker[bot]", __typename: "Bot" } }]]
    await f.operations.resolveThread("THREAD_1", { outcome: "fixed" })
    expect(f.calls.filter(call => call.operationName === "ReviewThreadOutcomeComments").map(call => call.variables?.after)).toEqual([null, "1"])
    expect(f.calls.filter(call => call.path.endsWith("/501/replies"))).toHaveLength(0)
    expect(f.state.thread.isResolved).toBe(true)
  })

  it.each(["Use `@someone` as text.", "Contact ops@example.com.", "See https://example.com/@someone."])("allows non-mention outcome reasons: %s", async reason => {
    const f = await fixture({ restrictCommentMentions: true })
    f.state.threadComments = [reviewComment]
    await f.operations.resolveThread("THREAD_1", { outcome: "declined", reason })
    expect(f.calls.filter(call => call.path.endsWith("/501/replies"))).toHaveLength(1)
  })

  it.each(["closed", "head", "filter"])("rejects %s work before allowing a host push", async condition => {
    const push = vi.fn(async () => head)
    const f = await fixture({ push, eligible: () => condition !== "filter" })
    if (condition === "closed") f.pullRequest.state = "CLOSED"
    if (condition === "head") f.pullRequest.headRefOid = "b".repeat(40)
    await expect(f.operations.push()).rejects.toThrow()
    expect(push).not.toHaveBeenCalled()
  })

  it("allows repairs on drafts admitted by the configured filter", async () => {
    const push = vi.fn(async () => head)
    const f = await fixture({ push, eligible: pr => pr.isDraft })
    f.pullRequest.isDraft = true
    await f.operations.push()
    await f.operations.comment("Draft repaired.")
    expect(push).toHaveBeenCalledOnce()
  })

  it("calls the bound host push without accepting a worker-selected target", async () => {
    const push = vi.fn(async () => head)
    const f = await fixture({ push })
    await f.operations.push()
    expect(push).toHaveBeenCalledWith()
  })

  it("uses the host-verified pushed SHA for subsequent comment, thread and merge operations", async () => {
    const nextHead = "b".repeat(40)
    const push = vi.fn(async () => { f.pullRequest.headRefOid = nextHead; return nextHead })
    const f = await fixture({ autoMerge: true, push })
    await f.operations.push()
    await f.operations.resolveThread("THREAD_1")
    await f.operations.updateMetadata({ title: "Repaired" })
    await f.operations.comment("Repair pushed.")
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
    expect(f.mutations().at(-1)!.variables).toMatchObject({ head: nextHead })
    f.pullRequest.headRefOid = "c".repeat(40)
    await expect(f.operations.comment("Obsolete")).rejects.toThrow("head changed")
  })

  it("rejects missing push authority", async () => {
    const f = await fixture()
    await expect(f.operations.push()).rejects.toThrow("no host-owned push")
    expect(f.forge).not.toHaveBeenCalled()
  })

  it("honors cancellation before resolving credentials", async () => {
    const controller = new AbortController()
    controller.abort(new Error("obsolete"))
    const f = await fixture({ signal: controller.signal })
    await expect(f.operations.comment("Update")).rejects.toThrow("obsolete")
    expect(f.forge).not.toHaveBeenCalled()
  })
})

it("refreshes dependencies only while the assigned PR head is current", async () => {
  const refreshDependencies = vi.fn(async () => {});
  const f = await fixture({ refreshDependencies });
  await f.operations.refreshDependencies();
  expect(refreshDependencies).toHaveBeenCalledTimes(1);
  f.pullRequest.headRefOid = "b".repeat(40);
  await expect(f.operations.refreshDependencies()).rejects.toThrow();
  expect(refreshDependencies).toHaveBeenCalledTimes(1);
});

describe("base CI evidence on a moving base", () => {
  const assigned = "b".repeat(40)
  const moved = "c".repeat(40)

  it("reads the assigned base after the base branch moved forward from it", async () => {
    const f = await fixture({ expectedBaseOid: assigned })
    Object.assign(f.pullRequest, { baseRefOid: moved })
    expect((await f.operations.readBaseCheckEvidence()).headSha).toBe(assigned)
    expect(f.calls.some(call => call.path === `/repos/acme/app/compare/${assigned}...main`)).toBe(true)
  })

  it("reads the assigned base when the PR's recorded base is older than it", async () => {
    // A conflicted PR keeps an old baseRefOid, while a conflict repair is assigned the live branch tip.
    const f = await fixture({ expectedBaseOid: moved })
    Object.assign(f.pullRequest, { baseRefOid: assigned })
    f.state.compare = { status: "identical", behind_by: 0 }
    expect((await f.operations.readBaseCheckEvidence()).headSha).toBe(moved)
    expect(f.calls.some(call => call.path === `/repos/acme/app/compare/${moved}...main`)).toBe(true)
  })

  it("refuses when the base no longer contains the assigned commit", async () => {
    const f = await fixture({ expectedBaseOid: assigned })
    Object.assign(f.pullRequest, { baseRefOid: moved })
    f.state.compare = { status: "diverged", behind_by: 2 }
    await expect(f.operations.readBaseCheckEvidence()).rejects.toThrow("Pull request base changed")
  })

  it("needs no comparison while the base is unchanged", async () => {
    const f = await fixture({ expectedBaseOid: assigned })
    Object.assign(f.pullRequest, { baseRefOid: assigned })
    expect((await f.operations.readBaseCheckEvidence()).headSha).toBe(assigned)
    expect(f.calls.some(call => call.path.startsWith("/repos/acme/app/compare/"))).toBe(false)
  })
})
