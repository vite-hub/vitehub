import { parseProviderBudget, parseProgressBudget, validateBudgets, requireEvidence, type InboxBudgets, type ProgressBudget, type ProgressOutcome, type ProviderBudget, type ProviderAttempt, type ProviderAttemptOutcome } from './budgets.ts'

import { parseWait, type PullRequestWait } from './wait-state.ts'
import { createHash, randomUUID } from 'node:crypto'
import * as v from 'valibot'
import { isRuntimeNumber, isRuntimeString } from '../../internal/runtime-value.ts'
import { createNodeSqliteInboxStorage, type PullRequestInboxExecutor, type PullRequestInboxRow, type PullRequestInboxStorage } from './storage.ts'

import type { GitHubPullRequestFilter, GitHubPullRequestFilterContext } from '../../channels.ts'
import { matchesGitHubPullRequestFilter } from '../../internal/github-pull-request-filter.ts'
import { parsePullRequest, parseEvidence, parseThread, parseDelivery, type GitHubEvidence, type GitHubReviewThread, type GitHubPullRequestRecord } from './types.ts'

export type Snapshot = {
  repository: string; number: number; pr: GitHubPullRequestRecord | null
  generation: number; handled: number; dirtyAt: number; nextAt: number; revision?: number
  status: 'ready' | 'working' | 'waiting' | 'terminal'
  wait?: PullRequestWait
  lease: string | null; leaseUntil: number; attempts: number
  progressBudget?: ProgressBudget
  hydrated: boolean; refresh: boolean; feedbackRefresh: boolean
  comments: Record<string, GitHubEvidence>; reviews: Record<string, GitHubEvidence>
  reviewComments: Record<string, GitHubEvidence>; checks: Record<string, GitHubEvidence>; statuses: Record<string, GitHubEvidence>
  threads: GitHubReviewThread[]; threadsHydrated?: boolean; reasons: string[]; lastResult?: string
  /** Persisted before a host-side merge so a crash after GitHub succeeds can recover safely. */
  mergeIntent?: { head: string; text: string }
}
export type SnapshotPatch = Partial<Pick<Snapshot, 'pr' | 'comments' | 'reviews' | 'reviewComments' | 'checks' | 'statuses' | 'threads' | 'hydrated' | 'refresh' | 'feedbackRefresh' | 'threadsHydrated'>>
export interface GitHubInboxDeliveryResult { accepted: true; duplicate?: boolean; queued: number[]; updated: number[]; ignored?: boolean; reason?: string }
export interface GitHubInboxSummary {
  repository: string; number: number; head?: string; generation: number; handled: number; status: Snapshot['status']; reasons: string[]
  wait?: PullRequestWait
  dirty: boolean; attempts: number; nextAt: number; lastResult?: string; progressBudget?: ProgressBudget
}
export type Claim = { token: string; generation: number; snapshot: Snapshot }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stamp = (value: GitHubEvidence) => Date.parse(value.updated_at ?? value.updatedAt ?? value.submitted_at ?? value.completed_at ?? value.started_at ?? value.created_at ?? '') || 0
class DeliveryValidationError extends Error {}
/** Normalize REST and discovery records once, before they enter the inbox. */
export const normalizePullRequest: typeof parsePullRequest = parsePullRequest

/** Evidence is feedback by default; callers suppress transport comments only after authenticating their author. */
export const isFeedback = (item: GitHubEvidence | undefined): boolean => Boolean(item)

function parseSnapshot(value: unknown): Snapshot {
  if (value === null || Object.prototype.toString.call(value) !== '[object Object]') throw new TypeError('Invalid inbox snapshot')
  // SAFETY: JSON.parse returns an object here; validation below checks every owned field.
  const input = value as Record<string, unknown>
  // SAFETY: Number.isInteger above guarantees this unknown value is a finite integer for the range check.
  const number = input.number as number
  const required = ['repository', 'number', 'generation', 'handled', 'dirtyAt', 'nextAt', 'status', 'lease', 'leaseUntil', 'attempts', 'hydrated', 'refresh', 'feedbackRefresh', 'comments', 'reviews', 'reviewComments', 'checks', 'statuses', 'threads', 'reasons']
  if (Object.prototype.toString.call(input.repository) !== '[object String]' || !Number.isInteger(input.number) || number < 1 ||
    required.some(key => !(key in input)) || !['ready', 'working', 'waiting', 'terminal'].some(status => status === input.status) ||
    (input.lease !== null && Object.prototype.toString.call(input.lease) !== '[object String]') ||
    ![input.generation, input.handled, input.dirtyAt, input.nextAt, input.leaseUntil, input.attempts].every(n => Number.isFinite(n)) ||
    ![input.hydrated, input.refresh, input.feedbackRefresh].every(value => value === true || value === false) ||
    !Array.isArray(input.threads) || !Array.isArray(input.reasons) || input.reasons.some(reason => Object.prototype.toString.call(reason) !== '[object String]') ||
    ('revision' in input && !Number.isFinite(input.revision)) ||
    ('threadsHydrated' in input && input.threadsHydrated !== true && input.threadsHydrated !== false) ||
    ('lastResult' in input && Object.prototype.toString.call(input.lastResult) !== '[object String]') ||
    ('mergeIntent' in input && (input.mergeIntent === null || Object.prototype.toString.call(input.mergeIntent) !== '[object Object]'
      // SAFETY: the preceding tag check establishes a non-null record.
      || Object.prototype.toString.call((input.mergeIntent as Record<string, unknown>).head) !== '[object String]'
      // SAFETY: the preceding tag check establishes a non-null record.
      || Object.prototype.toString.call((input.mergeIntent as Record<string, unknown>).text) !== '[object String]'))) {
    throw new TypeError('Invalid inbox snapshot')
  }
  if (input.wait !== undefined) parseWait(input.wait)
  if (input.progressBudget !== undefined) parseProgressBudget(input.progressBudget)
  const parseMap = (map: unknown): Record<string, GitHubEvidence> => {
    if (!map || Object.prototype.toString.call(map) !== '[object Object]') throw new TypeError('Invalid inbox snapshot')
    return Object.fromEntries(Object.entries(map).map(([key, evidence]) => [key, parseEvidence(evidence)]))
  }
  // SAFETY: All snapshot fields and nested values are validated immediately above.
  return { ...input, pr: input.pr === null ? null : parsePullRequest(input.pr), comments: parseMap(input.comments), reviews: parseMap(input.reviews),
    reviewComments: parseMap(input.reviewComments), checks: parseMap(input.checks), statuses: parseMap(input.statuses),
    threads: input.threads.map(parseThread) } as Snapshot
}

export interface PullRequestInboxOptions {
  /** A private `node:sqlite` file. Use `storage` instead to keep the inbox in the Agent State database. */
  path?: string
  /** SQL storage, for example `agentState.extension("babysitter")`. */
  storage?: PullRequestInboxStorage
  /** Separates inboxes that share one storage, for example one per Agent. */
  scope?: string
  repositories: readonly string[]
  filter?: GitHubPullRequestFilter
  clock?: () => number
  activityAuthors?: readonly string[]
  budgets?: InboxBudgets
}

export function pullRequestFilterContext(repository: string, pr: GitHubPullRequestRecord | null): GitHubPullRequestFilterContext {
  const headRepository = pr?.head?.repo?.full_name
  return { repository, author: pr?.user?.login, authorAssociation: pr?.author_association,
    labels: pr?.labels?.map(label => typeof label === 'string' ? label : label.name),
    draft: pr?.draft, fork: headRepository ? headRepository.toLowerCase() !== repository.toLowerCase() : undefined,
    base: pr?.base?.ref, head: pr?.head?.ref, title: pr?.title }
}

const stringValue = (value: unknown): string => isRuntimeString(value) ? value : String(value)
const legacyRecordSchema = v.record(v.string(), v.unknown())
const legacyWaitSchema = v.object({ headSha: v.pipe(v.string(), v.minLength(1)), contextKey: v.pipe(v.string(), v.minLength(1)) })
const summarySchema = v.object({
  repository: v.string(), number: v.number(), head: v.optional(v.string()), generation: v.number(), handled: v.number(),
  status: v.picklist(['ready', 'working', 'waiting', 'terminal']), reasons: v.array(v.string()), wait: v.optional(v.unknown()),
  dirty: v.boolean(), attempts: v.number(), nextAt: v.number(), lastResult: v.optional(v.string()), progressBudget: v.optional(v.unknown()),
})
function parseSummary(value: unknown): GitHubInboxSummary {
  const { wait, progressBudget, ...summary } = v.parse(summarySchema, value)
  const parsed: GitHubInboxSummary = summary
  if (wait !== undefined) parsed.wait = parseWait(wait)
  if (progressBudget !== undefined) parsed.progressBudget = parseProgressBudget(progressBudget)
  return parsed
}

/**
 * Converts a snapshot from an older inbox file. Older hosts used an `attention` status and a
 * `waitForChecks` record; both map to the current states. Invalid records are skipped.
 */
function legacySnapshot(raw: unknown): Snapshot | undefined {
  const record = v.safeParse(legacyRecordSchema, raw)
  if (!record.success) return undefined
  const value = { ...record.output }
  const legacyWait = v.safeParse(legacyWaitSchema, value.waitForChecks)
  if (!value.wait && legacyWait.success) {
    value.wait = { headSha: legacyWait.output.headSha, reason: 'checks', evidenceKey: legacyWait.output.contextKey }
  }
  if (value.status === 'attention' || value.status === 'working') value.status = value.wait ? 'waiting' : 'ready'
  value.lease = null
  value.leaseUntil = 0
  if (isRuntimeString(value.repository)) value.repository = value.repository.toLowerCase()
  try { return parseSnapshot(value) }
  catch { return undefined }
}

function summaryOf(s: Snapshot): GitHubInboxSummary {
  return { repository: s.repository, number: s.number, head: s.pr?.head?.sha,
    generation: s.generation, handled: s.handled, status: s.status, reasons: s.reasons,
    wait: s.wait, dirty: s.generation > s.handled, attempts: s.attempts, nextAt: s.nextAt, lastResult: s.lastResult, progressBudget: s.progressBudget }
}

/**
 * Durable PR inbox. Every method reads and writes storage, so all of them are asynchronous.
 * Snapshot JSON stays the source of truth. Claim, recovery, head matching, and summaries use
 * indexed columns derived from it on every write, so they do not parse every snapshot.
 */
export class PullRequestInbox {
  private storage: PullRequestInboxStorage
  private ownsStorage: boolean
  private scope: string
  private ready?: Promise<void>
  private tables: { pullRequests: string; deliveries: string; meta: string; schemaVersion: string }
  private repositories: string[]
  private clock: () => number
  private filter?: GitHubPullRequestFilter
  private activityAuthors: Set<string>
  private budgets: InboxBudgets
  constructor({ path, storage, scope = '', repositories, filter, clock = Date.now, budgets = {}, activityAuthors = [] }: PullRequestInboxOptions) {
    validateBudgets(budgets)
    if ((path === undefined) === (storage === undefined)) throw new Error('PullRequestInbox requires exactly one of path or storage.')
    this.budgets = { ...budgets }
    this.repositories = repositories.map(repository => repository.toLowerCase())
    this.clock = clock
    this.filter = filter
    this.activityAuthors = new Set(activityAuthors.map(author => author.trim().toLowerCase()))
    this.storage = storage ?? createNodeSqliteInboxStorage(path!)
    this.ownsStorage = !storage
    this.scope = scope
    const prefix = this.storage.tablePrefix
    this.tables = { pullRequests: `${prefix}pull_requests`, deliveries: `${prefix}deliveries`, meta: `${prefix}meta`, schemaVersion: `${prefix}schema_version` }
  }
  async close(): Promise<void> { if (this.ownsStorage) await this.storage.close?.() }
  private async init(): Promise<void> {
    this.ready ??= this.storage.transaction(async tx => {
      const t = this.tables
      await tx.execute(`CREATE TABLE IF NOT EXISTS ${t.schemaVersion} (version INTEGER PRIMARY KEY)`)
      const [row] = await tx.execute(`SELECT COALESCE(MAX(version), 0) AS version FROM ${t.schemaVersion}`)
      if (Number(row?.version ?? 0) >= 1) return
      await tx.execute(`CREATE TABLE IF NOT EXISTS ${t.pullRequests} (scope TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL,
        value TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL, handled INTEGER NOT NULL,
        dirty_at INTEGER NOT NULL, next_at INTEGER NOT NULL, lease TEXT, lease_until INTEGER NOT NULL, waiting INTEGER NOT NULL,
        progress_blocked INTEGER NOT NULL, state TEXT, head_sha TEXT, head_ref TEXT, base_ref TEXT, PRIMARY KEY(scope, repository, number))`)
      await tx.execute(`CREATE INDEX IF NOT EXISTS ${t.pullRequests}_head ON ${t.pullRequests}(scope, repository, state, head_sha)`)
      await tx.execute(`CREATE INDEX IF NOT EXISTS ${t.pullRequests}_refs ON ${t.pullRequests}(scope, repository, state, head_ref, base_ref)`)
      await tx.execute(`CREATE INDEX IF NOT EXISTS ${t.pullRequests}_queue ON ${t.pullRequests}(scope, status, dirty_at)`)
      await tx.execute(`CREATE TABLE IF NOT EXISTS ${t.deliveries} (scope TEXT NOT NULL, id TEXT NOT NULL, event TEXT, received INTEGER NOT NULL,
        payload TEXT, result TEXT, PRIMARY KEY(scope, id))`)
      await tx.execute(`CREATE INDEX IF NOT EXISTS ${t.deliveries}_received ON ${t.deliveries}(scope, received)`)
      await tx.execute(`CREATE TABLE IF NOT EXISTS ${t.meta} (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(scope, key))`)
      await tx.execute(`INSERT INTO ${t.schemaVersion} (version) VALUES (1)`)
    }).catch((error: unknown) => {
      this.ready = undefined
      throw error
    })
    await this.ready
  }
  private async transaction<T>(run: (tx: PullRequestInboxExecutor) => Promise<T>): Promise<T> {
    await this.init()
    return await this.storage.transaction(run)
  }
  private async read(statement: string, args: unknown[] = []): Promise<PullRequestInboxRow[]> {
    await this.init()
    return await this.storage.execute(statement, args)
  }
  private repositoryFilter(): { sql: string; args: string[] } {
    return { sql: `repository IN (${this.repositories.map(() => '?').join(',')})`, args: this.repositories }
  }
  private async getIn(tx: PullRequestInboxExecutor, repository: string, number: number): Promise<Snapshot | undefined> {
    const [row] = await tx.execute(`SELECT value FROM ${this.tables.pullRequests} WHERE scope=? AND repository=? AND number=?`, [this.scope, repository, number])
    // SAFETY: the value column stores snapshot JSON; parseSnapshot validates the decoded boundary.
    return row ? parseSnapshot(JSON.parse(stringValue(row.value))) : undefined
  }
  async get(repository: string, number: number): Promise<Snapshot | undefined> {
    await this.init()
    return await this.getIn({ execute: (statement, args) => this.storage.execute(statement, args) }, repository, number)
  }
  async all(): Promise<Snapshot[]> {
    if (!this.repositories.length) return []
    const repositories = this.repositoryFilter()
    const rows = await this.read(`SELECT value FROM ${this.tables.pullRequests} WHERE scope=? AND ${repositories.sql} ORDER BY repository, number`, [this.scope, ...repositories.args])
    return rows.map(row => parseSnapshot(JSON.parse(stringValue(row.value))))
  }
  private async put(tx: PullRequestInboxExecutor, s: Snapshot): Promise<void> {
    const head = s.pr?.head?.sha
    await tx.execute(`INSERT OR REPLACE INTO ${this.tables.pullRequests} (scope, repository, number, value, summary, status, generation, handled,
      dirty_at, next_at, lease, lease_until, waiting, progress_blocked, state, head_sha, head_ref, base_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      this.scope, s.repository, s.number, JSON.stringify(s), JSON.stringify(summaryOf(s)), s.status, s.generation, s.handled,
      s.dirtyAt, s.nextAt, s.lease, s.leaseUntil, s.wait ? 1 : 0, s.progressBudget?.exhausted && s.progressBudget.head === head ? 1 : 0,
      s.pr?.state === undefined ? null : String(s.pr.state).toLowerCase(), head ?? null, s.pr?.head?.ref ?? null, s.pr?.base?.ref ?? null,
    ])
  }
  private empty(repository: string, number: number): Snapshot {
    return { repository, number, pr: null, generation: 0, handled: 0, dirtyAt: this.clock(), nextAt: 0,
      status: 'ready', lease: null, leaseUntil: 0, attempts: 0, hydrated: false, refresh: true, feedbackRefresh: true,
      comments: {}, reviews: {}, reviewComments: {}, checks: {}, statuses: {}, threads: [], reasons: [] }
  }
  private async metaIn(tx: PullRequestInboxExecutor, key: string): Promise<unknown> {
    const [row] = await tx.execute(`SELECT value FROM ${this.tables.meta} WHERE scope=? AND key=?`, [this.scope, key])
    // Metadata remains intentionally untyped JSON; callers validate their own keys.
    return row ? JSON.parse(stringValue(row.value)) : undefined
  }
  private async setMetaIn(tx: PullRequestInboxExecutor, key: string, value: unknown): Promise<void> {
    await tx.execute(`INSERT OR REPLACE INTO ${this.tables.meta} (scope, key, value) VALUES (?,?,?)`, [this.scope, key, JSON.stringify(value)])
  }
  async meta(key: string): Promise<unknown> {
    await this.init()
    return await this.metaIn({ execute: (statement, args) => this.storage.execute(statement, args) }, key)
  }
  /** A numeric metadata value, such as a timestamp; anything else reads as undefined. */
  async metaNumber(key: string): Promise<number | undefined> {
    const value = await this.meta(key)
    return isRuntimeNumber(value) ? value : undefined
  }
  async setMeta(key: string, value: unknown): Promise<void> { await this.transaction(tx => this.setMetaIn(tx, key, value)) }
  /** Shared provider scope should identify the credential/account, without including its secret. */
  async providerBudget(provider: string): Promise<ProviderBudget | undefined> {
    const value = await this.meta(`provider-budget:${provider}`)
    return value === undefined ? undefined : parseProviderBudget(value)
  }
  private async providerBudgetIn(tx: PullRequestInboxExecutor, provider: string): Promise<ProviderBudget | undefined> {
    const value = await this.metaIn(tx, `provider-budget:${provider}`)
    return value === undefined ? undefined : parseProviderBudget(value)
  }
  async reserveProviderAttempt(provider: string): Promise<ProviderAttempt | undefined> {
    return await this.transaction(async tx => {
      if (!provider.trim()) throw new Error('Provider scope is required')
      const maxRetries = this.budgets.providerRetries
      if (maxRetries === undefined) throw new Error('Configure budgets.providerRetries before reserving attempts')
      const budget = await this.providerBudgetIn(tx, provider) ?? { generation: randomUUID(), maxRetries, nextAttempt: 0, succeededThrough: 0, pending: [], failures: [] }
      // Pending attempts also consume capacity. A crashed dispatch fails closed.
      if (budget.pending.length + budget.failures.length >= budget.maxRetries + 1) return undefined
      const attempt = ++budget.nextAttempt
      budget.pending.push(attempt)
      await this.setMetaIn(tx, `provider-budget:${provider}`, budget)
      return { provider, generation: budget.generation, attempt }
    })
  }
  async finishProviderAttempt(token: ProviderAttempt, outcome: ProviderAttemptOutcome): Promise<boolean> {
    return await this.transaction(async tx => {
      const budget = await this.providerBudgetIn(tx, token.provider)
      if (!budget || budget.generation !== token.generation || !budget.pending.includes(token.attempt)) return false
      budget.pending = budget.pending.filter(attempt => attempt !== token.attempt)
      if (outcome === 'retryable-failure' && token.attempt > budget.succeededThrough) budget.failures.push(token.attempt)
      // A late success must not clear failures from newer admissions.
      else if (outcome === 'success') {
        budget.succeededThrough = Math.max(budget.succeededThrough, token.attempt)
        budget.failures = budget.failures.filter(attempt => attempt > budget.succeededThrough)
      }
      await this.setMetaIn(tx, `provider-budget:${token.provider}`, budget)
      return true
    })
  }
  async resetProviderBudget(provider: string, reason: string): Promise<void> {
    requireEvidence(reason)
    await this.transaction(async tx => {
      const maxRetries = this.budgets.providerRetries
      if (maxRetries === undefined) throw new Error('Configure budgets.providerRetries before resetting attempts')
      await this.setMetaIn(tx, `provider-budget:${provider}`, { generation: randomUUID(), maxRetries, nextAttempt: 0, succeededThrough: 0, pending: [], failures: [], resetReason: reason })
    })
  }
  async resetProgressBudget(repository: string, number: number, head: string, reason: string): Promise<boolean> {
    requireEvidence(reason)
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, repository.toLowerCase(), number)
      if (!s || s.pr?.head?.sha !== head || s.status === 'terminal' || s.lease) return false
      const limit = this.budgets.noProgress
      if (limit === undefined) throw new Error('Configure budgets.noProgress before resetting progress')
      const previous = s.progressBudget?.head === head ? s.progressBudget : undefined
      s.progressBudget = { head, limit, count: 0, exhausted: false, evidence: previous?.evidence,
        creditedEvidence: previous?.creditedEvidence ?? [], resetReason: reason }
      this.dirty(s, 'progress-budget:reset'); await this.put(tx, s)
      return true
    })
  }
  private dirty(s: Snapshot, reason: string) {
    if (s.generation === s.handled) s.dirtyAt = this.clock()
    s.generation++; s.nextAt = 0; s.attempts = 0
    s.revision = (s.revision ?? 0) + 1
    if (!s.lease) s.status = s.wait ? 'waiting' : 'ready'
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
    if (!changed) {
      const next = { ...previous, ...pr }
      if (digest(previous) !== digest(next)) s.revision = (s.revision ?? 0) + 1
      s.pr = next
      return false
    }
    const newHead = previous?.head?.sha !== pr.head?.sha
    // A wait on a pushed head survives that head's synchronize event.
    if (newHead && pr.head?.sha !== s.wait?.headSha || pr.state === 'closed') delete s.wait
    s.pr = { ...previous, ...pr }
    if (newHead) {
      s.checks = Object.fromEntries(Object.entries(s.checks).filter(([, check]) => check.head_sha === pr.head?.sha))
      s.statuses = Object.fromEntries(Object.entries(s.statuses).filter(([, status]) => status.sha === pr.head?.sha))
      s.hydrated = false; s.feedbackRefresh = true
    }
    s.refresh = false
    if (pr.state === 'closed') { s.status = 'terminal'; delete s.mergeIntent }
    else if (s.status === 'terminal') {
      delete s.wait
      s.status = s.lease ? 'working' : 'ready'
    }
    return true
  }
  eligible(repository: string, pr: GitHubPullRequestRecord | null): boolean {
    return Boolean(pr && pr.state === 'open' && matchesGitHubPullRequestFilter(pullRequestFilterContext(repository, pr), this.filter, 'pull-request'))
  }
  async seed(repository: string, value: unknown): Promise<Snapshot> {
    repository = repository.toLowerCase()
    if (!this.repositories.includes(repository)) throw new Error('Repository is not configured for this inbox.')
    const pr = normalizePullRequest(value)
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, repository, pr.number) ?? this.empty(repository, pr.number)
      if (this.updatePr(s, pr)) this.dirty(s, 'bootstrap')
      if (!this.eligible(repository, s.pr)) { delete s.wait; s.status = 'terminal'; s.handled = s.generation }
      else if (s.status === 'terminal') {
        delete s.wait
        s.status = 'ready'
        if (s.generation <= s.handled) this.dirty(s, 'bootstrap-recovery')
      }
      await this.put(tx, s); return s
    })
  }
  private async ingestIn(tx: PullRequestInboxExecutor, id: string, event: string, value: unknown): Promise<GitHubInboxDeliveryResult> {
    let payload: ReturnType<typeof parseDelivery>
    try { payload = parseDelivery(value) }
    catch (error) { throw new DeliveryValidationError('Invalid GitHub inbox delivery', { cause: error }) }
      const t = this.tables
      if ((await tx.execute(`SELECT id FROM ${t.deliveries} WHERE scope=? AND id=?`, [this.scope, id])).length) return { accepted: true, duplicate: true, queued: [], updated: [] }
      const repository = String(payload.repository?.full_name ?? '').toLowerCase()
      const queued: number[] = []
      const updated: number[] = []
      const finish = async (reason?: string): Promise<GitHubInboxDeliveryResult> => {
        const result: GitHubInboxDeliveryResult = { accepted: true, queued, updated }
        if (reason) Object.assign(result, { ignored: true, reason })
        await tx.execute(`INSERT INTO ${t.deliveries} (scope, id, event, received, payload, result) VALUES (?,?,?,?,?,?)`, [this.scope, id, event, this.clock(), JSON.stringify(payload), JSON.stringify(result)])
        return result
      }
      if (!this.repositories.includes(repository)) return await finish('repository not configured')
      // Activity suppression applies to issue comments only. Actual reviews
      // and inline review comments are evidence regardless of reviewer name.
      const commentAuthor = String(payload.comment?.user?.login ?? payload.sender?.login ?? '').trim().toLowerCase()
      const commentBody = String(payload.comment?.body ?? '')
      const marked = commentBody.startsWith('<!-- vitehub-agent-activity:')
      const repairMarked = commentBody.startsWith('<!-- vitehub-babysitter-repair:')
      const activity = marked && this.activityAuthors.has(commentAuthor)
      // Only authenticated activity markers are transport records. A public
      // marker on an external comment must remain actionable feedback.
      if (event === 'issue_comment' && !payload.issue?.pull_request) return await finish('issue is not a PR')
      // Ordinary issue comments do not wake repair agents. Marker-prefixed
      // comments from untrusted authors remain actionable feedback.
      if (event === 'issue_comment' && !activity && !isFeedback(payload.comment)) return await finish('irrelevant comment')
      const supported = ['pull_request','issue_comment','pull_request_review','pull_request_review_comment','pull_request_review_thread','check_run','check_suite','workflow_run','status','push']
      if (!supported.includes(event)) return await finish('irrelevant event')
      if (event === 'pull_request' && !['opened','synchronize','reopened','closed','edited','ready_for_review','converted_to_draft','labeled','unlabeled','enqueued','dequeued'].includes(payload.action ?? '')) return await finish('irrelevant PR action')
      if (event === 'pull_request_review_thread' && (!['resolved', 'unresolved'].includes(payload.action ?? '') || !payload.thread?.node_id)) return await finish('irrelevant review thread action')
      const check = payload.check_run ?? payload.check_suite ?? payload.workflow_run
      // Push payloads expose the updated commit as `after`; use it for
      // head matching when a provider does not include a check object.
      const sha = check?.head_sha ?? payload.sha ?? payload.after
      const numbers = new Set<number>()
      const direct = payload.pull_request?.number ?? (payload.issue?.pull_request ? payload.issue.number : undefined)
      if (direct) numbers.add(direct)
      for (const pr of check?.pull_requests ?? []) if (pr.number) numbers.add(pr.number)
      // Open PRs whose head matches the commit, or whose base or head branch received the push.
      const pushedRef = event === 'push' && isRuntimeString(payload.ref) && payload.ref.startsWith('refs/heads/') ? payload.ref.slice('refs/heads/'.length) : null
      const matches = await tx.execute(`SELECT number FROM ${t.pullRequests} WHERE scope=? AND repository=? AND state='open'
        AND ((? IS NOT NULL AND head_sha=?) OR (? IS NOT NULL AND (base_ref=? OR head_ref=?)))`, [this.scope, repository, sha ?? null, sha ?? null, pushedRef, pushedRef, pushedRef])
      for (const row of matches) numbers.add(Number(row.number))
      for (const number of numbers) {
        const existing = await this.getIn(tx, repository, number)
        const s = existing ?? this.empty(repository, number)
        // Event filters govern admission only. Lifecycle evidence must still
        // invalidate active work when the author, labels, head, or state changes.
        if (!existing && !matchesGitHubPullRequestFilter({ ...pullRequestFilterContext(repository, payload.pull_request ?? null), actor: payload.sender?.login ?? payload.comment?.user?.login, action: payload.action }, { actor: this.filter?.actor, action: this.filter?.action }, 'event')) continue
        const pushRefMatch = event === 'push' && (payload.ref === `refs/heads/${s.pr?.base?.ref}` || payload.ref === `refs/heads/${s.pr?.head?.ref}`)
        if (sha && s.pr?.head?.sha && s.pr.head.sha !== sha && !pushRefMatch) continue // old-head CI cannot wake current head
        let changed = false
        if (payload.pull_request) changed = this.updatePr(s, payload.pull_request)
        const upsert = (map: Record<string, GitHubEvidence>, value: GitHubEvidence | undefined, itemKey?: string) => {
          if (!value) return
          const key = itemKey ?? String(value.id)
          const old = map[key]
          if (old && stamp(value) < stamp(old)) return
          // Timestamp-only activity does not become another repair task.
          const semantic = (v: GitHubEvidence) => Object.fromEntries(Object.entries(v).filter(([k]) => !['updated_at','url','html_url'].includes(k)))
          const next = payload.action === 'deleted' ? { id: value.id, deleted: true, updated_at: value.updated_at } : value
          if (old && digest(semantic(old)) === digest(semantic(next))) {
            if (digest(old) !== digest(next)) s.revision = (s.revision ?? 0) + 1
            map[key] = next
            return
          }
          map[key] = next
          changed = true
        }
        if (event === 'issue_comment') {
          const feedback = !activity
          if (feedback) upsert(s.comments, payload.comment)
          // Agent activity comments are self-generated transport records; they
          // must not advance the repair generation or revoke the active claim.
          if (activity || repairMarked && this.activityAuthors.has(commentAuthor)) changed = false
        }
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
        const exhausted = s.progressBudget?.exhausted && s.progressBudget.head === s.pr?.head?.sha
        const eligible = this.eligible(repository, s.pr)
        if (s.pr && !eligible) {
          // Filter ineligibility is terminal for this snapshot. Do not retain
          // an explicit wait across it: recovery must be admitted normally.
          delete s.wait
          s.status = 'terminal'; s.handled = s.generation
        } else if (s.status === 'terminal') {
          delete s.wait
          s.status = s.lease ? 'working' : 'ready'
        }
        await this.put(tx, s)
        if (changed || !s.pr) updated.push(number)
        if (wake && !s.wait && s.status !== 'terminal' && !exhausted) queued.push(number)
      }
      return await finish(numbers.size ? undefined : 'no matching PR head')
  }
  async ingest(id: string, event: string, value: unknown): Promise<GitHubInboxDeliveryResult> {
    return await this.transaction(tx => this.ingestIn(tx, id, event, value))
  }
  /** Apply multiple deliveries in one serialized storage transaction. */
  async ingestMany(items: readonly { id: string; event: string; value: unknown }[]): Promise<GitHubInboxDeliveryResult[]> {
    if (!items.length) return []
    return await this.transaction(async tx => {
      const results: GitHubInboxDeliveryResult[] = []
      for (const [index, item] of items.entries()) {
        // Keep the batch transaction, but isolate each delivery so one malformed
        // REST record cannot roll back valid evidence that preceded it.
        const savepoint = `inbox_ingest_${index}`
        await tx.execute(`SAVEPOINT ${savepoint}`)
        try {
          results.push(await this.ingestIn(tx, item.id, item.event, item.value))
          await tx.execute(`RELEASE SAVEPOINT ${savepoint}`)
        } catch (error) {
          if (!(error instanceof DeliveryValidationError)) throw error
          await tx.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          await tx.execute(`RELEASE SAVEPOINT ${savepoint}`)
        }
      }
      return results
    })
  }
  async claim(limit: number): Promise<Claim[]> {
    if (!this.repositories.length || limit < 1) return []
    return await this.transaction(async tx => {
      const now = this.clock(), claims: Claim[] = [], t = this.tables
      const repositories = this.repositoryFilter()
      // Columns select candidates; only these snapshots are parsed.
      const candidates = await tx.execute(`SELECT repository, number, base_ref FROM ${t.pullRequests}
        WHERE scope=? AND ${repositories.sql} AND waiting=0 AND status<>'terminal' AND generation>handled AND next_at<=?
          AND (lease IS NULL OR lease_until<=?) AND progress_blocked=0
        ORDER BY dirty_at, number`, [this.scope, ...repositories.args, now, now])
      for (const candidate of candidates) {
        if (claims.length >= limit) break
        const repository = stringValue(candidate.repository), number = Number(candidate.number)
        // Stack children remain local; a parent merge's base push wakes them.
        if (candidate.base_ref !== null && candidate.base_ref !== undefined && (await tx.execute(`SELECT 1 FROM ${t.pullRequests}
          WHERE scope=? AND repository=? AND number<>? AND state='open' AND head_ref=? LIMIT 1`, [this.scope, repository, number, candidate.base_ref])).length) continue
        const s = await this.getIn(tx, repository, number)
        if (!s) continue
        if (s.pr && !this.eligible(s.repository, s.pr)) continue
        if (s.mergeIntent) { s.refresh = true; s.hydrated = false }
        s.lease = randomUUID(); s.leaseUntil = now + 2 * 60 * 60_000; s.status = 'working'
        await this.put(tx, s); claims.push({ token: s.lease, generation: s.generation, snapshot: structuredClone(s) })
      }
      return claims
    })
  }
  async hydrate(claim: Claim, patch: SnapshotPatch): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token || s.generation !== claim.generation || (s.revision ?? 0) !== (claim.snapshot.revision ?? 0)) return false
      if (patch.pr) {
        const pr = normalizePullRequest(patch.pr)
        if (s.pr && stamp(pr) < stamp(s.pr)) return false
        patch = { ...patch, pr }
        // Only a closed PR proves that an interrupted merge completed. Keep
        // the fence for stale or inconclusive open reads so another claim
        // cannot issue a second merge request.
        if (pr.state === 'closed') {
          delete s.mergeIntent
          delete claim.snapshot.mergeIntent
        }
      }
      Object.assign(s, patch)
      if (s.pr && !this.eligible(s.repository, s.pr)) s.status = 'terminal'
      await this.put(tx, s); Object.assign(claim.snapshot, patch, { status: s.status }); return true
    })
  }
  async refreshThreads(observed: Snapshot, threads: GitHubReviewThread[]): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, observed.repository, observed.number)
      if (!s || s.lease || s.generation !== observed.generation || (s.revision ?? 0) !== (observed.revision ?? 0)) return false
      const semantic = (items: GitHubReviewThread[]) => items.map(thread => ({
        id: thread.node_id ?? thread.id, isResolved: thread.isResolved, isOutdated: thread.isOutdated,
        comments: (Array.isArray(thread.comments) ? thread.comments : thread.comments?.nodes ?? []).map((comment: GitHubEvidence) => String(comment.node_id ?? comment.id)).sort(),
      })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
      const changed = digest(semantic(s.threads)) !== digest(semantic(threads))
      s.threads = threads; s.threadsHydrated = true; s.feedbackRefresh = false
      if (changed && s.status !== 'terminal') this.dirty(s, 'review-threads:reconciled')
      await this.put(tx, s); return true
    })
  }
  async release(claim: Claim): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token) return false
      s.lease = null; s.leaseUntil = 0
      if (s.mergeIntent) { s.refresh = true; s.hydrated = false }
      if (s.status !== 'terminal') s.status = 'ready'
      await this.put(tx, s); return true
    })
  }
  async renew(claim: Claim, leaseUntil: number): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token || s.generation !== claim.generation || s.leaseUntil <= this.clock()) return false
      s.leaseUntil = leaseUntil
      await this.put(tx, s)
      return true
    })
  }
  async isCurrentClaim(claim: Claim): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      return Boolean(s && s.lease === claim.token && s.generation === claim.generation
        && (s.revision ?? 0) === (claim.snapshot.revision ?? 0))
    })
  }
  async hasMergeIntent(claim: Claim): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      // An outstanding intent fences the whole lease, including evidence that
      // arrived after the claim was taken. Requiring the old generation here
      // would let a recovered merge fall through into a repair pass.
      return Boolean(s && s.lease === claim.token && s.mergeIntent)
    })
  }
  /** Whether an unresolved host-side merge is persisted for this pull request. */
  async hasPersistedMergeIntent(repository: string, number: number): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, repository, number)
      return Boolean(s?.mergeIntent)
    })
  }
  /** Reserve a claim, run an external side effect, then persist its terminal result. */
  async merge(claim: Claim, action: () => Promise<boolean>, text: string): Promise<boolean> {
    const reserved = await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token || s.generation !== claim.generation
        || (s.revision ?? 0) !== (claim.snapshot.revision ?? 0) || s.mergeIntent) return false
      s.mergeIntent = { head: claim.snapshot.pr?.head?.sha ?? '', text }
      await this.put(tx, s)
      return true
    })
    if (!reserved) return false
    if (!await action()) {
      await this.release(claim)
      return false
    }
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token) return false
      s.lease = null; s.leaseUntil = 0; s.lastResult = text
      if (s.generation === claim.generation && (s.revision ?? 0) === (claim.snapshot.revision ?? 0)) {
        delete s.mergeIntent
        s.status = 'terminal'; s.handled = s.generation
      } else {
        s.status = 'ready'; s.nextAt = 0; s.handled = Math.max(s.handled, claim.generation)
        s.refresh = true; s.hydrated = false
      }
      await this.put(tx, s)
      return true
    })
  }
  /**
   * Finishes a claimed pass. A `wait` without `headSha` binds to the claimed head and requires
   * unchanged evidence. A wait with `headSha`, such as the head of a repair push, keeps later events
   * unhandled, so `waitsToEvaluate()` returns the PR and the host decides whether they need work.
   */
  async finish(claim: Claim, result: { text: string; retry?: boolean; terminal?: boolean; progress?: ProgressOutcome; wait?: Omit<PullRequestWait, 'headSha'> & { headSha?: string } }): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token) return false
      const pinnedHead = result.wait?.headSha
      if (result.wait && pinnedHead) {
        if (result.retry || result.terminal) throw new Error('A wait cannot also retry or terminate work')
        // The synchronize event for the pinned head may arrive before or after this finish.
        if (s.status === 'terminal' || (s.pr?.head?.sha !== pinnedHead && s.pr?.head?.sha !== claim.snapshot.pr?.head?.sha)) {
          s.lease = null; s.leaseUntil = 0
          if (s.status !== 'terminal') { s.status = 'ready'; s.nextAt = 0 }
          await this.put(tx, s)
          return false
        }
        s.wait = parseWait({ ...result.wait, headSha: pinnedHead })
        s.lease = null; s.leaseUntil = 0; s.lastResult = result.text
        this.recordProgress(s, claim, result.progress)
        s.status = 'waiting'; s.handled = Math.max(s.handled, claim.generation); s.reasons = s.generation > claim.generation ? s.reasons : []
        s.revision = (s.revision ?? 0) + 1
        await this.put(tx, s); return true
      }
      if (result.wait) {
        if (result.retry || result.terminal) throw new Error('A wait cannot also retry or terminate work')
        if (s.status === 'terminal' || !s.pr?.head?.sha || s.pr.head.sha !== claim.snapshot.pr?.head?.sha
          || s.generation !== claim.generation) {
          s.lease = null; s.leaseUntil = 0
          if (s.status !== 'terminal') { s.status = 'ready'; s.nextAt = 0 }
          await this.put(tx, s)
          return false
        }
        s.wait = parseWait({ ...result.wait, headSha: s.pr.head.sha })
        s.revision = (s.revision ?? 0) + 1
      }
      const head = s.pr?.head?.sha
      this.recordProgress(s, claim, result.progress)
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
      if (s.status !== 'terminal' && s.progressBudget?.exhausted && s.progressBudget.head === head) {
        s.status = 'waiting'; s.nextAt = 0; s.reasons = ['no-progress-budget-exhausted']
      }
      await this.put(tx, s); return true
    })
  }
  private recordProgress(s: Snapshot, claim: Claim, progress: ProgressOutcome | undefined): void {
    const head = s.pr?.head?.sha
    if (progress?.kind === 'verified') requireEvidence(progress.evidence)
    const previous = s.progressBudget?.head === head ? s.progressBudget : undefined
    const limit = previous?.limit ?? this.budgets.noProgress
    if (progress && head && head === claim.snapshot.pr?.head?.sha && limit !== undefined) {
      const creditedEvidence = previous?.creditedEvidence ?? []
      const verified = progress.kind === 'verified' && !creditedEvidence.includes(progress.evidence)
      const count = verified ? 0 : (previous?.count ?? 0) + 1
      s.progressBudget = { head, limit, count, exhausted: count >= limit,
        evidence: verified ? progress.evidence : previous?.evidence,
        creditedEvidence: verified ? [...creditedEvidence, progress.evidence] : creditedEvidence,
        resetReason: previous?.resetReason }
    }
  }
  /** Waiting PRs that received events since the host last evaluated their wait. */
  async waitsToEvaluate(): Promise<Snapshot[]> {
    if (!this.repositories.length) return []
    const repositories = this.repositoryFilter()
    const rows = await this.read(`SELECT value FROM ${this.tables.pullRequests} WHERE scope=? AND ${repositories.sql}
      AND waiting=1 AND status<>'terminal' AND lease IS NULL AND generation>handled ORDER BY dirty_at, number`, [this.scope, ...repositories.args])
    return rows.map(row => parseSnapshot(JSON.parse(stringValue(row.value))))
  }
  /** Records that the host evaluated a wait's new events and the wait still holds. */
  async acknowledgeWait(observed: Snapshot): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, observed.repository, observed.number)
      if (!s?.wait || s.lease || s.status === 'terminal' || s.generation !== observed.generation
        || (s.revision ?? 0) !== (observed.revision ?? 0)) return false
      s.handled = s.generation; s.reasons = []
      await this.put(tx, s)
      return true
    })
  }
  /** Re-evaluate structured evidence outside an Agent invocation before calling this method. */
  async wake(observed: Snapshot, evidenceKey: string): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, observed.repository, observed.number)
      if (!s?.wait || s.lease || s.status === 'terminal' || s.generation !== observed.generation
        || (s.revision ?? 0) !== (observed.revision ?? 0) || s.pr?.head?.sha !== observed.pr?.head?.sha) return false
      parseWait({ ...s.wait, evidenceKey })
      if (s.wait.evidenceKey === evidenceKey) return false
      delete s.wait
      this.dirty(s, 'wait:evidence-changed')
      await this.put(tx, s)
      return true
    })
  }
  async recoverLeases(): Promise<void> {
    // Only expired leases are recoverable, including when other processes share the database.
    await this.transaction(async tx => {
      const now = this.clock()
      const rows = await tx.execute(`SELECT repository, number FROM ${this.tables.pullRequests} WHERE scope=? AND lease IS NOT NULL AND lease_until<=?`, [this.scope, now])
      for (const row of rows) {
        const s = await this.getIn(tx, stringValue(row.repository), Number(row.number))
        if (!s?.lease || s.leaseUntil > now) continue
        s.lease = null; s.leaseUntil = 0
        if (s.mergeIntent) { s.refresh = true; s.hydrated = false }
        if (s.status !== 'terminal') s.status = 'ready'
        await this.put(tx, s)
      }
    })
  }
  async summary(): Promise<GitHubInboxSummary[]> {
    if (!this.repositories.length) return []
    const repositories = this.repositoryFilter()
    const rows = await this.read(`SELECT summary FROM ${this.tables.pullRequests} WHERE scope=? AND ${repositories.sql} ORDER BY repository, number`, [this.scope, ...repositories.args])
    return rows.map(row => parseSummary(JSON.parse(stringValue(row.summary))))
  }
  /** The open, unleased PR that a reconciliation probe checked longest ago, with that probe time. */
  async nextProbe(): Promise<{ repository: string; number: number; probedAt: number } | undefined> {
    if (!this.repositories.length) return undefined
    const repositories = this.repositoryFilter()
    const [row] = await this.read(`SELECT p.repository AS repository, p.number AS number, COALESCE(CAST(m.value AS INTEGER), 0) AS probed_at
      FROM ${this.tables.pullRequests} p LEFT JOIN ${this.tables.meta} m ON m.scope=p.scope AND m.key=('snapshot-probe:' || p.repository || ':' || p.number)
      WHERE p.scope=? AND p.${repositories.sql} AND p.lease IS NULL AND p.status<>'terminal'
      ORDER BY probed_at, p.repository, p.number LIMIT 1`, [this.scope, ...repositories.args])
    return row ? { repository: stringValue(row.repository), number: Number(row.number), probedAt: Number(row.probed_at) } : undefined
  }
  /**
   * Copies a pre-Agent-State inbox file once: snapshots, metadata except probe schedules, and
   * delivery IDs from the last 30 days. Leases are cleared, so stop the old process first.
   * The source file is opened read-only and left unchanged.
   */
  async importLegacyFile(path: string): Promise<{ imported: boolean; snapshots: number; skipped: number; deliveries: number }> {
    const { existsSync } = await import('node:fs')
    if (await this.meta('legacy-import:v1') !== undefined || !existsSync(path)) return { imported: false, snapshots: 0, skipped: 0, deliveries: 0 }
    const { DatabaseSync } = await import('node:sqlite')
    const source = new DatabaseSync(path, { readOnly: true })
    try {
      const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => stringValue(row.name)))
      const requiredTables = ['pr_snapshots', 'deliveries', 'inbox_meta']
      if (!requiredTables.every(table => tables.has(table))) return { imported: false, snapshots: 0, skipped: 0, deliveries: 0 }
      const snapshots = source.prepare('SELECT value FROM pr_snapshots').all()
      const meta = source.prepare('SELECT key, value FROM inbox_meta').all()
      const deliveries = source.prepare(`SELECT id, event, received FROM deliveries WHERE received >= ${this.clock() - 30 * 24 * 60 * 60_000}`).all()
      return await this.transaction(async tx => {
        if (await this.metaIn(tx, 'legacy-import:v1') !== undefined) return { imported: false, snapshots: 0, skipped: 0, deliveries: 0 }
        let imported = 0, skipped = 0
        for (const row of snapshots) {
          const snapshot = legacySnapshot(JSON.parse(stringValue(row.value)))
          if (!snapshot || !this.repositories.includes(snapshot.repository)) { skipped++; continue }
          const existing = await this.getIn(tx, snapshot.repository, snapshot.number)
          // A finalized destination is durable evidence. Legacy conversion clears
          // leases and maps working/attention to ready, so generation alone cannot
          // prevent resurrecting a terminal row from an older file.
          if (existing && (existing.status === 'terminal' || existing.lease !== null || existing.generation >= snapshot.generation)) { skipped++; continue }
          await this.put(tx, snapshot); imported++
        }
        for (const row of meta) {
          const key = stringValue(row.key)
          if (key.startsWith('snapshot-probe:') || key === 'snapshot-reconcile-next') continue
          // Destination metadata is authoritative when both files contain a key.
          // Preserve newer durable evidence during the one-shot migration.
          await tx.execute(`INSERT OR IGNORE INTO ${this.tables.meta} (scope, key, value) VALUES (?,?,?)`, [this.scope, key, stringValue(row.value)])
        }
        for (const row of deliveries) {
          await tx.execute(`INSERT OR IGNORE INTO ${this.tables.deliveries} (scope, id, event, received, payload, result) VALUES (?,?,?,?,NULL,NULL)`,
            [this.scope, stringValue(row.id), row.event === null ? null : stringValue(row.event), Number(row.received)])
        }
        const result = { imported: true, snapshots: imported, skipped, deliveries: deliveries.length }
        await this.setMetaIn(tx, 'legacy-import:v1', { at: new Date(this.clock()).toISOString(), source: path, ...result })
        return result
      })
    }
    finally {
      source.close()
    }
  }
  /** Drops delivery payloads after `payloadMs` and delivery IDs after `idMs`. Recent IDs still deduplicate redeliveries. */
  async pruneDeliveries({ payloadMs = 7 * 24 * 60 * 60_000, idMs = 30 * 24 * 60 * 60_000 }: { payloadMs?: number; idMs?: number } = {}): Promise<void> {
    const now = this.clock()
    await this.transaction(async tx => {
      await tx.execute(`DELETE FROM ${this.tables.deliveries} WHERE scope=? AND received<?`, [this.scope, now - idMs])
      await tx.execute(`UPDATE ${this.tables.deliveries} SET payload=NULL WHERE scope=? AND received<? AND payload IS NOT NULL`, [this.scope, now - payloadMs])
    })
  }
}
