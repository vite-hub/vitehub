import { and, asc, eq, getTableColumns, gt, lt, max, ne, sql } from "drizzle-orm"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { isRuntimeDiagnostic } from "@vite-hub/runtime"
import * as v from "valibot"

import { accountOf, canonical, fingerprint, jsonReplacer, toJson } from "./canonical.ts"
import { captureChanges } from "./capture.ts"
import { syncChanges, syncMutations, syncState } from "./database.ts"
import { describeSyncTable, isSyncDefinition, syncTableVersion } from "./define.ts"
import { syncErrors } from "./errors.ts"
import { liveResponse, wakeLiveStreams } from "./live.ts"
import { syncPushLimit } from "./protocol.ts"
import { allows, column, decode, mergeSubset, readSubset, readWhere, rowInScope, scopeSql } from "./scope.ts"

import type { SQL } from "drizzle-orm"
import type { BatchItem, BatchResponse } from "drizzle-orm/batch"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import type { SyncDatabase } from "./database.ts"
import type { SyncTable } from "./define.ts"
import type { SyncKey, SyncLiveEvent, SyncMutation, SyncMutationResult, SyncPullResponse, SyncRow, SyncScope, SyncValues, SyncWireError } from "./protocol.ts"
import type { SyncActionContext, SyncActionRows, SyncContext, SyncDefinition, SyncUser } from "./types.ts"

/** The most changes in one pull. A pull with more answers `more: true`. */
const pageSize = 500
/** The largest push body. */
const maxBodyBytes = 1024 * 1024
const day = 86_400_000
/** Applied mutation ids stay this long, so a retry after a lost answer is a `duplicate`. */
const mutationRetention = 7 * day
/** Exits (`delete` and `move` changes) stay this long. A cursor older than the removed ones gets a full snapshot. */
const exitRetention = 30 * day
/** At most one compaction for each name in this time, in one server process. */
const compactionInterval = 3_600_000

/** The signed-in caller, from ViteHub Auth. */
export interface SyncCaller {
  user: SyncUser | null
  session: unknown
}

/** What `handleSyncRequest()` uses. Create it once and pass the same object to each request. */
export interface SyncServices {
  /** The Database of the table. Pass a function when the Database connects per request, as D1 does on Cloudflare. */
  db: SyncDatabase | (() => SyncDatabase)
  /** The signed-in caller of a request. Without it, `user` and `session` are `null`. */
  identify?: (request: Request) => Promise<SyncCaller | null>
  /** Milliseconds since the epoch. Tests pass a fixed clock. */
  now?: () => number
  /**
   * Live streams. `interval` is the time in milliseconds between two checks of the change log (default 1000).
   * `seconds` is the time until the server ends a stream (default 25, which fits the limits of Vercel and Netlify).
   * `calls` is the most Database calls of one stream, where a batch is one call (default 40). A check makes at most 3,
   * and the stream ends before a check that could pass `calls`. The browser then opens a new stream, which is a new
   * Worker invocation. On the Workers Free plan, D1 allows 50 calls in an invocation, so 40 leaves 10 for the session
   * and the trigger checks of the request. On the Workers Paid plan, D1 allows 1000.
   */
  live?: { interval?: number, seconds?: number, calls?: number }
  /**
   * Pushes. `calls` is the most Database calls of one push, where a batch is one call (default 40). A plain write makes
   * 2: the read of its row and its batch. The server applies the mutations in order. Before a call that would leave no
   * room for the answer, it stops, and the mutation that it was checking goes in the next push with the others, which is
   * a new Worker invocation. The budget does not count request setup or stop the first mutation, so a long queue
   * can drain when each mutation fits in its own Worker invocation.
   */
  push?: { calls?: number }
  /**
   * The Sync definitions of the app by name, so an action can write another one with `sync(name)`, and the live stream
   * serves each of them. A ViteHub app passes every definition of `server/sync/`. They all use the Database of `db`.
   */
  definitions?: Readonly<Record<string, Pick<SyncDefinition, "~sync">>>
}

/** What `handleSyncLiveRequest()` uses: the services of every route, with every definition that the stream serves. */
export type SyncLiveServices = SyncServices & Required<Pick<SyncServices, "definitions">>

interface Resolved {
  name: string
  definition: SyncDefinition
  table: SyncTable
  db: SyncDatabase
  now: number
  version: string
  services: SyncServices
  /**
   * The Database calls of the request so far, where a batch is one call, and the most that it may make. Every scope of
   * the request shares it.
   */
  calls: { count: number, limit: number }
}

interface Scoped extends Resolved {
  context: SyncContext
  scope: SyncScope
  account: string
}

/** What the client holds: the base of an incremental pull. */
interface Held {
  cursor?: number | undefined
  scope?: string | undefined
  version?: string | undefined
  /** The client takes a snapshot in pages. */
  paged?: boolean | undefined
  /** The key after which the snapshot of the client goes on. */
  after?: SyncKey | undefined
}

const compactions = new WeakMap<SyncServices, Map<string, number>>()

const headers = { "content-type": "application/json", "cache-control": "private, no-store" }

function json(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body, jsonReplacer), { status, headers: { ...headers, ...extra } })
}

interface Diagnostic {
  code: SyncWireError["code"]
  message: string
  fix?: string | undefined
  docs?: string | undefined
}

/** A refused write: the error and the problems of each field. */
interface Refusal {
  error: Diagnostic
  issues?: SyncWireError["issues"]
}

function wire({ error, issues }: Refusal): SyncWireError {
  return { code: error.code, message: error.message, ...(issues ? { issues } : {}) }
}

function fail(status: number, error: Diagnostic, extra?: Record<string, string>): Response {
  return json(status, { ...wire({ error }), fix: error.fix, docs: error.docs }, extra)
}

function badRequest(message: string, status = 400, extra?: Record<string, string>): Response {
  return fail(status, syncErrors.SYNC_BAD_REQUEST({ message }), extra)
}

function resolveDb(services: SyncServices): SyncDatabase {
  const db = typeof services.db === "function" ? services.db() : services.db
  if (typeof Reflect.get(Object(db), "batch") !== "function") {
    throw syncErrors.SYNC_NO_DATABASE({ message: "[vitehub] Sync needs a SQLite Database with atomic `batch()`, such as libSQL, D1, or the local default Database. This Database has no `batch()`." })
  }
  return db
}

const rowSchema = v.record(v.string(), v.unknown())

/** A row that Sync wrote as JSON itself, such as the stored copy of a deleted row. */
function parseRow(text: string): Record<string, unknown> {
  return v.parse(rowSchema, JSON.parse(text))
}

/** A row as JSON, as the wire has it, to compare it with the scope. */
function rowJson(row: Record<string, unknown>): Record<string, unknown> {
  return parseRow(JSON.stringify(row, jsonReplacer))
}

/** A request that the server refuses before it reads or writes: the HTTP status and the error. */
interface Stop {
  status: number
  error: Diagnostic
}

/**
 * Resolves the scope of the caller: the values of `where`, with the subset of the client. Refuses with 401 or 403 when
 * `where` refuses the caller, and with 403 `SYNC_OUT_OF_SCOPE` when the subset is outside `where`.
 */
async function resolveScope(resolved: Resolved, request: Request, services: SyncServices, subset: SyncValues): Promise<[Stop, undefined] | [undefined, Scoped]> {
  const context = await callerContext(resolved, request, services)
  const [refused, whereValues] = await whereOf(resolved, context)
  if (refused) return [{ status: context.user ? 403 : 401, error: refused.error }, undefined]
  const subsets: readonly string[] = resolved.definition.options.subsets ?? []
  for (const name of Object.keys(subset)) {
    // A subset column needs an index, and a write that changes it must reach the subsets that held the row.
    if (!(name in whereValues) && !subsets.includes(name)) {
      return [{ status: 400, error: syncErrors.SYNC_BAD_REQUEST({ message: `The subset column \`${name}\` is not in \`subsets\`. Add "${name}" to \`subsets\` in \`server/sync/${resolved.name}.ts\`, such as \`defineSync({ subsets: ["${name}"] })\`.` }) }, undefined]
    }
  }
  const [outside, values] = mergeSubset(whereValues, subset)
  if (outside !== undefined) return [{ status: 403, error: syncErrors.SYNC_OUT_OF_SCOPE({ column: outside }) }, undefined]
  await captureScope(resolved, whereValues)
  const scope: SyncScope = { id: await fingerprint(`${resolved.name}\n${canonical(values)}`), values }
  const id = accountId(resolved, context, whereValues)
  const account = id === null ? scope.id : accountOf(id)
  return [undefined, { ...resolved, context, scope, account }]
}

/** The values of `where` for the caller, or the refusal when `where` returns `false`. */
async function whereOf(resolved: Resolved, context: SyncContext): Promise<[Refusal, undefined] | [undefined, SyncValues]> {
  const where: unknown = await resolved.definition.options.where(context)
  if (where === false) return [{ error: context.user ? syncErrors.SYNC_FORBIDDEN({ reason: "where" }) : syncErrors.SYNC_UNAUTHORIZED() }, undefined]
  if (!where || typeof where !== "object" || Array.isArray(where)) {
    throw syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] server/sync/${resolved.name}: \`where\` must return an object of column values, \`{}\`, or \`false\`.` })
  }
  return [undefined, readWhere(resolved.name, resolved.table, where)]
}

/** Before any rows go out or change, the triggers must record a move of each column that the scope uses. */
async function captureScope(resolved: Resolved, whereValues: SyncValues, reserve?: (calls: number) => void): Promise<void> {
  const { table } = resolved
  const subsets: readonly string[] = resolved.definition.options.subsets ?? []
  await captureChanges(resolved.services.db, resolved.db, table.name, column(table, table.key).name, [...new Set([...Object.keys(whereValues), ...subsets])].map(name => column(table, name).name), reserve)
}

/** The definition of a Sync name, for `sync(name)` in an action. */
function definitionOf(scoped: Scoped, name: string): SyncDefinition {
  const { definitions } = scoped.services
  const found: unknown = name === scoped.name ? scoped.definition : definitions && Object.hasOwn(definitions, name) ? definitions[name] : undefined
  if (!isSyncDefinition(found)) throw syncErrors.SYNC_UNKNOWN_NAME({ name })
  return found
}

/**
 * The scope of another definition for the caller of an action: its `where` without a subset. It uses the caller of the
 * action when both definitions identify the caller the same way.
 */
async function otherScope(scoped: Scoped, name: string): Promise<[Refusal, undefined] | [undefined, Scoped]> {
  const { services } = scoped
  const found = definitionOf(scoped, name)
  const table = describeSyncTable(found.options.table)
  const resolved: Resolved = { name, definition: found, table, db: scoped.db, now: scoped.now, version: await syncTableVersion(table), services, calls: scoped.calls }
  const context = found.options.identify === scoped.definition.options.identify ? scoped.context : await callerContext(resolved, scoped.context.request, services)
  const [refused, values] = await whereOf(resolved, context)
  if (refused) return [refused, undefined]
  await captureScope(resolved, values, calls => spend(scoped, calls))
  return [undefined, { ...resolved, context, scope: { id: await fingerprint(`${name}\n${canonical(values)}`), values }, account: scoped.account }]
}

/** The caller: the user of the definition's `identify`, else the ViteHub Auth user and session. */
async function callerContext(resolved: Resolved, request: Request, services: SyncServices): Promise<SyncContext> {
  const { identify } = resolved.definition.options
  if (!identify) {
    const caller = services.identify ? await services.identify(request) : null
    return { request, user: caller?.user ?? null, session: caller?.session ?? null }
  }
  const user: unknown = await identify({ request })
  if (user === null || user === undefined) return { request, user: null, session: null }
  const id: unknown = typeof user === "object" ? Reflect.get(user, "id") : undefined
  if (typeof id !== "string" || !id) {
    throw syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] server/sync/${resolved.name}: \`identify\` must return a user with an \`id\` text, such as \`{ id: session.userId }\`, or \`null\`.` })
  }
  // SAFETY: an object with a text `id` is a `SyncUser`.
  return { request, user: user as SyncUser, session: null }
}

/** The Sync names that warned about their account in this process. */
const accountWarnings = new Set<string>()

function isDevelopment(): boolean {
  const mode = typeof process === "undefined" ? undefined : process.env.NODE_ENV
  return mode !== undefined && mode !== "production"
}

/**
 * The id of the caller's account: `user.id`. `null` makes the scope the account. Queued writes belong to the account,
 * so it must not change when the caller joins or leaves a team.
 */
function accountId(resolved: Resolved, context: SyncContext, where: SyncValues): string | null {
  if (context.user) return context.user.id
  // With `identify`, a caller without a user is a visitor on purpose.
  if (!resolved.definition.options.identify && Object.values(where).some(Array.isArray) && !accountWarnings.has(resolved.name) && isDevelopment()) {
    accountWarnings.add(resolved.name)
    console.warn(`[vitehub] server/sync/${resolved.name}: \`where\` returns a list, such as teams, and the caller has no user, so the account of the queued writes is the scope. When the caller joins or leaves a team, the scope changes, and the browser holds back its queued writes. Return the caller's user from \`identify\` in server/sync/${resolved.name}.ts, such as \`identify: ({ request }) => getUser(request)\`.`)
  }
  return null
}

function headQuery(db: SyncDatabase, table: string) {
  return db.select({ seq: max(syncChanges.seq) }).from(syncChanges).where(eq(syncChanges.tableName, table))
}

type Statement = BatchItem<"sqlite">

/** Statements of a batch, and the answer that their results give. */
interface Part<R> {
  statements: readonly Statement[]
  read: (results: readonly unknown[]) => R
}

function part<const T extends readonly [Statement, ...Statement[]], R>(statements: T, read: (results: BatchResponse<T>) => R): Part<R> {
  // SAFETY: `runParts()` gives each part the results of its own statements, in order.
  return { statements, read: results => read(results as BatchResponse<T>) }
}

/**
 * Runs the statements of every part in one atomic `db.batch()`, so each part reads one moment of the Database. A batch
 * is one Database call: on the Workers Free plan, D1 allows 50 calls in an invocation.
 */
async function runParts<R>(db: SyncDatabase, parts: readonly Part<R>[]): Promise<R[]> {
  const [first, ...rest] = parts.flatMap(item => item.statements)
  if (!first) return []
  const results: readonly unknown[] = await db.batch([first, ...rest])
  let offset = 0
  return parts.map(item => item.read(results.slice(offset, offset += item.statements.length)))
}

function floorQuery(db: SyncDatabase, table: string) {
  return db.select({ floor: syncState.floor }).from(syncState).where(eq(syncState.tableName, table))
}

/** The rows of the scope after `after`, by key, at most one page and one row more. */
function pageQuery(scoped: Scoped, after: SyncKey | undefined) {
  const keyColumn = column(scoped.table, scoped.table.key)
  return scoped.db.select().from(scoped.table.table)
    .where(and(scopeSql(scoped.table, scoped.scope.values), after === undefined ? undefined : gt(keyColumn, after)))
    .orderBy(asc(keyColumn))
    .limit(pageSize + 1)
}

/** One page of rows, and the `after` of the next page, or `null` after the last one. */
function pageOf(rows: Record<string, unknown>[], key: string): { rows: Record<string, unknown>[], after: SyncKey | null } {
  const page = rows.slice(0, pageSize)
  return { rows: page, after: rows.length > pageSize ? String(page.at(-1)![key]) : null }
}

/**
 * A full snapshot of the scope, with the newest `seq` of the table as its cursor. A paged snapshot holds the first page
 * of rows by key.
 */
function snapshotPart(scoped: Scoped, paged = false): Part<SyncPullResponse> {
  const { db, scope, account, version } = scoped
  const { table, name, key, defaults } = scoped.table
  const answer = (state: { floor: number }[], last: { seq: number | null }[]) => ({ key, scope, account, version, defaults, cursor: Math.max(last[0]?.seq ?? 0, state[0]?.floor ?? 0), reset: true, deleted: [] })
  if (paged) {
    return part([floorQuery(db, name), headQuery(db, name), pageQuery(scoped, undefined)], ([state, last, rows]) => {
      const page = pageOf(rows, key)
      return { ...answer(state, last), ...page, more: page.after !== null }
    })
  }
  return part([floorQuery(db, name), headQuery(db, name), db.select().from(table).where(scopeSql(scoped.table, scope.values))], ([state, last, rows]) => (
    { ...answer(state, last), rows, more: false }
  ))
}

/**
 * The next page of a paged snapshot, as the rows are now. It keeps the cursor of the client: the changes since then
 * come with the next pull, so a row that changed during the snapshot is never missed.
 */
function snapshotPagePart(scoped: Scoped, cursor: number, after: SyncKey): Part<SyncPullResponse | undefined> {
  const { db, scope, account, version } = scoped
  const { name, key, defaults } = scoped.table
  return part([floorQuery(db, name), headQuery(db, name), pageQuery(scoped, after)], ([state, last, rows]) => {
    const lowest = state[0]?.floor ?? 0
    const highest = Math.max(last[0]?.seq ?? 0, lowest)
    if (cursor < lowest || cursor > highest) return undefined
    const page = pageOf(rows, key)
    return { key, scope, account, version, defaults, cursor, reset: false, ...page, deleted: [], more: page.after !== null || highest > cursor }
  })
}

/**
 * The changes after the cursor that the client holds, or a full snapshot when the client holds no cursor, another
 * scope, or another version. The answer is `undefined` when the cursor is out of range: then the client needs a snapshot.
 */
function pullPart(scoped: Scoped, held: Held): Part<SyncPullResponse | undefined> {
  const { db, scope, account, version } = scoped
  const { table, name, key, defaults } = scoped.table
  const { cursor } = held
  if (cursor === undefined || held.scope !== scope.id || held.version !== version) return snapshotPart(scoped, held.paged)
  if (held.paged && held.after !== undefined) return snapshotPagePart(scoped, cursor, held.after)
  const keyColumn = column(scoped.table, key)
  const where = scopeSql(scoped.table, scope.values)
  return part([
    floorQuery(db, name),
    headQuery(db, name),
    // `current` is the key of the row when it is in the scope now, so an exit of a row that came back is not sent.
    db.select({ seq: syncChanges.seq, key: syncChanges.key, op: syncChanges.op, row: syncChanges.row, current: keyColumn })
      .from(syncChanges)
      .leftJoin(table, and(eq(keyColumn, syncChanges.key), where))
      .where(and(eq(syncChanges.tableName, name), gt(syncChanges.seq, cursor)))
      .orderBy(asc(syncChanges.seq))
      .limit(pageSize + 1),
    // A join, not `key IN (...)`: the statement has a fixed number of parameters, so D1's limit of 100 never applies.
    // The first `pageSize` puts in scope cover every put in scope of the page above.
    db.select({ row: getTableColumns(table), seq: sql<number>`${syncChanges.seq}`.as("vitehub_sync_seq") })
      .from(table)
      .innerJoin(syncChanges, and(eq(syncChanges.tableName, name), eq(syncChanges.key, keyColumn)))
      .where(and(gt(syncChanges.seq, cursor), eq(syncChanges.op, "put"), where))
      .orderBy(asc(syncChanges.seq))
      .limit(pageSize),
  ], ([state, last, page, puts]) => {
    const lowest = state[0]?.floor ?? 0
    const highest = Math.max(last[0]?.seq ?? 0, lowest)
    // A cursor below the floor missed removed exits. A cursor above the newest change comes from another Database.
    if (cursor < lowest || cursor > highest) return undefined
    const stored = exitValues(scoped.table, scope.values)
    const changes = page.slice(0, pageSize)
    const next = changes.at(-1)?.seq ?? cursor
    const deleted = new Set<SyncKey>()
    for (const change of changes) {
      if (change.op !== "put" && change.current === null && change.row !== null && rowInScope(parseRow(change.row), stored)) deleted.add(change.key)
    }
    return {
      key,
      scope,
      account,
      version,
      defaults,
      cursor: next,
      reset: false,
      rows: puts.filter(put => put.seq <= next).map(put => put.row),
      deleted: [...deleted],
      more: page.length > pageSize,
    }
  })
}

/**
 * Pulls several stores in one Database call, a batch, so the cursor and the rows of each pull match. A store whose
 * cursor is out of range gets its snapshot in one more call. `calls` is the number of calls, 0 to 2.
 */
async function pullAll(db: SyncDatabase, pulls: readonly { scoped: Scoped, held: Held }[]): Promise<{ answers: SyncPullResponse[], calls: number }> {
  const answers = await runParts(db, pulls.map(({ scoped, held }) => pullPart(scoped, held)))
  const snapshots = await runParts(db, pulls.flatMap(({ scoped, held }, index) => answers[index] ? [] : [snapshotPart(scoped, held.paged)]))
  const calls = (pulls.length ? 1 : 0) + (snapshots.length ? 1 : 0)
  return { answers: answers.map(answer => answer ?? snapshots.shift()!), calls }
}

async function pull(scoped: Scoped, held: Held): Promise<SyncPullResponse> {
  const { answers: [answer] } = await pullAll(scoped.db, [{ scoped, held }])
  return answer!
}

function rejected(id: string, refusal: Refusal): SyncMutationResult {
  return { id, status: "rejected", error: wire(refusal) }
}

function invalid(message: string, issues?: SyncWireError["issues"]): Refusal {
  return { error: syncErrors.SYNC_INVALID({ message }), ...(issues ? { issues } : {}) }
}

function issuePath(path: readonly (PropertyKey | { key: PropertyKey })[] | undefined): string | undefined {
  if (!path?.length) return undefined
  return path.map(segment => String(typeof segment === "object" ? segment.key : segment)).join(".")
}

/**
 * The SQL of a column in a row as JSON: the value that the column stores. A blob (JSON or bigint) is its text, because
 * JSON cannot hold a blob. The triggers write exits the same way.
 */
function storedSql(target: SQLiteColumn): SQL {
  if (target.getSQLType() === "blob" || target.columnType.startsWith("SQLiteNumeric")) return sql`cast(${target} as text)`
  return sql`${target}`
}

/** A JSON value of a column as an exit stores it. See `storedSql()`. */
function storedValue(table: SyncTable, name: string, value: unknown): unknown {
  if (value === null || value === undefined) return null
  const target = column(table, name)
  const stored: unknown = target.mapToDriverValue(decode(table, name, value))
  if (stored instanceof Uint8Array) return new TextDecoder().decode(stored)
  if (typeof stored === "boolean") return stored ? 1 : 0
  if (typeof stored === "bigint") return Number.isSafeInteger(Number(stored)) ? Number(stored) : stored.toString()
  return toJson(stored) ?? null
}

/**
 * Scope values as an exit stores them, by SQL column name, so `rowInScope()` can compare them with an exit. The
 * triggers write exits, and they know the SQL names of the columns only.
 */
function exitValues(table: SyncTable, values: SyncValues): SyncValues {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [column(table, name).name, Array.isArray(value) ? value.map(item => storedValue(table, name, item)) : storedValue(table, name, value)]))
}

function literal(text: string): SQL {
  return sql.raw(`'${text.replaceAll("'", "''")}'`)
}

/**
 * The row as a JSON object, in SQL. Before version 3.48, SQLite allows at most 127 arguments to a function, so a wide
 * table is built in parts. `json_patch()` drops the `null` values of a later part, and a missing column reads as `null`.
 */
function rowObjectSql(table: SyncTable): SQL {
  const pairs = Object.entries(table.columns).map(([name, target]) => sql`${literal(name)}, ${storedSql(target)}`)
  let object: SQL | undefined
  for (let start = 0; start < pairs.length; start += 60) {
    const part = sql`json_object(${sql.join(pairs.slice(start, start + 60), sql`, `)})`
    object = object ? sql`json_patch(${object}, ${part})` : part
  }
  return object ?? sql`json_object()`
}

/**
 * The rows that the checks of one mutation read, as JSON text, or `null` when no row was there. The batch applies only
 * when each of these reads gives the same answer, so a write that ran at the same time cannot pass a check that it
 * changed. See `guardSql()`.
 */
type Reads = Map<string, { scoped: Scoped, key: SyncKey, scopedOnly: boolean, json: string | null }>

async function readRow(scoped: Scoped, key: SyncKey, scopedOnly: boolean, reads?: Reads): Promise<Record<string, unknown> | undefined> {
  const { db, table } = scoped
  spend(scoped)
  const [found] = await db.select({ row: getTableColumns(table.table), json: sql<string>`${rowObjectSql(table)}` }).from(table.table)
    .where(and(eq(column(table, table.key), key), scopedOnly ? scopeSql(table, scoped.scope.values) : undefined))
    .limit(1)
  const read = `${scoped.name}:${scoped.scope.id}:${scopedOnly ? "scoped" : "any"}:${key}`
  if (reads && !reads.has(read)) reads.set(read, { scoped, key, scopedOnly, json: found?.json ?? null })
  return found?.row
}

/**
 * True in SQL while every read of `reads`, of any table, gives the same answer as when the checks ran. The reads of one
 * table go in one `json_each()` parameter, so the guard has the same number of parameters for any number of rows. D1
 * allows at most 100 in a statement.
 */
function guardSql(reads: Reads): SQL | undefined {
  // The rows that were there, by definition, as `[key, row JSON]`. The keys that were not, by table and scope.
  const found = new Map<string, { table: SyncTable, rows: [SyncKey, string][] }>()
  const missing = new Map<string, { table: SyncTable, values: SyncValues | undefined, keys: SyncKey[] }>()
  for (const { scoped: { name, table, scope }, key, scopedOnly, json } of reads.values()) {
    if (json !== null) {
      // By definition, not by table: two definitions of one table can have other columns, so other row JSON.
      let group = found.get(name)
      if (!group) found.set(name, group = { table, rows: [] })
      group.rows.push([key, json])
      continue
    }
    const id = scopedOnly ? `${table.name}\n${scope.id}` : table.name
    let group = missing.get(id)
    if (!group) missing.set(id, group = { table, values: scopedOnly ? scope.values : undefined, keys: [] })
    group.keys.push(key)
  }
  const read = sql.identifier("vitehub_read")
  const guards: SQL[] = []
  for (const { table, rows } of found.values()) {
    const target: SQLiteTable = table.table
    guards.push(sql`NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(rows)}) AS ${read} WHERE NOT EXISTS (SELECT 1 FROM ${target} WHERE ${column(table, table.key)} = json_extract(${read}.value, '$[0]') AND ${rowObjectSql(table)} = json_extract(${read}.value, '$[1]')))`)
  }
  for (const { table, values, keys } of missing.values()) {
    const target: SQLiteTable = table.table
    guards.push(sql`NOT EXISTS (SELECT 1 FROM ${target} WHERE ${and(sql`${column(table, table.key)} IN (SELECT value FROM json_each(${JSON.stringify(keys)}))`, values ? scopeSql(table, values) : undefined)})`)
  }
  return guards.length ? and(...guards) : undefined
}

/**
 * The ledger entry of a mutation, with the JSON result of an action, so a retry gets the same result. With a guard, it
 * stores no name when a read changed: the `NOT NULL` column then fails the statement, and with it the whole batch, so
 * no write of the mutation applies.
 */
function ledgerStatement({ db, name, now }: Scoped, id: string, guard: SQL | undefined, result: unknown): Statement {
  const text = result === undefined ? null : JSON.stringify(result)
  if (!guard) return db.insert(syncMutations).values({ id, name, result: text, createdAt: now })
  return db.run(sql`INSERT INTO ${syncMutations} (${sql.identifier("id")}, ${sql.identifier("name")}, ${sql.identifier("result")}, ${sql.identifier("created_at")}) VALUES (${id}, CASE WHEN ${guard} THEN ${name} END, ${text}, ${now})`)
}

async function guardHolds(scoped: Scoped, guard: SQL): Promise<boolean> {
  spend(scoped)
  const row = await scoped.db.get<{ ok: number }>(sql`SELECT CASE WHEN ${guard} THEN 1 ELSE 0 END AS ok`)
  return row?.ok === 1
}

/**
 * The message of a SQLite error that comes from the row itself, such as a `NOT NULL` column without a value. The same
 * row fails the same way each time, so the mutation is rejected and the push goes on.
 */
function rowErrorMessage(error: unknown): string | undefined {
  for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 5; cause = Reflect.get(cause, "cause"), depth++) {
    const message: unknown = Reflect.get(cause, "message")
    const code: unknown = Reflect.get(cause, "code")
    if (typeof message === "string" && /constraint failed|datatype mismatch/i.test(message)) return message.replace(/^D1_ERROR:\s*/, "")
    if (typeof code === "string" && /^SQLITE_(CONSTRAINT|MISMATCH)/.test(code) && typeof message === "string") return message
  }
  return undefined
}

/** The rows that earlier writes of the same action changed: the row, or `null` after a delete. */
type Overlay = Map<SyncKey, Record<string, unknown> | null>

async function currentRow(scoped: Scoped, overlay: Overlay, key: SyncKey, scopedOnly: boolean, reads: Reads): Promise<Record<string, unknown> | undefined> {
  if (!overlay.has(key)) return await readRow(scoped, key, scopedOnly, reads)
  const row = overlay.get(key)
  if (!row || (scopedOnly && !rowInScope(rowJson(row), scoped.scope.values))) return undefined
  return row
}

/**
 * Checks the columns of a write, and returns the values as Drizzle wants them, or a refusal. A single value of the
 * scope must stay as it is. A column with a list in the scope may take any value of the list.
 */
function readColumns(scoped: Scoped, input: SyncRow, key: SyncKey | undefined): [Refusal, undefined] | [undefined, Record<string, unknown>] {
  const { table, scope } = scoped
  const values: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (!(name in table.columns)) return [invalid(`\`${name}\` is not a column of the table "${table.name}".`), undefined]
    if (name === table.key && key !== undefined && value !== key) return [invalid(`The primary key \`${name}\` cannot change.`), undefined]
    if (name in scope.values && !allows(scope.values[name], value)) return [{ error: syncErrors.SYNC_OUT_OF_SCOPE({ column: name }) }, undefined]
    try {
      values[name] = decode(table, name, value)
      if (values[name] instanceof Date && !Number.isFinite(values[name].getTime())) return [invalid(`Invalid date for column ${name}.`), undefined]
    }
    catch {
      return [invalid(`\`${name}\` has a value that the column cannot store.`), undefined]
    }
  }
  return [undefined, values]
}

async function check(scoped: Scoped, op: "insert" | "update" | "delete", row: Record<string, unknown>): Promise<Refusal | undefined> {
  const { schema, write } = scoped.definition.options
  // Safe by default: a visitor writes only when `write` allows it.
  if (write === undefined && !scoped.context.user) return { error: syncErrors.SYNC_FORBIDDEN({ reason: "visitor" }) }
  if (schema && op !== "delete") {
    const result = await schema["~standard"].validate(row)
    if (result.issues) {
      return invalid("The row does not match the schema of this Sync definition.", result.issues.map(issue => ({ message: issue.message, ...(issuePath(issue.path) ? { path: issuePath(issue.path) } : {}) })))
    }
  }
  if (typeof write === "function" && !await write({ ...scoped.context, op, row })) return { error: syncErrors.SYNC_FORBIDDEN({ reason: "write" }) }
  return undefined
}

/** One row write, from the browser or from an action. */
type Write =
  | { op: "insert", value: SyncRow }
  | { op: "update", key: SyncKey, patch: SyncRow }
  | { op: "delete", key: SyncKey }

/**
 * Checks one write with the rules of the definition, and returns the statements that apply it. The triggers of the
 * table write its change log entries. `overlay` holds the rows that earlier writes of the same action changed, and
 * gets this write.
 */
async function plan(scoped: Scoped, write: Write, overlay: Overlay, reads: Reads): Promise<[Refusal, undefined] | [undefined, Statement[]]> {
  const { db, table, scope } = scoped
  const keyColumn = column(table, table.key)
  const target: SQLiteTable = table.table
  if (write.op === "insert") {
    const key: unknown = write.value[table.key]
    if (typeof key !== "string" || !key) return [invalid(`An insert needs the primary key \`${table.key}\` as a text value, such as \`crypto.randomUUID()\`.`), undefined]
    const [refused, values] = readColumns(scoped, write.value, undefined)
    if (refused) return [refused, undefined]
    const row = { ...values }
    for (const [name, value] of Object.entries(scope.values)) {
      if (!Array.isArray(value)) row[name] = decode(table, name, value)
      // A list does not say which value to use, such as which team: the client must set one.
      else if (!(name in row)) return [{ error: syncErrors.SYNC_OUT_OF_SCOPE({ column: name }) }, undefined]
    }
    if (await currentRow(scoped, overlay, key, false, reads)) return [{ error: syncErrors.SYNC_KEY_EXISTS({ key }) }, undefined]
    const stopped = await check(scoped, "insert", row)
    if (stopped) return [stopped, undefined]
    overlay.set(key, row)
    return [undefined, [db.insert(target).values(row)]]
  }
  const { key } = write
  if (typeof key !== "string" || !key) return [invalid("An update or a delete needs `key`."), undefined]
  const current = await currentRow(scoped, overlay, key, true, reads)
  const inScope = and(eq(keyColumn, key), scopeSql(table, scope.values))
  if (write.op === "delete") {
    // Deleting a missing row changes nothing, so a repeated delete is not an error.
    if (!current) return [undefined, []]
    const stopped = await check(scoped, "delete", current)
    if (stopped) return [stopped, undefined]
    overlay.set(key, null)
    return [undefined, [db.delete(target).where(inScope)]]
  }
  if (!current) return [{ error: syncErrors.SYNC_NOT_FOUND({ message: `No row with the key ${JSON.stringify(key)} is in the scope of the caller.` }) }, undefined]
  const [refused, values] = readColumns(scoped, write.patch, key)
  if (refused) return [refused, undefined]
  const { [table.key]: _key, ...patch } = values
  const row = { ...current, ...patch }
  const stopped = await check(scoped, "update", row)
  if (stopped) return [stopped, undefined]
  if (!Object.keys(patch).length) return [undefined, []]
  overlay.set(key, row)
  return [undefined, [db.update(target).set(patch).where(inScope)]]
}

/** Thrown before a Database call that would pass the call budget of a push. The mutation then goes in the next push. */
const deferred = new Error("The push reached its Database call budget.")

function spend(scoped: Scoped, calls = 1): void {
  if (scoped.calls.count + calls > scoped.calls.limit) {
    scoped.calls.limit = scoped.calls.count
    throw deferred
  }
  scoped.calls.count += calls
}

function duplicateOf(id: string, result: string | null): SyncMutationResult {
  return result === null ? { id, status: "duplicate" } : { id, status: "duplicate", result: JSON.parse(result) }
}

/** The answer for a mutation id that the server applied before, with the stored result of an action, or `undefined`. */
async function duplicate(scoped: Scoped, id: string): Promise<SyncMutationResult | undefined> {
  spend(scoped)
  const [done] = await scoped.db.select({ result: syncMutations.result }).from(syncMutations).where(eq(syncMutations.id, id)).limit(1)
  return done ? duplicateOf(id, done.result) : undefined
}

/**
 * The mutation ids of a push that the server applied before, with their answers, in one Database call. The ids are one
 * `json_each()` parameter, so D1's limit of 100 parameters never applies.
 */
async function duplicates(scoped: Scoped, ids: readonly string[]): Promise<Map<string, SyncMutationResult>> {
  if (!ids.length) return new Map()
  spend(scoped)
  const done = await scoped.db.select({ id: syncMutations.id, result: syncMutations.result }).from(syncMutations)
    .where(sql`${syncMutations.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`)
  return new Map(done.map(({ id, result }) => [id, duplicateOf(id, result)]))
}

/** An action as the handler calls it, with a loose row type. */
type LooseAction = (context: SyncActionContext<Record<string, unknown>>, args: unknown) => unknown

function isAction(value: unknown): value is LooseAction {
  return typeof value === "function"
}

function errorIssues(error: unknown): SyncWireError["issues"] {
  const issues: unknown = error && typeof error === "object" ? Reflect.get(error, "issues") : undefined
  if (!Array.isArray(issues) || !issues.length) return undefined
  const found: NonNullable<SyncWireError["issues"]> = []
  for (const issue of issues) {
    const message: unknown = issue && typeof issue === "object" ? Reflect.get(issue, "message") : undefined
    if (typeof message !== "string") return undefined
    const path: unknown = Reflect.get(issue, "path")
    const text = Array.isArray(path) ? issuePath(path.map(segment => segment && typeof segment === "object" && "key" in segment ? { key: String(segment.key) } : String(segment))) : undefined
    found.push({ message, ...(text ? { path: text } : {}) })
  }
  return found
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const status: unknown = Reflect.get(error, "status") ?? Reflect.get(error, "statusCode")
  return typeof status === "number" ? status : undefined
}

/** What `refuse()` of an action throws. Its message is meant for the caller. */
// `refuse()` throws this local control value; `actionRefusal()` turns it into a diagnostic for the caller.
class ActionRefusal {
  constructor(readonly message: string) {}
}

/**
 * The refusal for an error that an action threw. `refuse()` gives its message. A ViteHub Diagnostic, an HTTP error below 500, and a schema error
 * with `issues` (such as from `v.parse()`) are meant for the caller, so their message goes to the browser. Any other
 * error can hold server details: the browser gets "The action failed.", and the server log gets the error.
 */
function actionRefusal(name: string, error: unknown): Refusal {
  if (error instanceof ActionRefusal) return { error: syncErrors.SYNC_ACTION_REFUSED({ message: error.message }) }
  const issues = errorIssues(error)
  const status = httpStatus(error)
  const message: unknown = error instanceof Error ? error.message : undefined
  if (typeof message === "string" && message && (isRuntimeDiagnostic(error) || (status !== undefined && status < 500) || issues)) {
    return { error: syncErrors.SYNC_ACTION_REFUSED({ message }), ...(issues ? { issues } : {}) }
  }
  console.error(`[vitehub] The Sync action "${name}" failed.`, error)
  return { error: syncErrors.SYNC_ACTION_REFUSED({ message: "The action failed." }) }
}

/**
 * Runs an action: it collects the writes, checks each with the rules of browser writes of its definition, and applies
 * them with the ledger entry in one atomic batch. One refused write refuses the whole action. `tables` has the other
 * tables that the writes change.
 */
async function runAction(scoped: Scoped, mutation: Extract<SyncMutation, { op: "action" }>, reads: Reads): Promise<[Refusal, undefined] | [undefined, { statements: Statement[], result: unknown, tables: Set<string> }]> {
  const actions: unknown = scoped.definition.options.actions
  const action: unknown = actions && typeof actions === "object" && Object.hasOwn(actions, mutation.name) ? Reflect.get(actions, mutation.name) : undefined
  if (!isAction(action)) return [invalid(`This Sync definition has no action named ${JSON.stringify(mutation.name)}.`), undefined]
  // `undefined` is the definition of the action, with the subset of the push.
  const writes: { target: string | undefined, write: Write }[] = []
  // The scopes of other definitions, by name. Each one resolves once, when the action reads or writes it first.
  const others = new Map<string, Promise<[Refusal, undefined] | [undefined, Scoped]>>()
  const scopeOf = (target: string) => {
    let found = others.get(target)
    if (!found) others.set(target, found = otherScope(scoped, target))
    return found
  }
  let open = true
  const rows = (target: string | undefined, keyColumn: string, get: SyncActionRows<Record<string, unknown>>["get"]): SyncActionRows<Record<string, unknown>> => {
    const collect = (write: Write) => {
      if (!open) throw syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] The Sync action "${mutation.name}" wrote after it returned. Await every write before the action returns.` })
      writes.push({ target, write })
    }
    return {
      get,
      insert: (value) => {
        const given: unknown = value[keyColumn]
        const key = typeof given === "string" && given ? given : crypto.randomUUID()
        collect({ op: "insert", value: { ...value, [keyColumn]: key } })
        return key
      },
      update: (key, patch) => collect({ op: "update", key, patch }),
      delete: key => collect({ op: "delete", key }),
    }
  }
  const context: SyncActionContext<Record<string, unknown>> = {
    ...scoped.context,
    ...rows(undefined, scoped.table.key, async key => await readRow(scoped, key, true, reads)),
    // SAFETY: the handler reads and writes every table with loose rows. The type of each name comes from its table.
    sync: ((name: string) => {
      const found = definitionOf(scoped, name)
      return rows(name, describeSyncTable(found.options.table).key, async (key) => {
        const [refused, other] = await scopeOf(name)
        // The action cannot read rows that `where` hides from the caller. Its writes to them are refused later.
        return refused ? undefined : await readRow(other, key, true, reads)
      })
    }) as SyncActionContext<Record<string, unknown>>["sync"],
    refuse: (message) => {
      throw new ActionRefusal(message)
    },
  }
  let result: unknown
  try {
    result = await action(context, mutation.args)
  }
  catch (error) {
    if (error === deferred) throw error
    return [actionRefusal(mutation.name, error), undefined]
  }
  finally {
    open = false
  }
  // One overlay for each table, so two definitions of one table see the earlier writes of each other.
  const overlays = new Map<string, Overlay>()
  const statements: Statement[] = []
  const tables = new Set<string>()
  for (const { target, write } of writes) {
    const [refused, into] = target === undefined ? [undefined, scoped] : await scopeOf(target)
    if (refused) return [refused, undefined]
    // `write: false` stops the writes of the browser and of the actions of other definitions, not of its own actions.
    if (into.name !== scoped.name && into.definition.options.write === false) return [{ error: syncErrors.SYNC_READ_ONLY() }, undefined]
    let overlay = overlays.get(into.table.name)
    if (!overlay) overlays.set(into.table.name, overlay = new Map())
    const [stopped, planned] = await plan(into, write, overlay, reads)
    if (stopped) return [stopped, undefined]
    statements.push(...planned)
    if (into.table.name !== scoped.table.name) tables.add(into.table.name)
  }
  return [undefined, { statements, result: toJson(result), tables }]
}

/** Attempts of one mutation whose reads changed before its batch ran. Then the push fails, and the client retries. */
const maxConflicts = 3

/**
 * Applies one mutation in one atomic batch. The ledger insert comes first, so a mutation id that is there already fails
 * the whole batch, and the rows stay as they are. When a write that ran at the same time changed a row that the checks
 * read, the batch fails, and the mutation is checked again from the start.
 */
async function apply(scoped: Scoped, mutation: SyncMutation, touched: Set<string>, applied: Map<string, SyncMutationResult>): Promise<SyncMutationResult> {
  const { id } = mutation
  const before = applied.get(id)
  if (before) return before
  // An action is server code, so `write: false` does not stop the writes of the definition's own actions.
  if (mutation.op !== "action" && scoped.definition.options.write === false) return rejected(id, { error: syncErrors.SYNC_READ_ONLY() })
  // `applied` was read when the push started. A push that runs at the same time can apply the id after that, and then
  // its row makes the checks refuse the mutation.
  const refuse = async (refusal: Refusal) => await duplicate(scoped, id) ?? rejected(id, refusal)
  for (let attempt = 1; ; attempt++) {
    const reads: Reads = new Map()
    let statements: Statement[]
    let result: unknown
    let tables = new Set<string>()
    if (mutation.op === "action") {
      const [refused, done] = await runAction(scoped, mutation, reads)
      if (refused) return await refuse(refused)
      statements = done.statements
      result = done.result
      tables = done.tables
    }
    else {
      const [refused, planned] = await plan(scoped, mutation, new Map(), reads)
      if (refused) return await refuse(refused)
      statements = planned
    }
    const guard = guardSql(reads)
    spend(scoped)
    try {
      await scoped.db.batch([ledgerStatement(scoped, id, guard, result), ...statements])
      for (const table of tables) touched.add(table)
      applied.set(id, result === undefined ? { id, status: "duplicate" } : { id, status: "duplicate", result })
      return result === undefined ? { id, status: "applied" } : { id, status: "applied", result }
    }
    catch (error) {
      // A push that runs at the same time applied the same id first.
      const raced = await duplicate(scoped, id)
      if (raced) return raced
      if (guard && !await guardHolds(scoped, guard)) {
        if (attempt < maxConflicts) continue
        throw syncErrors.SYNC_SERVER_ERROR({ message: `Other writes changed the rows of the mutation ${JSON.stringify(id)} ${maxConflicts} times while it was checked. Send it again.` })
      }
      const message = rowErrorMessage(error)
      if (message) return rejected(id, invalid(`The Database refused the row: ${message}`))
      throw error
    }
  }
}

/**
 * Removes applied mutation ids of the definition after 7 days and exits of its table after 30 days, and raises the
 * floor of the table to the highest removed `seq`, so an older cursor gets a full snapshot. Exits have the time of the
 * Database, because the triggers write them.
 */
async function compact(scoped: Scoped): Promise<void> {
  const { db, name, now } = scoped
  spend(scoped)
  const table = scoped.table.name
  const removable = and(eq(syncChanges.tableName, table), ne(syncChanges.op, "put"), lt(syncChanges.createdAt, now - exitRetention))
  await db.batch([
    db.delete(syncMutations).where(and(eq(syncMutations.name, name), lt(syncMutations.createdAt, now - mutationRetention))),
    db.run(sql`INSERT INTO ${syncState} (${sql.identifier("table_name")}, ${sql.identifier("floor")}) SELECT ${table}, max(${syncChanges.seq}) FROM ${syncChanges} WHERE ${removable} HAVING max(${syncChanges.seq}) IS NOT NULL ON CONFLICT (${sql.identifier("table_name")}) DO UPDATE SET ${sql.identifier("floor")} = max(${sql.identifier("floor")}, excluded.${sql.identifier("floor")})`),
    db.delete(syncChanges).where(removable),
  ])
}

async function maybeCompact(scoped: Scoped, services: SyncServices): Promise<void> {
  let last = compactions.get(services)
  if (!last) compactions.set(services, last = new Map())
  const previous = last.get(scoped.name)
  if (previous !== undefined && scoped.now - previous < compactionInterval) return
  last.set(scoped.name, scoped.now)
  await compact(scoped)
}

const mutationId = v.pipe(v.string(), v.minLength(1), v.maxLength(200))

const mutationSchema = v.variant("op", [
  v.object({ id: mutationId, op: v.literal("insert"), value: v.record(v.string(), v.unknown()) }),
  v.object({ id: mutationId, op: v.literal("update"), key: v.pipe(v.string(), v.minLength(1)), patch: v.record(v.string(), v.unknown()) }),
  v.object({ id: mutationId, op: v.literal("delete"), key: v.pipe(v.string(), v.minLength(1)) }),
  v.object({ id: mutationId, op: v.literal("action"), name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)), args: v.optional(v.unknown()) }),
])

const pushSchema = v.object({
  account: v.string(),
  cursor: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  scope: v.optional(v.string()),
  version: v.optional(v.string()),
  where: v.optional(v.unknown()),
  paged: v.optional(v.boolean()),
  after: v.optional(v.pipe(v.string(), v.minLength(1))),
  mutations: v.array(v.unknown()),
})

/** Reads at most `limit` bytes, so a large body without `content-length` stops early. */
async function readText(request: Request, limit: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return undefined
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  const decoder = new TextDecoder()
  return chunks.map(chunk => decoder.decode(chunk, { stream: true })).join("") + decoder.decode()
}

function parseCursor(value: string | null): number | undefined | false {
  if (value === null || value === "") return undefined
  return /^\d{1,15}$/.test(value) ? Number(value) : false
}

/** Reads `?where=` of a pull or a live stream. */
function parseSubsetQuery(table: SyncTable, value: string | null): [string, undefined] | [undefined, SyncValues] {
  if (value === null || value === "") return [undefined, {}]
  let input: unknown
  try {
    input = JSON.parse(value)
  }
  catch {
    return ["`where` must be JSON, such as `{\"issueId\":\"i1\"}`.", undefined]
  }
  return readSubset(table, input)
}

/**
 * Reads the JSON body of a `POST`: at most 1 MB, from the app's own origin. A cross-site page cannot send JSON without
 * a preflight, and a browser always sends `Origin` on POST.
 */
async function readJson(request: Request, what: string, smaller: string): Promise<[Response, undefined] | [undefined, unknown]> {
  const origin = request.headers.get("origin")
  if (origin && origin !== forwardedRequestOrigin(request)) return [fail(403, syncErrors.SYNC_FORBIDDEN({ reason: "origin" })), undefined]
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return [badRequest(`Send the ${what} as JSON.`, 415), undefined]
  const text = await readText(request, maxBodyBytes)
  if (text === undefined) return [badRequest(`The ${what} is larger than ${maxBodyBytes} bytes. ${smaller}`, 413), undefined]
  try {
    return [undefined, JSON.parse(text)]
  }
  catch {
    return [badRequest("The body is not JSON."), undefined]
  }
}

const liveSchema = v.object({
  pulls: v.array(v.object({
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    where: v.optional(v.record(v.string(), v.unknown())),
    cursor: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    scope: v.optional(v.string()),
    version: v.optional(v.string()),
    paged: v.optional(v.boolean()),
  })),
})

/** One store of a live stream. */
interface LiveEntry {
  scoped: Scoped
  held: Held
  /** The name and subset of the store, as the client sent them. Each event of the store has them. */
  store: { name: string, where?: SyncValues }
  /** `true` while the server has more changes for the store than its last pull had. */
  more: boolean
}

/**
 * Answers the live stream of several stores: `POST <base>_vitehub/sync` with a `SyncLiveRequest`. Each store is
 * checked as its pull is, with the `where` of its definition. A store that the caller may not see gets an `error`
 * event, and the others stream on. One read of the change log each interval serves every store of the stream, and one
 * batch pulls the stores whose table changed. The stream ends before it could pass `services.live.calls`.
 */
export async function handleSyncLiveRequest(request: Request, services: SyncLiveServices): Promise<Response> {
  const { definitions } = services
  const shape = "`{ pulls: [{ name, where?, cursor?, scope?, version? }] }`"
  if (request.method !== "POST") return badRequest(`Open a live stream with POST and the JSON body ${shape}.`, 405, { allow: "POST" })
  const [refused, raw] = await readJson(request, "live request", "Open fewer stores in one stream.")
  if (refused) return refused
  const body = v.safeParse(liveSchema, raw)
  if (!body.success) return badRequest(`The body must be a \`SyncLiveRequest\`: ${shape}.`)
  const db = resolveDb(services)
  // The session of ViteHub Auth is read once for the request, not once for each store.
  const { identify } = services
  let caller: Promise<SyncCaller | null> | undefined
  const once: SyncServices = identify ? { ...services, identify: request => caller ??= identify(request) } : services
  const entries: LiveEntry[] = []
  const refusals: SyncLiveEvent[] = []
  for (const { name, where, cursor, scope, version, paged } of body.output.pulls) {
    const store = { name, ...(where ? { where } : {}) }
    const refuse = (error: Diagnostic) => refusals.push({ type: "error", ...store, error: wire({ error }) })
    const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined
    if (!definition) {
      refuse(syncErrors.SYNC_BAD_REQUEST({ message: `No Sync definition is named ${JSON.stringify(name)}.` }))
      continue
    }
    const resolved = await resolve(name, definition, services, db)
    if (resolved.definition.options.live === false) {
      refuse(syncErrors.SYNC_BAD_REQUEST({ message: `The Sync definition "${name}" has \`live: false\`. Pull it with GET.` }))
      continue
    }
    const [wrong, subset] = readSubset(resolved.table, where)
    if (wrong !== undefined) {
      refuse(syncErrors.SYNC_BAD_REQUEST({ message: wrong }))
      continue
    }
    const [stopped, scoped] = await resolveScope(resolved, request, once, subset)
    if (stopped) refuse(stopped.error)
    else entries.push({ scoped, held: { cursor, scope, version, paged }, store, more: false })
  }
  // The highest `seq` of the change log that the stream read.
  let seen = 0
  // The Database calls of the stream, where a batch is one call.
  let calls = 0
  const budget = services.live?.calls ?? 40
  return liveResponse({
    // `services.db`, not the Database of this request: a function makes a new Database object for each request.
    key: services.db,
    // By table, so a write through another definition of a table, or an action that wrote it, wakes the stream too.
    tables: [...new Set(entries.map(entry => entry.scoped.table.name))],
    signal: request.signal,
    interval: services.live?.interval ?? 1000,
    seconds: services.live?.seconds ?? 25,
    async check(first) {
      if (!entries.length) return { events: refusals, end: true }
      // A check makes at most 3 calls: the change log, the pulls, and the snapshots of cursors out of range. The first
      // check always runs, so the client gets `open`.
      if (!first && calls + 3 > budget) return { end: true }
      let due = entries
      calls++
      if (first) {
        // The first check pulls every store, so a client with an old scope, version, or cursor gets its reset at once.
        const [head] = await db.select({ seq: max(syncChanges.seq) }).from(syncChanges)
        seen = head?.seq ?? 0
      }
      else {
        // One read for every store: the tables with changes since the last check. `seq` is the primary key.
        const changed = await db.select({ table: syncChanges.tableName, seq: max(syncChanges.seq) }).from(syncChanges).where(gt(syncChanges.seq, seen)).groupBy(syncChanges.tableName)
        const tables = new Set(changed.map(change => change.table))
        for (const change of changed) seen = Math.max(seen, change.seq ?? 0)
        due = entries.filter(entry => entry.more || tables.has(entry.scoped.table.name))
      }
      // The refusals, then `open`, so the client knows which stores are live before their first pull.
      const events: SyncLiveEvent[] = first ? [...refusals, { type: "open" }] : []
      const pulled = await pullAll(db, due)
      calls += pulled.calls
      for (const [index, entry] of due.entries()) {
        const answer = pulled.answers[index]!
        entry.held = { cursor: answer.cursor, scope: answer.scope.id, version: answer.version, paged: entry.held.paged }
        // The client pulls the other pages of a snapshot itself.
        entry.more = answer.after ? false : answer.more
        if (answer.reset || answer.rows.length || answer.deleted.length) events.push({ type: "pull", ...entry.store, pull: answer })
      }
      return { events, again: entries.some(entry => entry.more) }
    },
  })
}

/** Reads a Sync definition, and the table and version of the handler. */
async function resolve(name: string, definition: unknown, services: SyncServices, db: SyncDatabase): Promise<Resolved> {
  // The handler reads rows as plain objects. `where` and `write` get the rows that the table returns.
  if (!isSyncDefinition(definition)) throw syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] server/sync/${name} must default-export defineSync({ table, where }).` })
  const table = describeSyncTable(definition.options.table)
  return { name, definition, table, db, now: services.now?.() ?? Date.now(), version: await syncTableVersion(table), services, calls: { count: 0, limit: Number.POSITIVE_INFINITY } }
}

/**
 * Answers one Sync request. See `protocol.ts` for the wire contract.
 *
 * - `GET ?cursor&scope&version&where` pulls the changes since `cursor`.
 * - `POST` with a `SyncPushRequest` applies the writes in order and answers with the results and a pull.
 *
 * `handleSyncLiveRequest()` answers the live stream of every definition.
 */
export async function handleSyncRequest<TTable, TRow, TArgs>(name: string, definition: SyncDefinition<TTable, TRow, TArgs>, request: Request, services: SyncServices): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return badRequest("Use GET to pull and POST to push.", 405, { allow: "GET, POST" })
  const resolved = await resolve(name, definition, services, resolveDb(services))
  const { table } = resolved
  if (request.method === "GET") {
    const url = new URL(request.url)
    const cursor = parseCursor(url.searchParams.get("cursor"))
    if (cursor === false) return badRequest("`cursor` must be the `cursor` of an earlier pull.")
    const [wrong, subset] = parseSubsetQuery(table, url.searchParams.get("where"))
    if (wrong !== undefined) return badRequest(wrong)
    const [stopped, scoped] = await resolveScope(resolved, request, services, subset)
    if (stopped) return fail(stopped.status, stopped.error)
    const after = url.searchParams.get("after") || undefined
    const answer = await pull(scoped, { cursor, scope: url.searchParams.get("scope") ?? undefined, version: url.searchParams.get("version") ?? undefined, paged: url.searchParams.get("paged") === "1", after })
    if (url.searchParams.get("claim") === "1" && resolved.definition.options.identify && services.identify) {
      const auth = await services.identify(request)
      answer.authAccount = auth?.user ? accountOf(auth.user.id) : null
    }
    return json(200, answer)
  }

  const [refused, raw] = await readJson(request, "push", "Send fewer mutations in one push.")
  if (refused) return refused
  const body = v.safeParse(pushSchema, raw)
  if (!body.success) return badRequest("The body must be a `SyncPushRequest`: `{ account, cursor?, scope?, version?, where?, mutations }`.")
  const { account, cursor, scope: clientScope, version, paged, after, mutations: input } = body.output
  if (input.length > syncPushLimit) return fail(413, syncErrors.SYNC_TOO_MANY_MUTATIONS({ count: input.length, limit: syncPushLimit }))
  const mutations: SyncMutation[] = []
  for (const item of input) {
    const mutation = v.safeParse(mutationSchema, item)
    if (!mutation.success) return badRequest("Each mutation must be `{ id, op: \"insert\", value }`, `{ id, op: \"update\", key, patch }`, `{ id, op: \"delete\", key }`, or `{ id, op: \"action\", name, args }`.")
    const { output } = mutation
    mutations.push(output.op === "action" ? { ...output, args: output.args } : output)
  }
  const [wrong, subset] = readSubset(table, body.output.where)
  if (wrong !== undefined) return badRequest(wrong)
  const [stopped, scoped] = await resolveScope(resolved, request, services, subset)
  if (stopped) return fail(stopped.status, stopped.error)
  // Writes made for another account, such as before a sign-in as another user, must not apply with this caller's
  // rights. Writes of the same account apply under the current `where`, also after the caller joined or left a team.
  if (account !== scoped.account) return fail(409, syncErrors.SYNC_ACCOUNT_CHANGED())
  const results: SyncMutationResult[] = []
  // Other tables that actions wrote.
  const touched = new Set<string>()
  const applied = await duplicates(scoped, mutations.map(mutation => mutation.id))
  for (const mutation of mutations) {
    try {
      results.push(await apply(scoped, mutation, touched, applied))
    }
    catch (error) {
      if (error === deferred) break
      throw error
    }
    // The budget does not stop the first mutation. Each later one stops before a call that leaves no room for compaction
    // and the pull of the answer, up to 3 calls, and goes in the next push.
    scoped.calls.limit = (services.push?.calls ?? 40) - 3
  }
  scoped.calls.limit = Number.POSITIVE_INFINITY
  if (results.some(result => result.status === "applied")) {
    for (const name of [table.name, ...touched]) wakeLiveStreams(services.db, name)
    await maybeCompact(scoped, services)
  }
  return json(200, { results, pull: await pull(scoped, { cursor, scope: clientScope, version, paged, after }) })
}
