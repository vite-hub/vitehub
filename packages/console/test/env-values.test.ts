import { fileURLToPath } from "node:url"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ConsoleDatabase } from "../src/projects.ts"

const state = vi.hoisted(() => ({ db: undefined as unknown, sessionUser: undefined as { id: string, name: string, email: string } | undefined, sessionTeam: "" }))

vi.mock("vite-hub/database", () => ({ useDatabase: () => ({ db: state.db }) }))
// A request without an API key uses the session of `state.sessionUser`, or answers 401 without one.
vi.mock("vite-hub/auth/server", () => ({
  withAuthorization: (_required: boolean, handler: (request: Request, authorization: unknown) => Promise<Response>) => async (request: Request) => state.sessionUser
    ? handler(request, { session: { activeOrganizationId: state.sessionTeam }, user: state.sessionUser })
    : Response.json({ message: "Unauthorized." }, { status: 401 }),
}))

const { createConsoleApiKey } = await import("../src/api-keys.ts")
const { createConsoleProjectStore } = await import("../src/projects.ts")
const { parseEnvKey, readConsoleEnvConfig } = await import("../src/env-values.ts")
const { default: envIndex } = await import("../server/api/projects/[id]/env/index.get.ts")
const { default: envRoute } = await import("../server/api/projects/[id]/env/[...path].ts")

const consoleSecret = "c".repeat(64)
const envKey = "e".repeat(64)
const canary = "canary-value-7f3a9c"
const clients: ReturnType<typeof createClient>[] = []

beforeEach(() => {
  vi.stubEnv("VITEHUB_CONSOLE_SECRET", consoleSecret)
  vi.stubEnv("VITEHUB_CONSOLE_ENV_VALUES", "1")
  vi.stubEnv("VITEHUB_CONSOLE_ENV_KEY", envKey)
  state.sessionUser = undefined
})
afterEach(() => {
  vi.unstubAllEnvs()
  clients.splice(0).forEach(client => client.close())
})

async function setup() {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  await client.execute("PRAGMA foreign_keys = ON")
  const db = drizzle({ client })
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../server/databases/default/migrations/", import.meta.url)) })
  state.db = db
  const now = Date.now()
  for (const [id, name] of [["u-ada", "Ada"], ["u-bob", "Bob"]]) {
    await client.execute({ sql: "insert into user (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)", args: [id!, name!, `${name!.toLowerCase()}@example.com`, now, now] })
  }
  await client.execute({ sql: "insert into organization (id, name, slug, created_at) values (?, ?, ?, ?)", args: ["t-ada", "Ada's team", "t-ada", now] })
  await client.execute({ sql: "insert into organization (id, name, slug, created_at) values (?, ?, ?, ?)", args: ["t-other", "Other team", "t-other", now] })
  for (const [id, team, user, role] of [["m1", "t-ada", "u-ada", "owner"], ["m2", "t-ada", "u-bob", "member"], ["m3", "t-other", "u-bob", "owner"]]) {
    await client.execute({ sql: "insert into member (id, organization_id, user_id, role, created_at) values (?, ?, ?, ?, ?)", args: [id!, team!, user!, role!, now] })
  }
  const projects = createConsoleProjectStore(db as ConsoleDatabase, consoleSecret, "t-ada")
  const app = (await projects.create({ url: "https://app.example.com", createdBy: "u-ada" }))!
  const other = (await projects.create({ url: "https://other.example.com", createdBy: "u-ada" }))!
  const key = async (userId: string, projectIds?: string[], teamId = "t-ada") => (await createConsoleApiKey(db as ConsoleDatabase, { name: "CLI", projectIds, teamId, userId }))!
  return { app, client, key, other }
}

function call(token: string | undefined, method: string, path: string, body?: unknown): Promise<Response> {
  const request = new Request(`https://console.test${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return (/\/env\/?$/.test(path) ? envIndex : envRoute).fetch(request)
}

interface ActivityEvent {
  action: string
  outcome: string
  operation: string
  operationId: string
  actor: { id: string, kind: string }
  target?: { id: string }
}

async function activity(token: string, projectId: string, stage: string, name: string): Promise<ActivityEvent[]> {
  return (await (await call(token, "GET", `/api/projects/${projectId}/env/${stage}/${name}/activity`)).json() as { events: ActivityEvent[] }).events
}

describe("Console env values", () => {
  it("stores no values by default and says so on every route", async () => {
    const { app, key } = await setup()
    vi.stubEnv("VITEHUB_CONSOLE_ENV_VALUES", "")
    const owner = (await key("u-ada")).key
    for (const [method, path, body] of [
      ["GET", `/api/projects/${app.id}/env`],
      ["GET", `/api/projects/${app.id}/env/production`],
      ["PUT", `/api/projects/${app.id}/env/production/API_TOKEN`, { value: canary }],
      ["POST", `/api/projects/${app.id}/env/production/reveal`, {}],
    ] as const) {
      const response = await call(owner, method, path, body)
      expect(response.status).toBe(404)
      const problem = await response.json() as { code: string, message: string }
      expect(problem.code).toBe("CONSOLE_ENV_VALUES_OFF")
      expect(problem.message).toContain("does not store env values")
      expect(problem.message).toContain("VITEHUB_CONSOLE_ENV_VALUES=1")
      // Every Console runs this code, so the message speaks about this Console only, not about console.vitehub.dev.
      expect(problem.message).not.toContain("console.vitehub.dev")
    }
    expect(readConsoleEnvConfig({})).toEqual({ state: "off" })
    expect(readConsoleEnvConfig({ VITEHUB_CONSOLE_ENV_VALUES: "1" })).toMatchObject({ state: "misconfigured" })
    expect(readConsoleEnvConfig({ VITEHUB_CONSOLE_ENV_VALUES: "1", VITEHUB_CONSOLE_ENV_KEY: "short" })).toMatchObject({ state: "misconfigured" })
    expect(parseEnvKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))).toEqual(new Uint8Array(32).fill(7))
    vi.stubEnv("VITEHUB_CONSOLE_ENV_KEY", "")
    vi.stubEnv("VITEHUB_CONSOLE_ENV_VALUES", "1")
    expect((await call(owner, "GET", `/api/projects/${app.id}/env/production`)).status).toBe(500)
  })

  it("sets, lists, reveals, and deletes a value as an owner, and lists no value", async () => {
    const { app, client, key } = await setup()
    const owner = (await key("u-ada")).key
    expect(await (await call(owner, "GET", `/api/projects/${app.id}/env`)).json()).toEqual({ stages: ["production", "preview"] })

    expect((await call(owner, "PUT", `/api/projects/${app.id}/env/production/API_TOKEN`, { value: canary })).status).toBe(201)
    expect((await call(owner, "PUT", `/api/projects/${app.id}/env/production/API_TOKEN`, { value: `${canary}-2` })).status).toBe(200)
    expect((await call(owner, "PUT", `/api/projects/${app.id}/env/staging/DATABASE_URL`, { value: "libsql://db" })).status).toBe(201)

    const listed = await call(owner, "GET", `/api/projects/${app.id}/env/production`)
    const listText = await listed.text()
    expect(listText).not.toContain(canary)
    expect(JSON.parse(listText)).toMatchObject({ canReveal: true, stage: "production", stages: ["production", "preview", "staging"], variables: [{ name: "API_TOKEN" }] })

    const revealed = await call(owner, "POST", `/api/projects/${app.id}/env/production/reveal`, { names: ["API_TOKEN"] })
    expect(await revealed.json()).toEqual({ stage: "production", values: { API_TOKEN: `${canary}-2` } })
    expect(await (await call(owner, "POST", `/api/projects/${app.id}/env/staging/reveal`, {})).json()).toEqual({ stage: "staging", values: { DATABASE_URL: "libsql://db" } })

    // The value is encrypted at rest.
    expect(JSON.stringify((await client.execute("select * from vitehub_env_secrets")).rows)).not.toContain(canary)

    expect((await call(owner, "DELETE", `/api/projects/${app.id}/env/production/API_TOKEN`)).status).toBe(204)
    expect((await call(owner, "DELETE", `/api/projects/${app.id}/env/production/API_TOKEN`)).status).toBe(404)
    expect(await (await call(owner, "GET", `/api/projects/${app.id}/env/production`)).json()).toMatchObject({ variables: [] })
  })

  it("logs each write and reveal with its actor and no value", async () => {
    const { app, client, key } = await setup()
    const created = await key("u-ada")
    await call(created.key, "PUT", `/api/projects/${app.id}/env/production/API_TOKEN`, { value: canary })
    await call(created.key, "POST", `/api/projects/${app.id}/env/production/reveal`, { names: ["API_TOKEN"] })
    state.sessionUser = { email: "ada@example.com", id: "u-ada", name: "Ada" }
    state.sessionTeam = "t-ada"
    await call(undefined, "DELETE", `/api/projects/${app.id}/env/production/API_TOKEN`)

    const events = await activity(created.key, app.id, "production", "API_TOKEN")
    expect(events.map(event => [event.action, event.outcome, event.operation, event.actor.kind, event.actor.id, event.target?.id])).toEqual([
      ["remove", "succeeded", "console.delete", "user", "u-ada", undefined],
      // The reveal writes `started` before it reads the value, and `succeeded` before the value leaves.
      ["resolve", "succeeded", "console.reveal", "agent", `api-key:${created.apiKey.id}`, "u-ada"],
      ["resolve", "started", "console.reveal", "agent", `api-key:${created.apiKey.id}`, "u-ada"],
      ["replace", "succeeded", "console.set", "agent", `api-key:${created.apiKey.id}`, "u-ada"],
    ])
    expect(events[1]!.operationId).toBe(events[2]!.operationId)
    expect(JSON.stringify((await client.execute("select * from vitehub_env_activity")).rows)).not.toContain(canary)
  })

  it("lets a member see names but not set, delete, reveal, or read activity", async () => {
    const { app, key } = await setup()
    const owner = (await key("u-ada")).key
    await call(owner, "PUT", `/api/projects/${app.id}/env/production/API_TOKEN`, { value: canary })
    const member = (await key("u-bob")).key
    const listed = await call(member, "GET", `/api/projects/${app.id}/env/production`)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ canReveal: false, variables: [{ name: "API_TOKEN" }] })
    for (const [method, path, body] of [
      ["POST", `/api/projects/${app.id}/env/production/reveal`, { names: ["API_TOKEN"] }],
      ["PUT", `/api/projects/${app.id}/env/production/API_TOKEN`, { value: "other" }],
      ["DELETE", `/api/projects/${app.id}/env/production/API_TOKEN`],
      ["GET", `/api/projects/${app.id}/env/production/API_TOKEN/activity`],
    ] as const) {
      const response = await call(member, method, path, body)
      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain(canary)
    }
    expect(await (await call(owner, "POST", `/api/projects/${app.id}/env/production/reveal`, {})).json()).toMatchObject({ values: { API_TOKEN: canary } })
  })

  it("keeps an API key to its team and its projects", async () => {
    const { app, key, other } = await setup()
    const owner = (await key("u-ada")).key
    await call(owner, "PUT", `/api/projects/${other.id}/env/production/API_TOKEN`, { value: canary })
    const scoped = (await key("u-ada", [app.id])).key
    expect((await call(scoped, "GET", `/api/projects/${app.id}/env/production`)).status).toBe(200)
    const outside = await call(scoped, "POST", `/api/projects/${other.id}/env/production/reveal`, {})
    expect(outside.status).toBe(404)
    expect(await outside.text()).not.toContain(canary)
    // Bob owns another team. His key for that team does not open Ada's projects.
    const otherTeam = (await key("u-bob", undefined, "t-other")).key
    expect((await call(otherTeam, "GET", `/api/projects/${other.id}/env/production`)).status).toBe(404)
    expect((await call("vhk_unknown", "GET", `/api/projects/${other.id}/env/production`)).status).toBe(401)
  })

  it("reads a keyring from VITEHUB_CONSOLE_ENV_KEYS, current key first, and refuses both variables at once", () => {
    const next = "f".repeat(64)
    const on = { VITEHUB_CONSOLE_ENV_VALUES: "1" }
    expect(readConsoleEnvConfig({ ...on, VITEHUB_CONSOLE_ENV_KEY: envKey })).toEqual({ keys: [new Uint8Array(32).fill(0xEE)], state: "on" })
    expect(readConsoleEnvConfig({ ...on, VITEHUB_CONSOLE_ENV_KEYS: ` ${next} , ${envKey} ` })).toEqual({ keys: [new Uint8Array(32).fill(0xFF), new Uint8Array(32).fill(0xEE)], state: "on" })
    expect(readConsoleEnvConfig({ ...on, VITEHUB_CONSOLE_ENV_KEYS: `${next},` })).toMatchObject({ problem: expect.stringContaining("Key 2"), state: "misconfigured" })
    expect(readConsoleEnvConfig({ ...on, VITEHUB_CONSOLE_ENV_KEY: envKey, VITEHUB_CONSOLE_ENV_KEYS: next })).toMatchObject({ problem: expect.stringContaining("not both"), state: "misconfigured" })
  })

  it("rotates every stored value to the new key, so the old key can go", async () => {
    const { app, client, key, other } = await setup()
    const owner = (await key("u-ada")).key
    await call(owner, "PUT", `/api/projects/${app.id}/env/production/API_TOKEN`, { value: canary })
    await call(owner, "PUT", `/api/projects/${other.id}/env/staging/DATABASE_URL`, { value: "libsql://db" })
    const sealedWithOld = JSON.stringify((await client.execute("select payload from vitehub_env_secrets order by key")).rows)

    const next = "f".repeat(64)
    vi.stubEnv("VITEHUB_CONSOLE_ENV_KEY", "")
    vi.stubEnv("VITEHUB_CONSOLE_ENV_KEYS", `${next},${envKey}`)
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    expect(await (await call(owner, "POST", `/api/projects/${app.id}/env/production/reveal`, {})).json()).toEqual({ stage: "production", values: { API_TOKEN: canary } })
    expect(info).toHaveBeenCalledWith(expect.stringContaining("sealed 2 values again"))
    expect(JSON.stringify((await client.execute("select payload from vitehub_env_secrets order by key")).rows)).not.toBe(sealedWithOld)

    // Without the old key, every value still reads.
    vi.stubEnv("VITEHUB_CONSOLE_ENV_KEYS", "")
    vi.stubEnv("VITEHUB_CONSOLE_ENV_KEY", next)
    expect(await (await call(owner, "POST", `/api/projects/${app.id}/env/production/reveal`, {})).json()).toEqual({ stage: "production", values: { API_TOKEN: canary } })
    expect(await (await call(owner, "POST", `/api/projects/${other.id}/env/staging/reveal`, {})).json()).toEqual({ stage: "staging", values: { DATABASE_URL: "libsql://db" } })
    // The old key alone no longer opens them.
    vi.stubEnv("VITEHUB_CONSOLE_ENV_KEY", envKey)
    expect(await (await call(owner, "POST", `/api/projects/${app.id}/env/production/reveal`, {})).json()).toMatchObject({ code: "CONSOLE_ENV_KEY_MISSING" })
  })

  it("answers CONSOLE_ENV_KEY_MISSING when the keyring cannot open a value, and logs the reveal as failed", async () => {
    const { app, key } = await setup()
    const owner = (await key("u-ada")).key
    await call(owner, "PUT", `/api/projects/${app.id}/env/production/API_TOKEN`, { value: canary })
    vi.stubEnv("VITEHUB_CONSOLE_ENV_KEY", "f".repeat(64))
    // A value that the current key sealed, which the reveal of every value reads before API_TOKEN fails.
    await call(owner, "PUT", `/api/projects/${app.id}/env/production/ANOTHER`, { value: "another-value-1b2c" })

    for (const body of [{ names: ["API_TOKEN"] }, {}]) {
      const response = await call(owner, "POST", `/api/projects/${app.id}/env/production/reveal`, body)
      const text = await response.text()
      expect(response.status).toBe(500)
      expect(JSON.parse(text)).toMatchObject({
        code: "CONSOLE_ENV_KEY_MISSING",
        docs: "https://vitehub.dev/docs/development/diagnostics/console_env_key_missing",
        fix: expect.stringContaining("VITEHUB_CONSOLE_ENV_KEYS"),
        message: expect.stringContaining("API_TOKEN"),
        ok: false,
        status: 500,
      })
      // No value leaves when one of them cannot be opened.
      expect(text).not.toContain(canary)
      expect(text).not.toContain("another-value-1b2c")
    }

    const events = await activity(owner, app.id, "production", "API_TOKEN")
    expect(events.map(event => [event.action, event.outcome])).toEqual([
      ["resolve", "failed"],
      ["resolve", "started"],
      ["resolve", "failed"],
      ["resolve", "started"],
      ["replace", "succeeded"],
    ])
    expect(events[0]!.operationId).toBe(events[1]!.operationId)
    // ANOTHER opened, but its value did not leave, so its reveal did not succeed either.
    expect((await activity(owner, app.id, "production", "ANOTHER")).map(event => [event.action, event.outcome])).toEqual([
      ["resolve", "failed"],
      ["resolve", "started"],
      ["replace", "succeeded"],
    ])
  })

  it("refuses bad stages and names", async () => {
    const { app, key } = await setup()
    const owner = (await key("u-ada")).key
    expect((await call(owner, "GET", `/api/projects/${app.id}/env/..%2Fsecrets`)).status).toBe(400)
    expect((await call(owner, "PUT", `/api/projects/${app.id}/env/production/1BAD`, { value: "x" })).status).toBe(400)
    expect((await call(owner, "PUT", `/api/projects/${app.id}/env/production/OK`, { value: 1 })).status).toBe(400)
  })
})
