import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it } from "vitest"

import { readConsolePublicKeys, signConsoleRequest, verifyConsoleSignature } from "@vite-hub/internal/console-signature"

import { createConsoleProjectStore } from "../src/projects.ts"

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
    // The private key of the row signs requests that the public key on the setup page verifies.
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
    // Another team can link the same URL with its own key pair.
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
})
