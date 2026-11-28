import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { drizzleAdapter as legacyDrizzleAdapter } from "better-auth/adapters/drizzle"
import { admin, twoFactor } from "better-auth/plugins"
import { generateDrizzleJson, generateMigration } from "drizzle-kit/payload/sqlite"
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/auth.ts"
import { authDatabase } from "../src/auth/database.ts"
import { authSqliteRelations, authSqliteSchema, createAuthRelations, createAuthSqliteSchema } from "../src/auth/schema.ts"
import { createAuthForRequest } from "../src/_internal/auth/internal/server.ts"
import { mcpOAuth } from "../src/auth/mcp.ts"

const app = "https://app.example.com"
const resource = `${app}/mcp`
const state = vi.hoisted(() => ({ databases: {} as Record<string, { db: unknown, schema: Record<string, unknown> }> }))
vi.mock("@vite-hub/database/runtime/registry", () => ({ databases: state.databases }))

let directory: string
let client: ReturnType<typeof createClient>

beforeAll(async () => {
  directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "vitehub-auth-database-"))
  client = createClient({ url: `file:${join(directory, "auth.db")}` })
  // The migration that `vitehub database generate` writes for the contributed tables.
  const statements = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...authSqliteSchema }))
  for (const statement of statements) await client.execute(statement)
  state.databases.default = { db: drizzle({ client: client, relations: authSqliteRelations }), schema: { ...authSqliteSchema } }
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

  it("rejects user fields absent from the migrated table before opening the Database", () => {
    expect(() => authDatabase()({ user: { additionalFields: { plan: { type: "string" } } } })).toThrow(/`user` table of the "default" Database has no `plan` column/)
  })

  it("stores additional user fields and twoFactor() in the tables that the Definition adds", async () => {
    const schema = createAuthSqliteSchema({ plugins: ["twoFactor"], additionalFields: { user: { login: { type: "string" } } } })
    const extended = createClient({ url: `file:${join(directory, "extended.db")}` })
    try {
      for (const statement of await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...schema }))) await extended.execute(statement)
      // The dynamic schema has a string index; give Drizzle an explicit empty relations map.
      state.databases.extended = { db: drizzle({ client: extended, relations: defineRelations(schema, (): Record<string, never> => ({})) }), schema: { ...schema } }
      // comark-ui stores the GitHub login; Finance and Lesson Video turn on two-factor sign-in.
      const definition = defineAuth({
        database: authDatabase("extended"),
        emailAndPassword: { enabled: true },
        plugins: [twoFactor()],
        user: { additionalFields: { login: { type: "string", required: false } } },
      })
      const auth = createAuthForRequest(definition, new Request(app))
      const post = (path: string, body: unknown, cookie = "") => auth.handler(new Request(`${app}/api/auth${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", cookie, origin: app },
        method: "POST",
      }))
      const signUp = await post("/sign-up/email", { email: "grace@example.com", login: "grace", name: "Grace", password: "correct-horse-battery" })
      expect(signUp.status, await signUp.clone().text()).toBe(200)
      const cookie = signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
      const enable = await post("/two-factor/enable", { password: "correct-horse-battery" }, cookie)
      expect(enable.status, await enable.clone().text()).toBe(200)
      expect((await extended.execute("select login, two_factor_enabled from user")).rows).toEqual([expect.objectContaining({ login: "grace", two_factor_enabled: 0 })])
      expect((await extended.execute("select count(*) as count from two_factor")).rows[0]?.count).toBe(1)
    }
    finally {
      delete state.databases.extended
      extended.close()
    }
  })

  it("runs Better Auth, admin(), and MCP OAuth on the contributed tables", async () => {
    const schema = createAuthSqliteSchema({ plugins: ["admin"] })
    const adminClient = createClient({ url: `file:${join(directory, "admin.db")}` })
    try {
      for (const statement of await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...schema }))) await adminClient.execute(statement)
      state.databases.admin = { db: drizzle({ client: adminClient, relations: defineRelations(schema, (): Record<string, never> => ({})) }), schema: { ...schema } }
      const definition = defineAuth({
        database: authDatabase("admin"),
        emailAndPassword: { enabled: true },
        plugins: [admin(), ...mcpOAuth({ resource, loginPage: "/oauth" })],
      })
      const auth = createAuthForRequest(definition, new Request(app))
      const post = (path: string, body: unknown) => auth.handler(new Request(`${app}/api/auth${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", origin: app },
        method: "POST",
      }))

      const signUp = await post("/sign-up/email", { email: "ada@example.com", name: "Ada", password: "correct-horse-battery" })
      expect(signUp.status, await signUp.clone().text()).toBe(200)
      const users = await adminClient.execute("select email, role, email_verified from user")
      expect(users.rows).toEqual([expect.objectContaining({ email: "ada@example.com", role: "user", email_verified: 0 })])

      const registration = await post("/oauth2/register", { client_name: "Claude Code", redirect_uris: ["http://localhost:53682/callback"], token_endpoint_auth_method: "none" })
      expect(registration.status, await registration.clone().text()).toBe(201)
      expect((await adminClient.execute("select name from oauth_client")).rows).toEqual([expect.objectContaining({ name: "Claude Code" })])
      const { client_id: clientId } = await registration.json() as { client_id: string }
      const stored = await auth.handler(new Request(`${app}/api/auth/oauth2/public-client?client_id=${clientId}`, { headers: { cookie: signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") } }))
      expect(stored.status, await stored.clone().text()).toBe(200)
      expect(await stored.json()).toMatchObject({ client_id: clientId, client_name: "Claude Code" })

      const keys = await auth.handler(new Request(`${app}/api/auth/jwks`))
      expect(keys.status).toBe(200)
      expect((await adminClient.execute("select count(*) as count from jwks")).rows[0]?.count).toBe(1)
    }
    finally {
      delete state.databases.admin
      adminClient.close()
    }
  })

  it("adds no user.role and no admin() column for an Auth Definition without admin()", async () => {
    const columns = async (table: string) => (await client.execute(`select name from pragma_table_info('${table}')`)).rows.map(row => String(row.name))
    const adminColumns = ["role", "banned", "ban_reason", "ban_expires", "impersonated_by"]
    expect([...await columns("user"), ...await columns("session")].filter(name => adminColumns.includes(name))).toEqual([])
    expect(() => authDatabase()({ plugins: [admin()] })).toThrow(/`user` table of the "default" Database has no `role` column/)
  })

  it("keeps the limiter counters of every Auth instance in the rate_limit table", async () => {
    // A Worker build: the Auth Vite plugin marks it as a build, and there is no NODE_ENV.
    vi.stubGlobal("__VITEHUB_AUTH_DEV__", false)
    vi.stubEnv("NODE_ENV", "")
    try {
      const definition = defineAuth({ database: authDatabase(), emailAndPassword: { enabled: true } })
      const signIn = async (address: string) => {
        const request = new Request(`${app}/api/auth/sign-in/email`, {
          body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
          headers: { "cf-connecting-ip": address, "content-type": "application/json", "origin": app, "x-forwarded-for": "203.0.113.1" },
          method: "POST",
        })
        // srvx adds the Cloudflare client address to the Request as `ip`.
        Object.defineProperty(request, "ip", { value: address })
        // Each request builds its own Auth, as an Auth that follows `requestOrigin` does.
        return (await createAuthForRequest(definition, request).handler(request)).status
      }

      const first = [await signIn("198.51.100.7"), await signIn("198.51.100.7"), await signIn("198.51.100.7"), await signIn("198.51.100.7")]
      expect(first).toEqual([401, 401, 401, 429])
      expect(await signIn("198.51.100.8")).toBe(401)
      const rows = await client.execute("select key, count from rate_limit order by key")
      expect(rows.rows).toEqual([
        expect.objectContaining({ count: 3, key: "198.51.100.7|/sign-in/email" }),
        expect.objectContaining({ count: 1, key: "198.51.100.8|/sign-in/email" }),
      ])
    }
    finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it("runs Better Auth joins with Drizzle v1 relations", async () => {
    const schema = createAuthSqliteSchema({ plugins: ["admin"] })
    const relations = createAuthRelations(schema, { plugins: ["admin"] })
    const joinsClient = createClient({ url: `file:${join(directory, "joins.db")}` })
    try {
      for (const statement of await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...schema }))) await joinsClient.execute(statement)
      const db = drizzle({ client: joinsClient, relations })
      state.databases.joins = { db, schema: { ...schema } }
      const definition = defineAuth({
        advanced: { database: { joins: true } },
        database: authDatabase("joins"),
        emailAndPassword: { enabled: true },
        plugins: [admin()],
        session: { cookieCache: { enabled: false } },
      })
      const auth = createAuthForRequest(definition, new Request(app))
      const signUp = await auth.handler(new Request(`${app}/api/auth/sign-up/email`, {
        body: JSON.stringify({ email: "joins@example.com", name: "Joins", password: "correct-horse-battery" }),
        headers: { "content-type": "application/json", origin: app },
        method: "POST",
      }))
      expect(signUp.status, await signUp.clone().text()).toBe(200)
      const cookie = signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
      const findFirstSpy = vi.spyOn(db.query.session, "findFirst")
      const sessionResponse = await auth.handler(new Request(`${app}/api/auth/get-session`, {
        headers: { cookie, origin: app },
      }))
      expect(sessionResponse.status, await sessionResponse.clone().text()).toBe(200)
      expect(findFirstSpy).toHaveBeenCalledTimes(1)
      expect(await sessionResponse.json()).toMatchObject({
        user: { email: "joins@example.com" },
      })
    }
    finally {
      delete state.databases.joins
      joinsClient.close()
    }
  })

  it("preserves legacy SQLite MCP OAuth clients and structured additional fields after upgrading to relations-v2", async () => {
    const schemaOptions = {
      additionalFields: {
        user: {
          tags: { type: "string[]" },
          scores: { type: "number[]" },
          profile: { type: "json" },
        },
      },
    } as const
    const schema = createAuthSqliteSchema(schemaOptions)
    const relations = createAuthRelations(schema, schemaOptions)
    const upgradeClient = createClient({ url: `file:${join(directory, "upgrade.db")}` })
    try {
      for (const statement of await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...schema }))) await upgradeClient.execute(statement)
      const db = drizzle({ client: upgradeClient, relations })
      state.databases.upgrade = { db, schema: { ...schema } }

      const sharedOptions = () => ({
        emailAndPassword: { enabled: true },
        plugins: [...mcpOAuth({ resource, loginPage: "/oauth" })],
        session: { cookieCache: { enabled: false } },
        user: {
          additionalFields: {
            tags: { type: "string[]" as const, required: false },
            scores: { type: "number[]" as const, required: false },
            profile: { type: "json" as const, required: false },
          },
        },
      })

      const legacyAuth = createAuthForRequest(defineAuth(() => ({
        ...sharedOptions(),
        database: legacyDrizzleAdapter(db, { provider: "sqlite", schema }),
      })), new Request(app))

      const legacySignUp = await legacyAuth.handler(new Request(`${app}/api/auth/sign-up/email`, {
        body: JSON.stringify({
          email: "legacy@example.com",
          name: "Legacy",
          password: "correct-horse-battery",
          tags: ["alpha", "beta"],
          scores: [1, 2],
          profile: { tier: "pro", active: true },
        }),
        headers: { "content-type": "application/json", origin: app },
        method: "POST",
      }))
      expect(legacySignUp.status, await legacySignUp.clone().text()).toBe(200)
      const legacyCookie = legacySignUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")

      const redirectUri = "http://localhost:53682/callback"
      const registration = await legacyAuth.handler(new Request(`${app}/api/auth/oauth2/register`, {
        body: JSON.stringify({ client_name: "Legacy MCP", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
        headers: { "content-type": "application/json", origin: app },
        method: "POST",
      }))
      expect(registration.status, await registration.clone().text()).toBe(201)
      const { client_id: clientId } = await registration.json() as { client_id: string }

      const storedRedirectUris = (await upgradeClient.execute({ sql: "select redirect_uris from oauth_client where client_id = ?", args: [clientId] })).rows[0]?.redirect_uris
      expect(storedRedirectUris).toBe(JSON.stringify(JSON.stringify([redirectUri])))

      const upgradedAuth = createAuthForRequest(defineAuth({
        ...sharedOptions(),
        database: authDatabase("upgrade"),
      }), new Request(app))
      const authorizeParams = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        scope: "openid",
      })
      const authorize = await upgradedAuth.handler(new Request(`${app}/api/auth/oauth2/authorize?${authorizeParams}`))
      expect(authorize.status, await authorize.clone().text()).toBe(302)
      expect(authorize.headers.get("location")).toContain("/oauth")

      const legacySession = await upgradedAuth.handler(new Request(`${app}/api/auth/get-session`, {
        headers: { cookie: legacyCookie, origin: app },
      }))
      expect(legacySession.status, await legacySession.clone().text()).toBe(200)
      expect(await legacySession.json()).toMatchObject({
        user: {
          email: "legacy@example.com",
          tags: ["alpha", "beta"],
          scores: [1, 2],
          profile: { tier: "pro", active: true },
        },
      })

      const freshSignUp = await upgradedAuth.handler(new Request(`${app}/api/auth/sign-up/email`, {
        body: JSON.stringify({
          email: "fresh@example.com",
          name: "Fresh",
          password: "correct-horse-battery",
          tags: ["gamma"],
          scores: [3],
          profile: { tier: "free" },
        }),
        headers: { "content-type": "application/json", origin: app },
        method: "POST",
      }))
      expect(freshSignUp.status, await freshSignUp.clone().text()).toBe(200)
      const freshCookie = freshSignUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")

      const upgradedJoinsAuth = createAuthForRequest(defineAuth({
        ...sharedOptions(),
        advanced: { database: { joins: true } },
        database: authDatabase("upgrade"),
      }), new Request(app))
      for (const [cookie, expected] of [
        [legacyCookie, { email: "legacy@example.com", tags: ["alpha", "beta"], scores: [1, 2], profile: { tier: "pro", active: true } }],
        [freshCookie, { email: "fresh@example.com", tags: ["gamma"], scores: [3], profile: { tier: "free" } }],
      ] as const) {
        const res = await upgradedJoinsAuth.handler(new Request(`${app}/api/auth/get-session`, {
          headers: { cookie, origin: app },
        }))
        expect(res.status, await res.clone().text()).toBe(200)
        expect(await res.json()).toMatchObject({ user: expected })
      }
    }
    finally {
      delete state.databases.upgrade
      upgradeClient.close()
    }
  })

  it("queries both built-in and additional-field relations on real SQLite tables", async () => {
    const schemaOptions = {
      additionalFields: {
        session: {
          invitedBy: { type: "string", references: { model: "user", field: "id" } },
        },
      },
    } as const
    const schema = createAuthSqliteSchema(schemaOptions)
    const relations = createAuthRelations(schema, schemaOptions)
    const invitedClient = createClient({ url: `file:${join(directory, "invited.db")}` })
    try {
      for (const statement of await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...schema }))) await invitedClient.execute(statement)
      const db = drizzle({ client: invitedClient, relations })
      const now = new Date()
      await db.insert(schema.user).values([
        { id: "u-owner", name: "Owner", email: "owner@example.com", emailVerified: true, createdAt: now, updatedAt: now },
        { id: "u-inviter", name: "Inviter", email: "inviter@example.com", emailVerified: true, createdAt: now, updatedAt: now },
      ])
      await db.insert(schema.session).values({
        id: "s-1",
        token: "tok-1",
        userId: "u-owner",
        invitedBy: "u-inviter",
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
      })

      const owner = await db.query.user.findFirst({ where: { id: "u-owner" }, with: { sessions: true } })
      const inviter = await db.query.user.findFirst({ where: { id: "u-inviter" }, with: { sessionsByInvitedBy: true } })
      const session = await db.query.session.findFirst({ where: { id: "s-1" }, with: { user: true, invitedByUser: true } })
      expect(owner?.sessions.map(item => item.id)).toEqual(["s-1"])
      expect(inviter?.sessionsByInvitedBy.map(item => item.id)).toEqual(["s-1"])
      expect(session?.user?.email).toBe("owner@example.com")
      expect(session?.invitedByUser?.email).toBe("inviter@example.com")
    }
    finally {
      invitedClient.close()
    }
  })

  it("handles user.additionalFields.accounts collision cleanly during email sign-in", async () => {
    const schemaOptions = { additionalFields: { user: { accounts: { type: "string" } } } } as const
    const schema = createAuthSqliteSchema(schemaOptions)
    const relations = createAuthRelations(schema, schemaOptions)
    const collidingClient = createClient({ url: `file:${join(directory, "colliding.db")}` })
    try {
      for (const statement of await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...schema }))) await collidingClient.execute(statement)
      state.databases.colliding = { db: drizzle({ client: collidingClient, relations }), schema: { ...schema } }

      const auth = createAuthForRequest(defineAuth({
        database: authDatabase("colliding"),
        emailAndPassword: { enabled: true },
        user: { additionalFields: { accounts: { type: "string", required: false } } },
      }), new Request(app))
      const signUp = await auth.handler(new Request(`${app}/api/auth/sign-up/email`, {
        body: JSON.stringify({ email: "collide@example.com", name: "Collide", password: "correct-horse-battery", accounts: "enterprise" }),
        headers: { "content-type": "application/json", origin: app },
        method: "POST",
      }))
      expect(signUp.status, await signUp.clone().text()).toBe(200)
      const signIn = await auth.handler(new Request(`${app}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email: "collide@example.com", password: "correct-horse-battery" }),
        headers: { "content-type": "application/json", origin: app },
        method: "POST",
      }))
      expect(signIn.status, await signIn.clone().text()).toBe(200)
      expect(await signIn.json()).toMatchObject({ user: { email: "collide@example.com", accounts: "enterprise" } })

      const joinsAuth = createAuthForRequest(defineAuth({
        advanced: { database: { joins: true } },
        database: authDatabase("colliding"),
        emailAndPassword: { enabled: true },
        user: { additionalFields: { accounts: { type: "string", required: false } } },
      }), new Request(app))
      await expect(joinsAuth.$context).rejects.toThrow(/has no `accounts` relation for `advanced.database.joins`, because its `accounts` column collides/)
    }
    finally {
      delete state.databases.colliding
      collidingClient.close()
    }
  })

  it("names the missing tables instead of keeping users in memory", () => {
    const auth = createAuthForRequest(defineAuth({ database: authDatabase("accounts"), emailAndPassword: { enabled: true } }), new Request(app))
    return expect(auth.$context).rejects.toThrow(/found no Better Auth tables in the "accounts" Database/)
  })
})
