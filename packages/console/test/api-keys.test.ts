import { fileURLToPath } from "node:url"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ConsoleDatabase } from "../src/projects.ts"

const state = vi.hoisted(() => ({ db: undefined as unknown }))

vi.mock("vite-hub/database", () => ({ useDatabase: () => ({ db: state.db }) }))
vi.mock("vite-hub/auth/server", () => ({ withAuthorization: () => async () => Response.json({ message: "Unauthorized." }, { status: 401 }) }))

const { createConsoleApiKey, listConsoleApiKeys, revokeConsoleApiKey, verifyConsoleApiKey } = await import("../src/api-keys.ts")
const { createConsoleProjectStore } = await import("../src/projects.ts")
const { default: listProjects } = await import("../server/api/projects/index.get.ts")
const { default: linkProject } = await import("../server/api/projects/index.post.ts")
const { default: whoami } = await import("../server/api/whoami.get.ts")
const { default: revoke } = await import("../server/api/api-keys/[id].delete.ts")

const consoleSecret = "c".repeat(64)
const clients: ReturnType<typeof createClient>[] = []

beforeEach(() => { vi.stubEnv("VITEHUB_CONSOLE_SECRET", consoleSecret) })
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
  for (const [id, name] of [["t-ada", "Ada's team"], ["t-bob", "Bob's team"]]) {
    await client.execute({ sql: "insert into organization (id, name, slug, created_at) values (?, ?, ?, ?)", args: [id!, name!, id!, now] })
  }
  for (const [id, team, user, role] of [["m1", "t-ada", "u-ada", "owner"], ["m2", "t-bob", "u-bob", "owner"], ["m3", "t-bob", "u-ada", "member"]]) {
    await client.execute({ sql: "insert into member (id, organization_id, user_id, role, created_at) values (?, ?, ?, ?, ?)", args: [id!, team!, user!, role!, now] })
  }
  const link = async (team: string, url: string) => (await createConsoleProjectStore(db as ConsoleDatabase, consoleSecret, team).create({ url, createdBy: "u-ada" }))!
  return { client, db: db as ConsoleDatabase, link }
}

const bearer = (key: string, init: RequestInit & { path?: string } = {}) => new Request(`https://console.test${init.path ?? "/api/projects"}`, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } })

describe("Console API keys", () => {
  it("keeps only a hash, and shows the key in no list", async () => {
    const { client, db } = await setup()
    const created = (await createConsoleApiKey(db, { userId: "u-ada", teamId: "t-ada", name: "CI" }))!
    expect(created.key).toMatch(/^vhk_/)
    const dump = JSON.stringify((await client.execute("select * from console_api_keys")).rows)
    expect(dump).not.toContain(created.key)
    expect(dump).not.toContain(created.key.slice(8))
    expect(JSON.stringify(await listConsoleApiKeys(db, "u-ada"))).not.toContain(created.key.slice(8))
    expect(await listConsoleApiKeys(db, "u-ada")).toEqual([expect.objectContaining({ id: created.apiKey.id, name: "CI", start: created.key.slice(0, 8), team: { id: "t-ada", name: "Ada's team" } })])
  })

  it("rejects a revoked key, an expired key, a key of a person who left the team, and a key for a team they are not in", async () => {
    const { client, db } = await setup()
    expect(await createConsoleApiKey(db, { userId: "u-bob", teamId: "t-ada", name: "Not mine" })).toBeUndefined()

    const revoked = (await createConsoleApiKey(db, { userId: "u-ada", teamId: "t-ada", name: "Revoked" }))!
    expect(await verifyConsoleApiKey(db, revoked.key)).toBeDefined()
    expect(await revokeConsoleApiKey(db, "u-bob", revoked.apiKey.id)).toBe(false)
    expect(await revokeConsoleApiKey(db, "u-ada", revoked.apiKey.id)).toBe(true)
    expect(await verifyConsoleApiKey(db, revoked.key)).toBeUndefined()
    expect((await listProjects.fetch(bearer(revoked.key))).status).toBe(401)

    const short = (await createConsoleApiKey(db, { userId: "u-ada", teamId: "t-ada", name: "Short", days: 1 }))!
    expect(await verifyConsoleApiKey(db, short.key, Date.now() + 86_400_001)).toBeUndefined()

    const left = (await createConsoleApiKey(db, { userId: "u-ada", teamId: "t-bob", name: "Left" }))!
    expect(await verifyConsoleApiKey(db, left.key)).toMatchObject({ roles: ["member"] })
    await client.execute("delete from member where id = 'm3'")
    expect(await verifyConsoleApiKey(db, left.key)).toBeUndefined()
  })

  it("acts only in the key's team and on the key's projects", async () => {
    const { db, link } = await setup()
    const docs = await link("t-ada", "https://docs.example.com")
    const shop = await link("t-ada", "https://shop.example.com")
    const bobs = await link("t-bob", "https://bob.example.com")

    const team = (await createConsoleApiKey(db, { userId: "u-ada", teamId: "t-ada", name: "Team" }))!
    const listed = await (await listProjects.fetch(bearer(team.key))).json() as { projects: { id: string }[] }
    expect(listed.projects.map(project => project.id).sort()).toEqual([docs.id, shop.id].sort())

    const scoped = (await createConsoleApiKey(db, { userId: "u-ada", teamId: "t-ada", name: "Docs only", projectIds: [docs.id] }))!
    const only = await (await listProjects.fetch(bearer(scoped.key))).json() as { projects: { id: string }[] }
    expect(only.projects.map(project => project.id)).toEqual([docs.id])
    const linked = await linkProject.fetch(bearer(scoped.key, { method: "POST", body: JSON.stringify({ url: "https://new.example.com" }) }))
    expect(linked.status).toBe(403)

    expect(JSON.stringify(listed)).not.toContain(bobs.id)

    expect(await (await whoami.fetch(bearer(scoped.key, { path: "/api/whoami" }))).json()).toEqual({
      key: { expiresAt: scoped.apiKey.expiresAt, id: scoped.apiKey.id },
      projectIds: [docs.id],
      roles: ["owner"],
      team: { id: "t-ada", name: "Ada's team" },
      user: { email: "ada@example.com", id: "u-ada", name: "Ada" },
    })
    expect((await whoami.fetch(new Request("https://console.test/api/whoami"))).status).toBe(401)
  })

  it("lets a key revoke only itself", async () => {
    const { db } = await setup()
    const first = (await createConsoleApiKey(db, { userId: "u-ada", teamId: "t-ada", name: "First" }))!
    const second = (await createConsoleApiKey(db, { userId: "u-ada", teamId: "t-ada", name: "Second" }))!
    expect((await revoke.fetch(bearer(first.key, { method: "DELETE", path: `/api/api-keys/${second.apiKey.id}` }))).status).toBe(403)
    expect((await revoke.fetch(bearer(first.key, { method: "DELETE", path: "/api/api-keys/current" }))).status).toBe(204)
    expect(await verifyConsoleApiKey(db, first.key)).toBeUndefined()
    expect(await verifyConsoleApiKey(db, second.key)).toBeDefined()
  })
})
