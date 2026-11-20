import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, expect, it } from "vitest"

import { createBlobDatabaseWorkspaceStore } from "../src/blob-database.ts"
import { isWorkspaceName, useWorkspaceFiles } from "../src/files.ts"
import { resetWorkspaceRegistry, setWorkspaceRegistry } from "../src/core/registry.ts"
import { registerWorkspace } from "../src/test.ts"
import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"

const cleanup: Array<() => Promise<void> | void> = []
const migration = await readFile(new URL("fixtures/history.sql", import.meta.url), "utf8")

afterEach(async () => {
  resetWorkspaceRegistry()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function historyStore() {
  await mkdir(join(homedir(), ".cache/fleet/tmp"), { recursive: true })
  const root = await mkdtemp(join(homedir(), ".cache/fleet/tmp/workspace-history-diff-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle({ client })
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  return () => createBlobDatabaseWorkspaceStore({ blob, database, workspace: "meetups" })
}

it("lists the files that changed between two revisions on any ref", async () => {
  const store = await historyStore()
  const workspace = useWorkspaceFiles("meetups", { mode: "write", definition: { name: "meetups", store: store() } })
  const base = await workspace.history.commit({ ifHead: null, files: { "app.vue": "<NuxtPage />", "server/api/events.get.ts": "export default []", "README.md": "Meetups" } })
  const run = await workspace.history.commit({
    ref: "run-42",
    ifHead: null,
    files: { "app.vue": "<NuxtPage />", "server/api/events.get.ts": "export default [event]", "server/api/rsvp.post.ts": "export default {}" },
  })

  const diff = await workspace.history.diff({ from: base.id, to: run.id })
  expect(diff).toMatchObject({ from: base.id, to: run.id })
  expect(diff.entries.map(({ path, type }) => ({ path, type }))).toEqual([
    { path: "README.md", type: "removed" },
    { path: "server/api/events.get.ts", type: "modified" },
    { path: "server/api/rsvp.post.ts", type: "added" },
  ])
  expect(diff.entries[1]).toMatchObject({ before: { type: "file", size: 17 }, after: { type: "file", size: 22 } })

  const readonly = useWorkspaceFiles("meetups", { definition: { name: "meetups", store: store() } })
  expect(await readonly.history.diff({ from: base.id, to: run.id })).toEqual(diff)
  expect((await readonly.history.diff({ to: base.id })).entries.map(({ path, type }) => `${type} ${path}`)).toEqual([
    "added README.md",
    "added app.vue",
    "added server/api/events.get.ts",
  ])
  expect(await readonly.history.diff({ from: run.id, to: run.id })).toEqual({ from: run.id, to: run.id, entries: [] })
})

it("tells whether a name from outside the code is a Workspace", () => {
  setWorkspaceRegistry({ "meal-planner": async () => ({ default: {} }) })
  registerWorkspace("meetups", {})

  expect(isWorkspaceName("meetups")).toBe(true)
  expect(isWorkspaceName("meal-planner")).toBe(true)
  expect(isWorkspaceName("fix-seats-race")).toBe(false)
  expect(isWorkspaceName("toString")).toBe(false)
  expect(isWorkspaceName("")).toBe(false)
})
