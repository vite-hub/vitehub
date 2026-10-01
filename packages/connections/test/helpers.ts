import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, expect, vi } from "vitest"

import { createConnectionsRuntime, decodeConnectionsKey } from "../src/runtime/core.ts"
import { createConnectionsStore } from "../src/store.ts"

import type { ConnectionsRuntime, ConnectionsRuntimeOptions } from "../src/runtime/core.ts"
import type { ConnectionsDatabase } from "../src/store.ts"
import type { ConnectionDefinition, ConnectionOperation, ConnectionProvider, ConnectionTokenSet } from "../src/types.ts"

const cleanup: Array<() => void> = []

afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

export const accessToken = "ya29.synthetic-access-token-0001"
export const refreshToken = "1//synthetic-refresh-token-0001"

export function testKey(fill = 7): Uint8Array {
  return new Uint8Array(32).fill(fill)
}

export function base64urlKey(fill = 7): string {
  return Buffer.from(testKey(fill)).toString("base64url")
}

export function createDatabase(): ConnectionsDatabase {
  const client = createClient({ url: ":memory:" })
  cleanup.push(() => client.close())
  return drizzle(client)
}

export async function rows(db: ConnectionsDatabase, table: string): Promise<Array<Record<string, unknown>>> {
  const result = await db.all(sql.raw(`SELECT * FROM ${table}`))
  return result.map(row => ({ ...(row as Record<string, unknown>) }))
}

export function tokenSet(overrides: Partial<ConnectionTokenSet> = {}): ConnectionTokenSet {
  return {
    accessToken,
    account: "owner@example.com",
    expiresAt: Date.now() + 3_600_000,
    refreshToken,
    scopes: ["test.read", "test.write"],
    tokenType: "Bearer",
    ...overrides,
  }
}

/** Hand-written provider. `refresh` returns `access-<n>` tokens. */
export function fakeProvider(overrides: Partial<ConnectionProvider> = {}) {
  let count = 0
  const refresh = vi.fn(async (token: ConnectionTokenSet): Promise<ConnectionTokenSet> => {
    count += 1
    return { ...token, accessToken: `refreshed-access-${count}`, expiresAt: Date.now() + 3_600_000 }
  })
  const revoke = vi.fn(async (_token: ConnectionTokenSet): Promise<void> => undefined)
  const provider: ConnectionProvider = {
    authorizationUrl: async input => `https://auth.example/authorize?state=${input.state}`,
    exchange: async () => tokenSet(),
    id: "fake",
    kind: "oauth2",
    origins: ["https://api.example"],
    refresh,
    revoke,
    scopes: ["test.read"],
    ...overrides,
  }
  return { provider, refresh, revoke }
}

export const readOperation: ConnectionOperation<{ id: string }, { id: string, ok: boolean }, "read"> = {
  effect: "read",
  id: "test.items.get",
  request: input => ({ method: "GET", query: { secret: "query-value" }, url: `https://api.example/items/${input.id}` }),
}

export const writeOperation: ConnectionOperation<{ name: string }, { created: string }, "write"> = {
  effect: "write",
  id: "test.items.create",
  parse: body => ({ created: String((body as { name?: unknown }).name) }),
  request: input => ({ body: { name: input.name }, method: "POST", url: "https://api.example/items" }),
}

export interface FetchCall {
  authorization: string | null
  body: string | undefined
  method: string
  url: string
}

/** Records every call and answers with the handler result. Never reaches the network. */
export function mockFetch(handler: (url: URL, init: RequestInit, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    const headers = new Headers(init.headers)
    calls.push({
      authorization: headers.get("authorization"),
      body: typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : undefined,
      method: (init.method ?? "GET").toUpperCase(),
      url: url.toString(),
    })
    return handler(url, init, calls.length - 1)
  })
  return { calls, fetch: mock as typeof globalThis.fetch, mock }
}

export function setupRuntime(options: {
  definition?: ConnectionDefinition
  fetch?: typeof globalThis.fetch
  key?: Uint8Array | string
  name?: string
} & Partial<Pick<ConnectionsRuntimeOptions, "basePath">> = {}) {
  const db = createDatabase()
  const fake = fakeProvider()
  const definition = options.definition ?? { provider: fake.provider }
  const name = options.name ?? "api"
  const key = options.key ?? testKey()
  const runtime: ConnectionsRuntime = createConnectionsRuntime({
    ...(options.basePath ? { basePath: options.basePath } : {}),
    database: () => db,
    encryptionKey: () => key,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    registry: { [name]: async () => ({ default: definition }) },
  })
  const store = createConnectionsStore({ db, encryptionKey: decodeConnectionsKey(key) })
  return { db, definition, fake, name, runtime, store }
}

export async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}
