import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { admin } from "better-auth/plugins"
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api"
import { drizzle } from "drizzle-orm/libsql"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/auth.ts"
import { authDatabase } from "../src/auth/database.ts"
import { authSqliteSchema } from "../src/auth/schema.ts"
import { createAuthForRequest } from "../src/auth/server.ts"
import { consoleMcpOAuth } from "../src/console/auth.ts"

const app = "https://app.example.com"
const resource = `${app}/_vitehub/mcp`
const state = vi.hoisted(() => ({ databases: {} as Record<string, { db: unknown, schema: Record<string, unknown> }> }))
vi.mock("@vite-hub/database/drizzle", () => ({ databases: state.databases }))

let directory: string
let client: ReturnType<typeof createClient>

beforeAll(async () => {
  directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "vitehub-auth-database-"))
  client = createClient({ url: `file:${join(directory, "auth.db")}` })
  // The migration that `vitehub db generate` writes for the contributed tables.
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson({ ...authSqliteSchema }))
  for (const statement of statements) await client.execute(statement)
  state.databases.default = { db: drizzle(client, { schema: authSqliteSchema }), schema: { ...authSqliteSchema } }
})

afterAll(async () => {
  client?.close()
  await rm(directory, { force: true, recursive: true })
})

describe("authDatabase()", () => {
  it("inserts custom string IDs and matching references into the migrated tables", async () => {
    let nextId = 0
    const definition = defineAuth({
      advanced: { database: { generateId: () => `custom-${++nextId}` } },
      database: authDatabase(),
      emailAndPassword: { enabled: true },
    })
    const response = await createAuthForRequest(definition, new Request(app)).handler(new Request(`${app}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email: "custom@example.com", name: "Custom", password: "correct-horse-battery" }),
      headers: { "content-type": "application/json", origin: app },
      method: "POST",
    }))
    expect(response.status, await response.clone().text()).toBe(200)
    const { user } = await response.json() as { user: { id: string } }
    expect(user.id).toMatch(/^custom-/)
    expect((await client.execute({ sql: "select user_id from account where user_id = ?", args: [user.id] })).rows).toEqual([{ user_id: user.id }])
    expect((await client.execute({ sql: "select user_id from session where user_id = ?", args: [user.id] })).rows).toEqual([{ user_id: user.id }])
    await client.execute({ sql: "delete from user where id = ?", args: [user.id] })
  })

  it.each(["serial", "uuid", false] as const)("rejects incompatible ID strategy %s before opening the Database", (generateId) => {
    expect(() => authDatabase()({ advanced: { database: { generateId } } })).toThrow(/text IDs/)
  })

  it("runs Better Auth, admin(), and Console MCP OAuth on the contributed tables", async () => {
    const definition = defineAuth({
      database: authDatabase(),
      emailAndPassword: { enabled: true },
      plugins: [admin(), ...consoleMcpOAuth({ resource })],
    })
    const auth = createAuthForRequest(definition, new Request(app))
    const post = (path: string, body: unknown) => auth.handler(new Request(`${app}/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin: app },
      method: "POST",
    }))

    const signUp = await post("/sign-up/email", { email: "ada@example.com", name: "Ada", password: "correct-horse-battery" })
    expect(signUp.status, await signUp.clone().text()).toBe(200)
    const users = await client.execute("select email, role, email_verified from user")
    expect(users.rows).toEqual([expect.objectContaining({ email: "ada@example.com", role: "user", email_verified: 0 })])

    const registration = await post("/oauth2/register", { client_name: "Claude Code", redirect_uris: ["http://localhost:53682/callback"], token_endpoint_auth_method: "none" })
    expect(registration.status, await registration.clone().text()).toBe(201)
    expect((await client.execute("select name from oauth_client")).rows).toEqual([expect.objectContaining({ name: "Claude Code" })])
    const { client_id: clientId } = await registration.json() as { client_id: string }
    const stored = await auth.handler(new Request(`${app}/api/auth/oauth2/public-client?client_id=${clientId}`, { headers: { cookie: signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") } }))
    expect(stored.status, await stored.clone().text()).toBe(200)
    expect(await stored.json()).toMatchObject({ client_id: clientId, client_name: "Claude Code" })

    const keys = await auth.handler(new Request(`${app}/api/auth/jwks`))
    expect(keys.status).toBe(200)
    expect((await client.execute("select count(*) as count from jwks")).rows[0]?.count).toBe(1)
  })

  it("names the missing tables instead of keeping users in memory", () => {
    const auth = createAuthForRequest(defineAuth({ database: authDatabase("accounts"), emailAndPassword: { enabled: true } }), new Request(app))
    return expect(auth.$context).rejects.toThrow(/found no Better Auth tables in the "accounts" Database/)
  })
})
