// Pure decisions of the Sync client. The store calls them and does the side effects.
import { syncErrors } from "../errors.ts"
import { SyncError } from "./types.ts"

import type { SyncErrorCode, SyncKey, SyncMutation, SyncMutationResult, SyncPullResponse, SyncRow, SyncValues, SyncWireError } from "../protocol.ts"
import type { SyncMeta, SyncNewWrite, SyncQueuedWrite, SyncStorageChange } from "./storage.ts"
import type { SyncClientErrorCode, SyncLocal } from "./types.ts"

const wireCodes = {
  SYNC_UNAUTHORIZED: true,
  SYNC_FORBIDDEN: true,
  SYNC_ACCOUNT_CHANGED: true,
  SYNC_READ_ONLY: true,
  SYNC_INVALID: true,
  SYNC_NOT_FOUND: true,
  SYNC_KEY_EXISTS: true,
  SYNC_OUT_OF_SCOPE: true,
  SYNC_ACTION_REFUSED: true,
  SYNC_TOO_MANY_MUTATIONS: true,
  SYNC_BAD_REQUEST: true,
} satisfies Record<SyncErrorCode, true>

function isWireCode(code: unknown): code is SyncErrorCode {
  return typeof code === "string" && Object.hasOwn(wireCodes, code)
}

/** The primary key column. Before the first pull it is not known yet, and `id` is the likely name. */
function keyColumnOf(meta: SyncMeta | undefined): string {
  return meta?.key ?? "id"
}

/** The subset without `undefined` values, so `{ issueId: undefined }` is the whole table. */
function cleanWhere(where: object | undefined): SyncValues {
  const clean: SyncValues = {}
  for (const [column, value] of Object.entries(where ?? {})) {
    if (value !== undefined) clean[column] = value
  }
  return clean
}

/** A stable text for a subset: the same columns and values give the same text, in any order. Empty for no subset. */
function whereKey(where: object | undefined): string {
  const clean = cleanWhere(where)
  const columns = Object.keys(clean).sort()
  return columns.length ? JSON.stringify(Object.fromEntries(columns.map(column => [column, clean[column]]))) : ""
}

/** The single values of a scope. An array, such as the teams of the caller, has no one value to write. */
function singleValues(values: SyncValues | undefined): SyncValues {
  const single: SyncValues = {}
  for (const [column, value] of Object.entries(values ?? {})) {
    if (!Array.isArray(value)) single[column] = value
  }
  return single
}

/**
 * `true` when the write belongs to `account`, or was made before the first pull. A write of an account waits for the
 * pull that tells the account, such as after `clearSync({ keepWrites: true })`.
 */
function isOwn(write: SyncNewWrite, account: string | undefined): boolean {
  return write.account === null || write.account === account
}

/** `true` when the write belongs to `account` and goes to the server. A refused write is not active. */
function isActive(write: SyncNewWrite, account: string | undefined): boolean {
  return !write.error && isOwn(write, account)
}

/** `true` when the failure belongs to the current account. */
function isOwnFailure(write: SyncNewWrite, account: string | undefined): boolean {
  return Boolean(write.error) && isOwn(write, account)
}

/**
 * The rows that a pull or a meta describes: the account, the scope, the table version and the subset. A live stream
 * delivers pulls of the generation that it opened with. When the generation of the store changes, those pulls are old.
 */
function generationOf(value: { account: string, scope: { id: string }, version: string }, subset: string): string {
  return JSON.stringify([value.account, value.scope.id, value.version, subset])
}

/** The row of an insert on the wire: the single scope values, then the caller's value, then the key. */
function wireRow(write: Extract<SyncNewWrite, { op: "insert" }>, meta: SyncMeta | undefined): SyncRow {
  return { ...singleValues(meta?.scope.values), ...write.value, [keyColumnOf(meta)]: write.key }
}

/**
 * The row of an insert in the view: the defaults, the subset, the single scope values, the caller's value, then the
 * key. The defaults stay out of the wire, so the server fills its own.
 */
function insertedRow(value: SyncRow, key: SyncKey, meta: SyncMeta | undefined, where: SyncValues): SyncRow {
  return { ...meta?.defaults, ...where, ...singleValues(meta?.scope.values), ...value, [keyColumnOf(meta)]: key }
}

/**
 * A row write of an optimistic function. `row` of an update with `local.sync()` is the whole row after the patch, so a
 * store of another subset can show a row that moves into it.
 */
type SyncLocalWrite =
  | { op: "insert", key: SyncKey, value: SyncRow }
  | { op: "update", key: SyncKey, patch: SyncRow, row?: SyncRow }
  | { op: "delete", key: SyncKey }

/** A write that the optimistic function of an action makes with `local.sync(name)`. `id` is the id of the action. */
type SyncLinkedWrite = SyncLocalWrite & { id: string }

/** The open stores of other Sync names on the page, as an optimistic function reads them. */
interface SyncViewPage {
  /**
   * The row with this key in an open store of `name`, without the writes that actions make in that store with
   * `local.sync()`. An optimistic function that runs again so does not read its own earlier change.
   */
  get: (name: string, key: SyncKey) => SyncRow | undefined
  /** The primary key column of the rows of `name`. */
  key: (name: string) => string
}

/** What `buildView` needs besides the rows and the writes. */
interface SyncViewContext {
  meta: SyncMeta | undefined
  /** The subset of the store. */
  where: SyncValues
  /** The optimistic functions of actions, by name. */
  actions: ReadonlyMap<string, (local: SyncLocal<SyncRow>, args: unknown) => void>
  /** Gets an error that an optimistic function threw. The other writes still apply. */
  report: (write: SyncNewWrite, error: unknown) => void
  page?: SyncViewPage
  /** The writes of actions that the server applied, until the next pull brings their rows. */
  held?: readonly SyncLinkedWrite[]
  /**
   * Actions that the server applied, whose writes in other stores those stores hold now. `local.sync()` of these
   * actions changes nothing, so a later action does not read their writes twice.
   */
  handed?: ReadonlySet<string>
}

interface SyncView {
  rows: ReadonlyMap<SyncKey, SyncRow>
  /** The keys that an active write changes. */
  pending: ReadonlySet<SyncKey>
  /** The writes that the optimistic functions make in the stores of each Sync name. */
  outgoing: ReadonlyMap<string, readonly SyncLinkedWrite[]>
}

/** The key of the row number `index` that an optimistic action inserts without a key. */
function actionKey(id: string, index: number): SyncKey {
  return index ? `${id}-${index}` : id
}

/** `true` when an inserted row belongs to the subset: it has each value of the subset. */
function inSubset(value: SyncRow, where: SyncValues): boolean {
  return Object.entries(where).every(([column, wanted]) => value[column] === wanted)
}

/**
 * Applies a write that an action makes in a store with `local.sync()`, as the store shows it: an inserted or updated row
 * shows when it is in the subset of the store, and an updated row that leaves the subset goes away. Returns `true` when
 * the rows changed.
 */
function linkWrite(rows: Map<SyncKey, SyncRow>, write: SyncLocalWrite, where: SyncValues, meta: SyncMeta | undefined): boolean {
  if (write.op === "delete") return rows.delete(write.key)
  if (write.op === "insert") {
    if (!inSubset(write.value, where)) return false
    rows.set(write.key, insertedRow(write.value, write.key, meta, where))
    return true
  }
  const row = rows.get(write.key)
  const next = row ? { ...row, ...write.patch } : write.row
  if (!next || !inSubset(next, where)) return rows.delete(write.key)
  rows.set(write.key, next)
  return true
}

/**
 * The confirmed rows with each active write applied in order: row writes, and actions through their optimistic
 * function. Refused writes and writes of another account are left out. Then the writes that applied actions made in
 * this store with `local.sync()` apply, until a pull brings their rows. The writes of actions that wait are not in it:
 * `linkWrites()` adds them.
 */
function buildView(confirmed: ReadonlyMap<SyncKey, SyncRow>, writes: readonly SyncNewWrite[], context: SyncViewContext): SyncView {
  const { meta } = context
  const account = meta?.account
  const pending = new Set<SyncKey>()
  const outgoing = new Map<string, SyncLinkedWrite[]>()
  let view: Map<SyncKey, SyncRow> | undefined
  const rows = () => view ??= new Map(confirmed)
  const apply = (write: SyncLocalWrite) => {
    pending.add(write.key)
    if (write.op === "insert") rows().set(write.key, insertedRow(write.value, write.key, meta, context.where))
    else if (write.op === "delete") rows().delete(write.key)
    else {
      const row = (view ?? confirmed).get(write.key)
      if (row) rows().set(write.key, { ...row, ...write.patch })
    }
  }
  // The rows of each other Sync name as the optimistic functions changed them, in order: `null` after a delete.
  const changes = new Map<string, Map<SyncKey, SyncRow | null>>()
  for (const write of writes) {
    if (!isActive(write, account)) continue
    if (write.op !== "action") {
      apply(write)
      continue
    }
    const optimistic = context.actions.get(write.name)
    if (!optimistic) continue
    let inserted = 0
    let open = true
    const keyOf = (value: SyncRow, column: string) => {
      const given = value[column]
      return typeof given === "string" && given ? given : actionKey(write.id, inserted++)
    }
    const handed = context.handed?.has(write.id) ?? false
    // `local.sync(name)` of this function, by name.
    const linked = new Map<string, SyncLocal<SyncRow>>()
    const storesOf = (name: string): SyncLocal<SyncRow> => {
      const found = linked.get(name)
      if (found) return found
      const changed = changes.get(name) ?? new Map<SyncKey, SyncRow | null>()
      changes.set(name, changed)
      /** Adds the write to the stores of `name`. Returns `false` when they hold it already. */
      const record = (change: SyncLocalWrite) => {
        if (!open) throw syncErrors.SYNC_LOCAL_CLOSED()
        if (handed) return false
        let list = outgoing.get(name)
        if (!list) outgoing.set(name, list = [])
        list.push({ ...change, id: write.id })
        return true
      }
      const get = (key: SyncKey) => changed.has(key) ? changed.get(key) ?? undefined : context.page?.get(name, key)
      const made: SyncLocal<SyncRow> = {
        get,
        insert(value) {
          const column = context.page?.key(name) ?? "id"
          const key = keyOf(value, column)
          if (record({ op: "insert", key, value })) changed.set(key, { ...value, [column]: key })
          return key
        },
        update(key, patch) {
          const before = get(key)
          const row = before && { ...before, ...patch }
          if (record({ op: "update", key, patch, ...(row ? { row } : {}) }) && row) changed.set(key, row)
        },
        delete(key) {
          if (record({ op: "delete", key })) changed.set(key, null)
        },
        sync,
      }
      linked.set(name, made)
      return made
    }
    // SAFETY: the stores of a name hold the JSON rows of its table, which `SyncRowOf` names.
    const sync = storesOf as SyncLocal<SyncRow>["sync"]
    const local: SyncLocal<SyncRow> = {
      get: key => (view ?? confirmed).get(key),
      insert(value) {
        if (!open) throw syncErrors.SYNC_LOCAL_CLOSED()
        const key = keyOf(value, keyColumnOf(meta))
        apply({ op: "insert", key, value })
        return key
      },
      update(key, patch) {
        if (!open) throw syncErrors.SYNC_LOCAL_CLOSED()
        apply({ op: "update", key, patch })
      },
      delete(key) {
        if (!open) throw syncErrors.SYNC_LOCAL_CLOSED()
        apply({ op: "delete", key })
      },
      sync,
    }
    try {
      optimistic(local, write.args)
    }
    catch (error) {
      context.report(write, error)
    }
    open = false
  }
  // The writes of applied actions do not show as pending: the server has them.
  for (const write of context.held ?? []) linkWrite(rows(), write, context.where, meta)
  return { rows: view ?? confirmed, pending, outgoing }
}

/** The view with the writes that the actions that wait make in this store with `local.sync()`. They show as pending. */
function linkWrites(view: SyncView, writes: readonly SyncLinkedWrite[], where: SyncValues, meta: SyncMeta | undefined): SyncView {
  if (!writes.length) return view
  const rows = new Map(view.rows)
  const pending = new Set(view.pending)
  for (const write of writes) {
    if (linkWrite(rows, write, where, meta)) pending.add(write.key)
  }
  return { rows, pending, outgoing: view.outgoing }
}

/** The mutation that goes on the wire for a queued write. */
function toMutation(write: SyncNewWrite, meta: SyncMeta | undefined): SyncMutation {
  if (write.op === "insert") return { id: write.id, op: "insert", value: wireRow(write, meta) }
  if (write.op === "update") return { id: write.id, op: "update", key: write.key, patch: write.patch }
  if (write.op === "action") return { id: write.id, op: "action", name: write.name, args: write.args }
  return { id: write.id, op: "delete", key: write.key }
}

/**
 * The storage change for a pull. Writes made before the first pull take its account. Writes of another account stay as
 * they are, for when that account comes back. A new scope or table version drops the rows, not the writes.
 */
function pullChange(meta: SyncMeta | undefined, pull: SyncPullResponse, writes: readonly SyncQueuedWrite[]): SyncStorageChange {
  const update = writes.filter(write => write.account === null).map(write => ({ ...write, account: pull.account }))
  return {
    meta: { key: pull.key, cursor: pull.cursor, scope: pull.scope, account: pull.account, version: pull.version, defaults: pull.defaults },
    reset: pull.reset || (meta !== undefined && (meta.scope.id !== pull.scope.id || meta.version !== pull.version)),
    put: pull.rows.map(row => [String(row[pull.key]), row]),
    delete: pull.deleted,
    update,
  }
}

/**
 * The outbox change for the results of a push. A write without a result stays queued. `results` has each action that
 * the server applied, with its result, or `undefined` when it returned nothing. A duplicate has the result that the
 * server stored the first time.
 */
function pushChange(sent: readonly SyncQueuedWrite[], results: readonly SyncMutationResult[]): Required<Pick<SyncStorageChange, "remove" | "update">> & { results: Map<string, unknown> } {
  const byId = new Map(results.map(result => [result.id, result]))
  const remove: number[] = []
  const update: SyncQueuedWrite[] = []
  const values = new Map<string, unknown>()
  for (const write of sent) {
    const result = byId.get(write.id)
    if (result?.status === "applied" || result?.status === "duplicate") {
      remove.push(write.seq)
      if (write.op === "action") values.set(write.id, result.result)
    }
    else if (result?.status === "rejected") update.push({ ...write, error: result.error })
  }
  return { remove, update, results: values }
}

/**
 * The update that a new update of `key` merges into: the last active write of `local` that changes `key`, when it is an
 * update that is not on its way to storage (`storing`). `local` holds the writes of this tab that are not stored yet, so
 * no other tab and no push has them. An action in between stops the search, since its server code may read the row.
 */
function mergeTarget(local: readonly SyncNewWrite[], key: SyncKey, account: string | undefined, storing: ReadonlySet<string>): Extract<SyncNewWrite, { op: "update" }> | undefined {
  for (let index = local.length - 1; index >= 0; index--) {
    const write = local[index]!
    if (!isActive(write, account)) continue
    if (write.op === "action") return undefined
    if (write.key !== key) continue
    return write.op === "update" && !storing.has(write.id) ? write : undefined
  }
  return undefined
}

/**
 * A version 4 UUID. `crypto.randomUUID()` exists only on HTTPS and localhost, and an app on a LAN address in development
 * has neither, so this falls back to `crypto.getRandomValues()`.
 */
function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0F) | 0x40
  bytes[8] = (bytes[8]! & 0x3F) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Whether a JSON value is a `SyncPullResponse`. */
function isPull(value: unknown): value is SyncPullResponse {
  if (!value || typeof value !== "object") return false
  const scope: unknown = Reflect.get(value, "scope")
  return typeof Reflect.get(value, "key") === "string"
    && typeof Reflect.get(value, "cursor") === "number"
    && typeof Reflect.get(value, "account") === "string"
    && typeof Reflect.get(value, "version") === "string"
    && Array.isArray(Reflect.get(value, "rows"))
    && Array.isArray(Reflect.get(value, "deleted"))
    && Boolean(scope) && typeof scope === "object" && typeof Reflect.get(scope as object, "id") === "string"
}

/** Milliseconds before retry number `attempt + 1`: 1 s doubling to 30 s, with a random wait in the upper half. */
function backoffDelay(attempt: number, random: number): number {
  const ceiling = Math.min(30_000, 1000 * 2 ** attempt)
  return ceiling / 2 + random * ceiling / 2
}

function readIssues(value: unknown): { path?: string, message: string }[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((issue: unknown) => {
    if (!issue || typeof issue !== "object") return []
    const message: unknown = Reflect.get(issue, "message")
    const path: unknown = Reflect.get(issue, "path")
    return typeof message === "string" ? [{ message, ...(typeof path === "string" ? { path } : {}) }] : []
  })
}

const statusCodes: Record<number, SyncErrorCode> = {
  401: "SYNC_UNAUTHORIZED",
  403: "SYNC_FORBIDDEN",
  409: "SYNC_ACCOUNT_CHANGED",
  413: "SYNC_TOO_MANY_MUTATIONS",
}

/** The error of a response that is not 2xx, from the ViteHub error body `{ code, message, issues }`. */
function readError(status: number, body: unknown): SyncError {
  const fields = body && typeof body === "object" ? body : {}
  const code: unknown = Reflect.get(fields, "code")
  const message: unknown = Reflect.get(fields, "message")
  const fix: unknown = Reflect.get(fields, "fix")
  const issues = readIssues(Reflect.get(fields, "issues"))
  const known = status >= 500 ? "SYNC_SERVER_ERROR" : isWireCode(code) ? code : statusCodes[status] ?? "SYNC_BAD_REQUEST"
  return new SyncError(known, typeof message === "string" ? message : `The Sync route answered ${status}.`, { status, ...(issues ? { issues } : {}), ...(typeof fix === "string" ? { fix } : {}) })
}

/** A `SyncError` for a code that the client makes, with the why and fix of the catalog. */
function clientError(diagnostic: { code: SyncClientErrorCode, message: string, fix?: string | undefined }): SyncError {
  return new SyncError(diagnostic.code, diagnostic.message, diagnostic.fix ? { fix: diagnostic.fix } : {})
}

/** The wire form of an error, to keep with a refused write. */
function toWireError(error: SyncError): SyncWireError {
  const code = isWireCode(error.code) ? error.code : "SYNC_BAD_REQUEST"
  return { code, message: error.message, ...(error.issues ? { issues: error.issues } : {}) }
}

export { backoffDelay, buildView, cleanWhere, clientError, generationOf, insertedRow, isActive, isOwnFailure, isPull, keyColumnOf, linkWrite, linkWrites, mergeTarget, pullChange, pushChange, randomUUID, readError, singleValues, toMutation, toWireError, whereKey }
export type { SyncLinkedWrite, SyncView, SyncViewContext, SyncViewPage }
