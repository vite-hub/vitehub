import * as v from 'valibot'

const actor = v.nullish(v.object({ login: v.optional(v.string()), type: v.optional(v.string()), __typename: v.optional(v.string()) }))
const timestampFields = {
  updated_at: v.nullish(v.string()), updatedAt: v.nullish(v.string()),
  created_at: v.nullish(v.string()), createdAt: v.nullish(v.string()),
  submitted_at: v.nullish(v.string()), submittedAt: v.nullish(v.string()),
  completed_at: v.nullish(v.string()), started_at: v.nullish(v.string()),
}
const reference = v.object({
  sha: v.optional(v.string()), ref: v.optional(v.string()),
  repo: v.nullish(v.object({ full_name: v.string() })),
})
const pullRequestSchema = v.looseObject({
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  ...timestampFields, user: actor, author: actor,
  state: v.optional(v.string()), draft: v.optional(v.boolean()), isDraft: v.optional(v.boolean()),
  title: v.optional(v.string()), body: v.nullish(v.string()), html_url: v.optional(v.string()), url: v.optional(v.string()),
  head: v.optional(reference), base: v.optional(reference),
  headRefOid: v.optional(v.string()), headRefName: v.optional(v.string()),
  baseRefOid: v.optional(v.string()), baseRefName: v.optional(v.string()),
  headRepository: v.nullish(v.object({ nameWithOwner: v.string() })),
  author_association: v.optional(v.string()), authorAssociation: v.optional(v.string()),
  labels: v.optional(v.array(v.union([v.string(), v.object({ name: v.string() })]))),
  mergeable: v.nullish(v.boolean()), mergeable_state: v.optional(v.string()),
  reviewDecision: v.nullish(v.string()),
})
interface GitHubActor { login?: string; type?: string; __typename?: string }
interface GitHubTimestamps {
  updated_at?: string | null; updatedAt?: string | null; created_at?: string | null; createdAt?: string | null
  submitted_at?: string | null; submittedAt?: string | null; completed_at?: string | null; started_at?: string | null
}
interface GitHubRef { sha?: string; ref?: string; repo?: { full_name: string } | null }
export interface GitHubPullRequestRecord extends GitHubTimestamps {
  [key: string]: unknown
  number: number; user?: GitHubActor | null; author?: GitHubActor | null
  state?: string; draft?: boolean; isDraft?: boolean; title?: string; body?: string | null; html_url?: string; url?: string
  head?: GitHubRef; base?: GitHubRef; headRefOid?: string; headRefName?: string; baseRefOid?: string; baseRefName?: string
  headRepository?: { nameWithOwner: string } | null; author_association?: string; authorAssociation?: string
  labels?: (string | { name: string })[]; mergeable?: boolean | null; mergeable_state?: string; reviewDecision?: string | null
}
export function parsePullRequest(value: unknown): GitHubPullRequestRecord {
  const pr = v.parse(pullRequestSchema, value)
  return {
    ...pr,
    state: String(pr.state ?? 'open').toLowerCase() === 'merged' ? 'closed' : String(pr.state ?? 'open').toLowerCase(),
    user: pr.user ?? pr.author,
    author_association: pr.author_association ?? pr.authorAssociation,
    head: pr.head ?? { sha: pr.headRefOid, ref: pr.headRefName, repo: pr.headRepository ? { full_name: pr.headRepository.nameWithOwner } : undefined },
    base: pr.base ?? { sha: pr.baseRefOid, ref: pr.baseRefName },
    draft: pr.draft ?? pr.isDraft,
    html_url: pr.html_url ?? pr.url,
    updated_at: pr.updated_at ?? pr.updatedAt,
    created_at: pr.created_at ?? pr.createdAt,
  }
}

const evidenceSchema = v.looseObject({
  id: v.optional(v.union([v.string(), v.number()])), node_id: v.optional(v.string()), databaseId: v.nullish(v.number()),
  ...timestampFields, user: actor, author: actor,
  body: v.nullish(v.string()), html_url: v.optional(v.string()), url: v.optional(v.string()), deleted: v.optional(v.boolean()),
  state: v.optional(v.string()), name: v.optional(v.string()), status: v.optional(v.string()), conclusion: v.nullish(v.string()),
  head_sha: v.optional(v.string()), sha: v.optional(v.string()), context: v.optional(v.string()),
  description: v.nullish(v.string()), details_url: v.nullish(v.string()), target_url: v.nullish(v.string()),
  app: v.nullish(v.object({ slug: v.optional(v.string()) })),
  output: v.optional(v.object({ summary: v.nullish(v.string()), text: v.nullish(v.string()) })),
  pull_requests: v.optional(v.array(v.object({ number: v.pipe(v.number(), v.integer(), v.minValue(1)) }))),
  commit_id: v.optional(v.string()), original_commit_id: v.optional(v.string()), commit: v.nullish(v.object({ oid: v.string() })),
  pull_request_review_id: v.optional(v.number()), in_reply_to_id: v.optional(v.number()),
  path: v.optional(v.string()), line: v.nullish(v.number()), original_line: v.nullish(v.number()),
  start_line: v.nullish(v.number()), original_start_line: v.nullish(v.number()), side: v.optional(v.string()), start_side: v.nullish(v.string()),
})
/** Fields consumed from comments, reviews, checks, and statuses. Extra GitHub fields remain stored. */
export interface GitHubEvidence extends GitHubTimestamps {
  [key: string]: unknown
  id?: string | number; node_id?: string; databaseId?: number | null; user?: GitHubActor | null; author?: GitHubActor | null
  body?: string | null; html_url?: string; url?: string; deleted?: boolean
  state?: string; name?: string; status?: string; conclusion?: string | null
  head_sha?: string; sha?: string; context?: string; description?: string | null; details_url?: string | null; target_url?: string | null
  app?: { slug?: string } | null; output?: { summary?: string | null; text?: string | null }
  pull_requests?: { number: number }[]; commit_id?: string; original_commit_id?: string; commit?: { oid: string } | null
  pull_request_review_id?: number; in_reply_to_id?: number; path?: string; line?: number | null
  original_line?: number | null; start_line?: number | null; original_start_line?: number | null; side?: string; start_side?: string | null
}
export const parseEvidence = (value: unknown): GitHubEvidence => v.parse(evidenceSchema, value)

const connection = v.object({ nodes: v.array(evidenceSchema), pageInfo: v.optional(v.object({ hasNextPage: v.boolean(), endCursor: v.nullish(v.string()) })) })
const threadSchema = v.looseObject({
  id: v.optional(v.string()), node_id: v.optional(v.string()), isResolved: v.optional(v.boolean()), isOutdated: v.optional(v.boolean()),
  path: v.optional(v.string()), line: v.nullish(v.number()), originalLine: v.nullish(v.number()), startLine: v.nullish(v.number()), originalStartLine: v.nullish(v.number()),
  comments: v.optional(v.union([v.array(evidenceSchema), connection])),
  resolutionSource: v.optional(v.string()), resolutionObservedAt: v.optional(v.string()),
})
export interface GitHubReviewThread {
  [key: string]: unknown
  id?: string; node_id?: string; isResolved?: boolean; isOutdated?: boolean
  path?: string; line?: number | null; originalLine?: number | null; startLine?: number | null; originalStartLine?: number | null
  comments?: GitHubEvidence[] | { nodes: GitHubEvidence[]; pageInfo?: { hasNextPage: boolean; endCursor?: string | null } }
  resolutionSource?: string; resolutionObservedAt?: string
}
export const parseThread = (value: unknown): GitHubReviewThread => v.parse(threadSchema, value)
const deliverySchema = v.looseObject({
  ...evidenceSchema.entries,
  repository: v.optional(v.object({ full_name: v.string() })), action: v.optional(v.string()), sender: actor,
  pull_request: v.optional(pullRequestSchema),
  issue: v.optional(v.object({ number: v.pipe(v.number(), v.integer(), v.minValue(1)), pull_request: v.optional(v.unknown()) })),
  comment: v.optional(evidenceSchema), review: v.optional(evidenceSchema), thread: v.optional(threadSchema),
  check_run: v.optional(evidenceSchema), check_suite: v.optional(evidenceSchema), workflow_run: v.optional(evidenceSchema),
  sha: v.optional(v.string()), ref: v.optional(v.string()), state: v.optional(v.string()),
})
export interface GitHubDelivery extends GitHubEvidence {
  repository?: { full_name: string }; action?: string; sender?: GitHubActor | null
  pull_request?: GitHubPullRequestRecord; issue?: { number: number; pull_request?: unknown }
  comment?: GitHubEvidence; review?: GitHubEvidence; thread?: GitHubReviewThread
  check_run?: GitHubEvidence; check_suite?: GitHubEvidence; workflow_run?: GitHubEvidence; ref?: string
}
export const parseDelivery = (value: unknown): GitHubDelivery => v.parse(deliverySchema, value)
