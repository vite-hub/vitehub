// Pure decisions of the Sync client. The store calls them and does the side effects.
import { SyncError } from "./types.ts"

import type { SyncErrorCode, SyncKey, SyncMutation, SyncMutationResult, SyncPullResponse, SyncRow, SyncWireError } from "../protocol.ts"
import type { SyncMeta, SyncNewWrite, SyncQueuedWrite, SyncStorageChange } from "./storage.ts"

const wireCodes = {
  SYNC_UNAUTHORIZED: true,
  SYNC_FORBIDDEN: true,
  SYNC_SCOPE_CHANGED: true,
  SYNC_READ_ONLY: true,
  SYNC_INVALID: true,
  SYNC_NOT_FOUND: true,
  SYNC_KEY_EXISTS: true,
  SYNC_OUT_OF_SCOPE: true,
  SYNC_TOO_MANY_MUTATIONS: true,
  SYNC_BAD_REQUEST: true,
} satisfies Record<SyncErrorCode, true>

const scopeChanged: SyncWireError = {
  code: "SYNC_SCOPE_CHANGED",
  message: "This write was made for another account or scope. It was not sent.",
}

function isWireCode(code: unknown): code is SyncErrorCode {
  return typeof code === "string" && Object.hasOwn(wireCodes, code)
}

/** The primary key column. Before the first pull it is not known yet, and `id` is the likely name. */
function keyColumnOf(meta: SyncMeta | undefined): string {
  return meta?.key ?? "id"
}

/** The row of an insert: the scope values, then the caller's value, then the key. */
function insertedRow(write: Extract<SyncNewWrite, { op: "insert" }>, meta: SyncMeta | undefined): SyncRow {
  return { ...meta?.scope.values, ...write.value, [keyColumnOf(meta)]: write.key }
}

/** The confirmed rows with each queued write applied in order. Refused writes are left out. */
function replayWrites(confirmed: ReadonlyMap<SyncKey, SyncRow>, writes: readonly SyncNewWrite[], meta: SyncMeta | undefined): ReadonlyMap<SyncKey, SyncRow> {
  let view: Map<SyncKey, SyncRow> | undefined
  for (const write of writes) {
    if (write.error) continue
    view ??= new Map(confirmed)
    if (write.op === "insert") view.set(write.key, insertedRow(write, meta))
    else if (write.op === "delete") view.delete(write.key)
    else {
      const row = view.get(write.key)
      if (row) view.set(write.key, { ...row, ...write.patch })
    }
  }
  return view ?? confirmed
}

/** The mutation that goes on the wire for a queued write. */
function toMutation(write: SyncNewWrite, meta: SyncMeta | undefined): SyncMutation {
  if (write.op === "insert") return { id: write.id, op: "insert", value: insertedRow(write, meta) }
  if (write.op === "update") return { id: write.id, op: "update", key: write.key, patch: write.patch }
  return { id: write.id, op: "delete", key: write.key }
}

/**
 * The storage change for a pull. Writes made before the first pull take its scope. Writes of another scope become
 * failures, so they are never sent with the new caller's session.
 */
function pullChange(meta: SyncMeta | undefined, pull: SyncPullResponse, writes: readonly SyncQueuedWrite[]): SyncStorageChange {
  const scope = pull.scope.id
  const update: SyncQueuedWrite[] = []
  for (const write of writes) {
    if (write.error || write.scope === scope) continue
    update.push(write.scope === null ? { ...write, scope } : { ...write, error: scopeChanged })
  }
  return {
    meta: { key: pull.key, cursor: pull.cursor, scope: pull.scope },
    reset: pull.reset || (meta !== undefined && meta.scope.id !== scope),
    put: pull.rows.map(row => [String(row[pull.key]), row]),
    delete: pull.deleted,
    update,
  }
}

/** The outbox change for the results of a push. A write without a result stays queued. */
function pushChange(sent: readonly SyncQueuedWrite[], results: readonly SyncMutationResult[]): Required<Pick<SyncStorageChange, "remove" | "update">> {
  const byId = new Map(results.map(result => [result.id, result]))
  const remove: number[] = []
  const update: SyncQueuedWrite[] = []
  for (const write of sent) {
    const result = byId.get(write.id)
    if (result?.status === "applied" || result?.status === "duplicate") remove.push(write.seq)
    else if (result?.status === "rejected") update.push({ ...write, error: result.error })
  }
  return { remove, update }
}

/** Marks writes as made for another scope. */
function failScope(writes: readonly SyncQueuedWrite[]): SyncQueuedWrite[] {
  return writes.map(write => ({ ...write, error: scopeChanged }))
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
  const issues = readIssues(Reflect.get(fields, "issues"))
  const known = status >= 500 ? "SYNC_SERVER_ERROR" : isWireCode(code) ? code : statusCodes[status] ?? "SYNC_BAD_REQUEST"
  return new SyncError(known, typeof message === "string" ? message : `The Sync route answered ${status}.`, { status, ...(issues ? { issues } : {}) })
}

/** The wire form of an error, to keep with a refused write. */
function toWireError(error: SyncError): SyncWireError {
  const code = isWireCode(error.code) ? error.code : "SYNC_BAD_REQUEST"
  return { code, message: error.message, ...(error.issues ? { issues: error.issues } : {}) }
}

export { backoffDelay, failScope, insertedRow, keyColumnOf, pullChange, pushChange, randomUUID, readError, replayWrites, toMutation, toWireError }
