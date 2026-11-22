import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it, vi } from "vitest"

import { readConsolePublicKeys, signConsoleRequest, verifyConsoleSignature } from "@vite-hub/internal/console-signature"

import { createConsoleProjectStore, scopeConsoleProjectStore } from "../src/projects.ts"
import { renameProject } from "../server/utils/console.ts"

import type { ConsoleTeamCaller } from "../server/utils/console.ts"

vi.mock("vite-hub/database", () => ({ useDatabase: () => ({}) }))

const secret = "s".repeat(64)
const table = "CREATE TABLE `console_projects` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `url` text NOT NULL, `label` text, `key_sealed` text NOT NULL, `public_key` text NOT NULL, `created_by` text NOT NULL, `created_at` integer NOT NULL, UNIQUE (`team_id`, `url`))"

async function database() {
  const client = createClient({ url: ":memory:" })
  await client.execute(table)
  return { client, db: drizzle({ client }) }
}

describe("project store", () => {
  it("links a project with a new key pair and keeps only the sealed private key and the public key", async () => {
    const { client, db } = await database()
    const store = createConsoleProjectStore(db, secret, "team-1")
    const project = await store.create({ createdBy: "user-1", label: " Docs ", url: "https://app.example.com" })
    expect(project).toMatchObject({ createdBy: "user-1", label: "Docs", teamId: "team-1", url: "https://app.example.com" })
    expect(project!.keyVariable).toBe(`VITEHUB_CONSOLE_KEY_CONSOLE_${project!.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`)
    expect(project!.publicKey).toMatch(/^[\w-]{43}$/)
    const target = await store.target(project!.id)
    expect(target?.key.name).toBe(project!.keyVariable.slice("VITEHUB_CONSOLE_KEY_".length))
    const { rows } = await client.execute("SELECT key_sealed FROM console_projects")
    expect(String(rows[0]?.key_sealed)).not.toContain(target!.key.privateKey)
    const url = "https://app.example.com/_vitehub/rpc"
    const headers = new Headers(await signConsoleRequest({ body: "{}", caller: { via: "cli" }, key: target!.key, method: "POST", url }))
    const keys = readConsolePublicKeys({ [project!.keyVariable]: project!.publicKey })
    if (!(keys instanceof Map)) throw new Error(keys.message)
    await expect(verifyConsoleSignature({ headers, keys, method: "POST", origin: "https://app.example.com", url })).resolves.toMatchObject({ key: target!.key.name, ok: true })
    await expect(store.list()).resolves.toEqual([project])
    await expect(store.get(project!.id)).resolves.toEqual(project)
  })

  it("shows each team only its own projects", async () => {
    const { db } = await database()
    const first = createConsoleProjectStore(db, secret, "team-1")
    const second = createConsoleProjectStore(db, secret, "team-2")
    const project = await first.create({ createdBy: "u", url: "https://app.example.com" })
    const other = await second.create({ createdBy: "v", url: "https://app.example.com" })
    expect(other?.publicKey).not.toBe(project?.publicKey)
    expect(other?.keyVariable).not.toBe(project?.keyVariable)
    await expect(second.list()).resolves.toEqual([other])
    await expect(second.get(project!.id)).resolves.toBeUndefined()
    await expect(second.target(project!.id)).resolves.toBeUndefined()
    await expect(second.remove(project!.id)).resolves.toBe(false)
    await expect(first.list()).resolves.toEqual([project])
  })

  it("does not link the same URL twice", async () => {
    const { db } = await database()
    const store = createConsoleProjectStore(db, secret, "team-1")
    await store.create({ createdBy: "u", url: "https://app.example.com" })
    await expect(store.create({ createdBy: "u", url: "https://app.example.com" })).resolves.toBeUndefined()
  })

  it("gives no key when the secret changed", async () => {
    const { db } = await database()
    const project = await createConsoleProjectStore(db, secret, "team-1").create({ createdBy: "u", url: "https://app.example.com" })
    await expect(createConsoleProjectStore(db, "t".repeat(64), "team-1").target(project!.id)).resolves.toBeUndefined()
  })

  it("unlinks a project", async () => {
    const { db } = await database()
    const store = createConsoleProjectStore(db, secret, "team-1")
    const project = await store.create({ createdBy: "u", url: "https://app.example.com" })
    await expect(store.remove(project!.id)).resolves.toBe(true)
    await expect(store.remove(project!.id)).resolves.toBe(false)
    await expect(store.list()).resolves.toEqual([])
  })

  it("renames a project of the team, and an empty label removes the label", async () => {
    const { db } = await database()
    const store = createConsoleProjectStore(db, secret, "team-1")
    const project = await store.create({ createdBy: "u", label: "vitehub-calories", url: "https://app.example.com" })
    await expect(store.rename(project!.id, " Calories ")).resolves.toEqual({ ...project, label: "Calories" })
    await expect(store.get(project!.id)).resolves.toMatchObject({ label: "Calories", publicKey: project!.publicKey })
    await expect(store.rename(project!.id, " ")).resolves.toMatchObject({ label: null })
    await expect(store.rename(project!.id, null)).resolves.toMatchObject({ label: null })
    const scoped = scopeConsoleProjectStore(store, [project!.id])
    await expect(scoped.rename(project!.id, "Scoped")).resolves.toMatchObject({ label: "Scoped" })
    await expect(scopeConsoleProjectStore(store, []).rename(project!.id, "Hidden")).resolves.toBeUndefined()
    await expect(createConsoleProjectStore(db, secret, "team-2").rename(project!.id, "Mine")).resolves.toBeUndefined()
    await expect(store.get(project!.id)).resolves.toMatchObject({ label: "Scoped" })
  })
})

describe("renameProject()", () => {
  async function caller(roles: string[]): Promise<{ caller: ConsoleTeamCaller, id: string }> {
    const { db } = await database()
    const projects = createConsoleProjectStore(db, secret, "team-1")
    const project = await projects.create({ createdBy: "u", url: "https://app.example.com" })
    return { caller: { projects, roles, teamId: "team-1", user: { email: "ada@example.com", id: "ada", name: "Ada" } }, id: project!.id }
  }

  it("lets owners and admins rename, and answers the renamed project", async () => {
    for (const role of ["owner", "admin"]) {
      const { caller: admin, id } = await caller([role])
      const response = await renameProject(admin, id, { label: "Calories" })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ project: { id, label: "Calories" } })
    }
  })

  it("refuses members, a label that is not text, and a project of another team", async () => {
    const { caller: member, id } = await caller(["member"])
    const forbidden = await renameProject(member, id, { label: "Calories" })
    expect(forbidden.status).toBe(403)
    await expect(member.projects.get(id)).resolves.toMatchObject({ label: null })

    const { caller: owner, id: owned } = await caller(["owner"])
    for (const body of [undefined, {}, { label: 3 }]) {
      const invalid = await renameProject(owner, owned, body)
      expect(invalid.status).toBe(400)
      await expect(invalid.json()).resolves.toMatchObject({ code: "CONSOLE_PROJECT_INVALID" })
    }
    const missing = await renameProject(owner, "not-a-project", { label: "Calories" })
    expect(missing.status).toBe(404)
  })
})
