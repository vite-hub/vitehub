import { fileURLToPath } from "node:url"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ConsoleDatabase } from "../src/projects.ts"

const state = vi.hoisted(() => ({ db: undefined as unknown }))

vi.mock("vite-hub/database", () => ({ useDatabase: () => ({ db: state.db }) }))
// Every request is Ada's session in her team.
vi.mock("vite-hub/auth/server", () => ({
  withAuthorization: (_required: boolean, handler: (request: Request, authorization: unknown) => Promise<Response>) => (request: Request) =>
    handler(request, { session: { activeOrganizationId: "t-ada" }, user: { email: "ada@example.com", id: "u-ada", name: "Ada" } }),
}))

const { consumeForwardBudget, forwardBudget } = await import("../src/forward-budget.ts")
const { createConsoleProjectStore } = await import("../src/projects.ts")
const { checkProject, consoleTeamCaller } = await import("../server/utils/console.ts")
const { default: forward } = await import("../server/routes/p/[id]/_vitehub/[...path].ts")

const consoleSecret = "c".repeat(64)
const clients: ReturnType<typeof createClient>[] = []
const sent: string[] = []

beforeEach(() => {
  vi.stubEnv("VITEHUB_CONSOLE_SECRET", consoleSecret)
  sent.length = 0
  vi.stubGlobal("fetch", async (url: URL) => {
    sent.push(url.host)
    return Response.json({ ok: true })
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  clients.splice(0).forEach(client => client.close())
})

async function setup() {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  const db = drizzle({ client })
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../server/databases/default/migrations/", import.meta.url)) })
  state.db = db
  const now = Date.now()
  await client.execute({ sql: "insert into user (id, name, email, email_verified, created_at, updated_at) values ('u-ada', 'Ada', 'ada@example.com', 0, ?, ?)", args: [now, now] })
  await client.execute({ sql: "insert into organization (id, name, slug, created_at) values ('t-ada', 'Ada''s team', 't-ada', ?)", args: [now] })
  await client.execute({ sql: "insert into member (id, organization_id, user_id, role, created_at) values ('m1', 't-ada', 'u-ada', 'owner', ?)", args: [now] })
  const projects = createConsoleProjectStore(db as ConsoleDatabase, consoleSecret, "t-ada")
  const app = (await projects.create({ createdBy: "u-ada", url: "https://app.example.com" }))!
  const other = (await projects.create({ createdBy: "u-ada", url: "https://other.example.com" }))!
  return { app, client, db: db as ConsoleDatabase, other }
}

function call(projectId: string): Promise<Response> {
  return forward.fetch(new Request(`https://console.test/p/${projectId}/_vitehub/rpc`, { body: "{}", headers: { "content-type": "application/json" }, method: "POST" }))
}

describe("Console forward budget", () => {
  it("answers 429 with CONSOLE_FORWARD_RATE_LIMITED after the budget, and still sends calls to another project", async () => {
    const { app, other } = await setup()
    for (let index = 0; index < forwardBudget.limit; index++) expect((await call(app.id)).status).toBe(200)
    expect(sent).toHaveLength(forwardBudget.limit)

    const limited = await call(app.id)
    expect(limited.status).toBe(429)
    const retryAfter = Number(limited.headers.get("retry-after"))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)
    expect(await limited.json()).toMatchObject({ code: "CONSOLE_FORWARD_RATE_LIMITED", fix: expect.stringContaining("Retry-After"), status: 429 })
    // The limited call never reached the app.
    expect(sent).toHaveLength(forwardBudget.limit)

    expect((await call(other.id)).status).toBe(200)
    expect(sent.at(-1)).toBe("other.example.com")
  })

  it("counts the operation calls of the API and the ViteHub MCP in the same budget", async () => {
    const { app, db } = await setup()
    for (let index = 0; index < forwardBudget.limit; index++) await consumeForwardBudget(db, "u-ada", app.id)
    const caller = await consoleTeamCaller({ email: "ada@example.com", id: "u-ada", name: "Ada" }, "t-ada")
    if (caller instanceof Response) throw new Error(await caller.text())
    const check = await checkProject(caller, app.id)
    expect(await check.json()).toMatchObject({ answer: { code: "CONSOLE_FORWARD_RATE_LIMITED" }, linked: false, status: 429 })
    expect(sent).toEqual([])
  })

  it("starts a new window a minute after the first call, and keeps one row for each person and project", async () => {
    const { app, client, db } = await setup()
    const start = 1_800_000_000_000
    for (let index = 0; index < forwardBudget.limit; index++) await consumeForwardBudget(db, "u-ada", app.id, start)
    await expect(consumeForwardBudget(db, "u-ada", app.id, start + 59_500)).resolves.toBe(1)
    await expect(consumeForwardBudget(db, "u-bob", app.id, start + 59_500)).resolves.toBeUndefined()
    await expect(consumeForwardBudget(db, "u-ada", app.id, start + forwardBudget.windowMs)).resolves.toBeUndefined()
    const { rows } = await client.execute("select key, count from rate_limit order by key")
    expect(rows.map(row => [row.key, row.count])).toEqual([[`console-forward:u-ada:${app.id}`, 1], [`console-forward:u-bob:${app.id}`, 1]])
  })
})
