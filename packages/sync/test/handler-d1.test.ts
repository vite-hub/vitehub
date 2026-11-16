import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, expect, it } from "vitest"

import { syncTables } from "../src/database.ts"
import { defineSync } from "../src/define.ts"
import { handleSyncRequest } from "../src/runtime.ts"
import { origin, teamsOf } from "./handler-harness.ts"

import type { SyncPullResponse, SyncPushResponse } from "../src/protocol.ts"
import type { SyncServices } from "../src/runtime.ts"
import type { SyncDefinition } from "../src/types.ts"

const columns = {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
}
const issues = sqliteTable("issues", columns)
const labeled = sqliteTable("issues", { ...columns, label: text("label") })

let worker: Miniflare
let d1: Awaited<ReturnType<Miniflare["getD1Database"]>>

beforeAll(async () => {
  worker = new Miniflare({ compatibilityDate: "2026-07-14", d1Databases: ["DB"], modules: true, script: "export default { fetch() { return new Response('sync d1 test') } }" })
  d1 = await worker.getD1Database("DB")
  await d1.batch([...syncTables, "CREATE TABLE `issues` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `title` text NOT NULL, `done` integer DEFAULT 0 NOT NULL)"].map(statement => d1.prepare(statement)))
})
afterAll(async () => {
  await worker?.dispose()
})

/** One server process: a services object, as `createSyncHandler()` makes once. */
function processOf<TTable, TRow, TArgs>(definition: SyncDefinition<TTable, TRow, TArgs>) {
  const services: SyncServices = {
    db: () => drizzle(d1),
    identify: async (request) => {
      const id = request.headers.get("x-user")
      return id ? { user: { id, teams: (request.headers.get("x-teams") ?? "").split(",") }, session: null } : null
    },
  }
  const headers = (caller: { user: string, teams: string[] }) => ({ "x-user": caller.user, "x-teams": caller.teams.join(",") })
  return {
    async pull(caller: { user: string, teams: string[] }, held: { cursor?: number, scope?: string, version?: string, where?: Record<string, unknown> } = {}) {
      const url = new URL("/api/_vitehub/sync/issues", origin)
      if (held.cursor !== undefined) url.searchParams.set("cursor", String(held.cursor))
      if (held.scope) url.searchParams.set("scope", held.scope)
      if (held.version) url.searchParams.set("version", held.version)
      if (held.where) url.searchParams.set("where", JSON.stringify(held.where))
      // SAFETY: the test reads the documented answer of a pull.
      return await (await handleSyncRequest("issues", definition, new Request(url, { headers: headers(caller) }), services)).json() as SyncPullResponse
    },
    async push(caller: { user: string, teams: string[] }, account: string, mutations: unknown[]) {
      const request = new Request(new URL("/api/_vitehub/sync/issues", origin), { method: "POST", headers: { "content-type": "application/json", origin, ...headers(caller) }, body: JSON.stringify({ account, mutations }) })
      // SAFETY: the test reads the documented answer of a push.
      return await (await handleSyncRequest("issues", definition, request, services)).json() as SyncPushResponse
    },
  }
}

const held = (pull: SyncPullResponse, where?: Record<string, unknown>) => ({ cursor: pull.cursor, scope: pull.scope.id, version: pull.version, ...(where ? { where } : {}) })
const alice = { user: "alice", teams: ["a"] }
const bob = { user: "bob", teams: ["b"] }

it("captures every write on a local D1 with triggers, also after a migration adds a column", async () => {
  const db = drizzle(d1)
  const server = processOf(defineSync({ table: issues, where: ({ user }) => user ? { teamId: teamsOf(user) } : false }))
  const a = await server.pull(alice)
  const b = await server.pull(bob)

  // Writes of server code, not through Sync.
  await db.insert(issues).values([{ id: "i1", teamId: "a", title: "From a job" }, { id: "i2", teamId: "b", title: "Other team" }])
  const added = await server.pull(alice, held(a))
  expect(added).toMatchObject({ reset: false, rows: [{ id: "i1", title: "From a job" }], deleted: [] })
  await db.update(issues).set({ teamId: "b" }).where(eq(issues.id, "i1"))
  const moved = await server.pull(alice, held(added))
  expect(moved).toMatchObject({ reset: false, rows: [], deleted: ["i1"] })
  expect((await server.pull(bob, held(b))).rows.map(row => row.id).sort()).toEqual(["i1", "i2"])

  // Writes through Sync keep their ledger and their per-write refusals on D1.
  const pushed = await server.push(alice, a.account, [{ id: "m1", op: "insert", value: { id: "i3", teamId: "a", title: "Pushed" } }, { id: "m2", op: "insert", value: { id: "i4", teamId: "a" } }])
  expect(pushed.results).toEqual([{ id: "m1", status: "applied" }, { id: "m2", status: "rejected", error: expect.objectContaining({ code: "SYNC_INVALID", message: expect.stringContaining("NOT NULL") }) }])
  expect((await server.push(alice, a.account, [{ id: "m1", op: "insert", value: { id: "i3", teamId: "a", title: "Pushed" } }])).results).toEqual([{ id: "m1", status: "duplicate" }])
  const pushedPull = await server.pull(alice, held(moved))
  expect(pushedPull).toMatchObject({ reset: false, rows: [{ id: "i3" }], deleted: [] })

  // A migration adds a column. The old triggers keep working.
  await d1.prepare("ALTER TABLE `issues` ADD COLUMN `label` text").run()
  await d1.prepare("INSERT INTO `issues` (`id`, `team_id`, `title`, `label`) VALUES ('i5', 'a', 'Bug', 'bug')").run()
  expect(await server.pull(alice, held(pushedPull))).toMatchObject({ reset: false, rows: [{ id: "i5" }] })

  // The next deploy uses the column as a subset. Its triggers follow the column.
  const next = processOf(defineSync({ table: labeled, where: ({ user }) => user ? { teamId: teamsOf(user) } : false, subsets: ["label"] }))
  const bugs = await next.pull(alice, { where: { label: "bug" } })
  expect(bugs.rows.map(row => row.id)).toEqual(["i5"])
  await drizzle(d1).update(labeled).set({ label: "feature" }).where(eq(labeled.id, "i5"))
  expect(await next.pull(alice, held(bugs, { label: "bug" }))).toMatchObject({ reset: false, rows: [], deleted: ["i5"] })

  // A migration can drop a column that the triggers do not read.
  await d1.prepare("ALTER TABLE `issues` DROP COLUMN `done`").run()
  await d1.prepare("DELETE FROM `issues` WHERE `id` = 'i2'").run()
  const { results } = await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()
  expect(results).toEqual([{ name: "vitehub_sync_issues_delete" }, { name: "vitehub_sync_issues_insert" }, { name: "vitehub_sync_issues_replace_insert" }, { name: "vitehub_sync_issues_replace_update" }, { name: "vitehub_sync_issues_update" }])
})
