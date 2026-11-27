import { createHmac } from "node:crypto"
import { fileURLToPath } from "node:url"

import { createClient } from "@libsql/client"
import { authSqliteSchema } from "@vite-hub/auth/schema"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { organization } from "better-auth/plugins"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { afterEach, describe, expect, it, vi } from "vitest"

import { hashConsoleApiKey, verifyConsoleApiKey } from "../src/api-keys.ts"
import { consoleCliDeviceFlow, consoleDeviceDisabledPaths } from "../src/device.ts"
import { consoleSchema } from "../src/projects.ts"

const origin = "http://localhost:3000"
const secret = "console-device-flow-tests-secret-1234567890"
const clients: ReturnType<typeof createClient>[] = []
afterEach(() => {
  vi.useRealTimers()
  clients.splice(0).forEach(client => client.close())
})

async function setup() {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  await client.execute("PRAGMA foreign_keys = ON")
  const db = drizzle({ client })
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../server/databases/default/migrations/", import.meta.url)) })
  const auth = betterAuth({
    baseURL: origin,
    secret,
    logger: { disabled: true },
    database: drizzleAdapter(db, { provider: "sqlite", schema: { ...authSqliteSchema, ...consoleSchema } }),
    disabledPaths: [...consoleDeviceDisabledPaths],
    rateLimit: { enabled: true, storage: "database" },
    plugins: [organization(), ...consoleCliDeviceFlow({ database: () => db })],
  })
  const context = await auth.$context
  async function person(name: string) {
    const user = await context.internalAdapter.createUser({ name, email: `${name.toLowerCase()}@example.com`, emailVerified: true }, { method: "passkey" })
    const team = await context.adapter.create<{ id: string }>({ model: "organization", data: { name: `${name}'s team`, slug: name.toLowerCase(), createdAt: new Date() } })
    await context.adapter.create({ model: "member", data: { organizationId: team.id, userId: user.id, role: "owner", createdAt: new Date() } })
    const session = await context.internalAdapter.createSession(user.id)
    const signed = `${session.token}.${createHmac("sha256", secret).update(session.token).digest("base64")}`
    return { user, team, cookie: `better-auth.session_token=${encodeURIComponent(signed)}` }
  }
  const call = (path: string, init: { body?: unknown, cookie?: string, method?: string } = {}) => auth.handler(new Request(`${origin}/api/auth${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { origin, "x-forwarded-for": "203.0.113.7", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.cookie ? { cookie: init.cookie } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  }))
  const start = async () => {
    const response = await call("/device/code", { body: { client_id: "vitehub-cli", client_name: "vitehub CLI on test-box" } })
    expect(response.status).toBe(200)
    return await response.json() as { device_code: string, user_code: string, verification_uri: string, verification_uri_complete: string, interval: number, expires_in: number }
  }
  const poll = (deviceCode: string) => call("/cli/token", { body: { client_id: "vitehub-cli", device_code: deviceCode } })
  return { auth, client, db, person, call, start, poll }
}

function clock() {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() })
  return (ms: number) => vi.setSystemTime(Date.now() + ms)
}

describe("CLI device flow", () => {
  it("approves a code and gives the CLI an API key for the chosen team, once", async () => {
    const { client, db, person, call, start, poll } = await setup()
    const ada = await person("Ada")
    const advance = clock()
    const code = await start()
    expect(code.verification_uri).toBe(`${origin}/device`)
    expect(code.verification_uri_complete).toBe(`${origin}/device?user_code=${code.user_code}`)
    expect(code.interval).toBe(5)

    expect(await (await poll(code.device_code)).json()).toMatchObject({ error: "authorization_pending" })
    advance(5_100)

    const opened = await call(`/device?user_code=${code.user_code}`, { cookie: ada.cookie })
    expect(await opened.json()).toMatchObject({ client_name: "vitehub CLI on test-box", status: "pending", client_id: "vitehub-cli" })
    expect((await call("/cli/approve", { body: { userCode: code.user_code, teamId: ada.team.id }, cookie: ada.cookie })).status).toBe(200)

    const answer = await poll(code.device_code)
    expect(answer.status).toBe(200)
    expect(answer.headers.get("cache-control")).toBe("no-store")
    const token = await answer.json() as { access_token: string, token_type: string, expires_in: number, team: { id: string, name: string } }
    expect(token.access_token).toMatch(/^vhk_[\w-]{43}$/)
    expect(token).toMatchObject({ token_type: "Bearer", team: { id: ada.team.id, name: "Ada's team" } })
    expect(token.expires_in).toBeGreaterThan(89 * 86_400)
    expect(token.expires_in).toBeLessThanOrEqual(90 * 86_400)

    const rows = (await client.execute("select * from console_api_keys")).rows
    expect(rows).toHaveLength(1)
    for (const value of Object.values(rows[0]!)) expect(String(value)).not.toContain(token.access_token.slice(4))
    expect(rows[0]).toMatchObject({ key_hash: await hashConsoleApiKey(token.access_token), name: "vitehub CLI on test-box", team_id: ada.team.id, start: token.access_token.slice(0, 8) })
    expect(await verifyConsoleApiKey(db, token.access_token)).toMatchObject({ teamId: ada.team.id, user: { id: ada.user.id }, projectIds: null })

    advance(5_100)
    expect(await (await poll(code.device_code)).json()).toMatchObject({ error: "invalid_grant" })
  })

  it("answers slow_down when the CLI polls faster than the interval, and counts polls in the rate_limit table", async () => {
    const { client, start, poll } = await setup()
    const code = await start()
    expect(await (await poll(code.device_code)).json()).toMatchObject({ error: "authorization_pending" })
    const fast = await poll(code.device_code)
    expect(fast.status).toBe(400)
    expect(await fast.json()).toMatchObject({ error: "slow_down" })
    const limits = (await client.execute("select key, count from rate_limit")).rows.map(row => ({ key: String(row.key), count: Number(row.count) }))
    expect(limits).toEqual(expect.arrayContaining([expect.objectContaining({ key: expect.stringContaining("/cli/token"), count: 2 })]))
  })

  it("stops a client that ignores slow_down with the rate limit", async () => {
    const { start, poll } = await setup()
    const code = await start()
    const statuses: number[] = []
    for (let index = 0; index < 31; index++) statuses.push((await poll(code.device_code)).status)
    expect(statuses.slice(0, 30).every(status => status === 400)).toBe(true)
    expect(statuses[30]).toBe(429)
  })

  it("answers access_denied after the person denies", async () => {
    const { person, call, start, poll } = await setup()
    const ada = await person("Ada")
    const code = await start()
    await call(`/device?user_code=${code.user_code}`, { cookie: ada.cookie })
    expect((await call("/device/deny", { body: { userCode: code.user_code }, cookie: ada.cookie })).status).toBe(200)
    expect(await (await poll(code.device_code)).json()).toMatchObject({ error: "access_denied" })
  })

  it("answers expired_token after the code expires", async () => {
    const { person, call, start, poll } = await setup()
    const ada = await person("Ada")
    const advance = clock()
    const code = await start()
    expect(code.expires_in).toBe(900)
    advance(901_000)
    expect(await (await poll(code.device_code)).json()).toMatchObject({ error: "expired_token" })
    expect(await (await call("/cli/approve", { body: { userCode: code.user_code, teamId: ada.team.id }, cookie: ada.cookie })).json()).toMatchObject({ error: "invalid_request" })
  })

  it("refuses other clients, Better Auth's session endpoints, a team of someone else, and a code that another person opened", async () => {
    const { person, call, start } = await setup()
    const ada = await person("Ada")
    const bob = await person("Bob")
    expect(await (await call("/device/code", { body: { client_id: "other" } })).json()).toMatchObject({ error: "invalid_client" })
    const code = await start()
    expect((await call("/device/token", { body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "vitehub-cli", device_code: code.device_code } })).status).toBe(404)
    expect((await call("/device/approve", { body: { userCode: code.user_code }, cookie: ada.cookie })).status).toBe(404)
    await call(`/device?user_code=${code.user_code}`, { cookie: ada.cookie })
    expect((await call("/cli/approve", { body: { userCode: code.user_code, teamId: bob.team.id }, cookie: ada.cookie })).status).toBe(403)
    expect((await call("/cli/approve", { body: { userCode: code.user_code, teamId: bob.team.id }, cookie: bob.cookie })).status).toBe(403)
    expect((await call("/cli/approve", { body: { userCode: code.user_code, teamId: ada.team.id } })).status).toBe(401)
  })
})
