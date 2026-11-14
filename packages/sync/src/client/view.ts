// Pure decisions of the Sync client. The store calls them and does the side effects.
import { SyncError } from "./types.ts"

import type { SyncErrorCode, SyncKey, SyncMutation, SyncMutationResult, SyncPullResponse, SyncRow, SyncValues, SyncWireError } from "../protocol.ts"
import type { SyncMeta, SyncNewWrite, SyncQueuedWrite, SyncStorageChange } from "./storage.ts"
import type { SyncClientErrorCode, SyncLocal } from "./types.ts"

const wireCodes = {
  SYNC_UNAUTHORIZED: true,
  SYNC_FORBIDDEN: true,
  SYNC_SCOPE_CHANGED: true,
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
 * `true` when the write belongs to `account`, or was made before the first pull. A write of Sync v1 waits for the pull
 * of its scope, so it belongs to nobody until then.
 */
function isOwn(write: SyncNewWrite, account: string | undefined): boolean {
  if (write.legacyScope !== undefined) return false
  return write.account === null || account === undefined || write.account === account
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

type RowWrite = Extract<SyncNewWrite, { op: "insert" | "update" | "delete" }>

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

/** What `buildView` needs besides the rows and the writes. */
interface SyncViewContext {
  meta: SyncMeta | undefined
  /** The subset of the store. */
  where: SyncValues
  /** The optimistic functions of actions, by name. */
  actions: ReadonlyMap<string, (local: SyncLocal<SyncRow>, args: unknown) => void>
  /** Gets an error that an optimistic function threw. The other writes still apply. */
  report: (write: SyncNewWrite, error: unknown) => void
}

interface SyncView {
  rows: ReadonlyMap<SyncKey, SyncRow>
  /** The keys that an active write changes. */
  pending: ReadonlySet<SyncKey>
}

/** The key of the row number `index` that an optimistic action inserts without a key. */
function actionKey(id: string, index: number): SyncKey {
  return index ? `${id}-${index}` : id
}

/**
 * The confirmed rows with each active write applied in order: row writes, and actions through their optimistic
 * function. Refused writes and writes of another account are left out.
 */
function buildView(confirmed: ReadonlyMap<SyncKey, SyncRow>, writes: readonly SyncNewWrite[], context: SyncViewContext): SyncView {
  const { meta } = context
  const account = meta?.account
  const pending = new Set<SyncKey>()
  let view: Map<SyncKey, SyncRow> | undefined
  const rows = () => view ??= new Map(confirmed)
  const apply = (write: RowWrite) => {
    pending.add(write.key)
    if (write.op === "insert") rows().set(write.key, insertedRow(write.value, write.key, meta, context.where))
    else if (write.op === "delete") rows().delete(write.key)
    else {
      const row = (view ?? confirmed).get(write.key)
      if (row) rows().set(write.key, { ...row, ...write.patch })
    }
  }
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
    const local: SyncLocal<SyncRow> = {
      get: key => (view ?? confirmed).get(key),
      insert(value) {
        if (!open) throw new Error("An optimistic action must change `local` before it returns.")
        const given = value[keyColumnOf(meta)]
        const key = typeof given === "string" && given ? given : actionKey(write.id, inserted++)
        apply({ ...write, op: "insert", key, value })
        return key
      },
      update(key, patch) {
        if (!open) throw new Error("An optimistic action must change `local` before it returns.")
        apply({ ...write, op: "update", key, patch })
      },
      delete(key) {
        if (!open) throw new Error("An optimistic action must change `local` before it returns.")
        apply({ ...write, op: "delete", key })
      },
    }
    try {
      optimistic(local, write.args)
    }
    catch (error) {
      context.report(write, error)
    }
    open = false
  }
  return { rows: view ?? confirmed, pending }
}

/** The mutation that goes on the wire for a queued write. */
function toMutation(write: SyncNewWrite, meta: SyncMeta | undefined): SyncMutation {
  if (write.op === "insert") return { id: write.id, op: "insert", value: wireRow(write, meta) }
  if (write.op === "update") return { id: write.id, op: "update", key: write.key, patch: write.patch }
  if (write.op === "action") return { id: write.id, op: "action", name: write.name, args: write.args }
  return { id: write.id, op: "delete", key: write.key }
}

/**
 * The storage change for a pull. Writes made before the first pull take its account. A write of Sync v1 takes it only
 * when the pull has the scope id of the write, which is the same user with the same `where` values. Writes of another
 * account stay as they are, for when that account comes back. A new scope or table version drops the rows, not the
 * writes.
 */
function pullChange(meta: SyncMeta | undefined, pull: SyncPullResponse, writes: readonly SyncQueuedWrite[]): SyncStorageChange {
  const update: SyncQueuedWrite[] = []
  for (const write of writes) {
    if (write.legacyScope !== undefined) {
      if (write.legacyScope !== pull.scope.id) continue
      const { legacyScope: _legacyScope, ...adopted } = write
      update.push({ ...adopted, account: pull.account })
    }
    else if (write.account === null) {
      update.push({ ...write, account: pull.account })
    }
  }
  return {
    meta: { key: pull.key, cursor: pull.cursor, scope: pull.scope, account: pull.account, version: pull.version, defaults: pull.defaults },
    reset: pull.reset || (meta !== undefined && (meta.scope.id !== pull.scope.id || meta.version !== pull.version)),
    put: pull.rows.map(row => [String(row[pull.key]), row]),
    delete: pull.deleted,
    update,
  }
}

/** The outbox change for the results of a push. A write without a result stays queued. */
function pushChange(sent: readonly SyncQueuedWrite[], results: readonly SyncMutationResult[]): Required<Pick<SyncStorageChange, "remove" | "update">> & { results: Map<string, unknown> } {
  const byId = new Map(results.map(result => [result.id, result]))
  const remove: number[] = []
  const update: SyncQueuedWrite[] = []
  const values = new Map<string, unknown>()
  for (const write of sent) {
    const result = byId.get(write.id)
    if (result?.status === "applied" || result?.status === "duplicate") {
      remove.push(write.seq)
      if (result.status === "applied" && result.result !== undefined) values.set(write.id, result.result)
    }
    else if (result?.status === "rejected") update.push({ ...write, error: result.error })
  }
  return { remove, update, results: values }
}

/**
 * The unsent update that a new update of `key` can merge into: the last active write that changes `key`, when it is an
 * update that no tab sent. An action in between stops the search, since its server code may read the row. A sent
 * write may be on the server already, so a merge into it would send its old values again with a new id.
 */
function mergeTarget<TWrite extends SyncNewWrite>(writes: readonly TWrite[], key: SyncKey, account: string | undefined, sending: ReadonlySet<string>): TWrite | undefined {
  for (let index = writes.length - 1; index >= 0; index--) {
    const write = writes[index]!
    if (!isActive(write, account)) continue
    if (write.op === "action") return undefined
    if (write.key !== key) continue
    return write.op === "update" && !write.sent && !sending.has(write.id) ? write : undefined
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
  409: "SYNC_SCOPE_CHANGED",
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

export { backoffDelay, buildView, cleanWhere, clientError, generationOf, insertedRow, isActive, isOwnFailure, keyColumnOf, mergeTarget, pullChange, pushChange, randomUUID, readError, singleValues, toMutation, toWireError, whereKey }
export type { SyncView, SyncViewContext }
