import * as v from "valibot"
import type { GitHubHost } from "./github-host.ts"

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
  /** Disabled unless explicitly enabled by the host. Never infer this from model output. */
  autoMerge?: boolean
  /** Recheck the configured channel filter against current PR state before each operation. */
  eligible?: (pullRequest: GitHubPullRequestOperationSnapshot) => boolean | Promise<boolean>
  /** Host-owned checkout push, already bound to its source branch and expected-head lease. */
  push?: () => Promise<string>
  signal?: AbortSignal
}

export type GitHubAutoMergeResult =
  | { status: "enabled" | "already-enabled" | "merged" }
  | { status: "blocked", reason: "disabled" | "draft" | "repository-disabled" | "required-checks-missing" | "changes-requested" | "stacked-branch-cleanup" | "merge-method-unavailable" }

export interface GitHubPullRequestOperations {
  requestAutoMerge(): Promise<GitHubAutoMergeResult>
  comment(body: string): Promise<void>
  readCheckLogs(runId: number): Promise<{ text: string, truncated: boolean }>
  resolveThread(id: string): Promise<void>
  updateMetadata(input: { title?: string, body?: string }): Promise<void>
  push(): Promise<void>
}

const snapshotQuery = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed deleteBranchOnMerge
    pullRequest(number:$number){
      id number state isDraft headRefOid headRefName baseRefName title body
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
  const repository = options.repository
  let expectedHeadOid = options.expectedHeadOid
  const target = `/repos/${repository}/issues/${options.number}`
  const commandOptions = { repository, signal: options.signal, timeout: 60_000 }

  async function graphQL(query: string, variables: Record<string, string | number> = {}): Promise<unknown> {
    options.signal?.throwIfAborted()
    const reservation = await github.ensureGraphQLBudget(repository, { cost: 4, signal: options.signal, timeout: 60_000 })
    let submitted = false
    try {
      const args = ["api", "graphql", "-f", `query=${query}`]
      for (const [key, value] of Object.entries(variables)) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`)
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
    const { latestOpinionatedReviews: _reviews, labels: _labels, ...fields } = pullRequest
    if (options.eligible && !await options.eligible({ ...fields, repository, labels })) throw new Error("Pull request no longer matches the configured filter.")
    return data.repository
  }

  async function requestAutoMerge(): Promise<GitHubAutoMergeResult> {
    // Check before resolving credentials or reading remote state.
    if (options.autoMerge !== true) return { status: "blocked", reason: "disabled" }
    const current = await snapshot()
    const pullRequest = current.pullRequest
    if (pullRequest.isDraft) return { status: "blocked", reason: "draft" }
    if (!current.autoMergeAllowed) return { status: "blocked", reason: "repository-disabled" }
    const rules = await github.command(["api", `/repos/${repository}/rules/branches/${encodeURIComponent(pullRequest.baseRefName)}`], commandOptions)
    const activeRules = v.parse(v.array(v.object({ type: v.string(), parameters: v.optional(v.unknown()) })), JSON.parse(rules.stdout))
    const requiredChecks = activeRules.some(rule => rule.type === "required_status_checks"
      && v.safeParse(v.object({ required_status_checks: v.pipe(v.array(v.unknown()), v.minLength(1)) }), rule.parameters).success)
    // The branch rules endpoint includes active repository and organization rulesets.
    // Classic branch protection is read separately because it is not a ruleset.
    if (!requiredChecks) {
      const protection = v.parse(v.object({ repository: v.object({ ref: v.nullable(v.object({ branchProtectionRule: v.nullable(v.object({ requiresStatusChecks: v.boolean(), requiredStatusCheckContexts: v.array(v.string()) })) })) }) }), await graphQL(`query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){branchProtectionRule{requiresStatusChecks requiredStatusCheckContexts}}}}`, { owner: owner!, name: name!, ref: `refs/heads/${pullRequest.baseRefName}` }))
      const rule = protection.repository.ref?.branchProtectionRule
      if (!rule?.requiresStatusChecks || rule.requiredStatusCheckContexts.length === 0) return { status: "blocked", reason: "required-checks-missing" }
    }
    const reviews = [...pullRequest.latestOpinionatedReviews.nodes]
    let page = pullRequest.latestOpinionatedReviews.pageInfo
    const cursors = new Set<string>()
    while (page.hasNextPage) {
      const cursor = page.endCursor
      if (!cursor || cursors.has(cursor)) throw new Error("GitHub returned an invalid review cursor.")
      cursors.add(cursor)
      const result = v.parse(v.object({ node: v.object({ latestOpinionatedReviews: v.object({ nodes: v.array(reviewSchema), pageInfo: pageSchema }) }) }), await graphQL(`query($id:ID!,$cursor:String!){node(id:$id){... on PullRequest{latestOpinionatedReviews(first:100,after:$cursor){nodes{author{login __typename} state} pageInfo{hasNextPage endCursor}}}}}`, { id: pullRequest.id, cursor }))
      reviews.push(...result.node.latestOpinionatedReviews.nodes)
      page = result.node.latestOpinionatedReviews.pageInfo
    }
    if (pullRequest.reviewDecision === "CHANGES_REQUESTED" || reviews.some(review => review.state === "CHANGES_REQUESTED" && review.author?.__typename !== "Bot")) return { status: "blocked", reason: "changes-requested" }
    if (current.deleteBranchOnMerge && pullRequest.headRepository?.nameWithOwner.toLowerCase() === repository.toLowerCase()) {
      const children = v.parse(v.object({ repository: v.object({ pullRequests: v.object({ totalCount: v.number() }) }) }), await graphQL(`query($owner:String!,$name:String!,$base:String!){repository(owner:$owner,name:$name){pullRequests(first:1,states:OPEN,baseRefName:$base){totalCount}}}`, { owner: owner!, name: name!, base: pullRequest.headRefName }))
      if (children.repository.pullRequests.totalCount > 0) return { status: "blocked", reason: "stacked-branch-cleanup" }
    }
    if (pullRequest.autoMergeRequest) return { status: "already-enabled" }
    const method = current.squashMergeAllowed ? "SQUASH" : current.mergeCommitAllowed ? "MERGE" : current.rebaseMergeAllowed ? "REBASE" : undefined
    if (!method) return { status: "blocked", reason: "merge-method-unavailable" }
    // Recheck admission after the paginated eligibility reads. GitHub compares the
    // expected head atomically with enabling auto-merge, including concurrent pushes.
    const finalState = await snapshot()
    if (finalState.pullRequest.headRefOid !== pullRequest.headRefOid) throw new Error("Pull request head changed during auto-merge admission.")
    if (finalState.pullRequest.isDraft) return { status: "blocked", reason: "draft" }
    if (finalState.pullRequest.reviewDecision === "CHANGES_REQUESTED"
      || finalState.pullRequest.latestOpinionatedReviews.nodes.some(review => review.state === "CHANGES_REQUESTED" && review.author?.__typename !== "Bot")) return { status: "blocked", reason: "changes-requested" }
    const result = v.parse(v.object({ enablePullRequestAutoMerge: v.object({ pullRequest: v.object({ id: v.string(), state: v.string(), headRefOid: v.string(), autoMergeRequest: v.nullable(v.object({ enabledAt: v.string() })) }) }) }), await graphQL(`mutation($id:ID!,$head:GitObjectID!,$method:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,expectedHeadOid:$head,mergeMethod:$method}){pullRequest{id state headRefOid autoMergeRequest{enabledAt}}}}`, { id: pullRequest.id, head: pullRequest.headRefOid, method }))
    const confirmed = result.enablePullRequestAutoMerge.pullRequest
    if (confirmed.id !== pullRequest.id || confirmed.headRefOid !== pullRequest.headRefOid) throw new Error("GitHub did not confirm the expected pull request head.")
    if (confirmed.state === "MERGED") return { status: "merged" }
    if (confirmed.state !== "OPEN" || !confirmed.autoMergeRequest) throw new Error("GitHub did not confirm native auto-merge was enabled.")
    return { status: "enabled" }
  }

  return {
    requestAutoMerge,
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
      await snapshot()
      await github.command(["api", `${target}/comments`, "--method", "POST", "-f", `body=${body}`], commandOptions)
    },
    async resolveThread(id) {
      nonempty(id, "Review thread ID")
      const current = await snapshot()
      const thread = v.parse(v.object({ node: v.nullable(v.object({ pullRequest: v.object({ id: v.string() }), isResolved: v.boolean() })) }), await graphQL(`query($id:ID!){node(id:$id){... on PullRequestReviewThread{pullRequest{id} isResolved}}}`, { id }))
      if (!thread.node || thread.node.pullRequest.id !== current.pullRequest.id) throw new Error("Review thread does not belong to this pull request.")
      if (thread.node.isResolved) return
      await graphQL(`mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}`, { id })
    },
    async updateMetadata(input) {
      if (input.title === undefined && input.body === undefined) throw new Error("Provide a pull request title or body.")
      const args = ["api", target, "--method", "PATCH"]
      if (input.title !== undefined) args.push("-f", `title=${nonempty(input.title, "Title")}`)
      if (input.body !== undefined) args.push("-f", `body=${input.body}`)
      await snapshot()
      await github.command(args, commandOptions)
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
