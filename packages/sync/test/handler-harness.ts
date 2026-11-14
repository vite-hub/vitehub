import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"

import { syncTables } from "../src/database.ts"
import { handleSyncRequest } from "../src/runtime.ts"

import type { InStatement } from "@libsql/client"
import type { SyncDatabase } from "../src/database.ts"
import type { SyncPullResponse, SyncPushResponse, SyncValues } from "../src/protocol.ts"
import type { SyncServices } from "../src/runtime.ts"
import type { SyncDefinition, SyncUser } from "../src/types.ts"

export const origin = "https://app.test"
export const day = 86_400_000

/** The teams of a test user, from the `x-teams` header. */
export function teamsOf(user: SyncUser): string[] {
  const teams: unknown = user.teams
  return Array.isArray(teams) ? teams.filter((team): team is string => typeof team === "string") : []
}

/** What a client holds after a pull. */
export interface Held {
  cursor?: number
  scope?: string
  version?: string
  account?: string
}

export interface Caller {
  user: string | null
  teams?: readonly string[]
}

function callerHeaders(caller: Caller | string | null): Record<string, string> {
  const { user, teams } = typeof caller === "object" && caller !== null ? caller : { user: caller, teams: undefined }
  return { ...(user ? { "x-user": user } : {}), ...(teams ? { "x-teams": teams.join(",") } : {}) }
}

/**
 * A Sync definition on a real libSQL Database in memory. `statements` records the number of bound parameters of every
 * statement, so tests can check D1's limit of 100.
 */
export async function createHarness<TTable, TRow, TArgs>(options: {
  name: string
  ddl: readonly string[]
  definition: SyncDefinition<TTable, TRow, TArgs>
  live?: SyncServices["live"]
}) {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${[...syncTables, ...options.ddl].join(";\n")};`)
  const parameters: number[] = []
  const record = (statement: InStatement) => {
    if (typeof statement === "string") parameters.push(0)
    else parameters.push(Array.isArray(statement.args) ? statement.args.length : Object.keys(statement.args ?? {}).length)
  }
  const counted = new Proxy(client, {
    get(target, property) {
      if (property === "execute") {
        return async (statement: InStatement) => {
          record(statement)
          return await target.execute(statement)
        }
      }
      if (property === "batch") {
        return async (statements: InStatement[], mode?: "write" | "read" | "deferred") => {
          statements.forEach(record)
          return await target.batch(statements, mode)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const db: SyncDatabase = drizzle({ client: counted })
  const clock = { now: 1_000_000_000_000 }
  const services: SyncServices = {
    db,
    now: () => clock.now,
    identify: async (request: Request) => {
      const id = request.headers.get("x-user")
      const teams = request.headers.get("x-teams")
      return id ? { user: { id, ...(teams !== null ? { teams: teams ? teams.split(",") : [] } : {}) }, session: null } : null
    },
    ...(options.live ? { live: options.live } : {}),
  }
  const route = `/api/_vitehub/sync/${options.name}`
  const call = (request: Request, using: SyncServices = services) => handleSyncRequest(options.name, options.definition, request, using)

  function pullUrl(query: Held & { where?: SyncValues, live?: boolean }): URL {
    const url = new URL(route, origin)
    if (query.live) url.searchParams.set("live", "1")
    if (query.cursor !== undefined) url.searchParams.set("cursor", String(query.cursor))
    if (query.scope) url.searchParams.set("scope", query.scope)
    if (query.version) url.searchParams.set("version", query.version)
    if (query.where) url.searchParams.set("where", JSON.stringify(query.where))
    return url
  }

  async function pull(caller: Caller | string | null, query: Held & { where?: SyncValues } = {}, headers: Record<string, string> = {}) {
    const response = await call(new Request(pullUrl(query), { headers: { ...callerHeaders(caller), ...headers } }))
    // SAFETY: the tests read the documented answer of a pull.
    return { status: response.status, headers: response.headers, body: await response.json() as SyncPullResponse & { code?: string, message?: string } }
  }

  /** What a client holds after a fresh pull. */
  async function start(caller: Caller | string | null, where?: SyncValues, headers: Record<string, string> = {}) {
    const { body } = await pull(caller, where ? { where } : {}, headers)
    return { scope: body.scope.id, cursor: body.cursor, version: body.version, account: body.account }
  }

  async function push(caller: Caller | string | null, body: Held & { where?: SyncValues, mutations: unknown[] }, headers: Record<string, string> = {}) {
    const response = await call(new Request(new URL(route, origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...callerHeaders(caller), ...headers },
      body: JSON.stringify(body),
    }))
    // SAFETY: the tests read the documented answer of a push.
    return { status: response.status, body: await response.json() as SyncPushResponse & { code?: string, message?: string } }
  }

  async function live(caller: Caller | string | null, query: Held & { where?: SyncValues } = {}, using: SyncServices = services) {
    const controller = new AbortController()
    const response = await call(new Request(pullUrl({ ...query, live: true }), { headers: callerHeaders(caller), signal: controller.signal }), using)
    return { response, abort: () => controller.abort() }
  }

  return { client, db, clock, services, parameters, call, pull, start, push, live }
}

/** One event of a live stream, as the client parses it. */
export interface ParsedEvent {
  event: string
  id?: string
  data: unknown
}

/** Reads Server-Sent Events from a response. `next()` waits at most `ms` and answers `"timeout"` or `"end"`. */
export function readEvents(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  const comments: string[] = []

  function parse(block: string): ParsedEvent | undefined {
    const event: ParsedEvent = { event: "message", data: undefined }
    let data: string | undefined
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) comments.push(line)
      else if (line.startsWith("event: ")) event.event = line.slice(7)
      else if (line.startsWith("id: ")) event.id = line.slice(4)
      else if (line.startsWith("data: ")) data = (data === undefined ? "" : `${data}\n`) + line.slice(6)
    }
    if (data === undefined) return undefined
    event.data = JSON.parse(data)
    return event
  }

  async function next(ms: number): Promise<ParsedEvent | "timeout" | "end"> {
    const deadline = Date.now() + ms
    for (;;) {
      const split = buffer.indexOf("\n\n")
      if (split >= 0) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const event = parse(block)
        if (event) return event
        continue
      }
      const left = deadline - Date.now()
      if (left <= 0) return "timeout"
      pending ??= reader.read()
      const result = await Promise.race([pending, new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), left))])
      if (result === "timeout") return "timeout"
      pending = undefined
      if (result.done) return "end"
      buffer += decoder.decode(result.value, { stream: true })
    }
  }

  return { next, comments, cancel: () => reader.cancel() }
}
