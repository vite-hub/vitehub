import { parseProviderBudget, parseProgressBudget, validateBudgets, requireEvidence, type InboxBudgets, type ProgressBudget, type ProgressOutcome, type ProviderBudget, type ProviderAttempt, type ProviderAttemptOutcome } from './budgets.ts'

import { parseWait, type PullRequestWait } from './wait-state.ts'
import { createHash, randomUUID } from 'node:crypto'
import * as v from 'valibot'
import { isRuntimeNumber, isRuntimeString } from '../../internal/runtime-value.ts'
import { isRuntimeRecord } from '../../internal/runtime-type.ts'
import { createNodeSqliteInboxStorage, type PullRequestInboxExecutor, type PullRequestInboxRow, type PullRequestInboxStorage } from './storage.ts'
import type { AgentRunActivity } from '../../types.ts'
import { isStatusDeliveryCurrent, statusProjectionText, statusAcknowledgementSchema, statusDeliverySchema, statusOutboxPrefix, statusSentPrefix, statusWriterPrefix, statusTargetKey, workerBlockerPrefix, type StatusDelivery } from './status-delivery.ts'

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
  recoveryHead?: string
  sourcePushHead?: string
  sourcePushHeads?: string[]
  sourcePushOverflow?: boolean
  prospectivePush?: { token: string; heads: string[] }
  threadReopens?: Record<string, number>
  hydrated: boolean; refresh: boolean; feedbackRefresh: boolean
  comments: Record<string, GitHubEvidence>; reviews: Record<string, GitHubEvidence>
  reviewComments: Record<string, GitHubEvidence>; checks: Record<string, GitHubEvidence>; statuses: Record<string, GitHubEvidence>
  ciEvidence?: Record<string, unknown>[]
  threads: GitHubReviewThread[]; threadsHydrated?: boolean; reasons: string[]; lastResult?: string
}
export type SnapshotPatch = Partial<Pick<Snapshot, 'pr' | 'comments' | 'reviews' | 'reviewComments' | 'checks' | 'statuses' | 'threads' | 'hydrated' | 'refresh' | 'feedbackRefresh' | 'threadsHydrated' | 'ciEvidence'>>
export interface GitHubInboxDeliveryResult { accepted: true; duplicate?: boolean; queued: number[]; updated: number[]; ignored?: boolean; reason?: string }
export interface GitHubInboxSummary {
  repository: string; number: number; head?: string; generation: number; handled: number; status: Snapshot['status']; reasons: string[]
  wait?: PullRequestWait
  dirty: boolean; attempts: number; nextAt: number; lastResult?: string; progressBudget?: ProgressBudget
  stackBlocked?: boolean; stackParent?: { number: number; state: string }
}
export type Claim = { token: string; generation: number; snapshot: Snapshot; runId?: string; startedAt?: number; activity?: AgentRunActivity }
export type DirectMergeAttempt = { token: string; generation: number; revision: number; head: string; startedAt: number; asynchronous?: boolean; requestId?: string; enqueued?: boolean }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const statusContentKey = (snapshot: Snapshot, head = snapshot.wait?.headSha ?? snapshot.pr?.head?.sha) =>
  digest([head, snapshot.generation, snapshot.status, snapshot.lastResult])
const stamp = (value: GitHubEvidence) => Date.parse(value.updated_at ?? value.updatedAt ?? value.submitted_at ?? value.completed_at ?? value.started_at ?? value.created_at ?? '') || 0
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
    ('lastResult' in input && Object.prototype.toString.call(input.lastResult) !== '[object String]')) {
    throw new TypeError('Invalid inbox snapshot')
  }
  if (input.prospectivePush !== undefined) v.parse(v.object({ token: v.string(), heads: v.array(v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/i))) }), input.prospectivePush)
  if (input.threadReopens !== undefined) v.parse(v.record(v.string(), v.pipe(v.number(), v.integer(), v.minValue(0))), input.threadReopens)
  if (input.sourcePushHeads !== undefined) v.parse(v.array(v.string()), input.sourcePushHeads)
  if (input.sourcePushOverflow !== undefined) v.parse(v.boolean(), input.sourcePushOverflow)
  if (input.sourcePushHead !== undefined) v.parse(v.string(), input.sourcePushHead)
  if (input.recoveryHead !== undefined) v.parse(v.string(), input.recoveryHead)
  if (input.ciEvidence !== undefined) v.parse(v.array(v.record(v.string(), v.unknown())), input.ciEvidence)
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
  stackBlocked: v.optional(v.boolean()), stackParent: v.optional(v.object({ number: v.number(), state: v.string() })),
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
  private repositoryFilter(column = 'repository'): { sql: string; args: string[] } {
    return { sql: `${column} IN (${this.repositories.map(() => '?').join(',')})`, args: this.repositories }
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
  private compactTerminal(s: Snapshot): void {
    if (s.status !== 'terminal') return
    // Closed or filtered PRs can be reopened from a webhook or the open-PR
    // sweep. Keep their identity and durable result, but discard historical
    // feedback and CI payloads so terminal history cannot starve the scheduler.
    s.comments = {}
    s.reviews = {}
    s.reviewComments = {}
    s.checks = {}
    s.statuses = {}
    s.threads = []
    delete s.ciEvidence
    s.hydrated = false
    s.refresh = true
    s.feedbackRefresh = true
  }
  private async put(tx: PullRequestInboxExecutor, s: Snapshot): Promise<void> {
    let reopened = false
    let resumed = false
    let wasWorking = false
    let readySuperseded = false
    if (this.activityAuthors.size && (s.status === 'ready' || s.status === 'terminal')) {
      const [previous] = await tx.execute(`SELECT status, generation FROM ${this.tables.pullRequests} WHERE scope=? AND repository=? AND number=?`, [this.scope, s.repository, s.number])
      reopened = s.status === 'ready' && previous?.status === 'terminal'
      resumed = s.status === 'ready' && previous?.status === 'waiting'
      wasWorking = previous?.status === 'working'
      readySuperseded = s.status === 'ready' && (wasWorking || previous?.status === 'ready' && s.generation > Number(previous.generation))
    }
    if (!s.lease) delete s.prospectivePush
    this.compactTerminal(s)
    const head = s.pr?.head?.sha
    await tx.execute(`INSERT OR REPLACE INTO ${this.tables.pullRequests} (scope, repository, number, value, summary, status, generation, handled,
      dirty_at, next_at, lease, lease_until, waiting, progress_blocked, state, head_sha, head_ref, base_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      this.scope, s.repository, s.number, JSON.stringify(s), JSON.stringify(summaryOf(s)), s.status, s.generation, s.handled,
      s.dirtyAt, s.nextAt, s.lease, s.leaseUntil, s.wait ? 1 : 0, s.progressBudget?.exhausted && s.progressBudget.head === head ? 1 : 0,
      s.pr?.state === undefined ? null : String(s.pr.state).toLowerCase(), head ?? null, s.pr?.head?.ref ?? null, s.pr?.base?.ref ?? null,
    ])
    if (this.activityAuthors.size && (s.status === 'terminal' || reopened || resumed || readySuperseded)) {
      const target = statusTargetKey(s)
      const pending = v.safeParse(statusDeliverySchema, await this.metaIn(tx, `${statusOutboxPrefix}${target}`))
      const sent = v.safeParse(statusAcknowledgementSchema, await this.metaIn(tx, `${statusSentPrefix}${target}`))
      if (reopened || resumed || wasWorking || readySuperseded && (pending.success || sent.success) || (pending.success ? !isStatusDeliveryCurrent(pending.output, s) : sent.success && sent.output.status !== 'completed')) {
        await this.enqueueStatusProjectionIn(tx, s)
      }
    }
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
  /** Metadata entries whose keys start with `prefix`. */
  async metaEntries(prefix: string): Promise<Array<[string, unknown]>> {
    const rows = await this.read(`SELECT key, value FROM ${this.tables.meta} WHERE scope=? AND substr(key, 1, ?)=? ORDER BY key`, [this.scope, prefix.length, prefix])
    return rows.map(row => [stringValue(row.key), JSON.parse(stringValue(row.value))])
  }
  async deleteMeta(key: string): Promise<void> {
    await this.transaction(async tx => { await tx.execute(`DELETE FROM ${this.tables.meta} WHERE scope=? AND key=?`, [this.scope, key]) })
  }
  async setMeta(key: string, value: unknown): Promise<void> { await this.transaction(tx => this.setMetaIn(tx, key, value)) }
  private async enqueueStatusResult(tx: PullRequestInboxExecutor, snapshot: Snapshot, claim?: Claim, resultHead?: string): Promise<void> {
    if (!this.activityAuthors.size || !snapshot.lastResult?.trim()) return
    const head = resultHead ?? snapshot.pr?.head?.sha
    if (!head || claim && !resultHead && claim.snapshot.pr?.head?.sha !== head) return
    const key = statusTargetKey(snapshot)
    const contentKey = statusContentKey(snapshot, head)
    const statusRunId = `saved:${key}:${contentKey}`
    const sent = v.safeParse(statusAcknowledgementSchema, await this.metaIn(tx, `${statusSentPrefix}${key}`))
    const pending = await this.metaIn(tx, `${statusOutboxPrefix}${key}`)
    if (sent.success && sent.output.contentKey === contentKey
      && (sent.output.runId === statusRunId || sent.output.runId.startsWith(`${statusRunId}:`))
      || isRuntimeRecord(pending) && pending.contentKey === contentKey) return
    const now = this.clock()
    const delivery: StatusDelivery = {
      version: randomUUID(), contentKey, repository: snapshot.repository, number: snapshot.number,
      head, generation: snapshot.generation, text: snapshot.lastResult, attempts: 0, nextAt: now,
      activity: {
        runId: statusRunId,
        status: snapshot.status === 'waiting' ? 'waiting' : snapshot.status === 'ready' ? 'failed' : 'completed',
        updatedAt: new Date(now).toISOString(), links: [...claim?.activity?.links ?? []], tasks: [], summary: snapshot.lastResult,
      },
    }
    const previous = v.safeParse(statusDeliverySchema, pending)
    if (previous.success && previous.output.lease && (previous.output.leaseUntil ?? 0) > now) {
      delivery.lease = previous.output.lease
      delivery.leaseUntil = previous.output.leaseUntil
    }
    if (head !== snapshot.pr?.head?.sha) delivery.precedingHead = snapshot.pr?.head?.sha
    if (claim?.startedAt !== undefined) delivery.activity.startedAt = new Date(claim.startedAt).toISOString()
    await this.setMetaIn(tx, `${statusOutboxPrefix}${key}`, delivery)
  }
  private async statusWritersIn(tx: PullRequestInboxExecutor, target: string): Promise<Array<{ lease: string; expiresAt: number }>> {
    const parsed = v.safeParse(v.array(v.union([v.string(), v.object({ lease: v.string(), expiresAt: v.number() })])), await this.metaIn(tx, `${statusWriterPrefix}${target}`))
    const now = this.clock()
    if (!parsed.success) return []
    const writers = parsed.output.map(value => v.is(v.string(), value) ? { lease: value, expiresAt: now + 900_000 } : value)
      .filter(value => Number.isFinite(value.expiresAt) && value.expiresAt > now)
    // A crashed process cannot settle its marker. Bound correction replay,
    // and persist a legacy marker's first deadline instead of extending it on reads.
    if (writers.length !== parsed.output.length || parsed.output.some(value => v.is(v.string(), value))) {
      if (writers.length) await this.setMetaIn(tx, `${statusWriterPrefix}${target}`, writers)
      else await tx.execute(`DELETE FROM ${this.tables.meta} WHERE scope=? AND key=?`, [this.scope, `${statusWriterPrefix}${target}`])
    }
    return writers
  }
  private async settleStatusWriterIn(tx: PullRequestInboxExecutor, observed: StatusDelivery): Promise<Array<{ lease: string; expiresAt: number }>> {
    const target = statusTargetKey(observed)
    const remaining = (await this.statusWritersIn(tx, target)).filter(writer => writer.lease !== observed.lease)
    if (remaining.length) await this.setMetaIn(tx, `${statusWriterPrefix}${target}`, remaining)
    else await tx.execute(`DELETE FROM ${this.tables.meta} WHERE scope=? AND key=?`, [this.scope, `${statusWriterPrefix}${target}`])
    return remaining
  }
  private async enqueueStatusProjectionIn(tx: PullRequestInboxExecutor, current: Snapshot): Promise<void> {
    const target = statusTargetKey(current)
    const key = `${statusOutboxPrefix}${target}`
    const surviving = v.safeParse(statusDeliverySchema, await this.metaIn(tx, key))
    const now = this.clock()
    const version = randomUUID()
    const text = statusProjectionText(current)
    const head = current.pr?.head?.sha
    if (!head) return
    const contentKey = digest(['projection', head, current.generation, text])
    const delivery: StatusDelivery = {
      version, contentKey, repository: current.repository, number: current.number,
      head, generation: current.generation, projection: true,
      workerLease: current.status === 'working' ? current.lease ?? undefined : undefined,
      text, attempts: 0, nextAt: now,
      activity: { runId: `saved:${target}:${contentKey}:${version}`,
        status: current.status === 'terminal' ? 'completed' : current.status === 'working' && current.lease ? 'running' : 'queued',
        updatedAt: new Date(now).toISOString(), links: [], tasks: [], summary: text },
    }
    if (surviving.success && surviving.output.lease && (surviving.output.leaseUntil ?? 0) > now) {
      delivery.lease = surviving.output.lease
      delivery.leaseUntil = surviving.output.leaseUntil
    }
    await this.setMetaIn(tx, key, delivery)
  }
  /** A bounded batch of due deliveries. Invalid metadata never reaches the publisher. */
  async pendingStatusDeliveries(limit = 5): Promise<StatusDelivery[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Status delivery limit must be a positive integer')
    const now = this.clock()
    return (await this.metaEntries(statusOutboxPrefix)).flatMap(([, value]) => {
      const parsed = v.safeParse(statusDeliverySchema, value)
      return parsed.success && parsed.output.nextAt <= now && (parsed.output.leaseUntil ?? 0) <= now && this.repositories.includes(parsed.output.repository) ? [parsed.output] : []
    }).sort((a, b) => a.nextAt - b.nextAt).slice(0, limit)
  }
  /** Claim due, eligible deliveries atomically across hosts. Deferred heads yield the batch. */
  async claimStatusDeliveries(limit = 5, leaseMs = 300_000): Promise<StatusDelivery[]> {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Status delivery limits must be positive')
    return await this.transaction(async tx => {
      const now = this.clock()
      const rows = await tx.execute(`SELECT value FROM ${this.tables.meta} WHERE scope=? AND substr(key, 1, ?)=?`, [this.scope, statusOutboxPrefix.length, statusOutboxPrefix])
      const candidates = rows.flatMap(row => {
        const parsed = v.safeParse(statusDeliverySchema, JSON.parse(stringValue(row.value)))
        return parsed.success && parsed.output.nextAt <= now && (parsed.output.leaseUntil ?? 0) <= now && this.repositories.includes(parsed.output.repository) ? [parsed.output] : []
      }).sort((a, b) => a.nextAt - b.nextAt || a.repository.localeCompare(b.repository) || a.number - b.number)
      const claimed: StatusDelivery[] = []
      for (const pending of candidates) {
        const snapshot = await this.getIn(tx, pending.repository, pending.number)
        if (pending.projection && snapshot?.lease && snapshot.status !== 'terminal' && pending.workerLease !== snapshot.lease) {
          await this.enqueueStatusProjectionIn(tx, snapshot)
          continue
        }
        if (snapshot?.generation === pending.generation && pending.precedingHead && snapshot.pr?.head?.sha === pending.precedingHead && snapshot.wait?.headSha === pending.head && snapshot.pr.state === 'open') continue
        // Upgrade saved entries from releases that reused the invocation run ID.
        const statusRunId = `saved:${statusTargetKey(pending)}:${pending.contentKey}`
        const runId = pending.activity.runId.startsWith(`${statusRunId}:`) ? pending.activity.runId : statusRunId
        const delivery = { ...pending, activity: { ...pending.activity, runId }, lease: randomUUID(), leaseUntil: now + leaseMs }
        // Expiry releases delivery ownership. A bounded writer horizon keeps
        // corrections durable without a crashed publisher forcing endless writes.
        const target = statusTargetKey(pending)
        const writers = await this.statusWritersIn(tx, target)
        if (pending.lease && !writers.some(writer => writer.lease === pending.lease)
          && (pending.leaseUntil ?? 0) + 900_000 > now) {
          writers.push({ lease: pending.lease, expiresAt: pending.leaseUntil! + 900_000 })
        }
        writers.push({ lease: delivery.lease, expiresAt: delivery.leaseUntil + 900_000 })
        await this.setMetaIn(tx, `${statusWriterPrefix}${target}`, writers)
        await this.setMetaIn(tx, `${statusOutboxPrefix}${target}`, delivery)
        claimed.push(delivery)
        if (claimed.length === limit) break
      }
      return claimed
    })
  }
  /** Keep the external writer's lease, including when its saved result is superseded. */
  async renewStatusDelivery(observed: StatusDelivery, leaseMs = 300_000): Promise<boolean> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Status delivery lease must be positive')
    return await this.transaction(async tx => {
      const key = `${statusOutboxPrefix}${statusTargetKey(observed)}`
      const parsed = v.safeParse(statusDeliverySchema, await this.metaIn(tx, key))
      if (!observed.lease || !parsed.success || parsed.output.lease !== observed.lease) return false
      const leaseUntil = this.clock() + leaseMs
      await this.setMetaIn(tx, key, { ...parsed.output, leaseUntil })
      const target = statusTargetKey(observed)
      const writers = (await this.statusWritersIn(tx, target)).filter(writer => writer.lease !== observed.lease)
      writers.push({ lease: observed.lease, expiresAt: leaseUntil + 900_000 })
      await this.setMetaIn(tx, `${statusWriterPrefix}${target}`, writers)
      return true
    })
  }
  /** Version and lease comparisons preserve newer results and fence replaced consumers. */
  async finishStatusDelivery(observed: StatusDelivery, outcome: 'delivered' | 'discarded'): Promise<boolean> {
    return await this.transaction(async tx => {
      const writers = await this.settleStatusWriterIn(tx, observed)
      const key = `${statusOutboxPrefix}${statusTargetKey(observed)}`
      const parsed = v.safeParse(statusDeliverySchema, await this.metaIn(tx, key))
      if (!observed.lease || !parsed.success || parsed.output.lease !== observed.lease) return false
      const { lease: _lease, leaseUntil: _leaseUntil, ...released } = parsed.output
      if (parsed.output.version !== observed.version) {
        await this.setMetaIn(tx, key, released)
        return false
      }
      if (outcome === 'delivered') {
        if (!isStatusDeliveryCurrent(observed, await this.getIn(tx, observed.repository, observed.number))) {
          await this.setMetaIn(tx, key, released)
          await this.reconcileStatusWriterIn(tx, observed)
          return false
        }
        await this.setMetaIn(tx, `${statusSentPrefix}${statusTargetKey(observed)}`, { contentKey: observed.contentKey, runId: observed.activity.runId, status: observed.activity.status, head: observed.head, deliveredAt: this.clock() })
      }
      if (writers.length) {
        if (outcome === 'discarded') await this.reconcileStatusWriterIn(tx, observed)
        else {
          // An older accepted request can still land after this acknowledgement.
          // Replay with a fresh activity identity through each writer's correction window.
          const version = randomUUID()
          await this.setMetaIn(tx, key, { ...released, version, nextAt: this.clock() + 60_000,
            activity: { ...released.activity, runId: `saved:${statusTargetKey(observed)}:${released.contentKey}:${version}` } })
        }
      } else await tx.execute(`DELETE FROM ${this.tables.meta} WHERE scope=? AND key=?`, [this.scope, key])
      return true
    })
  }
  async retryStatusDelivery(observed: StatusDelivery, failure: unknown): Promise<boolean> {
    return await this.transaction(async tx => {
      await this.settleStatusWriterIn(tx, observed)
      const key = `${statusOutboxPrefix}${statusTargetKey(observed)}`
      const parsed = v.safeParse(statusDeliverySchema, await this.metaIn(tx, key))
      if (!observed.lease || !parsed.success || parsed.output.lease !== observed.lease) return false
      const { lease: _lease, leaseUntil: _leaseUntil, ...released } = parsed.output
      if (parsed.output.version !== observed.version) {
        await this.setMetaIn(tx, key, released)
        return false
      }
      if (!isStatusDeliveryCurrent(observed, await this.getIn(tx, observed.repository, observed.number))) {
        await this.setMetaIn(tx, key, released)
        await this.reconcileStatusWriterIn(tx, observed)
        return false
      }
      const attempts = parsed.output.attempts + 1
      await this.setMetaIn(tx, key, { ...released, attempts, nextAt: this.clock() + Math.min(900_000, 60_000 * 2 ** Math.min(attempts - 1, 4)), lastError: String(failure).slice(0, 1000) })
      return true
    })
  }
  /** Repair the external projection after a replaced writer finally settles. */
  async reconcileSettledStatusWriter(observed: StatusDelivery): Promise<boolean> {
    if (!observed.lease) return false
    return await this.transaction(async tx => {
      await this.settleStatusWriterIn(tx, observed)
      return await this.reconcileStatusWriterIn(tx, observed)
    })
  }
  private async reconcileStatusWriterIn(tx: PullRequestInboxExecutor, observed: StatusDelivery): Promise<boolean> {
    const target = statusTargetKey(observed)
    const key = `${statusOutboxPrefix}${target}`
    const current = await this.getIn(tx, observed.repository, observed.number)
    if (!current?.pr?.head?.sha) return false
    const surviving = v.safeParse(statusDeliverySchema, await this.metaIn(tx, key))
    const sent = v.safeParse(statusAcknowledgementSchema, await this.metaIn(tx, `${statusSentPrefix}${target}`))
    const contentKey = statusContentKey(current)
    const survivingCurrent = surviving.success && isStatusDeliveryCurrent(surviving.output, current)
    const resultCurrent = !current.lease && current.lastResult?.trim()
      && (current.status !== 'terminal' && current.generation === current.handled || survivingCurrent && !surviving.output.projection
        || current.status === 'terminal' && isStatusDeliveryCurrent(observed, current)
        || current.status === 'ready' && sent.success && sent.output.contentKey === contentKey)
    if (!resultCurrent) {
      // The old HTTP write may have replaced a newer comment. Persist an
      // honest queue/closure projection without relabelling the saved result.
      await this.enqueueStatusProjectionIn(tx, current)
      return true
    }
    if (survivingCurrent) {
      // Its side effect may already have happened while its response is still
      // pending. Preserve ownership, but fence that acknowledgement and replay.
      const version = randomUUID()
      await this.setMetaIn(tx, key, { ...surviving.output, version, nextAt: this.clock(), activity: {
        ...surviving.output.activity, runId: `saved:${target}:${surviving.output.contentKey}:${version}`,
      } })
      return true
    }
    await tx.execute(`DELETE FROM ${this.tables.meta} WHERE scope=? AND key=?`, [this.scope, `${statusSentPrefix}${target}`])
    await this.enqueueStatusResult(tx, current, undefined, current.wait?.headSha)
    const pending = v.safeParse(statusDeliverySchema, await this.metaIn(tx, key))
    if (!pending.success) return false
    // The activity channel remembers prior runs. A correction must have a fresh
    // identity so an already-published run is not rejected as a stale replay.
    await this.setMetaIn(tx, key, { ...pending.output, activity: {
      ...pending.output.activity, runId: `${pending.output.activity.runId}:${pending.output.version}`,
    } })
    return true
  }
  /** Upgrade historical waiting results without synthetic webhooks or model passes. */
  async backfillStatusDeliveries(): Promise<void> {
    for (const observed of await this.waitsToEvaluate(true, true)) {
      await this.transaction(async tx => {
        const current = await this.getIn(tx, observed.repository, observed.number)
        if (!current || current.lease || current.status !== 'waiting' || current.generation !== current.handled || current.generation !== observed.generation
          || (current.revision ?? 0) !== (observed.revision ?? 0)) return
        await this.enqueueStatusResult(tx, current, undefined, current.wait?.headSha)
      })
    }
  }
  async recordWorkerBlocker(observed: Snapshot, revision: string): Promise<void> {
    await this.transaction(async tx => {
      const current = await this.getIn(tx, observed.repository, observed.number)
      if (!current || current.pr?.head?.sha !== observed.pr?.head?.sha) return
      await this.setMetaIn(tx, `${workerBlockerPrefix}${statusTargetKey(observed)}`, { revision, head: observed.pr?.head?.sha })
    })
  }
  /** Wake and persist its release marker atomically, so restart cannot repeat the wake. */
  async wakeForWorkerRelease(observed: Snapshot, revision: string, evidenceKey: string): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, observed.repository, observed.number)
      if (!s?.wait || s.lease || s.status === 'terminal' || s.generation !== observed.generation
        || (s.revision ?? 0) !== (observed.revision ?? 0) || s.pr?.head?.sha !== observed.pr?.head?.sha) return false
      const key = `${workerBlockerPrefix}${statusTargetKey(s)}`
      const marker = await this.metaIn(tx, key)
      if (isRuntimeRecord(marker) && marker.revision === revision && marker.head === s.pr?.head?.sha) return false
      parseWait({ ...s.wait, evidenceKey })
      if (s.wait.evidenceKey === evidenceKey) return false
      s.recoveryHead = s.pr?.head?.sha; s.refresh = true
      delete s.wait
      this.dirty(s, 'wait:worker-release-changed')
      await this.put(tx, s)
      await this.setMetaIn(tx, key, { revision, head: s.pr?.head?.sha })
      // The corrected host can repair unchanged CI even when Actions reruns
      // are forbidden. Its old model fallback must not suppress that retry.
      await tx.execute(`DELETE FROM ${this.tables.meta} WHERE scope=? AND key=?`,
        [this.scope, `ci-permission-fallback:v1:${s.repository}:${s.pr?.head?.sha ?? ''}`])
      if (this.activityAuthors.size) await this.enqueueStatusProjectionIn(tx, s)
      return true
    })
  }
  private directMergeKey(repository: string, number: number): string { return `direct-merge:${repository}:${number}` }
  /** Atomically records that a claim has started an irreversible merge request. */
  async beginDirectMerge(claim: Claim, head: string, asynchronous = false): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token || s.generation !== claim.generation ||
        (s.revision ?? 0) !== (claim.snapshot.revision ?? 0) || s.leaseUntil <= this.clock()) return false
      if (await this.metaIn(tx, this.directMergeKey(s.repository, s.number)) !== undefined) return false
      await this.setMetaIn(tx, this.directMergeKey(s.repository, s.number), {
        token: claim.token, generation: claim.generation, revision: claim.snapshot.revision ?? 0,
        head, startedAt: this.clock(), ...(asynchronous ? { asynchronous } : {}),
      } satisfies DirectMergeAttempt)
      return true
    })
  }
  async directMergeAttempt(repository: string, number: number): Promise<DirectMergeAttempt | undefined> {
    const value = await this.meta(this.directMergeKey(repository, number))
    if (!value || Object.prototype.toString.call(value) !== '[object Object]') return undefined
    // SAFETY: the tag check above excludes null, arrays, and non-object metadata.
    const attempt = value as Record<string, unknown>
    if (!isRuntimeString(attempt.token) || !Number.isFinite(attempt.generation) || !Number.isFinite(attempt.revision) ||
      !isRuntimeString(attempt.head) || !Number.isFinite(attempt.startedAt)) return undefined
    // SAFETY: the required fields were validated above before this DirectMergeAttempt assertion.
    return attempt as DirectMergeAttempt
  }
  /** Save the provider's request identity without releasing the merge fence. */
  async recordDirectMergeRequest(repository: string, number: number, token: string, requestId: string): Promise<boolean> {
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(requestId)) throw new TypeError('Expected an asynchronous merge UUID.')
    return await this.transaction(async tx => {
      const key = this.directMergeKey(repository, number)
      const attempt = await this.metaIn(tx, key)
      if (!isRuntimeRecord(attempt) || attempt.token !== token || attempt.asynchronous !== true) return false
      await this.setMetaIn(tx, key, { ...attempt, requestId })
      return true
    })
  }
  /** Preserve a final enqueued result, including an immediate response without a UUID. */
  async recordDirectMergeEnqueued(repository: string, number: number, token: string): Promise<boolean> {
    return await this.transaction(async tx => {
      const key = this.directMergeKey(repository, number)
      const attempt = await this.metaIn(tx, key)
      if (!isRuntimeRecord(attempt) || attempt.token !== token || attempt.asynchronous !== true) return false
      await this.setMetaIn(tx, key, { ...attempt, enqueued: true })
      return true
    })
  }
  async clearDirectMerge(repository: string, number: number, token: string): Promise<boolean> {
    return await this.transaction(async tx => {
      const key = this.directMergeKey(repository, number)
      const attempt = await this.metaIn(tx, key)
      if (!isRuntimeRecord(attempt) || Array.isArray(attempt) || attempt.token !== token) return false
      await tx.execute(`DELETE FROM ${this.tables.meta} WHERE scope=? AND key=?`, [this.scope, key])
      return true
    })
  }
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
    if (newHead && s.prospectivePush) {
      const position = s.prospectivePush.heads.indexOf(pr.head?.sha ?? '')
      if (position < 0) delete s.prospectivePush
      else s.prospectivePush.heads = s.prospectivePush.heads.slice(position)
    }
    if (pr.state === 'closed') delete s.prospectivePush
    // A wait on a pushed head survives that head's synchronize event.
    if (newHead && pr.head?.sha !== s.wait?.headSha || pr.state === 'closed') delete s.wait
    s.pr = { ...previous, ...pr }
    if (newHead) {
      delete s.ciEvidence
      s.checks = Object.fromEntries(Object.entries(s.checks).filter(([, check]) => check.head_sha === pr.head?.sha))
      s.statuses = Object.fromEntries(Object.entries(s.statuses).filter(([, status]) => status.sha === pr.head?.sha))
      s.hydrated = false; s.feedbackRefresh = true
    }
    s.refresh = false
    if (pr.state === 'closed') s.status = 'terminal'
    else if (s.status === 'terminal') {
      delete s.wait
      // A reopened PR starts new work. A claim from its closed lifetime
      // cannot retain publication authority or defer the new status.
      s.lease = null; s.leaseUntil = 0
      s.status = 'ready'
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
  async ingest(id: string, event: string, value: unknown): Promise<GitHubInboxDeliveryResult> {
    const payload = parseDelivery(value)
    return await this.transaction(async tx => {
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
      if (sha && (check || event === 'status')) {
        // Source-push and check deliveries can precede synchronize. Retain CI
        // for an active publication or its durable pushed-head wait.
        const pending = await tx.execute(`SELECT number, value FROM ${t.pullRequests} WHERE scope=? AND repository=? AND state='open' AND (lease IS NOT NULL OR waiting=1)`, [this.scope, repository])
        for (const row of pending) {
          const snapshot = parseSnapshot(JSON.parse(stringValue(row.value)))
          if (snapshot.wait?.headSha === sha || snapshot.lease && snapshot.leaseUntil > this.clock() && (snapshot.sourcePushHeads?.includes(sha) || snapshot.prospectivePush?.token === snapshot.lease && snapshot.prospectivePush.heads.includes(sha))) numbers.add(Number(row.number))
        }
      }
      for (const number of numbers) {
        const existing = await this.getIn(tx, repository, number)
        const s = existing ?? this.empty(repository, number)
        // Event filters govern admission only. Lifecycle evidence must still
        // invalidate active work when the author, labels, head, or state changes.
        if (!existing && !matchesGitHubPullRequestFilter({ ...pullRequestFilterContext(repository, payload.pull_request ?? null), actor: payload.sender?.login ?? payload.comment?.user?.login, action: payload.action }, { actor: this.filter?.actor, action: this.filter?.action }, 'event')) continue
        const pushRefMatch = event === 'push' && (payload.ref === `refs/heads/${s.pr?.base?.ref}` || payload.ref === `refs/heads/${s.pr?.head?.ref}`)
        const pendingHead = sha && (check || event === 'status') && (s.wait?.headSha === sha || s.lease && s.leaseUntil > this.clock() && (s.sourcePushHeads?.includes(sha) || s.prospectivePush?.token === s.lease && s.prospectivePush.heads.includes(sha)))
        if (sha && s.pr?.head?.sha && s.pr.head.sha !== sha && !pushRefMatch && !pendingHead) continue // unrelated old-head CI cannot wake current head
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
          if (!isResolved) {
            const reopens = s.threadReopens ??= {}
            reopens[id] = (reopens[id] ?? 0) + 1
            changed = true
          }
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
        if (event === 'push') {
          // Preserve source-branch evidence before synchronize updates the PR head.
          // A same-named branch in the base repository is not a fork's source.
          if (payload.ref === `refs/heads/${s.pr?.head?.ref}` && (s.pr?.head?.repo?.full_name ?? repository).toLowerCase() === repository.toLowerCase()) {
            s.sourcePushHead = sha ?? 'unknown'
            if (s.lease) {
              const heads = s.sourcePushHeads ??= []
              if (!heads.includes(s.sourcePushHead)) {
                if (heads.length < 64) heads.push(s.sourcePushHead)
                else s.sourcePushOverflow = true
              }
            }
          }
          s.refresh = true; s.feedbackRefresh = true; changed = true
        }
        // Pending CI is evidence to retain, not another repair task. Terminal
        // results still wake the PR; revision invalidates in-flight hydration
        // even when this update does not need a new agent generation.
        const pendingCi = check && check.status !== 'completed' && !check.conclusion
          && ['queued', 'in_progress', 'pending', 'waiting', 'requested', 'rerequested', 'created'].includes(check.status ?? payload.action ?? '')
          || event === 'status' && payload.state === 'pending'
        const wake = (changed || !s.pr) && !pendingCi
        // New human feedback is new evidence on the same head. It resets an exhausted no-progress budget.
        const human = String(payload.sender?.type ?? '').toLowerCase() === 'user' && !this.activityAuthors.has(String(payload.sender?.login ?? '').toLowerCase())
        if (changed && human && ['issue_comment', 'pull_request_review', 'pull_request_review_comment'].includes(event) && s.progressBudget?.exhausted) {
          s.progressBudget = { ...s.progressBudget, count: 0, exhausted: false, resetReason: `${event}:${payload.sender?.login ?? 'unknown'}` }
        }
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
    })
  }
  /** Leases up to `limit` eligible PRs. `skip` leaves a candidate unclaimed for this call. */
  async claim(limit: number, options: { only?: (snapshot: Snapshot) => boolean; skip?: (snapshot: Snapshot) => boolean; includeBlocked?: boolean } = {}): Promise<Claim[]> {
    if (!this.repositories.length || limit < 1) return []
    return await this.transaction(async tx => {
      const now = this.clock(), claims: Claim[] = [], t = this.tables
      const repositories = this.repositoryFilter('p.repository')
      // Columns select candidates; only these snapshots are parsed. Stack parents come first,
      // weighted by their open children: merging one unblocks every child based on its branch.
      const candidates = await tx.execute(`SELECT p.repository AS repository, p.number AS number, p.base_ref AS base_ref, COALESCE(json_extract(p.value, '$.pr.base.repo.full_name'), p.repository) AS base_repository FROM ${t.pullRequests} p
        WHERE p.scope=? AND ${repositories.sql} AND p.waiting=0 AND p.status<>'terminal' AND p.generation>p.handled AND p.next_at<=?
          AND (p.lease IS NULL OR p.lease_until<=?) AND (p.progress_blocked=0 OR ?=1)
        ORDER BY (SELECT COUNT(*) FROM ${t.pullRequests} c WHERE c.scope=p.scope AND c.repository=p.repository AND c.state='open' AND c.base_ref=p.head_ref) DESC,
          p.dirty_at, p.number`, [this.scope, ...repositories.args, now, now, options.includeBlocked ? 1 : 0])
      for (const candidate of candidates) {
        if (claims.length >= limit) break
        const repository = stringValue(candidate.repository), number = Number(candidate.number)
        // Stack children remain local; a parent merge's base push wakes them.
        if (candidate.base_ref !== null && candidate.base_ref !== undefined && (await tx.execute(`SELECT 1 FROM ${t.pullRequests}
          WHERE scope=? AND repository=? AND number<>? AND state='open' AND head_ref=?
            AND json_extract(value, '$.pr.head.repo.full_name') = ? COLLATE NOCASE LIMIT 1`, [this.scope, repository, number, candidate.base_ref, candidate.base_repository])).length) continue
        const s = await this.getIn(tx, repository, number)
        if (!s) continue
        if (s.pr && !this.eligible(s.repository, s.pr)) continue
        if (options.only && !options.only(s)) continue
        if (options.skip && options.skip(s)) continue
        s.lease = randomUUID(); s.leaseUntil = now + 2 * 60 * 60_000; s.status = 'working'; s.sourcePushHeads = []
        delete s.sourcePushOverflow
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
  /** Retain a worker's verified thread resolution even when its webhook is missing. */
  async recordThreadResolution(claim: Claim, id: string, observed: Snapshot): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token || s.leaseUntil <= this.clock() || s.status === 'terminal' || s.pr?.state !== 'open'
        || s.pr.head?.sha !== observed.pr?.head?.sha || s.sourcePushOverflow || s.sourcePushHead !== observed.sourcePushHead
        || digest(s.sourcePushHeads ?? []) !== digest(observed.sourcePushHeads ?? [])
        || (s.threadReopens?.[id] ?? 0) !== (observed.threadReopens?.[id] ?? 0)) return false
      const index = s.threads.findIndex(thread => String(thread.node_id ?? thread.id) === id)
      if (index < 0) return false
      const thread = s.threads[index]
      if (!thread) return false
      if (thread.isResolved === true) return true
      const unchanged = s.generation === claim.generation && (s.revision ?? 0) === (claim.snapshot.revision ?? 0)
      s.threads[index] = { ...thread, isResolved: true, resolutionSource: 'worker', resolutionObservedAt: new Date(this.clock()).toISOString() }
      s.revision = (s.revision ?? 0) + 1
      await this.put(tx, s)
      // Own writes keep an unchanged claim usable. Concurrent evidence stays unacknowledged.
      if (unchanged) Object.assign(claim.snapshot, { threads: structuredClone(s.threads), revision: s.revision })
      return true
    })
  }
  /** Retain CI for an exact candidate before its source-push webhook arrives. This is not a publication receipt. */
  async registerProspectivePush(claim: Claim, head: string): Promise<boolean> {
    if (!/^[a-f\d]{40}$/i.test(head)) throw new TypeError('Expected an exact publication commit SHA.')
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.status === 'terminal' || s.sourcePushOverflow || s.lease !== claim.token || s.leaseUntil <= this.clock()
        || s.generation !== claim.generation || (s.revision ?? 0) !== (claim.snapshot.revision ?? 0)) return false
      const heads = s.prospectivePush?.token === claim.token ? s.prospectivePush.heads : []
      if (!heads.includes(head)) {
        if (heads.length >= 64) throw new Error('Publication candidate limit reached.')
        heads.push(head)
      }
      s.prospectivePush = { token: claim.token, heads }
      s.revision = (s.revision ?? 0) + 1
      await this.put(tx, s)
      return true
    })
  }
  async release(claim: Claim): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token) return false
      s.lease = null; s.leaseUntil = 0
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
  /** Checks the durable claim fence immediately before an irreversible provider action. */
  async isClaimCurrent(claim: Claim): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      return Boolean(s && s.lease === claim.token && s.generation === claim.generation &&
        (s.revision ?? 0) === (claim.snapshot.revision ?? 0) && s.leaseUntil > this.clock())
    })
  }
  /**
   * Finishes a claimed pass. A `wait` without `headSha` binds to the claimed head and requires
   * unchanged evidence. A wait with `headSha`, such as the head of a repair push, keeps later events
   * unhandled, so `waitsToEvaluate()` returns the PR and the host decides whether they need work.
   */
  async finish(claim: Claim, result: { text: string; retry?: boolean; terminal?: boolean; progress?: ProgressOutcome; verifiedPushHeads?: readonly string[]; wait?: Omit<PullRequestWait, 'headSha'> & { headSha?: string } }): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, claim.snapshot.repository, claim.snapshot.number)
      if (!s || s.lease !== claim.token || s.leaseUntil <= this.clock()) return false
      const pinnedHead = result.wait?.headSha
      if (result.wait && pinnedHead) {
        if (result.retry || result.terminal) throw new Error('A wait cannot also retry or terminate work')
        if (result.verifiedPushHeads && (result.progress?.kind !== 'verified' || result.progress.evidence !== `push:${pinnedHead}`)) throw new Error('Published ancestry requires a verified push receipt')
        const pushed = new Set([pinnedHead, ...result.verifiedPushHeads ?? []])
        const published = new Set([claim.snapshot.pr?.head?.sha, ...pushed])
        // Synchronize can lag several successful pushes. Accept only this pass's
        // verified publication chain, and fence a different source push even
        // while the PR snapshot still exposes its original head.
        if (s.status === 'terminal' || s.sourcePushOverflow || !published.has(s.pr?.head?.sha)
          || s.sourcePushHead !== claim.snapshot.sourcePushHead && !pushed.has(s.sourcePushHead ?? "")
          || s.sourcePushHeads?.some(head => !pushed.has(head))) {
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
        await this.put(tx, s)
        const ownSynchronize = s.generation === claim.generation + 1
          && pinnedHead !== claim.snapshot.pr?.head?.sha && s.pr?.head?.sha === pinnedHead
          && s.reasons.includes('pull_request:synchronize')
          && s.reasons.every(reason => reason === 'pull_request:synchronize' || claim.snapshot.reasons.includes(reason))
        if (s.generation === claim.generation || ownSynchronize) await this.enqueueStatusResult(tx, s, claim, pinnedHead)
        return true
      }
      if (result.wait) {
        if (result.retry || result.terminal) throw new Error('A wait cannot also retry or terminate work')
        if (s.status === 'terminal' || !s.pr?.head?.sha || s.pr.head.sha !== claim.snapshot.pr?.head?.sha
          || s.generation !== claim.generation || (s.revision ?? 0) !== (claim.snapshot.revision ?? 0)) {
          s.lease = null; s.leaseUntil = 0
          if (s.status !== 'terminal') { s.status = 'ready'; s.nextAt = 0 }
          await this.put(tx, s)
          return false
        }
        s.wait = parseWait({ ...result.wait, headSha: s.pr.head.sha })
        s.revision = (s.revision ?? 0) + 1
      }
      delete s.recoveryHead
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
      await this.put(tx, s)
      if (s.generation === claim.generation) await this.enqueueStatusResult(tx, s, claim)
      return true
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
  async waitsToEvaluate(includeExternal = false, includeIdle = false): Promise<Snapshot[]> {
    if (!this.repositories.length) return []
    const repositories = this.repositoryFilter()
    const rows = await this.read(`SELECT value FROM ${this.tables.pullRequests} WHERE scope=? AND ${repositories.sql}
      AND waiting=1 AND status<>'terminal' AND lease IS NULL ${includeExternal || includeIdle ? '' : 'AND generation>handled'} ORDER BY dirty_at, number`, [this.scope, ...repositories.args])
    return rows.map(row => parseSnapshot(JSON.parse(stringValue(row.value)))).filter(snapshot => snapshot.generation > snapshot.handled || includeExternal && (snapshot.wait?.wake || snapshot.wait?.retryAt !== undefined) || includeIdle && !snapshot.wait?.wake)
  }
  /** Records that the host evaluated a wait's new events and the wait still holds. */
  async acknowledgeWait(observed: Snapshot): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, observed.repository, observed.number)
      if (!s?.wait || s.lease || s.status === 'terminal' || s.generation !== observed.generation
        || (s.revision ?? 0) !== (observed.revision ?? 0)) return false
      s.handled = s.generation; s.reasons = []
      await this.put(tx, s)
      await this.enqueueStatusResult(tx, s, undefined, s.wait.headSha)
      return true
    })
  }
  /** Re-evaluate structured evidence outside an Agent invocation before calling this method. */
  async wake(observed: Snapshot, evidenceKey: string, options: { recovery?: boolean } = {}): Promise<boolean> {
    return await this.transaction(async tx => {
      const s = await this.getIn(tx, observed.repository, observed.number)
      if (!s?.wait || s.lease || s.status === 'terminal' || s.generation !== observed.generation
        || (s.revision ?? 0) !== (observed.revision ?? 0) || s.pr?.head?.sha !== observed.pr?.head?.sha) return false
      parseWait({ ...s.wait, evidenceKey })
      if (s.wait.evidenceKey === evidenceKey) return false
      if (options.recovery) { s.recoveryHead = s.pr?.head?.sha; s.refresh = true }
      else delete s.recoveryHead
      delete s.wait
      this.dirty(s, 'wait:evidence-changed')
      await this.put(tx, s)
      return true
    })
  }
  /**
   * Frees every lease in this scope at startup and returns how many were held. Call it only when one
   * process owns the scope: a pass cannot survive a restart, so its lease only delays the PR.
   */
  async releaseLeases(): Promise<number> {
    return await this.transaction(async tx => {
      const rows = await tx.execute(`SELECT repository, number FROM ${this.tables.pullRequests} WHERE scope=? AND lease IS NOT NULL`, [this.scope])
      let released = 0
      for (const row of rows) {
        const s = await this.getIn(tx, stringValue(row.repository), Number(row.number))
        if (!s?.lease) continue
        s.lease = null; s.leaseUntil = 0
        if (s.status !== 'terminal') s.status = s.wait ? 'waiting' : 'ready'
        await this.put(tx, s)
        released++
      }
      return released
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
        if (s.status !== 'terminal') s.status = 'ready'
        await this.put(tx, s)
      }
    })
  }
  async summary(): Promise<GitHubInboxSummary[]> {
    if (!this.repositories.length) return []
    const repositories = this.repositoryFilter()
    const rows = await this.read(`SELECT p.summary, (SELECT parent.number FROM ${this.tables.pullRequests} parent
      WHERE parent.scope=p.scope AND parent.repository=p.repository AND parent.number<>p.number
        AND parent.state='open' AND parent.head_ref=p.base_ref
        AND json_extract(parent.value, '$.pr.head.repo.full_name') = COALESCE(json_extract(p.value, '$.pr.base.repo.full_name'), p.repository) COLLATE NOCASE ORDER BY parent.number LIMIT 1) AS stack_parent
      FROM ${this.tables.pullRequests} p WHERE p.scope=? AND p.${repositories.sql} ORDER BY p.repository, p.number`, [this.scope, ...repositories.args])
    return rows.map(row => {
      const summary = parseSummary(JSON.parse(stringValue(row.summary)))
      if (summary.status !== 'ready' || !summary.dirty || row.stack_parent === null || row.stack_parent === undefined) return summary
      return { ...summary, stackBlocked: true, stackParent: { number: Number(row.stack_parent), state: 'open' } }
    })
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
          if (existing && (existing.lease !== null || existing.generation >= snapshot.generation)) { skipped++; continue }
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
  async pruneDeliveries({ payloadMs = 864e5, idMs = 6048e5 }: { payloadMs?: number; idMs?: number } = {}): Promise<void> {
    const now = this.clock()
    // CI metadata and full logs share the delivery payload retention window.
    // Entries written before timestamps were introduced are expired too.
    const staleEvidence = (await this.metaEntries('ci-evidence:v1:'))
      .filter(([, value]) => !isRuntimeRecord(value) || !isRuntimeNumber(value.fetchedAt) || value.fetchedAt < now - payloadMs)
      .map(([key]) => key)
    await this.transaction(async tx => {
      for (const key of staleEvidence) await tx.execute(`DELETE FROM ${this.tables.meta} WHERE scope=? AND key=?`, [this.scope, key])
      await tx.execute(`DELETE FROM ${this.tables.deliveries} WHERE scope=? AND received<?`, [this.scope, now - idMs])
      await tx.execute(`UPDATE ${this.tables.deliveries} SET payload=NULL WHERE scope=? AND received<? AND payload IS NOT NULL`, [this.scope, now - payloadMs])
    })
  }
}
