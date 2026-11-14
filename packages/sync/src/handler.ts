import { and, asc, eq, getTableColumns, gt, isNull, lt, max, sql } from "drizzle-orm"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import * as v from "valibot"

import { syncChanges, syncMutations, syncState } from "./database.ts"
import { describeSyncTable, isSyncDefinition } from "./define.ts"
import { syncErrors } from "./errors.ts"
import { syncPushLimit } from "./protocol.ts"

import type { SQL } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import type { SyncDatabase } from "./database.ts"
import type { SyncTable } from "./define.ts"
import type { SyncKey, SyncMutation, SyncMutationResult, SyncPullResponse, SyncRow, SyncScope, SyncWireError } from "./protocol.ts"
import type { SyncContext, SyncDefinition, SyncUser } from "./types.ts"

/** The most changes in one pull. A pull with more answers `more: true`. */
const pageSize = 500
/** The largest push body. */
const maxBodyBytes = 1024 * 1024
const day = 86_400_000
/** Applied mutation ids stay this long, so a retry after a lost answer is a `duplicate`. */
const mutationRetention = 7 * day
/** `delete` changes stay this long. A cursor older than the removed ones gets a full snapshot. */
const deleteRetention = 30 * day
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
}

interface Resolved {
  name: string
  definition: SyncDefinition
  table: SyncTable
  db: SyncDatabase
  now: number
}

interface Scoped extends Resolved {
  context: SyncContext
  scope: SyncScope
}

const compactions = new WeakMap<SyncServices, Map<string, number>>()

const headers = { "content-type": "application/json", "cache-control": "private, no-store" }

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

function json(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body, replacer), { status, headers: { ...headers, ...extra } })
}

interface Diagnostic {
  code: SyncWireError["code"]
  message: string
  fix?: string | undefined
  docs?: string | undefined
}

function wire(error: Diagnostic, issues?: SyncWireError["issues"]): SyncWireError {
  return { code: error.code, message: error.message, ...(issues ? { issues } : {}) }
}

function fail(status: number, error: Diagnostic, extra?: Record<string, string>): Response {
  return json(status, { ...wire(error), fix: error.fix, docs: error.docs }, extra)
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

/** Canonical JSON: object keys sorted, so the same values give the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(",")}}`
  }
  return JSON.stringify(value, replacer) ?? "null"
}

async function scopeId(name: string, values: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${name}\n${canonical(values)}`))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)
}

function column(table: SyncTable, name: string): SQLiteColumn {
  // SAFETY: callers pass only names that they checked against `table.columns`.
  return table.columns[name]!
}

function whereSql(table: SyncTable, values: Record<string, unknown>): SQL | undefined {
  return and(...Object.entries(values).map(([name, value]) => value === null ? isNull(column(table, name)) : eq(column(table, name), value)))
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

const rowSchema = v.record(v.string(), v.unknown())

/** A row that Sync wrote as JSON itself, such as the stored copy of a deleted row. */
function parseRow(text: string): Record<string, unknown> {
  return v.parse(rowSchema, JSON.parse(text))
}

/** Whether a row, such as the stored copy of a deleted row, has every `where` value. */
function inScope(row: Record<string, unknown>, values: Record<string, unknown>): boolean {
  return Object.entries(values).every(([name, value]) => sameValue(row[name] ?? null, value))
}

/** A JSON value of a column as Drizzle wants it: a `Date` for a timestamp column, a `bigint` for a bigint column. */
function decode(table: SyncTable, name: string, value: unknown): unknown {
  if (value === null || value === undefined) return value
  const { dataType } = column(table, name)
  if (dataType.startsWith("object date") && (typeof value === "string" || typeof value === "number")) return new Date(value)
  if (dataType.startsWith("bigint") && (typeof value === "string" || typeof value === "number")) return BigInt(value)
  return value
}

async function resolveScope(resolved: Resolved, request: Request, services: SyncServices): Promise<[Response, undefined] | [undefined, Scoped]> {
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
  const values: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(where)) {
    if (value === undefined) continue
    if (!(name in resolved.table.columns)) {
      throw syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] server/sync/${resolved.name}: \`where\` returned \`${name}\`, which is not a column of the table "${resolved.table.name}".` })
    }
    values[name] = value
  }
  // The JSON form of the values, so the client stamps the same values that the server stores.
  const scope: SyncScope = { id: await scopeId(resolved.name, values), values: parseRow(JSON.stringify(values, replacer)) }
  return [undefined, { ...resolved, context, scope }]
}

/**
 * Reads the changes after `cursor`, or a full snapshot. Each read is one atomic batch, so the cursor and the rows
 * match.
 */
async function pull(scoped: Scoped, cursor: number | undefined, clientScope: string | undefined): Promise<SyncPullResponse> {
  const { db, name, scope } = scoped
  const { table, key } = scoped.table
  const where = whereSql(scoped.table, scope.values)
  const floor = db.select({ floor: syncState.floor }).from(syncState).where(eq(syncState.name, name))
  const head = db.select({ seq: max(syncChanges.seq) }).from(syncChanges).where(eq(syncChanges.name, name))
  if (cursor !== undefined && clientScope === scope.id) {
    const [state, last, page, puts] = await db.batch([
      floor,
      head,
      db.select({ seq: syncChanges.seq, key: syncChanges.key, op: syncChanges.op, row: syncChanges.row })
        .from(syncChanges)
        .where(and(eq(syncChanges.name, name), gt(syncChanges.seq, cursor)))
        .orderBy(asc(syncChanges.seq))
        .limit(pageSize + 1),
      // A join, not `key IN (...)`: the statement has a fixed number of parameters, so D1's limit of 100 never applies.
      // The first `pageSize` puts in scope cover every put in scope of the page above.
      db.select({ row: getTableColumns(table), seq: sql<number>`${syncChanges.seq}`.as("vitehub_sync_seq") })
        .from(table)
        .innerJoin(syncChanges, and(eq(syncChanges.name, name), eq(syncChanges.key, column(scoped.table, key))))
        .where(and(gt(syncChanges.seq, cursor), eq(syncChanges.op, "put"), where))
        .orderBy(asc(syncChanges.seq))
        .limit(pageSize),
    ])
    const lowest = state[0]?.floor ?? 0
    const highest = Math.max(last[0]?.seq ?? 0, lowest)
    // A cursor below the floor missed removed deletes. A cursor above the newest change comes from another Database.
    if (cursor >= lowest && cursor <= highest) {
      const changes = page.slice(0, pageSize)
      const next = changes.at(-1)?.seq ?? cursor
      return {
        key,
        scope,
        cursor: next,
        reset: false,
        rows: puts.filter(put => put.seq <= next).map(put => put.row),
        deleted: changes.filter(change => change.op === "delete" && change.row !== null && inScope(parseRow(change.row), scope.values)).map(change => change.key),
        more: page.length > pageSize,
      }
    }
  }
  const [state, last, rows] = await db.batch([floor, head, db.select().from(table).where(where)])
  return { key, scope, cursor: Math.max(last[0]?.seq ?? 0, state[0]?.floor ?? 0), reset: true, rows, deleted: [], more: false }
}

function rejected(id: string, error: Diagnostic, issues?: SyncWireError["issues"]): SyncMutationResult {
  return { id, status: "rejected", error: wire(error, issues) }
}

function invalid(id: string, message: string, issues?: SyncWireError["issues"]): SyncMutationResult {
  return rejected(id, syncErrors.SYNC_INVALID({ message }), issues)
}

function issuePath(path: readonly (PropertyKey | { key: PropertyKey })[] | undefined): string | undefined {
  if (!path?.length) return undefined
  return path.map(segment => String(typeof segment === "object" ? segment.key : segment)).join(".")
}

/** Changes the change log entry of `key` to the newest one. */
function changeStatements({ db, name, now }: Pick<Resolved, "db" | "name" | "now">, key: SyncKey, op: "put" | "delete", row: Record<string, unknown> | null) {
  return [
    db.delete(syncChanges).where(and(eq(syncChanges.name, name), eq(syncChanges.key, key))),
    db.insert(syncChanges).values({ name, key, op, row: row ? JSON.stringify(row, replacer) : null, createdAt: now }),
  ] as const
}

async function readRow(scoped: Scoped, key: SyncKey, scopedOnly: boolean): Promise<Record<string, unknown> | undefined> {
  const { db, table } = scoped
  const [row] = await db.select().from(table.table)
    .where(and(eq(column(table, table.key), key), scopedOnly ? whereSql(table, scoped.scope.values) : undefined))
    .limit(1)
  return row
}

/** Checks the columns of a write, and returns the values as Drizzle wants them, or a refusal. */
function readColumns(scoped: Scoped, id: string, input: SyncRow, key: SyncKey | undefined): [SyncMutationResult, undefined] | [undefined, Record<string, unknown>] {
  const { table, scope } = scoped
  const values: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(input)) {
    if (!(name in table.columns)) return [invalid(id, `\`${name}\` is not a column of the table "${table.name}".`), undefined]
    if (name === table.key && key !== undefined && value !== key) return [invalid(id, `The primary key \`${name}\` cannot change.`), undefined]
    if (name in scope.values && !sameValue(value, scope.values[name])) return [rejected(id, syncErrors.SYNC_OUT_OF_SCOPE({ column: name })), undefined]
    values[name] = decode(table, name, value)
  }
  return [undefined, values]
}

async function check(scoped: Scoped, id: string, op: "insert" | "update" | "delete", row: Record<string, unknown>): Promise<SyncMutationResult | undefined> {
  const { schema, write } = scoped.definition.options
  if (schema && op !== "delete") {
    const result = await schema["~standard"].validate(row)
    if (result.issues) {
      return invalid(id, "The row does not match the schema of this Sync definition.", result.issues.map(issue => ({ message: issue.message, ...(issuePath(issue.path) ? { path: issuePath(issue.path) } : {}) })))
    }
  }
  if (typeof write === "function" && !await write({ ...scoped.context, op, row })) return rejected(id, syncErrors.SYNC_FORBIDDEN({ reason: "write" }))
  return undefined
}

async function applied(scoped: Scoped, id: string): Promise<boolean> {
  const [done] = await scoped.db.select({ id: syncMutations.id }).from(syncMutations).where(eq(syncMutations.id, id)).limit(1)
  return Boolean(done)
}

/**
 * Applies one mutation in one atomic batch. The ledger insert comes first, so a mutation id that is there already fails
 * the whole batch, and the row stays as it is.
 */
async function apply(scoped: Scoped, mutation: SyncMutation): Promise<SyncMutationResult> {
  const { id } = mutation
  if (await applied(scoped, id)) return { id, status: "duplicate" }
  const { db, name, now, table, scope } = scoped
  if (scoped.definition.options.write === false) return rejected(id, syncErrors.SYNC_READ_ONLY())
  const ledger = db.insert(syncMutations).values({ id, name, createdAt: now })
  const keyColumn = column(table, table.key)
  const target: SQLiteTable = table.table
  try {
    if (mutation.op === "insert") {
      const key: unknown = mutation.value[table.key]
      if (typeof key !== "string" || !key) return invalid(id, `An insert needs the primary key \`${table.key}\` as a text value, such as \`crypto.randomUUID()\`.`)
      const [refused, values] = readColumns(scoped, id, mutation.value, undefined)
      if (refused) return refused
      const row = { ...values }
      for (const [column, value] of Object.entries(scope.values)) row[column] = decode(table, column, value)
      if (await readRow(scoped, key, false)) return rejected(id, syncErrors.SYNC_KEY_EXISTS({ key }))
      const stopped = await check(scoped, id, "insert", row)
      if (stopped) return stopped
      await db.batch([ledger, db.insert(target).values(row), ...changeStatements(scoped, key, "put", null)])
      return { id, status: "applied" }
    }
    const { key } = mutation
    if (typeof key !== "string" || !key) return invalid(id, "An update or a delete needs `key`.")
    const current = await readRow(scoped, key, true)
    if (mutation.op === "delete") {
      // Deleting a missing row changes nothing, so a repeated delete is not an error.
      if (!current) {
        await db.batch([ledger])
        return { id, status: "applied" }
      }
      const stopped = await check(scoped, id, "delete", current)
      if (stopped) return stopped
      await db.batch([ledger, db.delete(target).where(and(eq(keyColumn, key), whereSql(table, scope.values))), ...changeStatements(scoped, key, "delete", current)])
      return { id, status: "applied" }
    }
    if (!current) return rejected(id, syncErrors.SYNC_NOT_FOUND({ message: `No row with the key ${JSON.stringify(key)} is in the scope of the caller.` }))
    const [refused, values] = readColumns(scoped, id, mutation.patch, key)
    if (refused) return refused
    const { [table.key]: _key, ...patch } = values
    const row = { ...current, ...patch }
    const stopped = await check(scoped, id, "update", row)
    if (stopped) return stopped
    if (!Object.keys(patch).length) {
      await db.batch([ledger])
      return { id, status: "applied" }
    }
    await db.batch([ledger, db.update(target).set(patch).where(and(eq(keyColumn, key), whereSql(table, scope.values))), ...changeStatements(scoped, key, "put", null)])
    return { id, status: "applied" }
  }
  catch (error) {
    // A push that runs at the same time applied the same id first, or inserted the same key.
    if (await applied(scoped, id)) return { id, status: "duplicate" }
    if (mutation.op === "insert" && typeof mutation.value[table.key] === "string" && await readRow(scoped, String(mutation.value[table.key]), false)) {
      return rejected(id, syncErrors.SYNC_KEY_EXISTS({ key: String(mutation.value[table.key]) }))
    }
    throw error
  }
}

/**
 * Removes applied mutation ids after 7 days and `delete` changes after 30 days, and raises the floor to the highest
 * removed `seq`, so an older cursor gets a full snapshot.
 */
async function compact(scoped: Scoped): Promise<void> {
  const { db, name, now } = scoped
  const cutoff = now - deleteRetention
  const removable = and(eq(syncChanges.name, name), eq(syncChanges.op, "delete"), lt(syncChanges.createdAt, cutoff))
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

const mutationSchema = v.variant("op", [
  v.object({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)), op: v.literal("insert"), value: v.record(v.string(), v.unknown()) }),
  v.object({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)), op: v.literal("update"), key: v.pipe(v.string(), v.minLength(1)), patch: v.record(v.string(), v.unknown()) }),
  v.object({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)), op: v.literal("delete"), key: v.pipe(v.string(), v.minLength(1)) }),
])

const pushSchema = v.object({
  scope: v.string(),
  cursor: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
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

/**
 * Answers one Sync request: `GET ?cursor&scope` pulls the changes since `cursor`, and `POST` with a `SyncPushRequest`
 * applies the writes in order and answers with the results and a pull. See `protocol.ts` for the wire contract.
 */
export async function handleSyncRequest<TTable, TRow>(name: string, definition: SyncDefinition<TTable, TRow>, request: Request, services: SyncServices): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return badRequest("Use GET to pull and POST to push.", 405, { allow: "GET, POST" })
  // The handler reads rows as plain objects. `where` and `write` get the rows that the table returns.
  const loose: unknown = definition
  if (!isSyncDefinition(loose)) throw syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] server/sync/${name} must default-export defineSync({ table, where }).` })
  const resolved: Resolved = { name, definition: loose, table: describeSyncTable(definition.options.table), db: resolveDb(services), now: services.now?.() ?? Date.now() }
  if (request.method === "GET") {
    const url = new URL(request.url)
    const cursor = parseCursor(url.searchParams.get("cursor"))
    if (cursor === false) return badRequest("`cursor` must be the `cursor` of an earlier pull.")
    const [stopped, scoped] = await resolveScope(resolved, request, services)
    if (stopped) return stopped
    return json(200, await pull(scoped, cursor, url.searchParams.get("scope") ?? undefined))
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
  if (!body.success) return badRequest("The body must be a `SyncPushRequest`: `{ scope, cursor?, mutations }`.")
  const { scope: clientScope, cursor, mutations: input } = body.output
  if (input.length > syncPushLimit) return fail(413, syncErrors.SYNC_TOO_MANY_MUTATIONS({ count: input.length, limit: syncPushLimit }))
  const mutations: SyncMutation[] = []
  for (const item of input) {
    const mutation = v.safeParse(mutationSchema, item)
    if (!mutation.success) return badRequest("Each mutation must be `{ id, op: \"insert\", value }`, `{ id, op: \"update\", key, patch }`, or `{ id, op: \"delete\", key }`.")
    mutations.push(mutation.output)
  }
  const [stopped, scoped] = await resolveScope(resolved, request, services)
  if (stopped) return stopped
  // Writes made for another caller, such as before a sign-in as another user, must not apply with this caller's rights.
  if (clientScope !== scoped.scope.id) return fail(409, syncErrors.SYNC_SCOPE_CHANGED())
  const results: SyncMutationResult[] = []
  for (const mutation of mutations) results.push(await apply(scoped, mutation))
  if (results.some(result => result.status === "applied")) await maybeCompact(scoped, services)
  return json(200, { results, pull: await pull(scoped, cursor, clientScope) })
}

/** The keys and deleted rows of a change that server code made to a Sync table directly. */
export interface SyncChanges {
  /** Keys of rows that server code inserted or updated. */
  put?: readonly SyncKey[]
  /** Rows that server code deleted, as they were before the delete. The server sends each key only to callers whose `where` matches the row. */
  delete?: readonly SyncRow[]
}

/** Writes change log entries for writes that server code made to the table itself. */
export async function recordChanges(name: string, definition: SyncDefinition, db: SyncDatabase, changes: SyncChanges, now: number): Promise<number> {
  const table = describeSyncTable(definition.options.table)
  const target = { name, db, now }
  const statements = []
  for (const key of changes.put ?? []) statements.push(...changeStatements(target, key, "put", null))
  for (const row of changes.delete ?? []) {
    const key = row[table.key]
    if (typeof key !== "string" || !key) throw syncErrors.SYNC_INVALID({ message: `[vitehub] recordSyncChanges("${name}"): each deleted row needs its primary key \`${table.key}\`.` })
    statements.push(...changeStatements(target, key, "delete", row))
  }
  const [first, ...rest] = statements
  if (first) await db.batch([first, ...rest])
  return statements.length / 2
}
