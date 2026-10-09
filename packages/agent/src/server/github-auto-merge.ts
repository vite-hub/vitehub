import { parseMarkdown } from "comark"
import html from "comark/plugins/html"
import type { ComarkPlugin, Node as MarkdownNode } from "comark"
import * as v from "valibot"
import type { GitHubHost } from "./github-host.ts"
import type { GitHubRepairCommit } from "./github-repair.ts"

const actor = v.nullable(v.object({ login: v.string(), __typename: v.string() }))
const reviewSchema = v.object({ author: actor, state: v.string() })
const pageSchema = v.object({ hasNextPage: v.boolean(), endCursor: v.nullable(v.string()) })
const snapshotSchema = v.object({
  id: v.string(),
  number: v.number(),
  state: v.string(),
  isDraft: v.boolean(),
  headRefOid: v.string(),
  headRefName: v.string(),
  baseRefName: v.string(),
  baseRefOid: v.optional(v.string()),
  title: v.string(),
  body: v.string(),
  author: actor,
  authorAssociation: v.string(),
  isCrossRepository: v.boolean(),
  headRepository: v.nullable(v.object({ nameWithOwner: v.string() })),
  labels: v.object({ nodes: v.array(v.object({ name: v.string() })), pageInfo: pageSchema }),
  reviewDecision: v.nullable(v.string()),
  autoMergeRequest: v.nullable(v.object({ enabledAt: v.string() })),
  latestOpinionatedReviews: v.object({ nodes: v.array(reviewSchema), pageInfo: pageSchema }),
})
const repositorySchema = v.object({
  autoMergeAllowed: v.boolean(),
  squashMergeAllowed: v.boolean(),
  mergeCommitAllowed: v.boolean(),
  rebaseMergeAllowed: v.boolean(),
  deleteBranchOnMerge: v.boolean(),
  pullRequest: snapshotSchema,
})

/** Fresh state supplied to host admission checks. It never comes from the worker. */
export interface GitHubPullRequestOperationSnapshot {
  repository: string
  id: string
  number: number
  state: string
  isDraft: boolean
  headRefOid: string
  headRefName: string
  baseRefName: string
  baseRefOid?: string
  title: string
  body: string
  author: { login: string, __typename: string } | null
  authorAssociation: string
  isCrossRepository: boolean
  headRepository: { nameWithOwner: string } | null
  labels: string[]
  reviewDecision: string | null
  autoMergeRequest: { enabledAt: string } | null
}

export interface GitHubPullRequestOperationsOptions {
  repository: string
  number: number
  expectedHeadOid: string
  /** Exact assigned PR base commit for scoped regression comparison. */
  expectedBaseOid?: string
  /** Disabled unless explicitly enabled by the host. Never infer this from model output. */
  autoMerge?: boolean
  /** Recheck the configured channel filter against current PR state before each operation. */
  eligible?: (pullRequest: GitHubPullRequestOperationSnapshot) => boolean | Promise<boolean>
  /** Exact GitHub logins allowed by the explicit mention capability. Defaults to none. */
  mentionAllowlist?: readonly string[]
  /** Reject live GitHub mentions in ordinary comments. Defaults to false for generic callers. */
  restrictCommentMentions?: boolean
  /** Host-owned prefix that correlates comment webhooks with this worker's activity. */
  commentPrefix?: string
  /** Host-owned checkout push, already bound to its source branch and expected-head lease. */
  push?: () => Promise<string>
  /** Host-owned frozen installation after resolving dependency conflicts. */
  refreshDependencies?: () => Promise<void>
  /** Host-owned staging and commit in the assigned repair checkout. */
  commitRepair?: (input: GitHubRepairCommit) => Promise<string>
  signal?: AbortSignal
}

export type GitHubAutoMergeResult =
  | { status: "enabled" | "already-enabled" | "merged" }
  | { status: "blocked", reason: "disabled" | "draft" | "repository-disabled" | "required-checks-missing" | "changes-requested" | "stacked-branch-cleanup" | "merge-method-unavailable" }

export interface GitHubBaseCheckEvidence {
  repository: string
  headSha: string
  checkRuns: Record<string, unknown>[]
  statuses: Record<string, unknown>[]
  workflowRuns: Record<string, unknown>[]
  truncated: { checkRuns: boolean, statuses: boolean, workflowRuns: boolean }
}

export interface GitHubPullRequestOperations {
  requestAutoMerge(): Promise<GitHubAutoMergeResult>
  comment(body: string): Promise<void>
  mention(login: string, body: string): Promise<void>
  readCheckLogs(runId: number): Promise<{ text: string, truncated: boolean }>
  readBaseCheckEvidence(): Promise<GitHubBaseCheckEvidence>
  readBaseCheckLogs(runId: number): Promise<{ repository: string, headSha: string, text: string, truncated: boolean }>
  resolveThread(id: string): Promise<void>
  updateMetadata(input: { title?: string, body?: string }): Promise<void>
  push(): Promise<void>
  refreshDependencies(): Promise<void>
  commitRepair(input: GitHubRepairCommit): Promise<string>
}

const snapshotQuery = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed deleteBranchOnMerge
    pullRequest(number:$number){
      id number state isDraft headRefOid headRefName baseRefName baseRefOid title body
      author{login __typename} authorAssociation isCrossRepository headRepository{nameWithOwner}
      labels(first:100){nodes{name} pageInfo{hasNextPage endCursor}}
      reviewDecision autoMergeRequest{enabledAt}
      latestOpinionatedReviews(first:100){nodes{author{login __typename} state} pageInfo{hasNextPage endCursor}}
    }
  }
}`

function nonempty(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} must not be empty.`)
  return value
}

// Managed users add one underscore and an alphanumeric enterprise shortcode of 3-8 characters.
const githubLoginPattern = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:_[A-Za-z0-9]{3,8})?$/
// GitHub renders mentions in Markdown, blockquotes, and quoted text. Keep
// URL paths, email-like text, and adjacent at-signs out of the token stream.
const githubMentionPattern = /(^|[^A-Za-z0-9@])@([A-Za-z0-9][A-Za-z0-9_-]{0,38}\/ent:[A-Za-z0-9][A-Za-z0-9_-]*|\/ent:[A-Za-z0-9][A-Za-z0-9_-]*|[A-Za-z0-9][A-Za-z0-9_-]{0,38}(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)?)(?=$|[^A-Za-z0-9_-])/g

export function normalizeGitHubMentionAllowlist(logins: readonly string[] = []): string[] {
  const normalized = new Set<string>()
  for (const login of logins) {
    const value = login.trim().toLowerCase()
    if (githubLoginPattern.test(value)) normalized.add(value)
  }
  return [...normalized]
}

async function githubMentionTokens(body: string): Promise<string[]> {
  // Parse CommonMark with HTML structure, without automatic closing of incomplete
  // code spans. Only rendered text can notify; code examples must stay usable.
  const document = await parseMarkdown(body, {
    registerDefaultPlugins: false,
    plugins: [html(), {
      name: "github-mention-comments",
      markdownItPlugins: [md => {
        // Remove actual inline comments before Comark falls back to raw text.
        // Escaped or entity-encoded delimiters remain visible text tokens.
        md.core.ruler.after("linkify", "github-mention-comments", state => {
          for (const token of state.tokens) {
            if (!token.children) continue
            token.children = token.children.filter(child => child.type !== "html_inline" || !child.content.startsWith("<!--"))
            for (let index = 0; index < token.children.length; index++) {
              const child = token.children[index]!
              if (child.type === "link_open" && child.info === "auto") child.attrSet("data-github-autolink", "true")
              // Markdown-It ends fuzzy URLs at quotes, while GitHub keeps
              // their adjacent path text inside the same non-notifying link.
              const label = token.children[index - 1]
              const suffix = token.children[index + 1]
              if (child.type === "link_close" && child.markup === "linkify" && label?.type === "text" && /^(?:https?:\/\/|www\.)/i.test(label.content) && suffix?.type === "text") {
                suffix.content = suffix.content.replace(/^["'][^\s<>]*/, "")
              }
            }
          }
        })
      }],
    } satisfies ComarkPlugin],
    autoClose: false,
    autoUnwrap: false,
    linkify: true,
  })
  const mentions: string[] = []
  function collectMentions(node: MarkdownNode): void {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Comark has already parsed the body into its string-or-element node contract.
    if (typeof node === "string") {
      // The Markdown parser bounds automatic URL links. Remove email text
      // using GFM local-part and domain characters only. Consume the complete
      // domain before checking its final character so an invalid suffix cannot
      // backtrack into a shorter valid email and hide a live mention.
      const text = node
        .replace(/[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/g, email => /[A-Za-z0-9]$/.test(email) ? " " : email)
      for (const match of text.matchAll(githubMentionPattern)) mentions.push(match[2]!.toLowerCase())
      return
    }
    const [tag, attributes, ...children] = node
    if (tag === "code" || tag === "pre" || tag === null) return
    // GitHub linkifies scheme URLs and www. URLs, including quote characters
    // and entities in their paths. Fuzzy bare domains remain ordinary text.
    if (tag === "a" && children.length === 1) {
      const label = String(children[0])
      if (attributes["data-github-autolink"] === "true" && /^(?:[A-Za-z][A-Za-z0-9+.-]*:|www\.)/i.test(label)) return
      if (label === attributes.href && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(label)) return
    }
    children.forEach(collectMentions)
  }
  document.nodes.forEach(collectMentions)
  return mentions
}

async function hasGitHubMention(body: string): Promise<boolean> {
  return (await githubMentionTokens(body)).length > 0
}

/**
 * Host-only PR operations. Keep the GitHub host and its credentials out of the
 * worker environment. Expose selected methods as capabilities, never command or access.
 * Native auto-merge remains subject to GitHub's branch rules after it is enabled.
 * This module does not approve reviews, merge directly, or delete branches.
 */
export function createGitHubPullRequestOperations(
  github: Pick<GitHubHost, "command" | "ensureGraphQLBudget">,
  options: GitHubPullRequestOperationsOptions,
): GitHubPullRequestOperations {
  const [owner, name, extra] = options.repository.split("/")
  if (!owner || !name || extra !== undefined || !/^[\w.-]+\/[\w.-]+$/.test(options.repository)) throw new Error("Expected a GitHub owner/repository.")
  if (!Number.isSafeInteger(options.number) || options.number <= 0) throw new Error("Expected a positive pull request number.")
  if (!/^[a-f\d]{40}$/i.test(options.expectedHeadOid)) throw new Error("Expected a full GitHub head commit SHA.")
  if (options.expectedBaseOid !== undefined && !/^[a-f\d]{40}$/i.test(options.expectedBaseOid)) throw new Error("Expected a full GitHub base commit SHA.")
  const repository = options.repository
  const mentionAllowlist = new Set(normalizeGitHubMentionAllowlist(options.mentionAllowlist))
  let expectedHeadOid = options.expectedHeadOid
  const target = `/repos/${repository}/issues/${options.number}`
  const commandOptions = { repository, signal: options.signal, timeout: 60_000 }

  async function graphQL(query: string, variables: Record<string, string | number> = {}): Promise<unknown> {
    options.signal?.throwIfAborted()
    const reservation = await github.ensureGraphQLBudget(repository, { cost: 4, signal: options.signal, timeout: 60_000 })
    let submitted = false
    try {
      const args = ["api", "graphql", "-f", `query=${query}`]
      for (const [key, value] of Object.entries(variables)) args.push(Number.isFinite(value) ? "-F" : "-f", `${key}=${value}`)
      reservation.submit()
      submitted = true
      const result = await github.command(args, commandOptions)
      const response = v.parse(v.object({ data: v.optional(v.unknown()), errors: v.optional(v.array(v.unknown())) }), JSON.parse(result.stdout))
      if (response.errors?.length || !response.data) throw new Error("GitHub could not complete the pull request operation.")
      return response.data
    }
    finally {
      // Charge the reserved upper bound, including uncertain network outcomes.
      if (submitted) reservation.settle(4)
      else reservation.release()
    }
  }

  async function snapshot() {
    const data = v.parse(v.object({ repository: repositorySchema }), await graphQL(snapshotQuery, { owner: owner!, name: name!, number: options.number }))
    const pullRequest = data.repository.pullRequest
    if (pullRequest.headRefOid !== expectedHeadOid) throw new Error("Pull request head changed; discard this worker's operations.")
    if (pullRequest.state !== "OPEN") throw new Error("Pull request is no longer open and ready for repair.")
    const labels = pullRequest.labels.nodes.map(label => label.name)
    let page = pullRequest.labels.pageInfo
    const cursors = new Set<string>()
    while (page.hasNextPage) {
      const cursor = page.endCursor
      if (!cursor || cursors.has(cursor)) throw new Error("GitHub returned an invalid label cursor.")
      cursors.add(cursor)
      const result = v.parse(v.object({ node: v.object({ labels: v.object({ nodes: v.array(v.object({ name: v.string() })), pageInfo: pageSchema }) }) }), await graphQL(`query($id:ID!,$cursor:String!){node(id:$id){... on PullRequest{labels(first:100,after:$cursor){nodes{name} pageInfo{hasNextPage endCursor}}}}}`, { id: pullRequest.id, cursor }))
      labels.push(...result.node.labels.nodes.map(label => label.name))
      page = result.node.labels.pageInfo
    }
    const reviews = [...pullRequest.latestOpinionatedReviews.nodes]
    page = pullRequest.latestOpinionatedReviews.pageInfo
    const reviewCursors = new Set<string>()
    while (page.hasNextPage) {
      const cursor = page.endCursor
      if (!cursor || reviewCursors.has(cursor)) throw new Error("GitHub returned an invalid review cursor.")
      reviewCursors.add(cursor)
      const result = v.parse(v.object({ node: v.object({ latestOpinionatedReviews: v.object({ nodes: v.array(reviewSchema), pageInfo: pageSchema }) }) }), await graphQL(`query($id:ID!,$cursor:String!){node(id:$id){... on PullRequest{latestOpinionatedReviews(first:100,after:$cursor){nodes{author{login __typename} state} pageInfo{hasNextPage endCursor}}}}}`, { id: pullRequest.id, cursor }))
      reviews.push(...result.node.latestOpinionatedReviews.nodes)
      page = result.node.latestOpinionatedReviews.pageInfo
    }
    const { latestOpinionatedReviews: _reviews, labels: _labels, ...fields } = pullRequest
    if (options.eligible && !await options.eligible({ ...fields, repository, labels })) throw new Error("Pull request no longer matches the configured filter.")
    return { ...data.repository, pullRequest: { ...fields, latestOpinionatedReviews: { nodes: reviews, pageInfo: { hasNextPage: false, endCursor: null } }, labels: pullRequest.labels } }
  }

  async function requestAutoMerge(): Promise<GitHubAutoMergeResult> {
    // Check before resolving credentials or reading remote state.
    if (options.autoMerge !== true) return { status: "blocked", reason: "disabled" }
    const current = await snapshot()
    const pullRequest = current.pullRequest
    if (pullRequest.isDraft) return { status: "blocked", reason: "draft" }
    if (!current.autoMergeAllowed) return { status: "blocked", reason: "repository-disabled" }
    // The hosted gh CLI does not provide `--slurp`; emit one JSON rule per line.
    const rules = await github.command([
      "api", "--paginate",
      `/repos/${repository}/rules/branches/${encodeURIComponent(pullRequest.baseRefName)}?per_page=100`,
      "--jq", ".[] | @json",
    ], commandOptions)
    const activeRules = v.parse(
      v.array(v.object({ type: v.string(), parameters: v.optional(v.unknown()) })),
      rules.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    )
    const requiredChecks = activeRules.some(rule => (rule.type === "required_status_checks"
      && v.safeParse(v.object({ required_status_checks: v.pipe(v.array(v.unknown()), v.minLength(1)) }), rule.parameters).success)
      || (rule.type === "workflows"
        && v.safeParse(v.object({ workflows: v.pipe(v.array(v.unknown()), v.minLength(1)) }), rule.parameters).success))
    // The branch rules endpoint includes active repository and organization rulesets.
    // Classic branch protection is read separately because it is not a ruleset.
    if (!requiredChecks) {
      const protection = v.parse(v.object({ repository: v.object({ ref: v.nullable(v.object({ branchProtectionRule: v.nullable(v.object({ requiresStatusChecks: v.boolean(), requiredStatusCheckContexts: v.array(v.string()) })) })) }) }), await graphQL(`query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){branchProtectionRule{requiresStatusChecks requiredStatusCheckContexts}}}}`, { owner: owner!, name: name!, ref: `refs/heads/${pullRequest.baseRefName}` }))
      const rule = protection.repository.ref?.branchProtectionRule
      if (!rule?.requiresStatusChecks || rule.requiredStatusCheckContexts.length === 0) return { status: "blocked", reason: "required-checks-missing" }
    }
    const reviews = pullRequest.latestOpinionatedReviews.nodes
    if (pullRequest.reviewDecision === "CHANGES_REQUESTED" || reviews.some(review => review.state === "CHANGES_REQUESTED" && review.author?.__typename !== "Bot")) return { status: "blocked", reason: "changes-requested" }
    async function preservesChildren(state: typeof current): Promise<boolean> {
      if (!state.deleteBranchOnMerge || state.pullRequest.headRepository?.nameWithOwner.toLowerCase() !== repository.toLowerCase()) return true
      const children = v.parse(v.object({ repository: v.object({ pullRequests: v.object({ totalCount: v.number() }) }) }), await graphQL(`query($owner:String!,$name:String!,$base:String!){repository(owner:$owner,name:$name){pullRequests(first:1,states:OPEN,baseRefName:$base){totalCount}}}`, { owner: owner!, name: name!, base: state.pullRequest.headRefName }))
      return children.repository.pullRequests.totalCount === 0
    }
    if (!await preservesChildren(current)) return { status: "blocked", reason: "stacked-branch-cleanup" }
    if (pullRequest.autoMergeRequest) return { status: "already-enabled" }
    const rulesetMethods = activeRules.filter(rule => rule.type === "pull_request").map(rule =>
      v.parse(v.object({ allowed_merge_methods: v.optional(v.array(v.string())) }), rule.parameters ?? {}).allowed_merge_methods)
    const method = ([
      ["SQUASH", current.squashMergeAllowed],
      ["MERGE", current.mergeCommitAllowed],
      ["REBASE", current.rebaseMergeAllowed],
    ] as const).find(([method, enabled]) => enabled
      && rulesetMethods.every(allowed => allowed === undefined || allowed.includes(method.toLowerCase())))?.[0]
    if (!method) return { status: "blocked", reason: "merge-method-unavailable" }
    // Recheck admission after the paginated eligibility reads. GitHub compares the
    // expected head atomically with enabling auto-merge, including concurrent pushes.
    const finalState = await snapshot()
    if (finalState.pullRequest.headRefOid !== pullRequest.headRefOid
      || finalState.pullRequest.baseRefName !== pullRequest.baseRefName) {
      throw new Error("Pull request ref changed during auto-merge admission.")
    }
    if (finalState.pullRequest.isDraft) return { status: "blocked", reason: "draft" }
    if (finalState.pullRequest.reviewDecision === "CHANGES_REQUESTED"
      || finalState.pullRequest.latestOpinionatedReviews.nodes.some(review => review.state === "CHANGES_REQUESTED" && review.author?.__typename !== "Bot")) return { status: "blocked", reason: "changes-requested" }
    if (!await preservesChildren(finalState)) return { status: "blocked", reason: "stacked-branch-cleanup" }
    const result = v.parse(v.object({ enablePullRequestAutoMerge: v.object({ pullRequest: v.object({ id: v.string(), state: v.string(), headRefOid: v.string(), autoMergeRequest: v.nullable(v.object({ enabledAt: v.string() })) }) }) }), await graphQL(`mutation($id:ID!,$method:PullRequestMergeMethod!,$head:GitObjectID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$method,expectedHeadOid:$head}){pullRequest{id state headRefOid autoMergeRequest{enabledAt}}}}`, { id: pullRequest.id, method, head: pullRequest.headRefOid }))
    const confirmed = result.enablePullRequestAutoMerge.pullRequest
    if (confirmed.id !== pullRequest.id || confirmed.headRefOid !== pullRequest.headRefOid) throw new Error("GitHub did not confirm the expected pull request head.")
    if (confirmed.state === "MERGED") return { status: "merged" }
    if (confirmed.state !== "OPEN" || !confirmed.autoMergeRequest) throw new Error("GitHub did not confirm native auto-merge was enabled.")
    return { status: "enabled" }
  }

  async function exactBaseSnapshot(): Promise<string> {
    if (!options.expectedBaseOid) throw new Error("This worker has no assigned base commit for CI comparison.")
    const current = await snapshot()
    if (current.pullRequest.baseRefOid !== options.expectedBaseOid) throw new Error("Pull request base changed; discard this base CI comparison.")
    return options.expectedBaseOid
  }

  return {
    requestAutoMerge,
    async readBaseCheckEvidence() {
      const base = await exactBaseSnapshot()
      const [checksResponse, statusesResponse, runsResponse] = await Promise.all([
        github.command(["api", `/repos/${repository}/commits/${base}/check-runs?per_page=100`], commandOptions),
        github.command(["api", `/repos/${repository}/commits/${base}/statuses?per_page=100`], commandOptions),
        github.command(["api", `/repos/${repository}/actions/runs?head_sha=${base}&per_page=100`], commandOptions),
      ])
      const checks = v.parse(v.object({ total_count: v.number(), check_runs: v.array(v.object({ id: v.number(), head_sha: v.string(), name: v.string(), status: v.string(), conclusion: v.nullish(v.string()), details_url: v.nullish(v.string()), html_url: v.optional(v.string()) })) }), JSON.parse(checksResponse.stdout))
      const statuses = v.parse(v.array(v.object({ id: v.number(), sha: v.optional(v.string()), context: v.string(), state: v.string(), description: v.nullish(v.string()), target_url: v.nullish(v.string()) })), JSON.parse(statusesResponse.stdout))
      const runs = v.parse(v.object({ total_count: v.number(), workflow_runs: v.array(v.object({ id: v.number(), head_sha: v.string(), repository: v.object({ full_name: v.string() }), status: v.string(), conclusion: v.nullish(v.string()), name: v.optional(v.string()), html_url: v.optional(v.string()) })) }), JSON.parse(runsResponse.stdout))
      await exactBaseSnapshot()
      return { repository, headSha: base,
        checkRuns: checks.check_runs.filter(check => check.head_sha === base).slice(0, 100),
        statuses: statuses.filter(status => status.sha === undefined || status.sha === base).slice(0, 100).map(status => ({ ...status, sha: base })),
        workflowRuns: runs.workflow_runs.filter(run => run.head_sha === base && run.repository.full_name.toLowerCase() === repository.toLowerCase()).slice(0, 100),
        truncated: { checkRuns: checks.total_count > 100, statuses: statuses.length >= 100, workflowRuns: runs.total_count > 100 } }
    },
    async readBaseCheckLogs(runId) {
      if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("Expected a positive workflow run ID.")
      const base = await exactBaseSnapshot()
      const result = await github.command(["api", `/repos/${repository}/actions/runs/${runId}`], commandOptions)
      const run = v.parse(v.object({ head_sha: v.string(), repository: v.object({ full_name: v.string() }) }), JSON.parse(result.stdout))
      if (run.head_sha !== base || run.repository.full_name.toLowerCase() !== repository.toLowerCase()) {
        throw new Error("Workflow run does not belong to this pull request's exact base commit.")
      }
      const logs = await github.command(["run", "view", String(runId), "--repo", repository, "--log-failed"], commandOptions)
      await exactBaseSnapshot()
      const limit = 200_000
      return { repository, headSha: base, text: logs.stdout.slice(0, limit), truncated: logs.stdout.length > limit }
    },
    async readCheckLogs(runId) {
      if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("Expected a positive workflow run ID.")
      await snapshot()
      const result = await github.command(["api", `/repos/${repository}/actions/runs/${runId}`], commandOptions)
      const run = v.parse(v.object({
        head_sha: v.string(),
        repository: v.object({ full_name: v.string() }),
        pull_requests: v.array(v.object({ number: v.number(), head: v.object({ sha: v.string() }) })),
      }), JSON.parse(result.stdout))
      if (run.repository.full_name.toLowerCase() !== repository.toLowerCase()
        || !(run.head_sha === expectedHeadOid || run.pull_requests.some(pr => pr.number === options.number && pr.head.sha === expectedHeadOid))) {
        throw new Error("Workflow run does not belong to this pull request head.")
      }
      const logs = await github.command(["run", "view", String(runId), "--repo", repository, "--log-failed"], commandOptions)
      const limit = 200_000
      return { text: logs.stdout.slice(0, limit), truncated: logs.stdout.length > limit }
    },
    async comment(body) {
      nonempty(body, "Comment")
      if (options.restrictCommentMentions && await hasGitHubMention(body)) throw new Error("Comments cannot contain GitHub mentions; use the guarded mention capability.")
      await snapshot()
      await github.command(["api", `${target}/comments`, "--method", "POST", "-f", `body=${options.commentPrefix ?? ""}${body}`], commandOptions)
    },
    async mention(login, body) {
      const targetLogin = nonempty(login, "GitHub login")
      if (!githubLoginPattern.test(targetLogin) || !mentionAllowlist.has(targetLogin.toLowerCase())) {
        throw new Error("GitHub login is not in the configured mention allowlist.")
      }
      const message = nonempty(body, "Mention body")
      if (await hasGitHubMention(message)) throw new Error("Mention body must not contain another mention.")
      await snapshot()
      // Keep block Markdown at the start of the validated body on its own line.
      await github.command(["api", `${target}/comments`, "--method", "POST", "-f", `body=${options.commentPrefix ?? ""}@${targetLogin}\n\n${message}`], commandOptions)
    },
    async resolveThread(id) {
      nonempty(id, "Review thread ID")
      const current = await snapshot()
      const thread = v.parse(v.object({ node: v.nullable(v.object({ pullRequest: v.object({ id: v.string() }), isResolved: v.boolean() })) }), await graphQL(`query($id:ID!){node(id:$id){... on PullRequestReviewThread{pullRequest{id} isResolved}}}`, { id }))
      if (!thread.node || thread.node.pullRequest.id !== current.pullRequest.id) throw new Error("Review thread does not belong to this pull request.")
      if (thread.node.isResolved) return
      // The thread lookup may race a push or closure. Its ownership is not evidence
      // that this pass still owns the current PR head.
      await snapshot()
      await graphQL(`mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}`, { id })
    },
    async updateMetadata(input) {
      if (input.title === undefined && input.body === undefined) throw new Error("Provide a pull request title or body.")
      const args = ["api", target, "--method", "PATCH"]
      if (input.title !== undefined) args.push("-f", `title=${nonempty(input.title, "Title")}`)
      const current = await snapshot()
      if (input.body !== undefined) {
        if (options.restrictCommentMentions) {
          const existing = new Set(await githubMentionTokens(current.pullRequest.body))
          const added = (await githubMentionTokens(input.body)).find((mention) => !existing.has(mention))
          if (added) throw new Error("Pull request bodies cannot add GitHub mentions; use the guarded mention capability.")
        }
        args.push("-f", `body=${input.body}`)
      }
      if (input.body !== undefined) {
        const rechecked = await snapshot()
        if (rechecked.pullRequest.body !== current.pullRequest.body) throw new Error("Pull request body changed while validating the update; retry.")
      }
      await github.command(args, commandOptions)
    },
    async refreshDependencies() {
      if (!options.refreshDependencies) throw new Error("This worker has no dependency refresh operation.")
      await snapshot()
      await options.refreshDependencies()
    },
    async commitRepair(input) {
      if (!options.commitRepair) throw new Error("This worker has no host-owned commit operation.")
      await snapshot()
      options.signal?.throwIfAborted()
      return await options.commitRepair(input)
    },
    async push() {
      if (!options.push) throw new Error("This worker has no host-owned push operation.")
      await snapshot()
      options.signal?.throwIfAborted()
      const pushedHead = await options.push()
      if (!/^[a-f\d]{40}$/i.test(pushedHead)) throw new Error("The host push did not return a verified commit SHA.")
      expectedHeadOid = pushedHead
    },
  }
}
