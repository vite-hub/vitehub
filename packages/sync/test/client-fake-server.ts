// An in-process Sync server for the client tests. It follows protocol.ts: a change log with `seq` cursors, scope ids
// from the caller, a ledger of mutation ids, 409 on a stale scope, and resets below the compaction floor.
import { syncRoute } from "../src/protocol.ts"

import type { SyncKey, SyncMutation, SyncMutationResult, SyncPullResponse, SyncPushRequest, SyncRow, SyncWireError } from "../src/protocol.ts"

interface Change { seq: number, op: "put" | "delete", row?: SyncRow }

export interface FakeSyncServer {
  /** The signed-in user, as the cookie would tell. `null` is a visitor without a session. */
  user: string | null
  /** `true` makes every request fail like a dropped connection, before the server reads it. */
  offline: boolean
  /** The server applies the next push, then the connection drops before the answer arrives. */
  loseNextResponse: boolean
  /** The status of the next responses, such as 503. `undefined` answers normally. */
  failWith: number | undefined
  /** Refuses a mutation with this error, after the scope checks. */
  refuse: ((mutation: SyncMutation) => SyncWireError | undefined) | undefined
  /** The most changes in one pull. */
  pageSize: number
  readonly rows: Map<SyncKey, SyncRow>
  /** Every request that reached the server, in order. */
  readonly requests: { method: string, url: URL, body?: SyncPushRequest }[]
  /** Every mutation that the server applied, in order. A replayed id is not here twice. */
  readonly applied: SyncMutation[]
  /** Writes a row as server code would, outside Sync, and logs the change. */
  write: (row: SyncRow) => void
  /** Deletes a row as server code would. */
  remove: (key: SyncKey) => void
  /** Drops the change log up to now, as compaction does. Older cursors get a reset. */
  compact: () => void
  fetch: typeof fetch
}

export function scopeIdOf(user: string): string {
  return `scope-${user}`
}

export function createFakeSyncServer(name = "todos"): FakeSyncServer {
  const route = syncRoute(name)
  const rows = new Map<SyncKey, SyncRow>()
  const changes = new Map<SyncKey, Change>()
  const ledger = new Set<string>()
  let seq = 0
  let floor = 0

  const log = (key: SyncKey, op: "put" | "delete", row?: SyncRow) => {
    changes.delete(key)
    changes.set(key, { seq: ++seq, op, ...(row ? { row } : {}) })
  }

  const server: FakeSyncServer = {
    user: "ada",
    offline: false,
    loseNextResponse: false,
    failWith: undefined,
    refuse: undefined,
    pageSize: 500,
    rows,
    requests: [],
    applied: [],
    write(row) {
      rows.set(String(row.id), row)
      log(String(row.id), "put")
    },
    remove(key) {
      const row = rows.get(key)
      if (!row) return
      rows.delete(key)
      log(key, "delete", row)
    },
    compact() {
      floor = seq
      changes.clear()
    },
    async fetch(input, init) {
      const url = new URL(String(input), "http://app.test")
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as SyncPushRequest : undefined
      if (server.offline) throw new TypeError("Failed to fetch")
      server.requests.push({ method: init?.method ?? "GET", url, ...(body ? { body } : {}) })
      if (server.failWith) return error(server.failWith, { code: "SYNC_BAD_REQUEST", message: "The server failed." })
      if (url.pathname !== route) return error(404, { code: "SYNC_BAD_REQUEST", message: "No such route." })
      const user = server.user
      if (!user) return error(401, { code: "SYNC_UNAUTHORIZED", message: "Sign in to sync." })
      const scope = { id: scopeIdOf(user), values: { ownerId: user } }
      if (init?.method !== "POST") {
        const cursor = url.searchParams.get("cursor")
        return json(pull(scope, cursor === null ? undefined : Number(cursor), url.searchParams.get("scope") ?? undefined))
      }
      if (!body) return error(400, { code: "SYNC_BAD_REQUEST", message: "No body." })
      if (body.scope !== scope.id) return error(409, { code: "SYNC_SCOPE_CHANGED", message: "The writes were made for another scope." })
      const results = body.mutations.map(mutation => apply(mutation, scope.values))
      const answer = json({ results, pull: pull(scope, body.cursor, body.scope) })
      if (server.loseNextResponse) {
        server.loseNextResponse = false
        throw new TypeError("Failed to fetch")
      }
      return answer
    },
  }

  function inScope(row: SyncRow | undefined, values: Record<string, unknown>): row is SyncRow {
    return Boolean(row) && Object.entries(values).every(([column, value]) => row![column] === value)
  }

  function pull(scope: { id: string, values: Record<string, unknown> }, cursor: number | undefined, scopeId: string | undefined): SyncPullResponse {
    if (cursor === undefined || scopeId !== scope.id || cursor < floor) {
      return { key: "id", scope, cursor: seq, reset: true, rows: [...rows.values()].filter(row => inScope(row, scope.values)), deleted: [], more: false }
    }
    const later = [...changes.entries()].filter(([, change]) => change.seq > cursor).sort((a, b) => a[1].seq - b[1].seq)
    const page = later.slice(0, server.pageSize)
    const changed: SyncRow[] = []
    const deleted: SyncKey[] = []
    for (const [key, change] of page) {
      if (change.op === "put" && inScope(rows.get(key), scope.values)) changed.push(rows.get(key)!)
      if (change.op === "delete" && inScope(change.row, scope.values)) deleted.push(key)
    }
    return { key: "id", scope, cursor: page.at(-1)?.[1].seq ?? cursor, reset: false, rows: changed, deleted, more: later.length > page.length }
  }

  function apply(mutation: SyncMutation, values: Record<string, unknown>): SyncMutationResult {
    if (ledger.has(mutation.id)) return { id: mutation.id, status: "duplicate" }
    const refused = (code: SyncWireError["code"], message: string): SyncMutationResult => ({ id: mutation.id, status: "rejected", error: { code, message } })
    if (mutation.op === "insert") {
      const key = String(mutation.value.id)
      if (rows.has(key)) return refused("SYNC_KEY_EXISTS", "The key exists.")
      if (!inScope({ ...values, ...mutation.value }, values)) return refused("SYNC_OUT_OF_SCOPE", "Out of scope.")
      const error = server.refuse?.(mutation)
      if (error) return { id: mutation.id, status: "rejected", error }
      rows.set(key, { ...mutation.value, ...values })
      log(key, "put")
    }
    else if (mutation.op === "update") {
      const row = rows.get(mutation.key)
      if (!inScope(row, values)) return refused("SYNC_NOT_FOUND", "No such row.")
      if (!inScope({ ...row, ...mutation.patch }, values)) return refused("SYNC_OUT_OF_SCOPE", "Out of scope.")
      const error = server.refuse?.(mutation)
      if (error) return { id: mutation.id, status: "rejected", error }
      rows.set(mutation.key, { ...row, ...mutation.patch })
      log(mutation.key, "put")
    }
    else {
      const row = rows.get(mutation.key)
      if (row && inScope(row, values)) {
        const error = server.refuse?.(mutation)
        if (error) return { id: mutation.id, status: "rejected", error }
        rows.delete(mutation.key)
        log(mutation.key, "delete", row)
      }
    }
    ledger.add(mutation.id)
    server.applied.push(mutation)
    return { id: mutation.id, status: "applied" }
  }

  return server
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "private, no-store" } })
}

function error(status: number, body: SyncWireError): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}
