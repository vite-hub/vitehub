import * as v from 'valibot'
import { parseEvidence, parsePullRequest, parseThread, type GitHubReviewThread, type GitHubEvidence, type GitHubDelivery, type GitHubPullRequestRecord } from './types.ts'
import { createHash } from 'node:crypto'
import { isFeedback, type Claim, type PullRequestInbox } from './store.ts'

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
export async function readSnapshot(read: ReadGitHubSnapshot, repository: string, number: number, readThreads?: ReadThreads): Promise<import('./store.ts').SnapshotPatch & { pr: GitHubPullRequestRecord }> {
  const prefix = `repos/${repository}`
  const [raw] = await read(`${prefix}/pulls/${number}`, '.')
  const pr = parsePullRequest(raw)
  if (!pr.head?.sha) throw new Error('GitHub returned no pull request head.')
  if (pr.state !== 'open') return { pr }
  const [comments, reviews, reviewComments, checks, statuses, threads] = await Promise.all([
    read(`${prefix}/issues/${number}/comments?per_page=100`),
    read(`${prefix}/pulls/${number}/reviews?per_page=100`),
    read(`${prefix}/pulls/${number}/comments?per_page=100`),
    read(`${prefix}/commits/${pr.head.sha}/check-runs?per_page=100`, '.check_runs[]'),
    read(`${prefix}/commits/${pr.head.sha}/statuses?per_page=100`),
    readThreads?.(repository, number),
  ])
  return { pr, comments: index(comments.map(parseEvidence).filter(isFeedback)), reviews: index(reviews.map(parseEvidence)),
    reviewComments: index(reviewComments.map(parseEvidence)),
    checks: Object.fromEntries(checks.map(parseEvidence).map(c => [`check_run:${c.id}`, c])),
    statuses: Object.fromEntries(statuses.map(parseEvidence).reverse().map(s => [s.context, s])), hydrated: true,
    ...(threads ? { threads, threadsHydrated: true, feedbackRefresh: false } : {}) }
}

export async function hydrateSnapshot(inbox: PullRequestInbox, claim: Claim, read: ReadGitHubSnapshot, readThreads?: ReadThreads): Promise<boolean> {
  const { snapshot: current } = claim
  if (current.hydrated && !current.refresh) {
    if (!readThreads || current.threadsHydrated && !current.feedbackRefresh) return true
    const threads = await readThreads(current.repository, current.number)
    return inbox.hydrate(claim, { threads, threadsHydrated: true, feedbackRefresh: false })
  }
  const snapshot = await readSnapshot(read, current.repository, current.number, readThreads)
  // CAS keeps an event received while REST requests ran from being overwritten.
  return inbox.hydrate(claim, { ...snapshot, refresh: false })
}

export async function reconcileOneSnapshot(inbox: PullRequestInbox, read: ReadGitHubSnapshot, now: number = Date.now(), readThreads?: ReadThreads): Promise<void> {
  // No more than one PR per minute, and no PR more often than every 15 minutes.
  // The first probe is delayed because bootstrap/claims already hydrate state.
  const globalKey = 'snapshot-reconcile-next'
  const globalNext = inbox.meta<number>(globalKey)
  if (globalNext === undefined) { inbox.setMeta(globalKey, now + 15 * 60_000); return }
  if (globalNext > now) return
  inbox.setMeta(globalKey, now + 60_000)
  const candidates = inbox.all().filter(s => !s.lease && s.status !== 'terminal')
    .sort((a, b) => (inbox.meta<number>(`snapshot-probe:${a.repository}:${a.number}`) ?? 0) - (inbox.meta<number>(`snapshot-probe:${b.repository}:${b.number}`) ?? 0))
  const s = candidates.find(s => (inbox.meta<number>(`snapshot-probe:${s.repository}:${s.number}`) ?? 0) <= now)
  if (!s) return
  inbox.setMeta(`snapshot-probe:${s.repository}:${s.number}`, now + 15 * 60_000)
  const snapshot = await readSnapshot(read, s.repository, s.number, readThreads)
  // Apply only if no webhook or claim arrived while this targeted probe ran.
  // New resolution evidence wakes a waiting PR without repeated full queries
  // in every agent pass.
  if (snapshot.threads) inbox.refreshThreads(s, snapshot.threads)
  const ingest = (event: string, payload: GitHubDelivery) => {
    const full = { repository: { full_name: s.repository }, ...payload }
    const id = `reconcile:${createHash('sha256').update(JSON.stringify([event, full])).digest('hex')}`
    inbox.ingest(id, event, full)
  }
  ingest('pull_request', { action: snapshot.pr.state === 'closed' ? 'closed' : 'synchronize', pull_request: snapshot.pr })
  if (snapshot.pr.state !== 'open') return
  for (const comment of Object.values(snapshot.comments ?? {})) ingest('issue_comment', { action: 'edited', issue: { number: s.number, pull_request: {} }, comment })
  for (const review of Object.values(snapshot.reviews ?? {})) ingest('pull_request_review', { action: 'submitted', pull_request: snapshot.pr, review })
  for (const comment of Object.values(snapshot.reviewComments ?? {})) ingest('pull_request_review_comment', { action: 'edited', pull_request: snapshot.pr, comment })
  for (const check_run of Object.values(snapshot.checks ?? {})) ingest('check_run', { action: check_run.status, check_run })
  for (const status of Object.values(snapshot.statuses ?? {}) ) ingest('status', { ...status, sha: snapshot.pr.head?.sha })
}
