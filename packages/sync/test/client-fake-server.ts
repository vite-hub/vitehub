// An in-process Sync server for the client tests. It follows protocol.ts v2: a change log with `seq` cursors and exit
// entries for rows that leave a scope, list values in `where`, subsets, a ledger of mutation ids, 409 for another
// account, table versions and defaults, actions with results, resets below the compaction floor, and live streams.
import { syncRoute } from "../src/protocol.ts"

import type { SyncKey, SyncMutation, SyncMutationResult, SyncPullResponse, SyncPushRequest, SyncRow, SyncScope, SyncValues, SyncWireError } from "../src/protocol.ts"

/** A `put` entry is the newest change of a key. An `exit` entry keeps a row as it was before it was deleted or moved. */
type Change = { seq: number, key: SyncKey, op: "put" } | { seq: number, key: SyncKey, op: "exit", row: SyncRow }

/** What a fake action gets: the caller and collected writes, as `SyncActionContext` on the real server. */
export interface FakeActionContext {
  user: string
  get: (key: SyncKey) => SyncRow | undefined
  insert: (value: SyncRow) => SyncKey
  update: (key: SyncKey, patch: SyncRow) => void
  delete: (key: SyncKey) => void
}

export interface FakeSyncServer {
  /** The signed-in user, as the cookie would tell. `null` is a visitor without a session. */
  user: string | null
  /** The `where` of the definition for a user. Default: `{ ownerId: user }`. */
  where: (user: string) => SyncValues
  /** The fingerprint of the table. A client with another one gets a reset. */
  version: string
  defaults: SyncRow
  /** `false` answers live requests with 400, as `defineSync({ live: false })`. */
  live: boolean
  actions: Record<string, (context: FakeActionContext, args: unknown) => unknown>
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
  /** The live streams that are open now. */
  readonly streams: number
  /** Writes a row as server code would, outside Sync, and logs the change. A changed scope column moves the row. */
  write: (row: SyncRow) => void
  /** Deletes a row as server code would. */
  remove: (key: SyncKey) => void
  /** Drops the change log up to now, as compaction does. Older cursors get a reset. */
  compact: () => void
  /** Ends every open live stream, as the server does after its time limit. */
  endStreams: () => void
  fetch: typeof fetch
}

export function accountOf(user: string): string {
  return `account-${user}`
}

/** The scope id of resolved values. */
export function scopeIdOf(values: SyncValues): string {
  return `scope:${JSON.stringify(Object.fromEntries(Object.keys(values).sort().map(column => [column, values[column]])))}`
}

function matches(row: SyncRow | undefined, values: SyncValues): row is SyncRow {
  return Boolean(row) && Object.entries(values).every(([column, value]) => Array.isArray(value) ? value.includes(row![column]) : row![column] === value)
}

export function createFakeSyncServer(name = "todos"): FakeSyncServer {
  const route = syncRoute(name)
  const rows = new Map<SyncKey, SyncRow>()
  let log: Change[] = []
  const ledger = new Set<string>()
  const wakers = new Set<() => void>()
  const enders = new Set<() => void>()
  let seq = 0
  let floor = 0

  function put(key: SyncKey, row: SyncRow | undefined): void {
    const before = rows.get(key)
    if (before) log.push({ seq: ++seq, key, op: "exit", row: before })
    if (row) rows.set(key, row)
    else rows.delete(key)
    log = log.filter(change => change.op !== "put" || change.key !== key)
    if (row) log.push({ seq: ++seq, key, op: "put" })
    for (const wake of wakers) wake()
  }

  const server: FakeSyncServer = {
    user: "ada",
    where: user => ({ ownerId: user }),
    version: "v1",
    defaults: {},
    live: true,
    actions: {},
    offline: false,
    loseNextResponse: false,
    failWith: undefined,
    refuse: undefined,
    pageSize: 500,
    rows,
    requests: [],
    applied: [],
    get streams() {
      return enders.size
    },
    write(row) {
      put(String(row.id), { ...row })
    },
    remove(key) {
      if (rows.has(key)) put(key, undefined)
    },
    compact() {
      floor = seq
      log = []
    },
    endStreams() {
      for (const end of enders) end()
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
      const subset = init?.method === "POST" ? body?.where : url.searchParams.has("where") ? JSON.parse(url.searchParams.get("where")!) as SyncValues : undefined
      const scope = resolve(server.where(user), subset)
      if ("code" in scope) return error(scope.code === "SYNC_OUT_OF_SCOPE" ? 403 : 400, scope)
      const account = accountOf(user)
      if (init?.method !== "POST") {
        const query = url.searchParams
        const cursor = query.has("cursor") ? Number(query.get("cursor")) : undefined
        if (query.has("live")) {
          if (!server.live) return error(400, { code: "SYNC_BAD_REQUEST", message: "This Sync definition has no live stream." })
          return stream(scope, account, cursor, query.get("scope") ?? undefined, query.get("version") ?? undefined, init?.signal ?? undefined)
        }
        return json(pull(scope, account, cursor, query.get("scope") ?? undefined, query.get("version") ?? undefined))
      }
      if (!body) return error(400, { code: "SYNC_BAD_REQUEST", message: "No body." })
      if (body.account !== account) return error(409, { code: "SYNC_SCOPE_CHANGED", message: "The writes were made for another account." })
      const results = body.mutations.map(mutation => apply(mutation, scope.values, user))
      const answer = json({ results, pull: pull(scope, account, body.cursor, body.scope, body.version) })
      if (server.loseNextResponse) {
        server.loseNextResponse = false
        throw new TypeError("Failed to fetch")
      }
      return answer
    },
  }

  /** Merges the subset into `where`, as the real server does. */
  function resolve(where: SyncValues, subset: SyncValues | undefined): SyncScope | SyncWireError {
    const values: SyncValues = { ...where }
    for (const [column, value] of Object.entries(subset ?? {})) {
      if (Array.isArray(value) || (value !== null && typeof value === "object")) return { code: "SYNC_BAD_REQUEST", message: `The subset value of ${column} must be a single value.` }
      const allowed = where[column]
      if (column in where && (Array.isArray(allowed) ? !allowed.includes(value) : allowed !== value)) return { code: "SYNC_OUT_OF_SCOPE", message: `The subset sets ${column} outside where.` }
      values[column] = value
    }
    return { id: scopeIdOf({ name, ...values }), values }
  }

  function pull(scope: SyncScope, account: string, cursor: number | undefined, scopeId: string | undefined, version: string | undefined): SyncPullResponse {
    const base = { key: "id", scope, account, version: server.version, defaults: server.defaults }
    if (cursor === undefined || scopeId !== scope.id || version !== server.version || cursor < floor) {
      return { ...base, cursor: seq, reset: true, rows: [...rows.values()].filter(row => matches(row, scope.values)), deleted: [], more: false }
    }
    const later = log.filter(change => change.seq > cursor)
    const page = later.slice(0, server.pageSize)
    const changed = new Map<SyncKey, SyncRow>()
    const deleted = new Set<SyncKey>()
    for (const change of page) {
      const current = rows.get(change.key)
      if (change.op === "put" && matches(current, scope.values)) changed.set(change.key, current)
      if (change.op === "exit" && matches(change.row, scope.values) && !matches(current, scope.values)) deleted.add(change.key)
    }
    for (const key of changed.keys()) deleted.delete(key)
    return { ...base, cursor: page.at(-1)?.seq ?? cursor, reset: false, rows: [...changed.values()], deleted: [...deleted], more: later.length > page.length }
  }

  function stream(scope: SyncScope, account: string, cursor: number | undefined, scopeId: string | undefined, version: string | undefined, signal: AbortSignal | undefined): Response {
    const encoder = new TextEncoder()
    let at = cursor
    let held = scopeId
    let heldVersion = version
    let closed = false
    let woken = false
    let stop = () => undefined as void
    let abort = () => undefined as void
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = () => {
          woken = false
          if (closed || (at !== undefined && at >= seq && held === scope.id && heldVersion === server.version)) return
          const next = pull(scope, account, at, held, heldVersion)
          at = next.cursor
          held = next.scope.id
          heldVersion = next.version
          if (!next.reset && !next.rows.length && !next.deleted.length) return
          controller.enqueue(encoder.encode(`event: pull\nid: ${next.cursor}\ndata: ${JSON.stringify({ pull: next })}\n\n`))
        }
        // One push or server write wakes the stream once, after it committed, as the real notifier does.
        const wake = () => {
          if (woken) return
          woken = true
          queueMicrotask(send)
        }
        stop = () => {
          closed = true
          wakers.delete(wake)
          enders.delete(end)
          signal?.removeEventListener("abort", abort)
        }
        const end = () => {
          if (closed) return
          stop()
          controller.close()
        }
        // An aborted fetch fails the read of its body, as in the browser.
        abort = () => {
          stop()
          controller.error(new DOMException("The live request was aborted.", "AbortError"))
        }
        wakers.add(wake)
        enders.add(end)
        signal?.addEventListener("abort", abort)
        controller.enqueue(encoder.encode(": ping\n\n"))
        send()
      },
      cancel() {
        stop()
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "private, no-store" } })
  }

  function apply(mutation: SyncMutation, values: SyncValues, user: string): SyncMutationResult {
    if (ledger.has(mutation.id)) return { id: mutation.id, status: "duplicate" }
    const refused = (code: SyncWireError["code"], message: string): SyncMutationResult => ({ id: mutation.id, status: "rejected", error: { code, message } })
    const singles = Object.fromEntries(Object.entries(values).filter(([, value]) => !Array.isArray(value)))
    const writes: [SyncKey, SyncRow | undefined][] = []
    // Checks one row write as the real server does, and collects it.
    const check = (write: Exclude<SyncMutation, { op: "action" }>): SyncWireError | undefined => {
      if (write.op === "insert") {
        const key = String(write.value.id)
        if (rows.has(key) || writes.some(([other]) => other === key)) return { code: "SYNC_KEY_EXISTS", message: "The key exists." }
        const row = { ...server.defaults, ...write.value, ...singles }
        if (!matches({ ...write.value, ...singles }, values)) return { code: "SYNC_OUT_OF_SCOPE", message: "Out of scope." }
        writes.push([key, row])
        return undefined
      }
      const row = rows.get(write.key)
      if (!matches(row, values)) return write.op === "delete" ? undefined : { code: "SYNC_NOT_FOUND", message: "No such row." }
      if (write.op === "delete") {
        writes.push([write.key, undefined])
        return undefined
      }
      const next = { ...row, ...write.patch }
      if (!matches(next, values) || Object.keys(singles).some(column => column in write.patch && write.patch[column] !== row[column])) return { code: "SYNC_OUT_OF_SCOPE", message: "Out of scope." }
      writes.push([write.key, next])
      return undefined
    }
    let result: unknown
    if (mutation.op === "action") {
      const run = server.actions[mutation.name]
      if (!run) return refused("SYNC_INVALID", `No action ${mutation.name}.`)
      const collected: Exclude<SyncMutation, { op: "action" }>[] = []
      try {
        result = run({
          user,
          get: key => matches(rows.get(key), values) ? rows.get(key) : undefined,
          insert(value) {
            const key = typeof value.id === "string" ? value.id : crypto.randomUUID()
            collected.push({ id: mutation.id, op: "insert", value: { ...value, id: key } })
            return key
          },
          update: (key, patch) => void collected.push({ id: mutation.id, op: "update", key, patch }),
          delete: key => void collected.push({ id: mutation.id, op: "delete", key }),
        }, mutation.args)
      }
      catch (cause) {
        return refused("SYNC_ACTION_REFUSED", cause instanceof Error ? cause.message : "The action failed.")
      }
      for (const write of collected) {
        const failed = check(write)
        if (failed) return { id: mutation.id, status: "rejected", error: failed }
      }
    }
    else {
      const failed = check(mutation)
      if (failed) return { id: mutation.id, status: "rejected", error: failed }
    }
    const error = server.refuse?.(mutation)
    if (error) return { id: mutation.id, status: "rejected", error }
    for (const [key, row] of writes) put(key, row)
    ledger.add(mutation.id)
    server.applied.push(mutation)
    return { id: mutation.id, status: "applied", ...(result === undefined ? {} : { result }) }
  }

  return server
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "private, no-store" } })
}

function error(status: number, body: SyncWireError): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}
