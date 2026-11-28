import { fileURLToPath } from "node:url"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ConsoleDatabase } from "../src/projects.ts"

const state = vi.hoisted(() => ({ db: undefined as unknown, userId: "u-ada" }))

vi.mock("vite-hub/database", () => ({ useDatabase: () => ({ db: state.db }) }))
vi.mock("vite-hub/auth/server", () => ({
  withAuthorization: (_required: boolean, handler: (request: Request, context: { user: { id: string } }) => Promise<Response>) => (request: Request) => handler(request, { user: { id: state.userId } }),
}))

const { listConsoleMcpConnections, revokeConsoleMcpConnection } = await import("../src/mcp-connections.ts")
const { default: list } = await import("../server/api/mcp-connections/index.get.ts")
const { default: revoke } = await import("../server/api/mcp-connections/[id].delete.ts")

const clients: ReturnType<typeof createClient>[] = []

afterEach(() => {
  state.userId = "u-ada"
  clients.splice(0).forEach(client => client.close())
})

const day = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 10, 20)

async function setup() {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  await client.execute("PRAGMA foreign_keys = ON")
  const db = drizzle({ client })
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../server/databases/default/migrations/", import.meta.url)) })
  state.db = db
  for (const [id, name] of [["u-ada", "Ada"], ["u-bob", "Bob"]] as const) {
    await client.execute({ sql: "insert into user (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)", args: [id, name, `${name.toLowerCase()}@example.com`, now, now] })
  }
  const addClient = (clientId: string, name: string | null, disabled = false) => client.execute({ sql: "insert into oauth_client (id, client_id, redirect_uris, name, disabled, created_at, updated_at) values (?, ?, '[\"http://127.0.0.1/callback\"]', ?, ?, ?, ?)", args: [`row-${clientId}`, clientId, name, disabled ? 1 : 0, now, now] })
  const consent = (clientId: string, userId: string, at: number) => client.execute({ sql: "insert into oauth_consent (id, client_id, user_id, scopes, created_at, updated_at) values (?, ?, ?, '[]', ?, ?)", args: [`consent-${clientId}-${userId}`, clientId, userId, at, at] })
  const refresh = (id: string, clientId: string, userId: string, at: number) => client.execute({ sql: "insert into oauth_refresh_token (id, token, client_id, user_id, scopes, created_at, expires_at) values (?, ?, ?, ?, '[]', ?, ?)", args: [id, `token-${id}`, clientId, userId, at, at + 30 * day] })
  const access = (id: string, clientId: string, userId: string, at: number) => client.execute({ sql: "insert into oauth_access_token (id, client_id, user_id, scopes, created_at, expires_at) values (?, ?, ?, '[]', ?, ?)", args: [id, clientId, userId, at, at + day] })
  return { access, addClient, client, consent, db: db as ConsoleDatabase, refresh }
}

describe("Console MCP connections", () => {
  it("lists each client that a person connected, with the last token as the last use", async () => {
    const { access, addClient, consent, db, refresh } = await setup()
    await addClient("t3", "T3 Code")
    await addClient("cli", null)
    await addClient("off", "Disabled", true)
    await consent("t3", "u-ada", now - 5 * day)
    await refresh("r1", "t3", "u-ada", now - 2 * day)
    await access("a1", "t3", "u-ada", now - day)
    await consent("cli", "u-ada", now - 10 * day)
    await consent("off", "u-ada", now - 3 * day)
    await consent("t3", "u-bob", now)
    expect(await listConsoleMcpConnections(db, "u-ada")).toEqual([
      { clientId: "t3", connectedAt: now - 5 * day, lastUsedAt: now - day, name: "T3 Code" },
      { clientId: "cli", connectedAt: now - 10 * day, lastUsedAt: null, name: null },
    ])
    expect(await listConsoleMcpConnections(db, "u-bob")).toEqual([{ clientId: "t3", connectedAt: now, lastUsedAt: null, name: "T3 Code" }])
    const response = await list.fetch(new Request("https://console.test/api/mcp-connections"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ connections: [{ clientId: "t3" }, { clientId: "cli" }] })
  })

  it("disconnects a client from one person and keeps it for the others", async () => {
    const { access, addClient, client, consent, db, refresh } = await setup()
    await addClient("t3", "T3 Code")
    await consent("t3", "u-ada", now)
    await refresh("r1", "t3", "u-ada", now)
    await access("a1", "t3", "u-ada", now)
    await consent("t3", "u-bob", now)
    expect(await revokeConsoleMcpConnection(db, "u-ada", "t3")).toBe(true)
    expect(await listConsoleMcpConnections(db, "u-ada")).toEqual([])
    expect(await listConsoleMcpConnections(db, "u-bob")).toHaveLength(1)
    expect((await client.execute("select count(*) as n from oauth_client")).rows[0]?.n).toBe(1)
  })

  it("deletes the client when no one else uses it, so its tokens stop at once", async () => {
    const { access, addClient, client, consent } = await setup()
    await addClient("t3", "T3 Code")
    await consent("t3", "u-ada", now)
    await access("a1", "t3", "u-ada", now)
    const response = await revoke.fetch(new Request("https://console.test/api/mcp-connections/t3", { method: "DELETE" }))
    expect(response.status).toBe(204)
    expect((await client.execute("select count(*) as n from oauth_client")).rows[0]?.n).toBe(0)
  })

  it("does not disconnect a client of another person", async () => {
    const { addClient, client, consent } = await setup()
    await addClient("t3", "T3 Code")
    await consent("t3", "u-bob", now)
    const response = await revoke.fetch(new Request("https://console.test/api/mcp-connections/t3", { method: "DELETE" }))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: "CONSOLE_MCP_CONNECTION_NOT_FOUND" })
    expect((await client.execute("select count(*) as n from oauth_consent")).rows[0]?.n).toBe(1)
  })
})
