import { describe, expect, it, vi } from "vitest"
import { createGitHubPullRequestOperations, type GitHubPullRequestOperationsOptions } from "../src/server/github-auto-merge.ts"

import { repairCapability } from "../src/presets/babysitter/repair.ts"
import { resolveAgentCapabilities } from "../src/capability-runtime.ts"

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
    additionalRulePages: [] as unknown[][],
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
    if (args.some(arg => arg.includes("/rules/branches/"))) return { stdout: [...state.rules, ...state.additionalRulePages.flat()].map(rule => JSON.stringify(rule)).join("\n"), stderr: "" }
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
  it("exposes accepted mention logins and omits unconfigured mentions", async () => {
    const logins = [" stefina ", "MAXI", "octocat-", "octo--cat"]
    const f = fixture({ mentionAllowlist: logins })
    const capability = repairCapability(f.operations, false, logins)
    const resolveTools = async (definition: ReturnType<typeof repairCapability>) =>
      (await resolveAgentCapabilities({ capabilities: [definition] }, {
        capabilities: {}, memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn(),
      }, {})).tools
    const mention = (await resolveTools(capability))?.mentionOnPullRequest
    expect(mention?.inputSchema).toMatchObject({ properties: { login: { type: "string", enum: ["stefina", "maxi"] } } })
    if (!mention?.execute) throw new Error("Missing configured mention tool.")
    await mention.execute({ login: "stefina", body: "Please restore the service." })
    expect(f.command).toHaveBeenCalledWith(
      ["api", "/repos/acme/app/issues/12/comments", "--method", "POST", "-f", "body=@stefina\n\nPlease restore the service."],
      expect.anything(),
    )
    expect(await resolveTools(repairCapability(f.operations, false))).not.toHaveProperty("mentionOnPullRequest")
    expect(await resolveTools(repairCapability(f.operations, false, [" "]))).not.toHaveProperty("mentionOnPullRequest")
    expect(await resolveTools(repairCapability(f.operations, false, ["octocat-", "octo--cat"]))).not.toHaveProperty("mentionOnPullRequest")
  })

  it("marks both comments and mentions as host-authored repair activity", async () => {
    const commentPrefix = "<!-- vitehub-babysitter-repair:repair -->\n"
    const f = fixture({ mentionAllowlist: ["stefina"], commentPrefix })
    await f.operations.comment("Verified blocker.")
    await f.operations.mention("stefina", "Please restore the service.")
    const bodies = f.command.mock.calls
      .filter(([args]) => args[1] === "/repos/acme/app/issues/12/comments")
      .map(([args]) => args.find(arg => arg.startsWith("body=")))
    expect(bodies).toEqual([
      `body=${commentPrefix}Verified blocker.`,
      `body=${commentPrefix}@stefina\n\nPlease restore the service.`,
    ])
  })

  it("exposes a guarded explicit mention operation", async () => {
    const f = fixture({ mentionAllowlist: ["stefina"] })
    await f.operations.mention("Stefina", "Please confirm the product decision.")
    expect(f.command).toHaveBeenCalledWith(
      ["api", "/repos/acme/app/issues/12/comments", "--method", "POST", "-f", "body=@Stefina\n\nPlease confirm the product decision."],
      expect.anything(),
    )
    await expect(f.operations.mention("someone-else", "Please review this.")).rejects.toThrow(/allowlist/)
    await expect(f.operations.mention("stefina", "Also notify @another.")).rejects.toThrow(/another mention/)
  })

  it("does not let ordinary Babysitter comments bypass the mention allowlist", async () => {
    const f = fixture({ mentionAllowlist: ["stefina"], restrictCommentMentions: true })
    await expect(f.operations.comment("Please ask @stefina to confirm.")).rejects.toThrow(/guarded mention capability/)
    await expect(f.operations.comment("Please ask @other-user to confirm.")).rejects.toThrow(/guarded mention capability/)
    await expect(f.operations.comment("Please ask @stefina and @other-user to confirm.")).rejects.toThrow(/guarded mention capability/)
    await expect(f.operations.comment("Please ask @acme/ops to confirm.")).rejects.toThrow(/guarded mention capability/)
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
    const f = fixture({ mentionAllowlist: ["stefina"], restrictCommentMentions: true })
    await f.operations.comment(body)
    await f.operations.mention("stefina", body)
    const bodies = f.command.mock.calls
      .filter(([args]) => args[1] === "/repos/acme/app/issues/12/comments")
      .map(([args]) => args.find(arg => arg.startsWith("body=")))
    expect(bodies).toEqual([`body=${body}`, `body=@stefina\n\n${body}`])
  })

  it.each([
    "foo+@bar_baz.example",
    "foo+@bar.example_test",
    "foo+@bar_.example",
    "foo+@bar-.example",
    "foo+@bar.example.",
  ])("allows GFM email domain %s across comment and metadata operations", async (email) => {
    const body = `Contact ${email} for details.`
    const f = fixture({ mentionAllowlist: ["stefina"], restrictCommentMentions: true })
    await f.operations.comment(body)
    await f.operations.mention("stefina", body)
    await f.operations.updateMetadata({ body })
    expect(f.command.mock.calls.filter(([args]) => args.includes("POST"))).toHaveLength(2)
    expect(f.command.mock.calls.some(([args]) => args.includes("PATCH") && args.includes(`body=${body}`))).toBe(true)
  })

  it.each(["foo+@onmax.example-", "foo+@onmax.example_", "foo+@onmax.example-.", "foo+@onmax.example_."])("guards invalid email domain %s across comment and metadata operations", async (email) => {
    const body = `Contact ${email} for details.`
    const f = fixture({ mentionAllowlist: ["stefina"], restrictCommentMentions: true })
    await expect(f.operations.comment(body)).rejects.toThrow(/guarded mention capability/)
    await expect(f.operations.mention("stefina", body)).rejects.toThrow(/another mention/)
    expect(f.command).not.toHaveBeenCalled()
    await expect(f.operations.updateMetadata({ body })).rejects.toThrow(/cannot add GitHub mentions/)
    expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(false)
  })

  it.each(["!", "#", "$", "%", "&", "=", "?", "/"])("guards email-like text with %s before a live mention", async (punctuation) => {
    const body = `Contact foo${punctuation}@unapproved.com`
    const f = fixture({ mentionAllowlist: ["stefina"], restrictCommentMentions: true })
    await expect(f.operations.comment(body)).rejects.toThrow(/guarded mention capability/)
    await expect(f.operations.mention("stefina", body)).rejects.toThrow(/another mention/)
    expect(f.command).not.toHaveBeenCalled()
    await expect(f.operations.updateMetadata({ body })).rejects.toThrow(/cannot add GitHub mentions/)
    expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(false)
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
    const f = fixture({ restrictCommentMentions: true })
    await expect(f.operations.comment(body)).rejects.toThrow(/guarded mention capability/)
    expect(f.command).not.toHaveBeenCalled()
    const explicit = fixture({ mentionAllowlist: ["stefina"] })
    await expect(explicit.operations.mention("stefina", body)).rejects.toThrow(/another mention/)
    expect(explicit.command).not.toHaveBeenCalled()
  })

  it.each(["octocat-", "octo--cat", "octo_cat_", "octo__cat", "_octo", "octo_", "octo_ab", "octo_abcdefghi", "octo_a-b"])("rejects malformed allowlisted login %s before contacting GitHub", async (login) => {
    const f = fixture({ mentionAllowlist: [login] })
    await expect(f.operations.mention(login, "Please restore the service.")).rejects.toThrow(/login|allowlist/)
    expect(f.command).not.toHaveBeenCalled()
  })

  it.each(["mona-cat_octo", "mona-cat_abc", "mona-cat_abc12345", "octo_admin", "ab_admin"])("accepts managed-user login %s in the mention allowlist", async login => {
    const f = fixture({ mentionAllowlist: [login] })
    await f.operations.mention(login, "Please restore the service.")
    expect(f.command).toHaveBeenCalledWith(
      ["api", "/repos/acme/app/issues/12/comments", "--method", "POST", "-f", `body=@${login}\n\nPlease restore the service.`],
      expect.anything(),
    )
  })

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
    expect(args.find(arg => arg.startsWith("query="))).toContain("expectedHeadOid")
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

  it("accepts required checks returned on a later branch rules page", async () => {
    const f = fixture({ autoMerge: true })
    f.state.additionalRulePages = [f.state.rules]
    f.state.rules = [{ type: "required_signatures" }]
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
    expect(f.command).toHaveBeenCalledWith(
      ["api", "--paginate", "/repos/acme/app/rules/branches/main?per_page=100", "--jq", ".[] | @json"],
      expect.anything(),
    )
  })

  it.each([false, true])("accepts required workflows with later-page rules: %s", async (laterPage) => {
    const f = fixture({ autoMerge: true })
    const rules = [{ type: "workflows", parameters: { workflows: [{ path: ".github/workflows/ci.yml", repository_id: 123 }] } }]
    f.state.rules = laterPage ? [] : rules
    f.state.additionalRulePages = laterPage ? [rules] : []
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
    expect(f.mutations()).toHaveLength(1)
    expect(f.command.mock.calls.some(([args]) => args.some(arg => arg.includes("branchProtectionRule")))).toBe(false)
  })

  it.each([undefined, {}, { workflows: [] }, { workflows: "ci" }])("rejects absent or invalid required workflows: %j", async (parameters) => {
    const f = fixture({ autoMerge: true })
    f.state.rules = [{ type: "workflows", parameters }]
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason: "required-checks-missing" })
    expect(f.mutations()).toHaveLength(0)
  })

  it("selects a method allowed by every active ruleset, including later pages", async () => {
    const f = fixture({ autoMerge: true })
    f.state.rules.push({ type: "pull_request", parameters: { allowed_merge_methods: ["squash", "rebase"] } })
    f.state.additionalRulePages = [[{ type: "pull_request", parameters: { allowed_merge_methods: ["merge", "rebase"] } }]]
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "enabled" })
    expect(f.mutations()[0]![0]).toContain("method=REBASE")
  })

  it("blocks when repository and ruleset merge methods have no intersection", async () => {
    const f = fixture({ autoMerge: true })
    f.repository.rebaseMergeAllowed = false
    f.state.rules.push({ type: "pull_request", parameters: { allowed_merge_methods: ["rebase"] } })
    expect(await f.operations.requestAutoMerge()).toEqual({ status: "blocked", reason: "merge-method-unavailable" })
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
    await expect(f.operations.requestAutoMerge()).rejects.toThrow("Pull request ref changed")
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
  it.each([
    'See https://example.com/"@other-user',
    "See www.example.com/@other-user",
    "See https://example.com/&quot;@other-user",
  ])("allows URL-only labels in pull request body updates: %s", async (body) => {
    const f = fixture({ restrictCommentMentions: true })
    await f.operations.updateMetadata({ body })
    expect(f.command).toHaveBeenCalledWith(["api", "/repos/acme/app/issues/12", "--method", "PATCH", "-f", `body=${body}`], expect.anything())
  })

  it("rejects a body mention outside a URL", async () => {
    const f = fixture({ restrictCommentMentions: true })
    await expect(f.operations.updateMetadata({ body: "See https://example.com/ @other-user" })).rejects.toThrow(/cannot add GitHub mentions/)
    expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(false)
  })
  it("binds comments and metadata to the selected PR, treating content as literal fields", async () => {
    const f = fixture()
    await f.operations.comment("$(touch /tmp/never) @secret-file")
    await f.operations.updateMetadata({ title: "New title", body: "" })
    expect(f.command).toHaveBeenCalledWith(["api", "/repos/acme/app/issues/12/comments", "--method", "POST", "-f", "body=$(touch /tmp/never) @secret-file"], expect.anything())
    expect(f.command).toHaveBeenCalledWith(["api", "/repos/acme/app/issues/12", "--method", "PATCH", "-f", "title=New title", "-f", "body="], expect.anything())
  })

  it("guards new mentions in pull request body updates while preserving existing ones", async () => {
    const f = fixture({ restrictCommentMentions: true })
    f.pullRequest.body = "Please contact @existing-user."
    await expect(f.operations.updateMetadata({ body: "Please contact @new-user." })).rejects.toThrow(/cannot add GitHub mentions/)
    expect(f.command.mock.calls.some(([args]) => args[1] === "/repos/acme/app/issues/12" && args.includes("body=Please contact @new-user."))).toBe(false)

    await f.operations.updateMetadata({ body: "Updated details for @existing-user." })
    expect(f.command).toHaveBeenCalledWith(
      ["api", "/repos/acme/app/issues/12", "--method", "PATCH", "-f", "body=Updated details for @existing-user."],
      expect.anything(),
    )
  })

  it("does not conflate organization enterprise team mentions", async () => {
    const f = fixture({ restrictCommentMentions: true })
    f.pullRequest.body = "Contact @acme/ent:platform-sre."
    await expect(f.operations.updateMetadata({ body: "Contact @acme/ent:security." })).rejects.toThrow(/cannot add GitHub mentions/)
    expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(false)
    await f.operations.updateMetadata({ body: "Updated details for @acme/ent:platform-sre." })
  })

  it("does not conflate long regular team mentions", async () => {
    const f = fixture({ restrictCommentMentions: true })
    const original = `@acme/${"platform".repeat(8)}`
    const replacement = `@acme/${"security".repeat(8)}`
    f.pullRequest.body = `Contact ${original}.`
    await expect(f.operations.updateMetadata({ body: `Contact ${replacement}.` })).rejects.toThrow(/cannot add GitHub mentions/)
    expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(false)
    await f.operations.updateMetadata({ body: `Updated details for ${original}.` })
  })

  it("rejects body updates when a concurrent edit removes a validated mention", async () => {
    const f = fixture({ restrictCommentMentions: true })
    f.pullRequest.body = "Contact @existing-user."
    let reads = 0
    f.state.beforeRead = () => {
      if (++reads === 2) f.pullRequest.body = "Mention removed by maintainer."
    }
    await expect(f.operations.updateMetadata({ body: "Updated details for @existing-user." })).rejects.toThrow(/body changed/)
    expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(false)
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

it("refreshes dependencies only while the assigned PR head is current", async () => {
  const refreshDependencies = vi.fn(async () => {});
  const f = fixture({ refreshDependencies });
  await f.operations.refreshDependencies();
  expect(refreshDependencies).toHaveBeenCalledTimes(1);
  f.pullRequest.headRefOid = "b".repeat(40);
  await expect(f.operations.refreshDependencies()).rejects.toThrow();
  expect(refreshDependencies).toHaveBeenCalledTimes(1);
});
