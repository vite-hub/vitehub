import { ConsoleRequestError, requestConsole } from "./request"
import { dayLabel } from "./time"

import type { ConsoleDocumentCollection, ConsoleDocumentSetup } from "../definitions"
import type { ConsoleFieldIssue } from "./schema-form"

// These types mirror the document editor contract in `@vite-hub/internal/console`.

export type ConsoleDocumentState = "draft" | "published" | "changed" | "deleted"

export const consoleDocumentStates: readonly ConsoleDocumentState[] = ["draft", "changed", "published", "deleted"]

/** `overdue`: past its time without a run. `failed`: a draft changed after scheduling, so nothing was published. */
export type ConsoleDocumentScheduleStatus = "pending" | "overdue" | "failed"

/** The scheduled publish of a document. */
export interface ConsoleDocumentSchedule {
  /** When it publishes, as an ISO timestamp. */
  at: string
  failure?: string
  id: string
  status: ConsoleDocumentScheduleStatus
}

export interface ConsoleDocumentScheduled extends ConsoleDocumentSchedule {
  documents: ConsoleDocumentPublishExpectation[]
}

export interface ConsoleDocumentSummary {
  data: Record<string, unknown>
  /** Draft digest, or null for a document deleted on the draft. */
  digest: string | null
  id: string
  path: string
  /** Field issues of the draft. Publish refuses it until they are fixed. */
  issues?: number
  schedule?: ConsoleDocumentSchedule
  state: ConsoleDocumentState
  title: string
  updatedAt: string | null
}

/** A document to publish and the draft digest the user reviewed. */
export interface ConsoleDocumentPublishExpectation {
  digest: string | null
  id: string
}

export interface ConsoleDocumentChange extends ConsoleDocumentPublishExpectation {
  /** Field issues of the draft. Publish all leaves it out. */
  issues?: number
  state: Exclude<ConsoleDocumentState, "published">
}

export interface ConsoleDocumentPage {
  /** Every unpublished change of the collection, before search, state, and filters. */
  changes: ConsoleDocumentChange[]
  facets?: Record<string, Array<{ count: number, value: string }>>
  items: ConsoleDocumentSummary[]
  nextCursor: string | null
  /** Documents with a schedule, before search, state, and filters. */
  scheduled: number
  states: Record<ConsoleDocumentState, number>
  total: number
}

export interface ConsoleDocument {
  body: string
  collection: string
  data: Record<string, unknown>
  digest: string
  id: string
  /** Field issues of a draft saved in progress. It saved, but cannot publish until they are fixed. */
  issues?: ConsoleFieldIssue[]
  path: string
  revision: string
  schedule?: ConsoleDocumentSchedule
  state?: ConsoleDocumentState
  updatedAt: string | null
  /** Public URL path, such as `/blog/hello`, when the collection maps documents to pages. */
  url?: string | null
}

/** One stored file as written, frontmatter included. */
export interface ConsoleRawDocument {
  collection: string
  digest: string
  id: string
  path: string
  revision: string
  text: string
}

export interface ConsoleDocumentRevision {
  action: string
  author?: string
  createdAt: string
  id: string
  message?: string
  ref: string
}

export interface ConsoleDocumentListQuery {
  cursor?: string
  facets?: readonly string[]
  filter?: Record<string, string | readonly string[]>
  limit?: number
  search?: string
  /** Only documents with a schedule. */
  scheduled?: boolean
  sort?: { direction?: "asc" | "desc", field: string }
  state?: ConsoleDocumentState
}

export interface ConsoleDocumentPublished {
  documents: Array<{ change: "add" | "update" | "delete", collection: string, id: string }>
  revision: string | null
}

/** One unpublished change with its title, for the dashboard. */
export interface ConsoleDocumentPendingChange extends ConsoleDocumentChange {
  title: string
  updatedAt: string | null
}

export interface ConsoleDocumentOverviewCollection {
  /** Every unpublished change, most recently changed first. */
  changes: ConsoleDocumentPendingChange[]
  name: string
  /** Every document with a scheduled publish, soonest first. Owners that predate scheduling leave it out. */
  scheduled?: ConsoleDocumentScheduledChange[]
  states: Record<ConsoleDocumentState, number>
}

/** One document with a scheduled publish, for the dashboard. */
export interface ConsoleDocumentScheduledChange {
  id: string
  schedule: ConsoleDocumentSchedule
  title: string
}

/** One recent revision that changed documents. */
export interface ConsoleDocumentActivity {
  action: string
  author?: string
  createdAt: string
  documents: Array<{ collection: string, id: string, title: string }>
  id: string
  ref: string
}

/** Counts, unpublished changes, and recent activity of every readable collection. */
export interface ConsoleDocumentOverview {
  activity: ConsoleDocumentActivity[]
  collections: ConsoleDocumentOverviewCollection[]
}

export interface ConsoleDocumentSearchResult {
  collection: string
  id: string
  state: ConsoleDocumentState
  title: string
  updatedAt: string | null
}

/** The person behind an editor tab. */
export interface ConsoleDocumentSessionUser {
  id: string
  image?: string
  name: string
}

/** One editor tab that has a document open. */
export interface ConsoleDocumentSession {
  collection: string
  id: string
  /** `edit` while it holds the edit lease. `live` for a live room that holds it for everyone in it; `user.name` lists them. */
  kind: "edit" | "live" | "view"
  /** True for this tab. */
  self: boolean
  /** When it started editing, as an ISO timestamp. */
  since: string | null
  user: ConsoleDocumentSessionUser
}

/** Who has one document open, after a session action. */
export interface ConsoleDocumentPresence {
  /** False when the owner cannot track sessions. The editor stays editable. */
  available: boolean
  /** The draft digest now, to reload a clean page that someone else saved. */
  digest?: string | null
  /** Whether this tab may edit. */
  editing: boolean
  holder: ConsoleDocumentSession | null
  /** Whether one tab at a time holds the edit lease. */
  lease: boolean
  now: string
  reason?: string
  sessions: ConsoleDocumentSession[]
  /** The signed-in Console user. */
  user: ConsoleDocumentSessionUser | null
}

/** Every open tab in readable collections. */
export interface ConsoleDocumentSessions {
  available: boolean
  reason?: string
  sessions: ConsoleDocumentSession[]
  user: ConsoleDocumentSessionUser | null
}

export type ConsoleDocumentSessionAction = "acquire" | "release" | "report" | "takeover"

/** The result of each owner document action. */
interface ConsoleDocumentActionResults {
  get: ConsoleDocument | null
  list: ConsoleDocumentPage
  overview: ConsoleDocumentOverview
  search: { items: ConsoleDocumentSearchResult[] }
  publish: ConsoleDocumentPublished
  raw: ConsoleRawDocument | null
  remove: null
  restore: ConsoleDocument
  revisions: { cursor?: string, revisions: ConsoleDocumentRevision[] }
  save: ConsoleDocument
  schedule: ConsoleDocumentScheduled
  session: ConsoleDocumentPresence
  sessions: ConsoleDocumentSessions
  unschedule: null
}

/** The owner document actions of one document editor section, called through the Console RPC transport. */
export interface ConsoleDocumentsClient {
  get(collection: string, id: string): Promise<ConsoleDocument | null>
  list(collection: string, query?: ConsoleDocumentListQuery): Promise<ConsoleDocumentPage>
  /** Counts, unpublished changes, and recent activity of every readable collection, in one request. */
  overview(options?: { activity?: number }): Promise<ConsoleDocumentOverview>
  /** Finds drafts by title, id, fields, and body across every readable collection. */
  search(query: string, options?: { limit?: number, signal?: AbortSignal }): Promise<ConsoleDocumentSearchResult[]>
  /** Publishes exactly these drafts. A draft saved after review fails with a conflict and nothing is published. */
  publish(collection: string, expect: readonly ConsoleDocumentPublishExpectation[]): Promise<ConsoleDocumentPublished>
  /** Reads the stored file on the draft, or at an earlier revision, without validating it. */
  raw(collection: string, id: string, revision?: string): Promise<ConsoleRawDocument | null>
  /** `live` says the tab edits in the live room of the document, which holds the lease for it. */
  remove(collection: string, id: string, ifDigest: string, session?: string, live?: boolean): Promise<null>
  restore(collection: string, id: string, revision: string, ifDigest: string | null, session?: string, live?: boolean): Promise<ConsoleDocument>
  revisions(collection: string, id: string, cursor?: string): Promise<{ cursor?: string, revisions: ConsoleDocumentRevision[] }>
  /** `session` is this tab's token, so its own edit lease does not block the save. */
  save(collection: string, id: string, input: { body: string, data: Record<string, unknown>, ifDigest: string | null, session?: string }): Promise<ConsoleDocument>
  /** Publishes exactly these drafts at `at`, an ISO timestamp. A draft saved after scheduling makes the schedule fail. */
  schedule(collection: string, at: string, expect: readonly ConsoleDocumentPublishExpectation[]): Promise<ConsoleDocumentScheduled>
  /** Cancels a pending schedule, or dismisses a failed one. */
  unschedule(collection: string, schedule: string): Promise<null>
  /** Reports, takes, or releases this tab's session on one document. `keepalive` lets a release outlive the page. */
  session(collection: string, id: string, input: { action: ConsoleDocumentSessionAction, input?: boolean, kind?: "edit" | "view", session: string }, options?: { keepalive?: boolean }): Promise<ConsoleDocumentPresence>
  /** Every open tab in readable collections, or in one. */
  sessions(options?: { collection?: string, session?: string, signal?: AbortSignal }): Promise<ConsoleDocumentSessions>
}

/** Calls the owner document actions of one document editor section. */
export function createConsoleDocumentsClient(base: string, section: string): ConsoleDocumentsClient {
  async function call<TAction extends keyof ConsoleDocumentActionResults>(action: TAction, body: Record<string, unknown>, signal?: AbortSignal, keepalive?: boolean): Promise<ConsoleDocumentActionResults[TAction]> {
    const options: Parameters<typeof requestConsole>[1] = { body, method: "POST", query: { action, section } }
    if (signal) options.signal = signal
    if (keepalive) options.keepalive = true
    const value = await requestConsole(base, options)
    // SAFETY: The owner actions return the mirrored contract for this action. The editor renders fields as text and checks ids before use.
    return value as ConsoleDocumentActionResults[TAction]
  }
  return {
    list: (collection: string, query: ConsoleDocumentListQuery = {}) => call("list", { collection, ...query }),
    overview: (options: { activity?: number } = {}) => call("overview", { ...options }),
    search: async (query: string, options: { limit?: number, signal?: AbortSignal } = {}) =>
      (await call("search", options.limit ? { limit: options.limit, query } : { query }, options.signal)).items,
    get: (collection: string, id: string) => call("get", { collection, id }),
    raw: (collection: string, id: string, revision?: string) => call("raw", revision ? { collection, id, revision } : { collection, id }),
    save: (collection: string, id: string, input: { body: string, data: Record<string, unknown>, ifDigest: string | null, session?: string }) =>
      call("save", { collection, id, ...input }),
    remove: (collection: string, id: string, ifDigest: string, session?: string, live?: boolean) => call("remove", { collection, id, ifDigest, ...(session ? { session } : {}), ...(live ? { live } : {}) }),
    publish: (collection: string, expect: readonly ConsoleDocumentPublishExpectation[]) =>
      call("publish", { collection, expect: expect.map(({ digest, id }) => ({ digest, id })) }),
    revisions: (collection: string, id: string, cursor?: string) =>
      call("revisions", cursor ? { collection, cursor, id } : { collection, id }),
    restore: (collection: string, id: string, revision: string, ifDigest: string | null, session?: string, live?: boolean) =>
      call("restore", { collection, id, ifDigest, revision, ...(session ? { session } : {}), ...(live ? { live } : {}) }),
    schedule: (collection: string, at: string, expect: readonly ConsoleDocumentPublishExpectation[]) =>
      call("schedule", { at, collection, expect: expect.map(({ digest, id }) => ({ digest, id })) }),
    unschedule: (collection: string, schedule: string) => call("unschedule", { collection, schedule }),
    session: (collection: string, id: string, input: { action: ConsoleDocumentSessionAction, input?: boolean, kind?: "edit" | "view", session: string }, options: { keepalive?: boolean } = {}) =>
      call("session", { collection, id, ...input }, undefined, options.keepalive),
    sessions: (options: { collection?: string, session?: string, signal?: AbortSignal } = {}) =>
      call("sessions", { ...(options.collection ? { collection: options.collection } : {}), ...(options.session ? { session: options.session } : {}) }, options.signal),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

/** "Fix 2 fields to publish": why Publish is off for a draft with field issues. */
export function consoleFixFieldsLabel(count: number): string {
  return `Fix ${count === 1 ? "1 field" : `${count} fields`} to publish`
}

/** Returns the field issues of a `CONTENT_INVALID` failure, or undefined for another error. */
export function consoleFieldIssues(error: unknown): ConsoleFieldIssue[] | undefined {
  if (!(error instanceof ConsoleRequestError) || error.failureCode !== "CONTENT_INVALID") return
  const issues = error.details?.issues
  if (!Array.isArray(issues)) return []
  return issues.flatMap((issue) => {
    if (!(issue instanceof Object) || Array.isArray(issue)) return []
    const message: unknown = Reflect.get(issue, "message")
    const field: unknown = Reflect.get(issue, "field")
    const path: unknown = Reflect.get(issue, "path")
    if (String(message) !== message) return []
    const entry: ConsoleFieldIssue = { message, path: Array.isArray(path) ? path.filter(segment => String(segment) === segment || Number.isInteger(segment)) : [] }
    if (String(field) === field) entry.field = field
    return [entry]
  })
}

/** The document a `CONTENT_INVALID` failure names, as `publish` reports a draft that no longer validates. */
export function consoleInvalidDocument(error: unknown): string | undefined {
  if (!(error instanceof ConsoleRequestError) || error.failureCode !== "CONTENT_INVALID") return
  const id = error.details?.id
  return String(id) === id ? id : undefined
}

/** The holder named by a `CONTENT_LEASE_HELD` failure: another tab holds the edit lease. Undefined for another error. */
export function consoleLeaseHolder(error: unknown): { name: string, since: string | null } | undefined {
  if (!(error instanceof ConsoleRequestError) || error.failureCode !== "CONTENT_LEASE_HELD") return
  const holder = error.details?.holder
  const user: unknown = holder instanceof Object ? Reflect.get(holder, "user") : undefined
  const name: unknown = user instanceof Object ? Reflect.get(user, "name") : undefined
  const since: unknown = holder instanceof Object ? Reflect.get(holder, "since") : undefined
  return { name: String(name) === name && name ? name : "Someone", since: String(since) === since ? since : null }
}

export function isConsoleConflict(error: unknown): boolean {
  return error instanceof ConsoleRequestError && error.failureCode === "WORKSPACE_CONFLICT"
}

/** A draft that moved after review, as a publish conflict reports it. `actual` is null when the draft deleted it. */
export interface ConsolePublishMismatch {
  actual: string | null
  expected: string | null
  id: string
}

/** Returns the documents that changed after review, from a publish conflict, or undefined for another error. */
export function consolePublishMismatches(error: unknown): ConsolePublishMismatch[] | undefined {
  if (!isConsoleConflict(error) || !(error instanceof ConsoleRequestError)) return
  const documents = error.details?.documents
  if (!Array.isArray(documents)) return
  return documents.flatMap((entry) => {
    if (!(entry instanceof Object) || Array.isArray(entry)) return []
    const id: unknown = Reflect.get(entry, "id")
    const expected: unknown = Reflect.get(entry, "expected")
    const actual: unknown = Reflect.get(entry, "actual")
    if (String(id) !== id) return []
    return [{ actual: String(actual) === actual ? actual : null, expected: String(expected) === expected ? expected : null, id }]
  })
}

export function consoleErrorMessage(error: unknown, fallback = "The request failed."): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** A document id from a title: lowercase words joined by dashes, such as `hello-world`. */
export function consoleDocumentSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/(^|\/)-+|-+(?=\/|$)/g, "$1")
    .replace(/^\/+|\/+$/g, "")
}

/** Whether the server accepts an id: relative path segments without `.` or `..`. */
export function isConsoleDocumentId(id: string): boolean {
  return Boolean(id) && !id.startsWith("/") && !id.endsWith("/") && !id.includes("\\")
    && id.split("/").every(segment => segment && segment !== "." && segment !== "..")
}

export function stableConsoleJSON(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    const object = record(entry)
    return object && !Array.isArray(entry) ? Object.fromEntries(Object.entries(object).sort(([left], [right]) => left.localeCompare(right))) : entry
  })
}

export function consoleDocumentStateLabel(state: ConsoleDocumentState): string {
  return { changed: "Changed", deleted: "Deleted", draft: "Draft", published: "Published" }[state]
}

/** "Scheduled · Oct 20, 09:00" in the browser time zone, "Overdue · …", or "Schedule failed". */
export function consoleDocumentScheduleLabel(schedule: ConsoleDocumentSchedule, locale?: string): string {
  if (schedule.status === "failed") return "Schedule failed"
  const date = new Date(schedule.at)
  const when = Number.isNaN(date.getTime())
    ? schedule.at
    : `${date.toLocaleDateString(locale, { day: "numeric", month: "short" })}, ${date.toLocaleTimeString(locale, { hour: "2-digit", hour12: false, minute: "2-digit" })}`
  return `${schedule.status === "overdue" ? "Overdue" : "Scheduled"} · ${when}`
}

/**
 * Why a schedule shows its status, for tooltips: when it publishes, why it failed, or, for an overdue one, the fix. The
 * owner names the fix in `setup.schedule` when nothing runs scheduled publishes.
 */
export function consoleDocumentScheduleHint(schedule: ConsoleDocumentSchedule, setup?: ConsoleDocumentSetup, locale?: string): string {
  if (schedule.failure) return `${schedule.failure} Dismiss it from the menu, then schedule again.`
  const when = new Date(schedule.at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
  if (schedule.status === "overdue") {
    const fix = setup?.schedule ? consoleHintText(setup.schedule.message) : "Check that the Schedule that publishes scheduled documents runs on this host."
    return `Was due ${when}. No run has published it yet. ${fix}`
  }
  return `Publishes this draft ${when}. Saving it again before then makes the schedule fail.`
}

/** A setup hint as text and code parts: text in backticks, such as `defineContent()`, is code. */
export function consoleHintParts(message: string): Array<{ code: boolean, text: string }> {
  return message.split("`").map((text, index) => ({ code: index % 2 === 1, text })).filter(part => part.text)
}

/** A setup hint as plain text, for tooltips and menu descriptions. */
export function consoleHintText(message: string): string {
  return message.replaceAll("`", "")
}

/** The status dot of a schedule: a pending one is neutral, an overdue one a warning, and a failed one an error. */
export function consoleDocumentScheduleTone(schedule: ConsoleDocumentSchedule): "error" | "neutral" | "warning" {
  return ({ failed: "error", overdue: "warning", pending: "neutral" } as const)[schedule.status]
}

/**
 * The ISO timestamp of a local date (`2026-10-20`) and time (`09:00`, or `09:00:00` as `Time.toString()` writes it) in the
 * browser time zone, or undefined when the inputs do not name a valid time.
 */
export function consoleLocalScheduleTime(date: string, time: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const clock = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(time)
  if (!match || !clock) return
  const value = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(clock[1]), Number(clock[2]))
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
}

export function consoleDocumentStateColor(state: ConsoleDocumentState): "error" | "neutral" | "success" | "warning" {
  return ({ changed: "warning", deleted: "error", draft: "neutral", published: "success" } as const)[state]
}

/**
 * The name of one document of a collection, for buttons and toasts such as `Post deleted`: the owner `singularLabel`, such
 * as `Person` for People. Without it, `Posts` → `Post` and `Stories` → `Story`, and labels that are not a plain one-word
 * plural become `Document`.
 */
export function consoleSingularLabel(collection: Pick<ConsoleDocumentCollection, "label" | "singularLabel">): string {
  if (collection.singularLabel?.trim()) return collection.singularLabel.trim()
  const word = collection.label.trim()
  if (/\s/.test(word) || !/s$/i.test(word) || /(ss|us|is|news|series)$/i.test(word)) return "Document"
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`
  return word.slice(0, -1)
}

// List view state in the URL: `?q=launch&state=draft&sort=date:desc&filter.category=story`.

/** A state tab, `all`, or `scheduled` for documents with a scheduled publish. */
export type ConsoleListState = ConsoleDocumentState | "all" | "scheduled"

export interface ConsoleListView {
  filters: Record<string, string>
  search: string
  sort: string
  state: ConsoleListState
}

const filterPrefix = "filter."

function queryText(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return String(first) === first && first ? first : undefined
}

/** Reads the list view from a route query. Unknown states, sorts, and filter fields fall back to the defaults. */
export function parseConsoleListQuery(
  query: Readonly<Record<string, unknown>>,
  options: { facets: readonly string[], sorts: readonly string[] },
): ConsoleListView {
  const state = queryText(query.state)
  const sort = queryText(query.sort)
  const filters: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) {
    const name = key.startsWith(filterPrefix) ? key.slice(filterPrefix.length) : undefined
    const text = queryText(value)
    if (name && text && options.facets.includes(name)) filters[name] = text
  }
  return {
    filters,
    search: queryText(query.q) ?? "",
    sort: sort && options.sorts.includes(sort) ? sort : options.sorts[0] ?? "id:asc",
    state: state === "scheduled" ? state : consoleDocumentStates.find(entry => entry === state) ?? "all",
  }
}

/** Writes the list view as a route query, leaving out defaults so a fresh list has a clean URL. */
export function consoleListQuery(view: ConsoleListView, defaultSort: string): Record<string, string> {
  const query: Record<string, string> = {}
  if (view.search.trim()) query.q = view.search.trim()
  if (view.state !== "all") query.state = view.state
  if (view.sort !== defaultSort) query.sort = view.sort
  for (const [name, value] of Object.entries(view.filters).sort(([left], [right]) => left.localeCompare(right))) {
    if (value) query[`${filterPrefix}${name}`] = value
  }
  return query
}

// The list keeps its view when someone opens a document and comes back.
const listQueries = new Map<string, Record<string, string>>()

/** Remembers the list query of a collection, so Back from the editor returns to the same tab, sort, and filters. */
export function rememberConsoleListQuery(collection: string, query: Record<string, string>): void {
  listQueries.set(collection, { ...query })
}

/** The last list query of a collection, or an empty query. */
export function consoleListQueryFor(collection: string): Record<string, string> {
  return { ...listQueries.get(collection) }
}

/** Groups revisions, newest first, under day labels such as `Today` and `Oct 12`. */
export function groupConsoleRevisions(revisions: readonly ConsoleDocumentRevision[], now: number, timeZone?: string): Array<{ label: string, revisions: ConsoleDocumentRevision[] }> {
  const groups: Array<{ label: string, revisions: ConsoleDocumentRevision[] }> = []
  for (const revision of revisions) {
    const label = dayLabel(revision.createdAt, now, timeZone) ?? "Unknown date"
    const last = groups.at(-1)
    if (last?.label === label) last.revisions.push(revision)
    else groups.push({ label, revisions: [revision] })
  }
  return groups
}

/** What a revision did, as History names it: `Saved`, `Published`, `Restored`, `Deleted`, or `Started draft`. */
export function consoleRevisionLabel(revision: ConsoleDocumentRevision): string {
  if (revision.ref === "published" || revision.action === "publish") return "Published"
  return new Map([["remove", "Deleted"], ["restore", "Restored"], ["save", "Saved"], ["seed", "Started draft"]]).get(revision.action) ?? "Changed"
}

export function consoleRevisionTone(revision: ConsoleDocumentRevision): "error" | "neutral" | "success" {
  if (revision.ref === "published" || revision.action === "publish") return "success"
  return revision.action === "remove" ? "error" : "neutral"
}

/** Consecutive saves by one author, newest first. `revisions[0]` is the latest save of the run. */
export interface ConsoleRevisionRun {
  revisions: ConsoleDocumentRevision[]
}

/** Saves further apart than this start a new run, even from the same author. */
const revisionRunGap = 15 * 60_000

/**
 * Collapses consecutive saves by the same author into runs for History. The editor saves a draft after each pause in
 * typing, so one sitting writes many revisions; History shows them as one row. Publishes, restores, deletes, saves by
 * someone else, and saves more than 15 minutes apart each start a new run. Storage keeps every revision.
 */
export function groupConsoleRevisionRuns(revisions: readonly ConsoleDocumentRevision[]): ConsoleRevisionRun[] {
  const runs: ConsoleRevisionRun[] = []
  for (const revision of revisions) {
    const last = runs.at(-1)?.revisions.at(-1)
    const joins = last && revision.action === "save" && last.action === "save" && revision.ref === last.ref && revision.author === last.author
      && Math.abs(Date.parse(last.createdAt) - Date.parse(revision.createdAt)) <= revisionRunGap
    if (joins) runs.at(-1)!.revisions.push(revision)
    else runs.push({ revisions: [revision] })
  }
  return runs
}

export type { ConsoleDocumentCollection }

// Document files

export type ConsoleDocumentFormat = "markdown" | "json" | "yaml"

/** Whether documents of a collection have a Markdown body. JSON and YAML documents are fields only. */
export function consoleDocumentHasBody(collection: Pick<ConsoleDocumentCollection, "format">): boolean {
  return (collection.format ?? "markdown") === "markdown"
}

const ambiguousYamlScalar = /^(?:true|false|yes|no|on|off|y|n|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[\da-f]+|0o[0-7]+|[-+]?\.inf|\.nan)$/i

/** Whether a string can be written as a plain YAML scalar and read back as the same string. */
function isPlainYamlString(value: string): boolean {
  return Boolean(value)
    && value.trim() === value
    && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)
    && ![...value].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7F)
    && !/: | #|:$/.test(value)
    && !ambiguousYamlScalar.test(value)
}

/** A YAML scalar. Strings that would read back differently are quoted as JSON, which YAML also reads. */
function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (String(value) === value) return isPlainYamlString(value) ? value : JSON.stringify(value)
  return JSON.stringify(value)
}

function yamlLines(value: unknown, indent: string): string[] {
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}[]`]
    return value.flatMap((entry) => {
      const nested = yamlBlock(entry, `${indent}  `)
      if (!nested) return [`${indent}- ${yamlScalar(entry)}`]
      // The first key of an object item shares the dash line.
      return Array.isArray(entry) ? [`${indent}-`, ...nested] : [`${indent}- ${nested[0]!.trimStart()}`, ...nested.slice(1)]
    })
  }
  const entries = Object.entries(record(value) ?? {})
  if (!entries.length) return [`${indent}{}`]
  return entries.flatMap(([key, entry]) => {
    const nested = yamlBlock(entry, `${indent}  `)
    return nested ? [`${indent}${yamlScalar(key)}:`, ...nested] : [`${indent}${yamlScalar(key)}: ${yamlScalar(entry)}`]
  })
}

/** Block lines for a non-empty object or list, or undefined for a value that fits on its key's line. */
function yamlBlock(value: unknown, indent: string): string[] | undefined {
  if (Array.isArray(value)) return value.length ? yamlLines(value, indent) : undefined
  const object = record(value)
  return object && Object.keys(object).length ? yamlLines(object, indent) : undefined
}

/**
 * The text of a document in its file format, for diffs: a Markdown file with YAML frontmatter, an indented JSON object,
 * or a YAML mapping. Nested fields become nested YAML blocks, so a change to one nested value is one changed line.
 */
export function consoleDocumentText(version: { body: string, data: Record<string, unknown> }, format: ConsoleDocumentFormat = "markdown"): string {
  if (format === "json") return `${JSON.stringify(version.data, null, 2)}\n`
  const fields = Object.keys(version.data).length ? `${yamlLines(version.data, "").join("\n")}\n` : ""
  if (format === "yaml") return fields || "{}\n"
  // Compare bodies by content, not by a trailing newline that the rich editor drops.
  const body = version.body.endsWith("\n") ? version.body : `${version.body}\n`
  return `${fields ? `---\n${fields}---\n\n` : ""}${body}`
}

// SEO

/** The `x-vitehub-seo` hint of a `seo()` field: lengths that search results and social cards show. */
export interface ConsoleSeoHint {
  description: { min: number, recommended: number }
  title: { recommended: number }
}

export interface ConsoleSeoFallbacks {
  description?: string
  image?: unknown
  title?: string
  /** Document URL path, such as `/blog/hello`. */
  url?: string
}

/** The name and hint of the collection's `seo()` field, found by its `x-vitehub-seo` keyword. */
export function consoleSeoField(schema: Record<string, unknown>): { hint: ConsoleSeoHint, name: string, schema: Record<string, unknown> } | undefined {
  for (const [name, value] of Object.entries(record(schema.properties) ?? {})) {
    const property = record(value)
    const hint = record(property?.["x-vitehub-seo"])
    if (!property || !hint) continue
    const number = (value: unknown, fallback: number) => (Number.isFinite(value) ? Number(value) : fallback)
    const title = record(hint.title) ?? {}
    const description = record(hint.description) ?? {}
    return {
      hint: {
        description: { min: number(description.min, 50), recommended: number(description.recommended, 160) },
        title: { recommended: number(title.recommended, 60) },
      },
      name,
      schema: property,
    }
  }
}

function firstText(data: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = data[field]
    if (String(value) === value && value.trim()) return value.trim()
  }
}

/** What `contentHead()` falls back to when an SEO value is empty: the document title, then its description or summary. */
export function consoleSeoFallbacks(data: Record<string, unknown>, titleField: string | undefined, url: string | null | undefined): ConsoleSeoFallbacks {
  const fallbacks: ConsoleSeoFallbacks = {}
  const title = firstText(data, titleField ? [titleField, "title", "name"] : ["title", "name"])
  const description = firstText(data, ["description", "summary", "excerpt"])
  if (title) fallbacks.title = title
  if (description) fallbacks.description = description
  if (url) fallbacks.url = url
  return fallbacks
}

/**
 * A URL the Console can show for an image value: a URL as is. A Blob reference `{ pathname }` has no URL of its own; the
 * media library resolves it with the served Blob route of the project, and without one the preview shows a placeholder.
 */
export function consoleImageUrl(image: unknown): string | undefined {
  return String(image) === image && image.trim() ? image : undefined
}

/** Text cut to a length on a word boundary with an ellipsis, as search results show it. */
export function consoleTruncate(value: string, length: number): string {
  if (value.length <= length) return value
  const cut = value.slice(0, length + 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > length * 0.6 ? cut.slice(0, space) : value.slice(0, length)).trimEnd()}…`
}
