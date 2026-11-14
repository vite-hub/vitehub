import { and, asc, eq, getTableColumns, gt, lt, max, ne, sql } from "drizzle-orm"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { isRuntimeDiagnostic } from "@vite-hub/runtime"
import * as v from "valibot"

import { canonical, fingerprint, jsonReplacer, sameValue, toJson } from "./canonical.ts"
import { syncChanges, syncMutations, syncState } from "./database.ts"
import { describeSyncTable, isSyncDefinition, syncTableVersion } from "./define.ts"
import { syncErrors } from "./errors.ts"
import { liveResponse, wakeLiveStreams } from "./live.ts"
import { syncPushLimit } from "./protocol.ts"
import { allows, column, decode, mergeSubset, readSubset, readWhere, rowInScope, scopeSql } from "./scope.ts"

import type { BatchItem } from "drizzle-orm/batch"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"
import type { SyncDatabase } from "./database.ts"
import type { SyncTable } from "./define.ts"
import type { SyncKey, SyncMutation, SyncMutationResult, SyncPullResponse, SyncRow, SyncScope, SyncValues, SyncWireError } from "./protocol.ts"
import type { SyncActionContext, SyncContext, SyncDefinition, SyncUser } from "./types.ts"

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
   */
  live?: { interval?: number, seconds?: number }
}

interface Resolved {
  name: string
  definition: SyncDefinition
  table: SyncTable
  db: SyncDatabase
  now: number
  version: string
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

/** A row as JSON, as Sync stores it in an exit and compares it with the scope. */
function rowJson(row: Record<string, unknown>): Record<string, unknown> {
  return parseRow(JSON.stringify(row, jsonReplacer))
}

/**
 * Resolves the scope of the caller: the values of `where`, with the subset of the client. Answers 401 or 403 when
 * `where` refuses the caller, and 403 `SYNC_OUT_OF_SCOPE` when the subset is outside `where`.
 */
async function resolveScope(resolved: Resolved, request: Request, services: SyncServices, subset: SyncValues): Promise<[Response, undefined] | [undefined, Scoped]> {
  const caller = services.identify ? await services.identify(request) : null
  const context: SyncContext = { request, user: caller?.user ?? null, session: caller?.session ?? null }
  const where: unknown = await resolved.definition.options.where(context)
  if (where === false) {
    return context.user
      ? [fail(403, syncErrors.SYNC_FORBIDDEN({ reason: "where" })), undefined]
      : [fail(401, syncErrors.SYNC_UNAUTHORIZED()), undefined]
  }
  if (!where || typeof where !== "object" || Array.isArray(where)) {
    throw syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] server/sync/${resolved.name}: \`where\` must return an object of column values, \`{}\`, or \`false\`.` })
  }
  const [outside, values] = mergeSubset(readWhere(resolved.name, resolved.table, where), subset)
  if (outside !== undefined) return [fail(403, syncErrors.SYNC_OUT_OF_SCOPE({ column: outside })), undefined]
  const scope: SyncScope = { id: await fingerprint(`${resolved.name}\n${canonical(values)}`), values }
  const account = context.user ? await fingerprint(`account\n${context.user.id}`) : scope.id
  return [undefined, { ...resolved, context, scope, account }]
}

function headQuery(db: SyncDatabase, name: string) {
  return db.select({ seq: max(syncChanges.seq) }).from(syncChanges).where(eq(syncChanges.name, name))
}

/**
 * Reads the changes after the cursor that the client holds, or a full snapshot when the client holds no cursor,
 * another scope, or another version. Each read is one atomic batch, so the cursor and the rows match.
 */
async function pull(scoped: Scoped, held: Held): Promise<SyncPullResponse> {
  const { db, name, scope, account, version } = scoped
  const { table, key, defaults } = scoped.table
  const keyColumn = column(scoped.table, key)
  const where = scopeSql(scoped.table, scope.values)
  const base = { key, scope, account, version, defaults }
  const floor = db.select({ floor: syncState.floor }).from(syncState).where(eq(syncState.name, name))
  const { cursor } = held
  if (cursor !== undefined && held.scope === scope.id && held.version === version) {
    const [state, last, page, puts] = await db.batch([
      floor,
      headQuery(db, name),
      // `current` is the key of the row when it is in the scope now, so an exit of a row that came back is not sent.
      db.select({ seq: syncChanges.seq, key: syncChanges.key, op: syncChanges.op, row: syncChanges.row, current: keyColumn })
        .from(syncChanges)
        .leftJoin(table, and(eq(keyColumn, syncChanges.key), where))
        .where(and(eq(syncChanges.name, name), gt(syncChanges.seq, cursor)))
        .orderBy(asc(syncChanges.seq))
        .limit(pageSize + 1),
      // A join, not `key IN (...)`: the statement has a fixed number of parameters, so D1's limit of 100 never applies.
      // The first `pageSize` puts in scope cover every put in scope of the page above.
      db.select({ row: getTableColumns(table), seq: sql<number>`${syncChanges.seq}`.as("vitehub_sync_seq") })
        .from(table)
        .innerJoin(syncChanges, and(eq(syncChanges.name, name), eq(syncChanges.key, keyColumn)))
        .where(and(gt(syncChanges.seq, cursor), eq(syncChanges.op, "put"), where))
        .orderBy(asc(syncChanges.seq))
        .limit(pageSize),
    ])
    const lowest = state[0]?.floor ?? 0
    const highest = Math.max(last[0]?.seq ?? 0, lowest)
    // A cursor below the floor missed removed exits. A cursor above the newest change comes from another Database.
    if (cursor >= lowest && cursor <= highest) {
      const changes = page.slice(0, pageSize)
      const next = changes.at(-1)?.seq ?? cursor
      const deleted = new Set<SyncKey>()
      for (const change of changes) {
        if (change.op !== "put" && change.current === null && change.row !== null && rowInScope(parseRow(change.row), scope.values)) deleted.add(change.key)
      }
      return {
        ...base,
        cursor: next,
        reset: false,
        rows: puts.filter(put => put.seq <= next).map(put => put.row),
        deleted: [...deleted],
        more: page.length > pageSize,
      }
    }
  }
  const [state, last, rows] = await db.batch([floor, headQuery(db, name), db.select().from(table).where(where)])
  return { ...base, cursor: Math.max(last[0]?.seq ?? 0, state[0]?.floor ?? 0), reset: true, rows, deleted: [], more: false }
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

type Statement = BatchItem<"sqlite">

type Target = Pick<Resolved, "db" | "name" | "now">

/** Makes `key`'s `put` the newest change. Each key has one `put`. */
function putStatements({ db, name, now }: Target, key: SyncKey): Statement[] {
  return [
    db.delete(syncChanges).where(and(eq(syncChanges.name, name), eq(syncChanges.key, key), eq(syncChanges.op, "put"))),
    db.insert(syncChanges).values({ name, key, op: "put", row: null, createdAt: now }),
  ]
}

/** Appends an exit: the row left the scopes that held it, because it was deleted or because a `where` column changed. */
function exitStatements({ db, name, now }: Target, key: SyncKey, op: "delete" | "move", row: Record<string, unknown>): Statement[] {
  const exit = db.insert(syncChanges).values({ name, key, op, row: JSON.stringify(row, jsonReplacer), createdAt: now })
  if (op === "move") return [exit]
  return [exit, db.delete(syncChanges).where(and(eq(syncChanges.name, name), eq(syncChanges.key, key), eq(syncChanges.op, "put")))]
}

async function readRow(scoped: Scoped, key: SyncKey, scopedOnly: boolean): Promise<Record<string, unknown> | undefined> {
  const { db, table } = scoped
  const [row] = await db.select().from(table.table)
    .where(and(eq(column(table, table.key), key), scopedOnly ? scopeSql(table, scoped.scope.values) : undefined))
    .limit(1)
  return row
}

/** The rows that earlier writes of the same action changed: the row, or `null` after a delete. */
type Overlay = Map<SyncKey, Record<string, unknown> | null>

async function currentRow(scoped: Scoped, overlay: Overlay, key: SyncKey, scopedOnly: boolean): Promise<Record<string, unknown> | undefined> {
  if (!overlay.has(key)) return await readRow(scoped, key, scopedOnly)
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
    values[name] = decode(table, name, value)
  }
  return [undefined, values]
}

async function check(scoped: Scoped, op: "insert" | "update" | "delete", row: Record<string, unknown>): Promise<Refusal | undefined> {
  const { schema, write } = scoped.definition.options
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
 * Checks one write with the rules of the definition, and returns the statements that apply it with their change log
 * entries. `overlay` holds the rows that earlier writes of the same action changed, and gets this write.
 */
async function plan(scoped: Scoped, write: Write, overlay: Overlay): Promise<[Refusal, undefined] | [undefined, Statement[]]> {
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
    if (await currentRow(scoped, overlay, key, false)) return [{ error: syncErrors.SYNC_KEY_EXISTS({ key }) }, undefined]
    const stopped = await check(scoped, "insert", row)
    if (stopped) return [stopped, undefined]
    overlay.set(key, row)
    return [undefined, [db.insert(target).values(row), ...putStatements(scoped, key)]]
  }
  const { key } = write
  if (typeof key !== "string" || !key) return [invalid("An update or a delete needs `key`."), undefined]
  const current = await currentRow(scoped, overlay, key, true)
  const inScope = and(eq(keyColumn, key), scopeSql(table, scope.values))
  if (write.op === "delete") {
    // Deleting a missing row changes nothing, so a repeated delete is not an error.
    if (!current) return [undefined, []]
    const stopped = await check(scoped, "delete", current)
    if (stopped) return [stopped, undefined]
    overlay.set(key, null)
    return [undefined, [db.delete(target).where(inScope), ...exitStatements(scoped, key, "delete", current)]]
  }
  if (!current) return [{ error: syncErrors.SYNC_NOT_FOUND({ message: `No row with the key ${JSON.stringify(key)} is in the scope of the caller.` }) }, undefined]
  const [refused, values] = readColumns(scoped, write.patch, key)
  if (refused) return [refused, undefined]
  const { [table.key]: _key, ...patch } = values
  const row = { ...current, ...patch }
  const stopped = await check(scoped, "update", row)
  if (stopped) return [stopped, undefined]
  if (!Object.keys(patch).length) return [undefined, []]
  // A new value of a `where` column, such as another team, moves the row out of the scopes that held it.
  const moved = Object.keys(scope.values).some(name => name in patch && !sameValue(current[name] ?? null, patch[name] ?? null))
  overlay.set(key, row)
  return [undefined, [
    db.update(target).set(patch).where(inScope),
    ...moved ? exitStatements(scoped, key, "move", current) : [],
    ...putStatements(scoped, key),
  ]]
}

async function applied(scoped: Scoped, id: string): Promise<boolean> {
  const [done] = await scoped.db.select({ id: syncMutations.id }).from(syncMutations).where(eq(syncMutations.id, id)).limit(1)
  return Boolean(done)
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

/**
 * The refusal for an error that an action threw. A ViteHub Diagnostic, an HTTP error below 500, and a schema error
 * with `issues` (such as from `v.parse()`) are meant for the caller, so their message goes to the browser. Any other
 * error can hold server details: the browser gets "The action failed.", and the server log gets the error.
 */
function actionRefusal(name: string, error: unknown): Refusal {
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
 * Runs an action: it collects the writes, checks each with the rules of browser writes, and applies them with the
 * ledger entry in one atomic batch. One refused write refuses the whole action.
 */
async function runAction(scoped: Scoped, mutation: Extract<SyncMutation, { op: "action" }>): Promise<[Refusal, undefined] | [undefined, { statements: Statement[], result: unknown }]> {
  const actions: unknown = scoped.definition.options.actions
  const action: unknown = actions && typeof actions === "object" && Object.hasOwn(actions, mutation.name) ? Reflect.get(actions, mutation.name) : undefined
  if (!isAction(action)) return [invalid(`This Sync definition has no action named ${JSON.stringify(mutation.name)}.`), undefined]
  const { table } = scoped
  const writes: Write[] = []
  let open = true
  const collect = (write: Write) => {
    if (!open) throw syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] The Sync action "${mutation.name}" wrote after it returned. Await every write before the action returns.` })
    writes.push(write)
  }
  const context: SyncActionContext<Record<string, unknown>> = {
    ...scoped.context,
    get: async key => await readRow(scoped, key, true),
    insert: (value) => {
      const given: unknown = value[table.key]
      const key = typeof given === "string" && given ? given : crypto.randomUUID()
      collect({ op: "insert", value: { ...value, [table.key]: key } })
      return key
    },
    update: (key, patch) => collect({ op: "update", key, patch }),
    delete: key => collect({ op: "delete", key }),
  }
  let result: unknown
  try {
    result = await action(context, mutation.args)
  }
  catch (error) {
    return [actionRefusal(mutation.name, error), undefined]
  }
  finally {
    open = false
  }
  const overlay: Overlay = new Map()
  const statements: Statement[] = []
  for (const write of writes) {
    const [refused, planned] = await plan(scoped, write, overlay)
    if (refused) return [refused, undefined]
    statements.push(...planned)
  }
  return [undefined, { statements, result: toJson(result) }]
}

/**
 * Applies one mutation in one atomic batch. The ledger insert comes first, so a mutation id that is there already fails
 * the whole batch, and the rows stay as they are.
 */
async function apply(scoped: Scoped, mutation: SyncMutation): Promise<SyncMutationResult> {
  const { id } = mutation
  if (await applied(scoped, id)) return { id, status: "duplicate" }
  const { db, name, now } = scoped
  const ledger = db.insert(syncMutations).values({ id, name, createdAt: now })
  try {
    if (mutation.op === "action") {
      const [refused, done] = await runAction(scoped, mutation)
      if (refused) return rejected(id, refused)
      await db.batch([ledger, ...done.statements])
      return done.result === undefined ? { id, status: "applied" } : { id, status: "applied", result: done.result }
    }
    // An action is server code, so `write: false` stops only the writes of the browser.
    if (scoped.definition.options.write === false) return rejected(id, { error: syncErrors.SYNC_READ_ONLY() })
    const [refused, statements] = await plan(scoped, mutation, new Map())
    if (refused) return rejected(id, refused)
    await db.batch([ledger, ...statements])
    return { id, status: "applied" }
  }
  catch (error) {
    // A push that runs at the same time applied the same id first, or inserted the same key.
    if (await applied(scoped, id)) return { id, status: "duplicate" }
    if (mutation.op === "insert" && typeof mutation.value[scoped.table.key] === "string" && await readRow(scoped, String(mutation.value[scoped.table.key]), false)) {
      return rejected(id, { error: syncErrors.SYNC_KEY_EXISTS({ key: String(mutation.value[scoped.table.key]) }) })
    }
    throw error
  }
}

/**
 * Removes applied mutation ids after 7 days and exits after 30 days, and raises the floor to the highest removed
 * `seq`, so an older cursor gets a full snapshot.
 */
async function compact(scoped: Scoped): Promise<void> {
  const { db, name, now } = scoped
  const removable = and(eq(syncChanges.name, name), ne(syncChanges.op, "put"), lt(syncChanges.createdAt, now - exitRetention))
  await db.batch([
    db.delete(syncMutations).where(and(eq(syncMutations.name, name), lt(syncMutations.createdAt, now - mutationRetention))),
    db.run(sql`INSERT INTO ${syncState} (${sql.identifier("name")}, ${sql.identifier("floor")}) SELECT ${name}, max(${syncChanges.seq}) FROM ${syncChanges} WHERE ${removable} HAVING max(${syncChanges.seq}) IS NOT NULL ON CONFLICT (${sql.identifier("name")}) DO UPDATE SET ${sql.identifier("floor")} = max(${sql.identifier("floor")}, excluded.${sql.identifier("floor")})`),
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

function liveStream(scoped: Scoped, held: Held, request: Request, services: SyncServices): Response {
  const { db, name } = scoped
  let synced = held
  return liveResponse({
    // `services.db`, not the Database of this request: a function makes a new Database object for each request.
    key: services.db,
    name,
    signal: request.signal,
    interval: services.live?.interval ?? 1000,
    seconds: services.live?.seconds ?? 25,
    async check(first) {
      // The first check pulls, so a client with an old scope, version, or cursor gets its reset at once.
      if (!first) {
        const [head] = await headQuery(db, name)
        if ((head?.seq ?? 0) <= (synced.cursor ?? 0)) return {}
      }
      const answer = await pull(scoped, synced)
      synced = { cursor: answer.cursor, scope: answer.scope.id, version: answer.version }
      const changed = answer.reset || answer.rows.length > 0 || answer.deleted.length > 0
      return { ...changed ? { event: { type: "pull", pull: answer } } : {}, again: answer.more }
    },
  })
}

/**
 * Answers one Sync request. See `protocol.ts` for the wire contract.
 *
 * - `GET ?cursor&scope&version&where` pulls the changes since `cursor`.
 * - `GET ?live&cursor&scope&version&where` streams pulls as Server-Sent Events.
 * - `POST` with a `SyncPushRequest` applies the writes in order and answers with the results and a pull.
 */
export async function handleSyncRequest<TTable, TRow, TArgs>(name: string, definition: SyncDefinition<TTable, TRow, TArgs>, request: Request, services: SyncServices): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return badRequest("Use GET to pull and POST to push.", 405, { allow: "GET, POST" })
  // The handler reads rows as plain objects. `where` and `write` get the rows that the table returns.
  const loose: unknown = definition
  if (!isSyncDefinition(loose)) throw syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] server/sync/${name} must default-export defineSync({ table, where }).` })
  const table = describeSyncTable(definition.options.table)
  const resolved: Resolved = { name, definition: loose, table, db: resolveDb(services), now: services.now?.() ?? Date.now(), version: await syncTableVersion(table) }
  if (request.method === "GET") {
    const url = new URL(request.url)
    const live = url.searchParams.has("live")
    if (live && loose.options.live === false) return badRequest(`The Sync definition "${name}" has \`live: false\`. Pull with GET without \`live\`.`)
    const cursor = parseCursor(url.searchParams.get("cursor"))
    if (cursor === false) return badRequest("`cursor` must be the `cursor` of an earlier pull.")
    const [wrong, subset] = parseSubsetQuery(table, url.searchParams.get("where"))
    if (wrong !== undefined) return badRequest(wrong)
    const [stopped, scoped] = await resolveScope(resolved, request, services, subset)
    if (stopped) return stopped
    const held: Held = { cursor, scope: url.searchParams.get("scope") ?? undefined, version: url.searchParams.get("version") ?? undefined }
    if (live) return liveStream(scoped, held, request, services)
    return json(200, await pull(scoped, held))
  }

  // A cross-site page cannot send JSON without a preflight, and a browser always sends `Origin` on POST.
  const origin = request.headers.get("origin")
  if (origin && origin !== forwardedRequestOrigin(request)) return fail(403, syncErrors.SYNC_FORBIDDEN({ reason: "origin" }))
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return badRequest("Send the push as JSON.", 415)
  const text = await readText(request, maxBodyBytes)
  if (text === undefined) return badRequest(`The push is larger than ${maxBodyBytes} bytes. Send fewer mutations in one push.`, 413)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    return badRequest("The body is not JSON.")
  }
  const body = v.safeParse(pushSchema, raw)
  if (!body.success) return badRequest("The body must be a `SyncPushRequest`: `{ account, cursor?, scope?, version?, where?, mutations }`.")
  const { account, cursor, scope: clientScope, version, mutations: input } = body.output
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
  if (stopped) return stopped
  // Writes made for another account, such as before a sign-in as another user, must not apply with this caller's
  // rights. Writes of the same account apply under the current `where`, also after the caller joined or left a team.
  if (account !== scoped.account) return fail(409, syncErrors.SYNC_SCOPE_CHANGED())
  const results: SyncMutationResult[] = []
  for (const mutation of mutations) results.push(await apply(scoped, mutation))
  if (results.some(result => result.status === "applied")) {
    wakeLiveStreams(services.db, name)
    await maybeCompact(scoped, services)
  }
  return json(200, { results, pull: await pull(scoped, { cursor, scope: clientScope, version }) })
}

/** The changes that server code made to a Sync table directly. */
export interface SyncChanges {
  /** Keys of rows that server code inserted or updated. */
  put?: readonly SyncKey[]
  /**
   * Rows that server code deleted, as they were before the delete. The server sends each key only to callers whose
   * `where` matches the row.
   */
  delete?: readonly SyncRow[]
  /**
   * Rows whose `where` column server code changed, such as a move to another team, as they were before the change.
   * Callers who could see the old row get the key in `deleted`, and callers who can see the new row get the row.
   */
  moved?: readonly SyncRow[]
}

/** Writes change log entries for writes that server code made to the table itself. Returns the number of changes. */
export async function recordChanges(name: string, definition: SyncDefinition, db: SyncDatabase, changes: SyncChanges, now: number): Promise<number> {
  const table = describeSyncTable(definition.options.table)
  const target: Target = { name, db, now }
  const keyOf = (row: SyncRow, field: "delete" | "moved"): SyncKey => {
    const key = row[table.key]
    if (typeof key !== "string" || !key) throw syncErrors.SYNC_INVALID({ message: `[vitehub] recordSyncChanges("${name}"): each row in \`${field}\` needs its primary key \`${table.key}\`.` })
    return key
  }
  const statements: Statement[] = []
  for (const row of changes.delete ?? []) statements.push(...exitStatements(target, keyOf(row, "delete"), "delete", row))
  // The exit comes before the `put`, so a pull sees that the row is in the new scope after it left the old one.
  for (const row of changes.moved ?? []) statements.push(...exitStatements(target, keyOf(row, "moved"), "move", row), ...putStatements(target, keyOf(row, "moved")))
  for (const key of changes.put ?? []) statements.push(...putStatements(target, key))
  const [first, ...rest] = statements
  if (first) await db.batch([first, ...rest])
  return (changes.put?.length ?? 0) + (changes.delete?.length ?? 0) + (changes.moved?.length ?? 0)
}
