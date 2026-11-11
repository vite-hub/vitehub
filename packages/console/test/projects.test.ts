import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it } from "vitest"

import { createConsoleProjectStore } from "../src/projects.ts"
import { tokenSha256 } from "../src/token-box.ts"

const secret = "s".repeat(64)
const table = "CREATE TABLE `console_projects` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `url` text NOT NULL, `label` text, `token_sealed` text NOT NULL, `token_sha256` text NOT NULL, `created_by` text NOT NULL, `created_at` integer NOT NULL, UNIQUE (`team_id`, `url`))"

async function database() {
  const client = createClient({ url: ":memory:" })
  await client.execute(table)
  return { client, db: drizzle({ client }) }
}

describe("project store", () => {
  it("links a project with a new token and keeps only the sealed token and its hash", async () => {
    const { client, db } = await database()
    const store = createConsoleProjectStore(db, secret, "team-1")
    const project = await store.create({ createdBy: "user-1", label: " Docs ", url: "https://app.example.com" })
    expect(project).toMatchObject({ createdBy: "user-1", label: "Docs", teamId: "team-1", url: "https://app.example.com" })
    const target = await store.target(project!.id)
    expect(target?.token).toMatch(/^[0-9a-f]{64}$/)
    expect(project!.tokenSha256).toBe(await tokenSha256(target!.token))
    const { rows } = await client.execute("SELECT token_sealed FROM console_projects")
    expect(String(rows[0]?.token_sealed)).not.toContain(target!.token)
    await expect(store.list()).resolves.toEqual([project])
    await expect(store.get(project!.id)).resolves.toEqual(project)
  })

  it("shows each team only its own projects", async () => {
    const { db } = await database()
    const first = createConsoleProjectStore(db, secret, "team-1")
    const second = createConsoleProjectStore(db, secret, "team-2")
    const project = await first.create({ createdBy: "u", url: "https://app.example.com" })
    // Another team can link the same URL with its own token.
    const other = await second.create({ createdBy: "v", url: "https://app.example.com" })
    expect(other?.tokenSha256).not.toBe(project?.tokenSha256)
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

  it("gives no token when the secret changed", async () => {
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
