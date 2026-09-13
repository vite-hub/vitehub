import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { GitHubPullRequestFilter, GitHubPullRequestFilterContext } from '../../channels.ts'
import { matchesGitHubPullRequestFilter } from '../../internal/github-pull-request-filter.ts'
import { parsePullRequest, parseDelivery, type GitHubEvidence, type GitHubReviewThread, type GitHubPullRequestRecord } from './types.ts'

export type Snapshot = {
  repository: string; number: number; pr: GitHubPullRequestRecord | null
  generation: number; handled: number; dirtyAt: number; nextAt: number; revision?: number
  status: 'ready' | 'working' | 'waiting' | 'terminal'
  lease: string | null; leaseUntil: number; attempts: number
  hydrated: boolean; refresh: boolean; feedbackRefresh: boolean
  comments: Record<string, GitHubEvidence>; reviews: Record<string, GitHubEvidence>
  reviewComments: Record<string, GitHubEvidence>; checks: Record<string, GitHubEvidence>; statuses: Record<string, GitHubEvidence>
  threads: GitHubReviewThread[]; threadsHydrated?: boolean; reasons: string[]; lastResult?: string
}
export type SnapshotPatch = Partial<Pick<Snapshot, 'pr' | 'comments' | 'reviews' | 'reviewComments' | 'checks' | 'statuses' | 'threads' | 'hydrated' | 'refresh' | 'feedbackRefresh' | 'threadsHydrated'>>
export interface GitHubInboxDeliveryResult { accepted: true; duplicate?: boolean; queued: number[]; updated: number[]; ignored?: boolean; reason?: string }
export interface GitHubInboxSummary {
  repository: string; number: number; head?: string; generation: number; handled: number; status: Snapshot['status']; reasons: string[]
  dirty: boolean; attempts: number; nextAt: number; lastResult?: string
}
export type Claim = { token: string; generation: number; snapshot: Snapshot }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stamp = (value: GitHubEvidence) => Date.parse(value.updated_at ?? value.updatedAt ?? value.submitted_at ?? value.completed_at ?? value.started_at ?? value.created_at ?? '') || 0
/** Normalize REST and discovery records once, before they enter the inbox. */
export const normalizePullRequest: typeof parsePullRequest = parsePullRequest

/** Activity comments have a transport marker; all other humans and bots are feedback. */
export const isFeedback = (item: GitHubEvidence | undefined): boolean => Boolean(item && !String(item.body ?? '').startsWith('<!-- vitehub-agent-activity:'))

export interface PullRequestInboxOptions {
  path: string
  repositories: readonly string[]
  filter?: GitHubPullRequestFilter
  clock?: () => number
}

export function pullRequestFilterContext(repository: string, pr: GitHubPullRequestRecord | null): GitHubPullRequestFilterContext {
  const headRepository = pr?.head?.repo?.full_name
  return { repository, author: pr?.user?.login, authorAssociation: pr?.author_association,
    labels: pr?.labels?.map(label => typeof label === 'string' ? label : label.name),
    draft: pr?.draft, fork: headRepository ? headRepository.toLowerCase() !== repository.toLowerCase() : undefined,
    base: pr?.base?.ref, head: pr?.head?.ref, title: pr?.title }
}

export class PullRequestInbox {
  private db: DatabaseSync
  private repositories: string[]
  private clock: () => number
  private filter?: GitHubPullRequestFilter
  constructor({ path, repositories, filter, clock = Date.now }: PullRequestInboxOptions) {
    this.repositories = repositories.map(repository => repository.toLowerCase())
    this.clock = clock
    this.filter = filter
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS pr_snapshots (repository TEXT, number INTEGER, value TEXT NOT NULL, PRIMARY KEY(repository,number));
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, event TEXT, received INTEGER, payload TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS inbox_meta (key TEXT PRIMARY KEY, value TEXT);`)
  }
  close(): void { this.db.close() }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  get(repository: string, number: number): Snapshot | undefined {
    const row = this.db.prepare('SELECT value FROM pr_snapshots WHERE repository=? AND number=?').get(repository, number)
    return row ? JSON.parse(row.value as string) as Snapshot : undefined
  }
  all(): Snapshot[] {
    return this.db.prepare('SELECT value FROM pr_snapshots').all().map(row => JSON.parse(row.value as string) as Snapshot)
      .filter(s => this.repositories.includes(s.repository))
  }
  private put(s: Snapshot) {
    this.db.prepare('INSERT OR REPLACE INTO pr_snapshots VALUES (?,?,?)').run(s.repository, s.number, JSON.stringify(s))
  }
  private empty(repository: string, number: number): Snapshot {
    return { repository, number, pr: null, generation: 0, handled: 0, dirtyAt: this.clock(), nextAt: 0,
      status: 'ready', lease: null, leaseUntil: 0, attempts: 0, hydrated: false, refresh: true, feedbackRefresh: true,
      comments: {}, reviews: {}, reviewComments: {}, checks: {}, statuses: {}, threads: [], reasons: [] }
  }
  meta<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM inbox_meta WHERE key=?').get(key)
    return row ? JSON.parse(row.value as string) : undefined
  }
  setMeta(key: string, value: unknown): void { this.db.prepare('INSERT OR REPLACE INTO inbox_meta VALUES (?,?)').run(key, JSON.stringify(value)) }
  private dirty(s: Snapshot, reason: string) {
    if (s.generation === s.handled) s.dirtyAt = this.clock()
    s.generation++; s.nextAt = 0; s.attempts = 0
    s.revision = (s.revision ?? 0) + 1
    if (!s.lease) s.status = 'ready'
    s.reasons = [...new Set([...s.reasons, reason])]
  }
  private updatePr(s: Snapshot, pr: GitHubPullRequestRecord) {
    pr = normalizePullRequest(pr)
    if (s.pr && stamp(pr) < stamp(s.pr)) return false
    const previous = s.pr
    const changed = !previous || (['state','draft','title','body','mergeable','mergeable_state'] as const).some(k => pr[k] !== undefined && pr[k] !== previous[k])
      || digest(pullRequestFilterContext(s.repository, pr)) !== digest(pullRequestFilterContext(s.repository, previous))
      || pr.head?.sha !== previous.head?.sha || pr.base?.sha !== previous.base?.sha || pr.base?.ref !== previous.base?.ref
    // Retain freshness even when only timestamps changed, so a delayed
    // delivery cannot subsequently regress the current head or closed state.
    if (!changed) { s.pr = { ...previous, ...pr }; return false }
    const newHead = previous?.head?.sha !== pr.head?.sha
    s.pr = { ...previous, ...pr }
    if (newHead) {
      s.checks = Object.fromEntries(Object.entries(s.checks).filter(([, check]) => check.head_sha === pr.head?.sha))
      s.statuses = Object.fromEntries(Object.entries(s.statuses).filter(([, status]) => status.sha === pr.head?.sha))
      s.hydrated = false; s.feedbackRefresh = true
    }
    s.refresh = false
    if (pr.state === 'closed') s.status = 'terminal'
    else if (s.status === 'terminal') s.status = s.lease ? 'working' : 'ready'
    return true
  }
  eligible(repository: string, pr: GitHubPullRequestRecord | null): boolean {
    return Boolean(pr && pr.state === 'open' && matchesGitHubPullRequestFilter(pullRequestFilterContext(repository, pr), this.filter, 'pull-request'))
  }
  seed(repository: string, value: unknown): Snapshot {
    repository = repository.toLowerCase()
    if (!this.repositories.includes(repository)) throw new Error('Repository is not configured for this inbox.')
    const pr = normalizePullRequest(value)
    return this.transaction(() => {
      const s = this.get(repository, pr.number) ?? this.empty(repository, pr.number)
      if (this.updatePr(s, pr)) this.dirty(s, 'bootstrap')
      if (!this.eligible(repository, s.pr)) { s.status = 'terminal'; s.handled = s.generation }
      else if (s.status === 'terminal') {
        s.status = 'ready'
        if (s.generation <= s.handled) this.dirty(s, 'bootstrap-recovery')
      }
      this.put(s); return s
    })
  }
  ingest(id: string, event: string, value: unknown): GitHubInboxDeliveryResult {
    const payload = parseDelivery(value)
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM deliveries WHERE id=?').get(id)) return { accepted: true, duplicate: true, queued: [] as number[], updated: [] as number[] }
      const repository = String(payload.repository?.full_name ?? '').toLowerCase()
      const queued: number[] = []
      const updated: number[] = []
      const finish = (reason?: string): GitHubInboxDeliveryResult => {
        const result: GitHubInboxDeliveryResult = { accepted: true, queued, updated, ...(reason ? { ignored: true, reason } : {}) }
        this.db.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?)').run(id, event, this.clock(), JSON.stringify(payload), JSON.stringify(result))
        return result
      }
      if (!this.repositories.includes(repository)) return finish('repository not configured')
      // Activity suppression applies to issue comments only. Actual reviews
      // and inline review comments are evidence regardless of reviewer name.
      if (event === 'issue_comment' && !isFeedback(payload.comment)) return finish('irrelevant comment')
      if (event === 'issue_comment' && !payload.issue?.pull_request) return finish('issue is not a PR')
      const supported = ['pull_request','issue_comment','pull_request_review','pull_request_review_comment','pull_request_review_thread','check_run','check_suite','workflow_run','status','push']
      if (!supported.includes(event)) return finish('irrelevant event')
      if (event === 'pull_request' && !['opened','synchronize','reopened','closed','edited','ready_for_review','converted_to_draft','labeled','unlabeled','enqueued','dequeued'].includes(payload.action ?? '')) return finish('irrelevant PR action')
      if (event === 'pull_request_review_thread' && (!['resolved', 'unresolved'].includes(payload.action ?? '') || !payload.thread?.node_id)) return finish('irrelevant review thread action')
      const check = payload.check_run ?? payload.check_suite ?? payload.workflow_run
      const sha = check?.head_sha ?? payload.sha
      const numbers = new Set<number>()
      const direct = payload.pull_request?.number ?? (payload.issue?.pull_request ? payload.issue.number : undefined)
      if (direct) numbers.add(direct)
      for (const pr of check?.pull_requests ?? []) if (pr.number) numbers.add(pr.number)
      for (const s of this.all()) if (s.repository === repository && s.pr?.state === 'open') {
        if (sha && s.pr.head?.sha === sha) numbers.add(s.number)
        if (event === 'push' && payload.ref === `refs/heads/${s.pr.base?.ref}`) numbers.add(s.number)
      }
      for (const number of numbers) {
        const existing = this.get(repository, number)
        const s = existing ?? this.empty(repository, number)
        // Event filters govern admission only. Lifecycle evidence must still
        // invalidate active work when the author, labels, head, or state changes.
        if (!existing && !matchesGitHubPullRequestFilter({ ...pullRequestFilterContext(repository, payload.pull_request ?? null), actor: payload.sender?.login ?? payload.comment?.user?.login, action: payload.action }, { actor: this.filter?.actor, action: this.filter?.action }, 'event')) continue
        if (sha && s.pr?.head?.sha && s.pr.head.sha !== sha) continue // old-head CI cannot wake current head
        let changed = false
        if (event === 'pull_request' && payload.pull_request) changed = this.updatePr(s, payload.pull_request)
        if (!s.pr && payload.pull_request) changed = this.updatePr(s, payload.pull_request) || changed
        const upsert = (map: Record<string, GitHubEvidence>, value: GitHubEvidence | undefined, itemKey?: string) => {
          if (!value) return
          const key = itemKey ?? String(value.id)
          const old = map[key]
          if (old && stamp(value) < stamp(old)) return
          // Timestamp-only activity does not become another repair task.
          const semantic = (v: GitHubEvidence) => Object.fromEntries(Object.entries(v).filter(([k]) => !['updated_at','url','html_url'].includes(k)))
          const next = payload.action === 'deleted' ? { id: value.id, deleted: true, updated_at: value.updated_at } : value
          if (old && digest(semantic(old)) === digest(semantic(next))) { map[key] = next; return }
          map[key] = next
          changed = true
        }
        if (event === 'issue_comment') upsert(s.comments, payload.comment)
        if (event === 'pull_request_review_comment') { upsert(s.reviewComments, payload.comment); if (changed) s.feedbackRefresh = true }
        if (event === 'pull_request_review') { upsert(s.reviews, payload.review); if (changed) s.feedbackRefresh = true }
        if (event === 'pull_request_review_thread' && payload.thread) {
          const id = String(payload.thread.node_id)
          const position = s.threads.findIndex(thread => String(thread.node_id ?? thread.id) === id)
          const previous = position < 0 ? undefined : s.threads[position]
          const incomingComments: GitHubEvidence[] = Array.isArray(payload.thread.comments) ? payload.thread.comments : []
          const previousComments: GitHubEvidence[] = Array.isArray(previous?.comments) ? previous.comments : previous?.comments?.nodes ?? []
          const comments = new Map(previousComments.map(comment => [String(comment.node_id ?? comment.id), comment]))
          for (const comment of incomingComments) {
            const key = String(comment.node_id ?? comment.id)
            const old = comments.get(key)
            if (!old || stamp(comment) >= stamp(old)) comments.set(key, comment)
            upsert(s.reviewComments, comment)
          }
          const isResolved = payload.action === 'resolved'
          if (!previous || previous.isResolved !== isResolved || digest(previousComments) !== digest([...comments.values()])) {
            const thread = { ...previous, id, node_id: id, isResolved,
              resolutionSource: 'webhook', resolutionObservedAt: new Date(this.clock()).toISOString(), comments: [...comments.values()] }
            if (position < 0) s.threads.push(thread)
            else s.threads[position] = thread
            changed = true
            // GitHub's thread payload has no ordering timestamp. A delayed
            // opposite transition can arrive last, so verify resolution with
            // one targeted thread read when this generation is claimed.
            s.feedbackRefresh = true
          }
          // REST review comments do not carry thread resolution. Only this
          // explicit event (or a targeted thread query) supplies that evidence.
          // Comments with no matching thread stay resolution-unknown.
        }
        if (check) upsert(s.checks, check, `${event}:${check.id}`)
        if (event === 'status') upsert(s.statuses, payload, payload.context)
        if (event === 'push') { s.refresh = true; s.feedbackRefresh = true; changed = true }
        // Pending CI is evidence to retain, not another repair task. Terminal
        // results still wake the PR; revision invalidates in-flight hydration
        // even when this update does not need a new agent generation.
        const pendingCi = check && check.status !== 'completed' && !check.conclusion
          && ['queued', 'in_progress', 'pending', 'waiting', 'requested', 'rerequested', 'created'].includes(check.status ?? payload.action ?? '')
          || event === 'status' && payload.state === 'pending'
        const wake = (changed || !s.pr) && !pendingCi
        if (wake) this.dirty(s, `${event}:${payload.action ?? check?.conclusion ?? payload.state ?? 'updated'}`)
        else if (changed) s.revision = (s.revision ?? 0) + 1
        if (s.pr && !this.eligible(repository, s.pr)) { s.status = 'terminal'; s.handled = s.generation }
        this.put(s)
        if (changed || !s.pr) updated.push(number)
        if (wake && s.status !== 'terminal') queued.push(number)
      }
      return finish(numbers.size ? undefined : 'no matching PR head')
    })
  }
  claim(limit: number): Claim[] {
    return this.transaction(() => {
      const now = this.clock(), all = this.all(), claims: Claim[] = []
      for (const s of all.sort((a,b) => a.dirtyAt - b.dirtyAt || a.number - b.number)) {
        if (claims.length >= limit) break
        if (s.lease && s.leaseUntil > now || s.status === 'terminal' || s.generation <= s.handled || s.nextAt > now) continue
        if (s.pr && !this.eligible(s.repository, s.pr)) continue
        // Stack children remain local; a parent merge's base push wakes them.
        if (s.pr?.base?.ref && all.some(parent => parent.repository === s.repository && parent.number !== s.number && String(parent.pr?.state).toLowerCase() === 'open' && parent.pr?.head?.ref === s.pr?.base?.ref)) continue
        s.lease = randomUUID(); s.leaseUntil = now + 2 * 60 * 60_000; s.status = 'working'
        this.put(s); claims.push({ token: s.lease, generation: s.generation, snapshot: structuredClone(s) })
      }
      return claims
    })
  }
  hydrate(claim: Claim, patch: SnapshotPatch): boolean {
    return this.transaction(() => {
      const s = this.get(claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token || s.generation !== claim.generation || (s.revision ?? 0) !== (claim.snapshot.revision ?? 0)) return false
      if (patch.pr) patch = { ...patch, pr: normalizePullRequest(patch.pr) }
      Object.assign(s, patch)
      if (s.pr && !this.eligible(s.repository, s.pr)) s.status = 'terminal'
      this.put(s); Object.assign(claim.snapshot, patch, { status: s.status }); return true
    })
  }
  refreshThreads(observed: Snapshot, threads: GitHubReviewThread[]): boolean {
    return this.transaction(() => {
      const s = this.get(observed.repository, observed.number)
      if (!s || s.lease || s.generation !== observed.generation || (s.revision ?? 0) !== (observed.revision ?? 0)) return false
      const semantic = (items: GitHubReviewThread[]) => items.map(thread => ({
        id: thread.node_id ?? thread.id, isResolved: thread.isResolved, isOutdated: thread.isOutdated,
        comments: (Array.isArray(thread.comments) ? thread.comments : thread.comments?.nodes ?? []).map((comment: GitHubEvidence) => String(comment.node_id ?? comment.id)).sort(),
      })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
      const changed = digest(semantic(s.threads)) !== digest(semantic(threads))
      s.threads = threads; s.threadsHydrated = true; s.feedbackRefresh = false
      if (changed && s.status !== 'terminal') this.dirty(s, 'review-threads:reconciled')
      this.put(s); return true
    })
  }
  release(claim: Claim): boolean {
    return this.transaction(() => {
      const s = this.get(claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token) return false
      s.lease = null; s.leaseUntil = 0
      if (s.status !== 'terminal') s.status = 'ready'
      this.put(s); return true
    })
  }
  finish(claim: Claim, result: { text: string; retry?: boolean; terminal?: boolean }): boolean {
    return this.transaction(() => {
      const s = this.get(claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token) return false
      s.lease = null; s.leaseUntil = 0; s.lastResult = result.text
      if (s.status === 'terminal' || result.terminal && s.generation === claim.generation) { s.status = 'terminal'; s.handled = s.generation }
      else if (s.generation !== claim.generation) { s.status = 'ready'; s.handled = Math.max(s.handled, claim.generation); s.nextAt = 0 }
      else if (result.retry) {
        s.attempts++
        // Escalate the delay, not a permanent dead end. A new event resets
        // this retry delay and still preempts the unchanged generation.
        s.status = 'ready'; s.nextAt = this.clock() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(s.attempts, 5))
      }
      else { s.status = 'waiting'; s.handled = s.generation; s.reasons = [] }
      this.put(s); return true
    })
  }
  recoverLeases(): void {
    // Only expired leases are recoverable, including when other processes share the database.
    this.transaction(() => {
      for (const s of this.all()) {
        if (!s.lease || s.leaseUntil > this.clock()) continue
        s.lease = null; s.leaseUntil = 0
        if (s.status !== 'terminal') s.status = 'ready'
        this.put(s)
      }
    })
  }
  summary(): GitHubInboxSummary[] {
    return this.all().map(s => ({ repository: s.repository, number: s.number, head: s.pr?.head?.sha,
      generation: s.generation, handled: s.handled, status: s.status, reasons: s.reasons,
      dirty: s.generation > s.handled, attempts: s.attempts, nextAt: s.nextAt, lastResult: s.lastResult }))
  }
}
