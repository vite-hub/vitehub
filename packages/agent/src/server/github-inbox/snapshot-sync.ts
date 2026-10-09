import * as v from 'valibot'
import { parseEvidence, parsePullRequest, parseThread, type GitHubReviewThread, type GitHubEvidence, type GitHubDelivery, type GitHubPullRequestRecord } from './types.ts'
import { createHash } from 'node:crypto'
import { type Claim, type PullRequestInbox, type Snapshot } from './store.ts'

export type ReadGitHubSnapshot = (path: string, projection?: string) => Promise<unknown[]>
export type ReadThreads = (repository: string, number: number) => Promise<GitHubReviewThread[]>
export type ReadGraphql = (query: string, variables: Record<string, string | number | null>) => Promise<unknown>
const index = (items: GitHubEvidence[]) => Object.fromEntries(items.map(item => [String(item.id), item]))
const pageInfo = v.object({ hasNextPage: v.boolean(), endCursor: v.nullish(v.string()) })
const commentConnection = v.object({ nodes: v.array(v.object({ id: v.string(), databaseId: v.nullish(v.number()) })), pageInfo })
const threadConnection = v.object({ nodes: v.array(v.pipe(v.unknown(), v.transform(parseThread))), pageInfo })
const envelope = v.object({ data: v.optional(v.unknown()), errors: v.optional(v.array(v.object({ message: v.string() }))) })

/** Read paginated thread state and comment identities. REST intake owns comment bodies. */
export async function readPullRequestThreads(graphql: ReadGraphql, repository: string, number: number): Promise<GitHubReviewThread[]> {
  const [owner, name, extra] = repository.split('/')
  if (!owner || !name || extra) throw new Error('Invalid repository for review threads')
  const threads: GitHubReviewThread[] = []
  const request = async (query: string, variables: Record<string, string | number | null>) => {
    const raw = await graphql(query, variables)
    const response = v.parse(envelope, raw)
    if (response.errors?.length) throw new Error(`GitHub review thread query failed: ${response.errors.map(error => error.message).join('; ')}`)
    return response.data ?? raw
  }
  const nextCursor = (connection: { pageInfo: v.InferOutput<typeof pageInfo> }, seen: Set<string>): string | null => {
    if (!connection.pageInfo.hasNextPage) return null
    const cursor = connection.pageInfo.endCursor
    if (!cursor || seen.has(cursor)) throw new Error('Invalid review thread pagination cursor')
    seen.add(cursor); return cursor
  }
  let after: string | null = null
  const pages = new Set<string>()
  do {
    const data = v.parse(v.object({ repository: v.object({ pullRequest: v.object({ reviewThreads: threadConnection }) }) }), await request(`query GitHubPullRequestReviewThreads($owner:String!,$name:String!,$number:Int!,$after:String) {
      repository(owner:$owner,name:$name) { pullRequest(number:$number) { reviewThreads(first:100,after:$after) {
        nodes { id isResolved isOutdated path line originalLine startLine originalStartLine
          comments(first:100) { nodes { id databaseId } pageInfo { hasNextPage endCursor } }
        } pageInfo { hasNextPage endCursor }
      } } }
    }`, { owner, name, number, after }))
    const connection = data.repository.pullRequest.reviewThreads
    after = nextCursor(connection, pages)
    for (const thread of connection.nodes) {
      if (!thread.id || typeof thread.isResolved !== 'boolean') throw new Error('Incomplete review thread metadata')
      const firstComments = v.parse(commentConnection, thread.comments)
      const comments = [...firstComments.nodes]
      const commentPages = new Set<string>()
      let commentAfter = nextCursor(firstComments, commentPages)
      while (commentAfter) {
        const more = v.parse(v.object({ node: v.object({ comments: commentConnection }) }), await request(`query GitHubPullRequestThreadComments($id:ID!,$after:String!) {
          node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$after) {
            nodes { id databaseId } pageInfo { hasNextPage endCursor }
          } } }
        }`, { id: thread.id, after: commentAfter }))
        commentAfter = nextCursor(more.node.comments, commentPages)
        comments.push(...more.node.comments.nodes)
      }
      threads.push({ ...thread, comments, resolutionSource: 'graphql' })
    }
  } while (after)
  return threads
}

/** REST snapshots fill webhook gaps without asking an LLM to poll GitHub. */
export async function readSnapshot(read: ReadGitHubSnapshot, repository: string, number: number, readThreads?: ReadThreads, activityAuthors: readonly string[] = []): Promise<import('./store.ts').SnapshotPatch & { pr: GitHubPullRequestRecord }> {
  const prefix = `repos/${repository}`
  const [raw] = await read(`${prefix}/pulls/${number}`, '.')
  const pr = parsePullRequest(raw)
  if (!pr.head?.sha) throw new Error('GitHub returned no pull request head.')
  if (pr.state !== 'open') return { pr }
  const readAll = async (path: string, projection?: string) => {
    const items: unknown[] = []
    for (let page = 1; ; page++) {
      const batch = await read(`${path}&page=${page}`, projection)
      items.push(...batch)
      if (batch.length < 100) return items
    }
  }
  const [comments, reviews, reviewComments, checks, statuses, threads] = await Promise.all([
    readAll(`${prefix}/issues/${number}/comments?per_page=100`),
    readAll(`${prefix}/pulls/${number}/reviews?per_page=100`),
    readAll(`${prefix}/pulls/${number}/comments?per_page=100`),
    readAll(`${prefix}/commits/${pr.head.sha}/check-runs?per_page=100`, '.check_runs[]'),
    readAll(`${prefix}/commits/${pr.head.sha}/statuses?per_page=100`),
    readThreads?.(repository, number),
  ])
  const normalizedActivityAuthors = new Set(activityAuthors.map(author => author.trim().toLowerCase()))
  const snapshot = { pr, comments: index(comments.map(parseEvidence).filter(comment => !((normalizedActivityAuthors.has(String(comment.user?.login ?? comment.author?.login ?? '').trim().toLowerCase())) && String(comment.body ?? '').startsWith('<!-- vitehub-agent-activity:')))), reviews: index(reviews.map(parseEvidence)),
    reviewComments: index(reviewComments.map(parseEvidence)),
    checks: Object.fromEntries(checks.map(parseEvidence).map(c => [`check_run:${c.id}`, c])),
    statuses: Object.fromEntries(statuses.map(parseEvidence).reverse().map(s => [s.context, s])), hydrated: true,
  }
  if (threads) Object.assign(snapshot, { threads, threadsHydrated: true, feedbackRefresh: false })
  return snapshot
}

export async function hydrateSnapshot(inbox: PullRequestInbox, claim: Claim, read: ReadGitHubSnapshot, readThreads?: ReadThreads, activityAuthors: readonly string[] = []): Promise<boolean> {
  const { snapshot: current } = claim
  if (current.hydrated && !current.refresh && current.pr?.mergeable !== null && current.pr?.mergeable_state !== 'unknown') {
    if (!readThreads || current.threadsHydrated && !current.feedbackRefresh) return true
    const threads = await readThreads(current.repository, current.number)
    return await inbox.hydrate(claim, { threads, threadsHydrated: true, feedbackRefresh: false })
  }
  const snapshot = await readSnapshot(read, current.repository, current.number, readThreads, activityAuthors)
  // CAS keeps an event received while REST requests ran from being overwritten.
  return await inbox.hydrate(claim, { ...snapshot, refresh: false })
}

export async function reconcileOneSnapshot(inbox: PullRequestInbox, read: ReadGitHubSnapshot, now: number = Date.now(), readThreads?: ReadThreads, activityAuthors: readonly string[] = []): Promise<void> {
  // No more than one PR per minute, and no PR more often than every 15 minutes.
  // The first probe is delayed because bootstrap/claims already hydrate state.
  const globalKey = 'snapshot-reconcile-next'
  const globalNext = await inbox.metaNumber(globalKey)
  if (globalNext === undefined) { await inbox.setMeta(globalKey, now + 15 * 60_000); return }
  if (globalNext > now) return
  await inbox.setMeta(globalKey, now + 60_000)
  const next = await inbox.nextProbe()
  if (!next || next.probedAt > now) return
  const s = await inbox.get(next.repository, next.number)
  if (!s) return
  await probeSnapshot(inbox, read, s, now, readThreads, activityAuthors)
}

/** Reads one PR over REST and ingests it as synthetic deliveries, so missed webhooks are recovered. */
async function probeSnapshot(inbox: PullRequestInbox, read: ReadGitHubSnapshot, s: Snapshot, now: number, readThreads?: ReadThreads, activityAuthors: readonly string[] = []): Promise<void> {
  await inbox.setMeta(`snapshot-probe:${s.repository}:${s.number}`, now + 15 * 60_000)
  const snapshot = await readSnapshot(read, s.repository, s.number, readThreads, activityAuthors)
  // Apply only if no webhook or claim arrived while this targeted probe ran.
  // New resolution evidence wakes a waiting PR without repeated full queries
  // in every agent pass.
  if (snapshot.threads) await inbox.refreshThreads(s, snapshot.threads)
  const ingest = async (event: string, payload: GitHubDelivery) => {
    const full = { repository: { full_name: s.repository }, ...payload }
    const id = `reconcile:${createHash('sha256').update(JSON.stringify([event, full])).digest('hex')}`
    await inbox.ingest(id, event, full)
  }
  await ingest('pull_request', { action: snapshot.pr.state === 'closed' ? 'closed' : 'synchronize', pull_request: snapshot.pr })
  if (snapshot.pr.state !== 'open') return
  for (const comment of Object.values(snapshot.comments ?? {})) await ingest('issue_comment', { action: 'edited', issue: { number: s.number, pull_request: {} }, comment })
  for (const review of Object.values(snapshot.reviews ?? {})) await ingest('pull_request_review', { action: 'submitted', pull_request: snapshot.pr, review })
  for (const comment of Object.values(snapshot.reviewComments ?? {})) await ingest('pull_request_review_comment', { action: 'edited', pull_request: snapshot.pr, comment })
  for (const check_run of Object.values(snapshot.checks ?? {})) await ingest('check_run', { action: check_run.status, check_run })
  for (const status of Object.values(snapshot.statuses ?? {}) ) await ingest('status', { ...status, sha: snapshot.pr.head?.sha })
}

const OPEN_PULL_REQUESTS = `query BabysitterOpenPullRequests($owner:String!,$name:String!,$after:String) {
  repository(owner:$owner,name:$name) { pullRequests(states:OPEN,first:50,after:$after) {
    nodes { number title isDraft headRefOid headRefName baseRefName baseRefOid mergeable updatedAt url authorAssociation totalCommentsCount
      author { login } headRepository { nameWithOwner } labels(first:100) { nodes { name } }
      commits(last:1) { nodes { commit { statusCheckRollup { state contexts(first:100) {
        nodes { __typename ... on CheckRun { databaseId status conclusion } ... on StatusContext { context state } }
        pageInfo { hasNextPage } } } } } }
      latestReviews(first:100) { nodes { id state } pageInfo { hasNextPage } }
      reviewThreads(first:100) { nodes { id isResolved comments { totalCount } } pageInfo { hasNextPage } } }
    pageInfo { hasNextPage endCursor } } }
}`
const nodes = v.object({ nodes: v.array(v.unknown()), pageInfo: v.optional(v.object({ hasNextPage: v.boolean() })) })
const openPullRequestSchema = v.object({
  number: v.pipe(v.number(), v.integer(), v.minValue(1)), title: v.nullish(v.string()), isDraft: v.boolean(),
  headRefOid: v.string(), headRefName: v.string(), baseRefName: v.string(), baseRefOid: v.nullish(v.string()),
  mergeable: v.nullish(v.string()), updatedAt: v.string(), url: v.string(), authorAssociation: v.nullish(v.string()), totalCommentsCount: v.nullish(v.number()),
  author: v.nullish(v.object({ login: v.string() })), headRepository: v.nullish(v.object({ nameWithOwner: v.string() })),
  labels: v.object({ nodes: v.array(v.object({ name: v.string() })) }),
  commits: v.object({ nodes: v.array(v.object({ commit: v.object({ statusCheckRollup: v.nullish(v.object({ state: v.nullish(v.string()), contexts: nodes })) }) })) }),
  latestReviews: nodes, reviewThreads: nodes,
})
const openPullRequestsSchema = v.object({ repository: v.object({ pullRequests: v.object({
  nodes: v.array(openPullRequestSchema), pageInfo: v.object({ hasNextPage: v.boolean(), endCursor: v.nullish(v.string()) }),
}) }) })
interface OpenPullRequestConnection { nodes: unknown[]; pageInfo?: { hasNextPage: boolean } }
/** One open PR from the change detection query. */
export interface OpenPullRequest {
  number: number; title?: string | null; isDraft: boolean; headRefOid: string; headRefName: string; baseRefName: string; baseRefOid?: string | null
  mergeable?: string | null; updatedAt: string; url: string; authorAssociation?: string | null; totalCommentsCount?: number | null
  author?: { login: string } | null; headRepository?: { nameWithOwner: string } | null; labels: { nodes: Array<{ name: string }> }
  commits: { nodes: Array<{ commit: { statusCheckRollup?: { state?: string | null; contexts: OpenPullRequestConnection } | null } }> }
  latestReviews: OpenPullRequestConnection; reviewThreads: OpenPullRequestConnection
}

/** Row order and an UNKNOWN mergeability are not changes; the base SHA is left to push deliveries. */
export function openPullRequestFingerprint(pr: OpenPullRequest): string {
  const rows = (connection: OpenPullRequestConnection | undefined) =>
    [...(connection?.nodes ?? []).map(node => JSON.stringify(node)).sort(), ...(connection?.pageInfo?.hasNextPage ? ['truncated'] : [])]
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup
  return createHash('sha256').update(JSON.stringify({
    head: pr.headRefOid, base: pr.baseRefName, draft: pr.isDraft, conflicting: pr.mergeable === 'CONFLICTING', title: pr.title,
    labels: pr.labels.nodes.map(label => label.name).sort(), comments: pr.totalCommentsCount, ci: rollup?.state ?? null,
    checks: rows(rollup?.contexts), reviews: rows(pr.latestReviews), threads: rows(pr.reviewThreads),
  })).digest('hex')
}

type PendingChange = { fingerprint: string; retryAt: number }
const pendingChangeSchema = v.object({ fingerprint: v.string(), retryAt: v.number() })
// Webhooks can wake the reconciler concurrently. Keep the expensive open-PR
// snapshot scan single-flight per inbox so each wake cannot reread every large
// snapshot row before the durable minute gate is observed.
const changeDetectionInFlight = new WeakSet<PullRequestInbox>()

/**
 * Reads every open PR of each repository in one GraphQL query per 50 PRs, at most once a minute.
 * Seeds new PRs and marks PRs whose fingerprint changed, or that closed, for a targeted REST probe.
 * This recovers lost webhook deliveries without probing unchanged PRs.
 */
export async function detectChangedPullRequests(inbox: PullRequestInbox, graphql: (repository: string) => ReadGraphql, repositories: readonly string[], now: number = Date.now(), allowSeed = true): Promise<void> {
  if (changeDetectionInFlight.has(inbox)) return
  changeDetectionInFlight.add(inbox)
  try {
  if (((await inbox.metaNumber('change-detect-next')) ?? 0) > now) return
  await inbox.setMeta('change-detect-next', now + 60_000)
  const tracked = await inbox.summary()
  for (const repository of repositories.map(r => r.toLowerCase())) {
    try {
    const [owner, name] = repository.split('/')
    if (!owner || !name) continue
    const open = new Map<number, OpenPullRequest>()
    const cursors = new Set<string>()
    let after: string | null = null
    do {
      const raw = await graphql(repository)(OPEN_PULL_REQUESTS, { owner, name, after })
      const response = v.parse(envelope, raw)
      if (response.errors?.length) throw new Error(`GitHub open pull request query failed: ${response.errors.map(error => error.message).join('; ')}`)
      const page = v.parse(openPullRequestsSchema, response.data ?? raw).repository.pullRequests
      for (const pr of page.nodes) open.set(pr.number, pr)
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? '' : null
      if (after !== null && (!after || cursors.has(after))) throw new Error('Invalid open pull request cursor')
      if (after) cursors.add(after)
    } while (after)
    // Mark changes only after every page succeeded, so a partial list never looks like closed PRs.
    const mark = async (number: number, fingerprint: string) => {
      const key = `snapshot-changed:${repository}:${number}`
      const pending = v.safeParse(pendingChangeSchema, await inbox.meta(key))
      if (await inbox.meta(`change-fingerprint:${repository}:${number}`) === fingerprint || pending.success && pending.output.fingerprint === fingerprint) return
      await inbox.setMeta(key, { fingerprint, retryAt: 0 } satisfies PendingChange)
    }
    for (const [number, pr] of open) {
      const fingerprint = openPullRequestFingerprint(pr)
      if (await inbox.get(repository, number)) { await mark(number, fingerprint); continue }
      if (!allowSeed) continue
      // A PR that no delivery reported yet. Seeding applies the filter; the claim hydrates it over REST.
      await inbox.seed(repository, { number, title: pr.title, state: 'open', draft: pr.isDraft, user: pr.author ? { login: pr.author.login } : null,
        author_association: pr.authorAssociation, html_url: pr.url, updated_at: pr.updatedAt, labels: pr.labels.nodes.map(label => label.name),
        head: { sha: pr.headRefOid, ref: pr.headRefName, repo: pr.headRepository ? { full_name: pr.headRepository.nameWithOwner } : null },
        base: { sha: pr.baseRefOid ?? undefined, ref: pr.baseRefName } })
      await inbox.setMeta(`change-fingerprint:${repository}:${number}`, fingerprint)
    }
    // An inbox PR missing from the open list closed or merged.
    for (const item of tracked) if (item.repository === repository && item.status !== 'terminal' && !open.has(item.number)) await mark(item.number, 'closed')
    } catch {
      // A repository failure must not prevent detection for later repositories.
      // The next interval retries this repository; partial pages are never marked.
      continue
    }
  }

  } finally {
    changeDetectionInFlight.delete(inbox)
  }
}

/** Probes up to `limit` PRs that change detection marked, then records their fingerprints. */
export async function probeChangedSnapshots(inbox: PullRequestInbox, read: ReadGitHubSnapshot, now: number = Date.now(), readThreads?: ReadThreads, activityAuthors: readonly string[] = [], limit = 3): Promise<number> {
  let probed = 0
  for (const [key, value] of await inbox.metaEntries('snapshot-changed:')) {
    if (probed >= limit) break
    const pending = v.safeParse(pendingChangeSchema, value)
    const [, repository, number] = /^snapshot-changed:(.+):(\d+)$/.exec(key) ?? []
    if (!pending.success || !repository || !number) { await inbox.deleteMeta(key); continue }
    if (pending.output.retryAt > now) continue
    const s = await inbox.get(repository, Number(number))
    if (!s) { await inbox.deleteMeta(key); continue }
    // A failed probe retries later, not on every reconcile tick.
    await inbox.setMeta(key, { ...pending.output, retryAt: now + 2 * 60_000 } satisfies PendingChange)
    probed++
    await probeSnapshot(inbox, read, s, now, readThreads, activityAuthors)
    await inbox.setMeta(`change-fingerprint:${repository}:${number}`, pending.output.fingerprint)
    await inbox.deleteMeta(key)
  }
  return probed
}
