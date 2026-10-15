import { ViteHubError } from "@vite-hub/runtime"
import { isWorkspaceConflict } from "@vite-hub/workspace"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { WorkspaceRetainedHistory, WorkspaceRevision } from "@vite-hub/workspace"
import type { ContentPublishedDocument, ContentPublishExpectation, ContentPublishResult } from "./collections.ts"

/** The history ref that stores pending and failed schedules, one file per schedule. */
export const contentSchedulesRef = "schedules" as const

/** A pending schedule this long past its time has not run: no runner fired, or it fires less often. */
export const contentScheduleOverdueMs: number = 5 * 60_000

const maxCommitAttempts = 8

/**
 * - `pending`: waits for its time, or for the next run of `content.publishDue()` after it.
 * - `overdue`: more than five minutes past its time without a run. Check that a Schedule calls `content.publishDue()`.
 * - `failed`: a run found a draft that changed after scheduling, or one that no longer validates, and published nothing.
 */
export type ContentScheduleStatus = "pending" | "overdue" | "failed"

/** One document a schedule publishes and the draft digest that was reviewed. */
export interface ContentScheduledDocument {
  collection: string
  id: string
  /** The reviewed draft digest, or null to publish the deletion. */
  digest: string | null
}

/** Why a run published nothing. */
export interface ContentScheduleFailure {
  /** When the run failed, as an ISO timestamp. */
  at: string
  /** `WORKSPACE_CONFLICT` when a draft changed after scheduling, or `CONTENT_INVALID` when it no longer validates. */
  code: string
  message: string
  /** The error details, such as `{ ref: 'draft', documents: [{ collection, id, expected, actual }] }` for a conflict. */
  details?: Record<string, unknown>
}

/** A publish of reviewed drafts at a later time, from `content.schedule()`. */
export interface ContentSchedule {
  id: string
  /** When to publish, as an ISO timestamp in UTC. */
  at: string
  status: ContentScheduleStatus
  /** Exactly the documents to publish, with the draft digests that were reviewed. Pass it to `publish({ expect })`. */
  expect: ContentScheduledDocument[]
  /** Message of the publish revision. */
  message?: string
  /** JSON-safe metadata, such as the author. The publish revision carries it too. */
  metadata?: Record<string, unknown>
  /** When the schedule was created, as an ISO timestamp. */
  createdAt: string
  /** Set when `status` is `failed`. */
  failure?: ContentScheduleFailure
}

export interface ContentScheduleOptions {
  /** When to publish: a `Date`, or an ISO timestamp with a time zone, such as `2026-10-20T09:00:00+02:00`. Must be in the future. */
  at: Date | string
  /**
   * Exactly the documents to publish, with the reviewed draft digests from `status()` or `get({ ref: 'draft' })`, as
   * `publish({ expect })` takes them. Omit `id` for a singleton.
   */
  expect: readonly ContentPublishExpectation[]
  /** Message of the publish revision. Defaults to one such as `Publish 2 Content documents`. */
  message?: string
  /** JSON-safe metadata, such as the author. It is stored with the schedule and on the publish revision. */
  metadata?: Record<string, unknown>
}

export interface ContentSchedulesOptions {
  /** Only schedules that publish a document of this collection. */
  collection?: string
  /** Only schedules that publish this document. Combine it with `collection`. */
  id?: string
  status?: ContentScheduleStatus
}

export interface ContentUnscheduleOptions {
  message?: string
  /** JSON-safe revision metadata, such as who cancelled it. */
  metadata?: Record<string, unknown>
}

export interface ContentPublishDueOptions {
  /** The time to compare with. Defaults to now. */
  now?: Date
}

export interface ContentPublishDueResult {
  /** Schedules that ran and are removed, with the publish revision, or null when the drafts were already published. */
  published: Array<{ schedule: string, revision: string | null, documents: ContentPublishedDocument[] }>
  /** Schedules that published nothing because a draft changed or no longer validates. They stay until `unschedule()`. */
  failed: ContentSchedule[]
}

/** The schedule `status()` reports for a document: its pending or overdue one, or else a failed one. */
export interface ContentDocumentSchedule {
  id: string
  at: string
  status: ContentScheduleStatus
  /** The draft digest the schedule publishes. A different draft digest means the run will fail. */
  digest: string | null
  /** Why the run published nothing, when `status` is `failed`. */
  failure?: ContentScheduleFailure
}

/** What the stored schedule file holds. `status` is computed when read. */
type StoredSchedule = Omit<ContentSchedule, "status">

/** The collections runtime parts that schedules use. */
export interface ContentSchedulesHost {
  history(): Promise<WorkspaceRetainedHistory>
  /** Files of a revision with their digests, and a reader. */
  open(revision: WorkspaceRevision): Promise<{ files: ReadonlyMap<string, string>, read(path: string): Promise<string> }>
  /** Validate `expect` entries the way `publish({ expect })` does, filling the id of a singleton. */
  expectations(method: string, expect: unknown): ContentScheduledDocument[]
  /** The digests on the draft and on `published` of each expected document. */
  digests(expect: readonly ContentScheduledDocument[]): Promise<Array<{ draft: string | null, published: string | null }>>
  /** A `WORKSPACE_CONFLICT` naming each document whose draft no longer matches. */
  mismatch(method: string, mismatches: Array<{ collection: string, id: string, expected: string | null, actual: string | null }>): Error
  /** `publish({ expect })` that records the schedule on the publish revision. */
  publish(schedule: StoredSchedule): Promise<ContentPublishResult>
  /** Merge caller metadata with the reserved `content` key. */
  metadata(metadata: Record<string, unknown> | undefined, content: Record<string, unknown>): Record<string, unknown>
}

export interface ContentSchedulesRuntime {
  schedule(options: ContentScheduleOptions): Promise<ContentSchedule>
  schedules(options?: ContentSchedulesOptions): Promise<ContentSchedule[]>
  unschedule(id: string, options?: ContentUnscheduleOptions): Promise<void>
  publishDue(options?: ContentPublishDueOptions): Promise<ContentPublishDueResult>
  /** The schedule of each document, keyed by `collection/id`. */
  documentSchedules(): Promise<ReadonlyMap<string, ContentDocumentSchedule>>
}

function invalid(message: string): Error {
  return contentErrorDiagnostics.CONTENT_R0011({ message: `[vitehub] ${message}` })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

/** Like isRecord(), without narrowing typed options. */
function isOptionsObject(value: unknown): boolean {
  return isRecord(value)
}

/** The key `documentSchedules()` uses for one document. */
export function contentScheduleKey(collection: string, id: string): string {
  return `${collection}/${id}`
}

function statusOf(stored: StoredSchedule, now: number): ContentScheduleStatus {
  if (stored.failure) return "failed"
  return Date.parse(stored.at) + contentScheduleOverdueMs < now ? "overdue" : "pending"
}

function withStatus(stored: StoredSchedule, now: number): ContentSchedule {
  return { ...structuredClone(stored), status: statusOf(stored, now) }
}

/** Read a stored schedule file, or undefined when another writer stored something else at the path. */
function parseStored(text: string): StoredSchedule | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    return
  }
  if (!isRecord(value) || String(value.id) !== value.id || String(value.at) !== value.at || Number.isNaN(Date.parse(value.at))
    || String(value.createdAt) !== value.createdAt || !Array.isArray(value.expect)) return
  const expect = value.expect.flatMap((entry: unknown) => isRecord(entry) && String(entry.collection) === entry.collection && String(entry.id) === entry.id
    && (entry.digest === null || String(entry.digest) === entry.digest)
    ? [{ collection: entry.collection, id: entry.id, digest: entry.digest as string | null }]
    : [])
  if (expect.length !== value.expect.length) return
  const stored: StoredSchedule = { id: value.id, at: value.at, expect, createdAt: value.createdAt }
  if (String(value.message) === value.message) stored.message = value.message
  if (isRecord(value.metadata)) stored.metadata = value.metadata
  if (isRecord(value.failure)) {
    const failure = value.failure
    stored.failure = { at: String(failure.at), code: String(failure.code), message: String(failure.message) }
    if (isRecord(failure.details)) stored.failure.details = failure.details
  }
  return stored
}

function render(stored: StoredSchedule): string {
  return `${JSON.stringify(stored, null, 2)}\n`
}

function readAt(value: unknown, now: number): string {
  const date = Object.prototype.toString.call(value) === "[object Date]"
    ? new Date(Number(value))
    : String(value) === value && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()) ? new Date(value) : undefined
  if (!date || Number.isNaN(date.getTime())) {
    throw invalid(`schedule({ at }) must be a Date or an ISO timestamp with a time zone, such as "2026-10-20T09:00:00Z"; received ${JSON.stringify(value)}.`)
  }
  if (date.getTime() <= now) throw invalid(`schedule({ at }) must be in the future; received ${date.toISOString()}. Use publish({ expect }) to publish now.`)
  return date.toISOString()
}

function failureOf(error: unknown, at: string): ContentScheduleFailure | undefined {
  const code: unknown = Reflect.get(Object(error), "code")
  if (code !== "WORKSPACE_CONFLICT" && code !== "CONTENT_INVALID") return
  const details: unknown = Reflect.get(Object(error), "details")
  const failure: ContentScheduleFailure = { at, code, message: error instanceof Error ? error.message : String(error) }
  if (isRecord(details)) failure.details = JSON.parse(JSON.stringify(details))
  return failure
}

/**
 * Scheduled publishing. Each schedule is a JSON file on the `schedules` ref of the Content Workspace, so it lives
 * wherever the documents live, every change is a revision, and every write is a compare-and-swap on the ref head.
 * `publishDue()` runs due schedules; a Schedule Definition calls it on every host.
 */
export function createContentSchedules(host: ContentSchedulesHost): ContentSchedulesRuntime {
  async function read(): Promise<{ head: WorkspaceRevision | null, entries: Map<string, { path: string, digest: string, stored: StoredSchedule }> }> {
    const retained = await host.history()
    const head = await retained.head({ ref: contentSchedulesRef })
    const entries = new Map<string, { path: string, digest: string, stored: StoredSchedule }>()
    if (!head) return { head, entries }
    const opened = await host.open(head)
    await Promise.all([...opened.files].map(async ([path, digest]) => {
      const stored = parseStored(await opened.read(path))
      if (stored && stored.id === path) entries.set(stored.id, { path, digest, stored })
    }))
    return { head, entries }
  }

  /** Commit one change to the `schedules` ref. `change` returns undefined to skip, for example when the file moved on. */
  async function commit(
    change: (state: Awaited<ReturnType<typeof read>>) => { put?: Record<string, string>, delete?: string[], message: string, metadata: Record<string, unknown> } | undefined,
  ): Promise<boolean> {
    const retained = await host.history()
    for (let attempt = 1; ; attempt++) {
      const state = await read()
      const next = change(state)
      if (!next) return false
      try {
        await retained.commit({
          ref: contentSchedulesRef,
          ifHead: state.head?.id ?? null,
          changes: {
            put: Object.fromEntries(Object.entries(next.put ?? {}).map(([path, text]) => [path, { content: text, mediaType: "application/json" }])),
            delete: next.delete ?? [],
          },
          message: next.message,
          metadata: next.metadata,
        })
        return true
      }
      catch (error) {
        // Another schedule change moved the head. The callback checks its own file again.
        if (isWorkspaceConflict(error) && attempt < maxCommitAttempts) continue
        throw error
      }
    }
  }

  async function schedule(options: ContentScheduleOptions): Promise<ContentSchedule> {
    if (!isOptionsObject(options)) throw invalid("schedule() requires { at, expect }.")
    const now = Date.now()
    const at = readAt(options.at, now)
    const expect = host.expectations("schedule", options.expect)
    if (options.message !== undefined && String(options.message) !== options.message) throw invalid("schedule({ message }) must be a string.")
    const metadata = options.metadata === undefined ? undefined : host.metadata(options.metadata, {})
    if (metadata) delete metadata.content
    // Schedule only what was reviewed: a draft that already moved would fail at its time.
    const digests = await host.digests(expect)
    const mismatches = expect.flatMap((entry, index) => {
      const actual = digests[index]!.draft
      return actual === entry.digest ? [] : [{ collection: entry.collection, id: entry.id, expected: entry.digest, actual }]
    })
    if (mismatches.length) throw host.mismatch("schedule", mismatches)
    if (digests.every(digest => digest.draft === digest.published)) {
      throw invalid(`schedule() has nothing to publish: ${expect.map(entry => contentScheduleKey(entry.collection, entry.id)).join(", ")} ${expect.length === 1 ? "is" : "are"} already published as reviewed.`)
    }
    const stored: StoredSchedule = { id: globalThis.crypto.randomUUID(), at, expect, createdAt: new Date(now).toISOString() }
    if (options.message !== undefined) stored.message = options.message
    if (metadata && Object.keys(metadata).length) stored.metadata = metadata
    await commit(({ entries }) => {
      // One pending schedule per document, so `status()` and the Console show one time.
      for (const { stored: other } of entries.values()) {
        if (other.failure) continue
        const taken = other.expect.find(entry => expect.some(candidate => candidate.collection === entry.collection && candidate.id === entry.id))
        if (taken) {
          throw invalid(`${contentScheduleKey(taken.collection, taken.id)} is already scheduled for ${other.at} by schedule ${JSON.stringify(other.id)}. Call unschedule(${JSON.stringify(other.id)}) first.`)
        }
      }
      return {
        put: { [stored.id]: render(stored) },
        message: `Schedule ${expect.length === 1 ? contentScheduleKey(expect[0]!.collection, expect[0]!.id) : `${expect.length} Content documents`} for ${at}`,
        metadata: host.metadata(options.metadata, { action: "schedule", schedule: stored.id, at, documents: expect.map(({ collection, id }) => ({ collection, id })) }),
      }
    })
    return withStatus(stored, Date.now())
  }

  async function schedules(options: ContentSchedulesOptions = {}): Promise<ContentSchedule[]> {
    if (!isOptionsObject(options)) throw invalid("schedules() options must be an object.")
    for (const key of ["collection", "id", "status"] as const) {
      if (options[key] !== undefined && String(options[key]) !== options[key]) throw invalid(`schedules({ ${key} }) must be a string.`)
    }
    if (options.id !== undefined && options.collection === undefined) {
      throw invalid("schedules({ id }) requires collection.")
    }
    const now = Date.now()
    return [...(await read()).entries.values()]
      .map(({ stored }) => withStatus(stored, now))
      .filter(entry => (options.status === undefined || entry.status === options.status)
        && entry.expect.some(document => (options.collection === undefined || document.collection === options.collection)
          && (options.id === undefined || document.id === options.id)))
      .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id))
  }

  async function unschedule(id: string, options: ContentUnscheduleOptions = {}): Promise<void> {
    if (String(id) !== id || !id) throw invalid("unschedule() requires a schedule id.")
    if (!isOptionsObject(options)) throw invalid("unschedule() options must be an object.")
    let found = false
    await commit(({ entries }) => {
      const entry = entries.get(id)
      if (!entry) return
      found = true
      return {
        delete: [entry.path],
        message: options.message ?? `Unschedule ${entry.stored.at}`,
        metadata: host.metadata(options.metadata, { action: "unschedule", schedule: id, documents: entry.stored.expect.map(({ collection, id: documentId }) => ({ collection, id: documentId })) }),
      }
    })
    if (!found) {
      throw new ViteHubError("CONTENT_NOT_FOUND", `[vitehub] Content schedule ${JSON.stringify(id)} does not exist. It may have run or been removed.`, { details: { schedule: id } })
    }
  }

  async function publishDue(options: ContentPublishDueOptions = {}): Promise<ContentPublishDueResult> {
    if (!isOptionsObject(options)) throw invalid("publishDue() options must be an object.")
    if (options.now !== undefined && (Object.prototype.toString.call(options.now) !== "[object Date]" || Number.isNaN(Number(options.now)))) {
      throw invalid("publishDue({ now }) must be a valid Date.")
    }
    const now = options.now === undefined ? Date.now() : Number(options.now)
    const due = [...(await read()).entries.values()]
      .filter(({ stored }) => !stored.failure && Date.parse(stored.at) <= now)
      .sort((left, right) => left.stored.at.localeCompare(right.stored.at))
    const result: ContentPublishDueResult = { published: [], failed: [] }
    const errors: unknown[] = []
    for (const { path, digest, stored } of due) {
      let published: ContentPublishResult | undefined
      let failure: ContentScheduleFailure | undefined
      try {
        published = await host.publish(stored)
      }
      catch (error) {
        failure = failureOf(error, new Date().toISOString())
        // Anything else, such as an unavailable store, leaves the schedule pending for the next run.
        if (!failure) {
          errors.push(error)
          continue
        }
      }
      const failed: StoredSchedule | undefined = failure ? { ...stored, failure } : undefined
      // Finish only the schedule this run read: a concurrent run or an unschedule() already settled any other version.
      const settled = await commit(({ entries }) => {
        if (entries.get(stored.id)?.digest !== digest) return
        const documents = stored.expect.map(({ collection, id }) => ({ collection, id }))
        return failed
          ? { put: { [path]: render(failed) }, message: `Schedule ${stored.id} failed: ${failed.failure!.code}`, metadata: { content: { action: "schedule-failed", schedule: stored.id, documents } } }
          : { delete: [path], message: `Ran schedule ${stored.id}`, metadata: { content: { action: "schedule-published", schedule: stored.id, revision: published!.revision?.id ?? null, documents } } }
      })
      if (!settled) continue
      if (failed) result.failed.push(withStatus(failed, now))
      else result.published.push({ schedule: stored.id, revision: published!.revision?.id ?? null, documents: published!.documents })
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, `[vitehub] ${errors.length} Content schedules could not run. They stay pending for the next run.`)
    return result
  }

  async function documentSchedules(): Promise<ReadonlyMap<string, ContentDocumentSchedule>> {
    const now = Date.now()
    const result = new Map<string, ContentDocumentSchedule>()
    const ordered = [...(await read()).entries.values()].map(({ stored }) => withStatus(stored, now))
      // Pending and overdue schedules win over failed ones, then the earliest time.
      .sort((left, right) => Number(left.status === "failed") - Number(right.status === "failed") || left.at.localeCompare(right.at))
    for (const entry of ordered) {
      for (const document of entry.expect) {
        const key = contentScheduleKey(document.collection, document.id)
        if (result.has(key)) continue
        const schedule: ContentDocumentSchedule = { id: entry.id, at: entry.at, status: entry.status, digest: document.digest }
        if (entry.failure) schedule.failure = entry.failure
        result.set(key, schedule)
      }
    }
    return result
  }

  return { schedule, schedules, unschedule, publishDue, documentSchedules }
}
