import { eq } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { defineSync } from "../src/define.ts"
import { createSyncHandler } from "../src/runtime.ts"
import { createHarness, origin, teamsOf } from "./handler-harness.ts"

import type { SyncPullResponse, SyncPushResponse } from "../src/protocol.ts"
import type { SyncServices } from "../src/runtime.ts"

const issues = sqliteTable("issues", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  ownerId: text("owner_id"),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
})

const ddl = "CREATE TABLE `issues` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `owner_id` text, `title` text NOT NULL, `done` integer DEFAULT 0 NOT NULL)"

const byTeam = defineSync({ table: issues, where: ({ user }) => user ? { teamId: teamsOf(user) } : false })

const as = (held: { scope: string, version: string, account: string, cursor: number }) => ({ scope: held.scope, version: held.version, account: held.account, cursor: held.cursor })

const alice = { user: "alice", teams: ["a"] }
const bob = { user: "bob", teams: ["b"] }
const carol = { user: "carol", teams: ["c"] }

async function setup(definition = byTeam) {
  return { ...await createHarness({ name: "issues", definition, ddl: [ddl] }), definition }
}

/** The handler of a ViteHub app on the same Database, as a new server process sees it. */
function processOf(app: { db: SyncServices["db"], services: SyncServices }, definitions: Record<string, unknown>) {
  const handler = createSyncHandler({ definitions, db: () => app.db, session: app.services.identify! })
  const headers = (caller: { user: string, teams: readonly string[] }) => ({ "x-user": caller.user, "x-teams": caller.teams.join(",") })
  return {
    async pull(name: string, caller: { user: string, teams: readonly string[] }, query: { cursor?: number, scope?: string, version?: string, where?: Record<string, unknown> } = {}) {
      const url = new URL(`/api/_vitehub/sync/${name}`, origin)
      if (query.cursor !== undefined) url.searchParams.set("cursor", String(query.cursor))
      if (query.scope) url.searchParams.set("scope", query.scope)
      if (query.version) url.searchParams.set("version", query.version)
      if (query.where) url.searchParams.set("where", JSON.stringify(query.where))
      const response = await handler.fetch(new Request(url, { headers: headers(caller) }))
      // SAFETY: the tests read the documented answer of a pull.
      return await response.json() as SyncPullResponse
    },
    async push(name: string, caller: { user: string, teams: readonly string[] }, body: { account: string, mutations: unknown[] }) {
      const response = await handler.fetch(new Request(new URL(`/api/_vitehub/sync/${name}`, origin), {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...headers(caller) },
        body: JSON.stringify(body),
      }))
      // SAFETY: the tests read the documented answer of a push.
      return await response.json() as SyncPushResponse
    },
  }
}

async function triggers(app: { client: { execute: (sql: string) => Promise<{ rows: unknown[] }> } }) {
  const { rows } = await app.client.execute("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
  // SAFETY: `sqlite_master` has text `name` and `sql` columns.
  return rows as unknown as { name: string, sql: string }[]
}

describe("writes that do not go through Sync", () => {
  it("sends inserts, updates, and deletes that server code makes with Drizzle or plain SQL", async () => {
    const app = await setup()
    const a = await app.start(alice)
    const b = await app.start(bob)

    await app.db.insert(issues).values([{ id: "i1", teamId: "a", title: "From a job" }, { id: "i2", teamId: "b", title: "Other team" }])
    const added = (await app.pull(alice, as(a))).body
    expect(added).toMatchObject({ reset: false, rows: [{ id: "i1", teamId: "a", title: "From a job" }], deleted: [] })

    await app.db.update(issues).set({ title: "Renamed" }).where(eq(issues.id, "i1"))
    const changed = (await app.pull(alice, { ...as(a), cursor: added.cursor })).body
    expect(changed).toMatchObject({ reset: false, rows: [{ id: "i1", title: "Renamed" }], deleted: [] })

    await app.db.delete(issues).where(eq(issues.id, "i1"))
    expect((await app.pull(alice, { ...as(a), cursor: changed.cursor })).body).toMatchObject({ reset: false, rows: [], deleted: ["i1"] })

    // Bob gets the row of his team, and nothing of team `a`.
    const own = (await app.pull(bob, as(b))).body
    expect(own).toMatchObject({ reset: false, rows: [{ id: "i2" }], deleted: [] })

    // A new key is a delete of the old key and an insert of the new one.
    await app.client.execute("UPDATE `issues` SET `id` = 'i9' WHERE `id` = 'i2'")
    expect((await app.pull(bob, { ...as(b), cursor: own.cursor })).body).toMatchObject({ reset: false, rows: [{ id: "i9" }], deleted: ["i2"] })
  })

  it("sends a move by server code to the old team as deleted, to the new team as a row, and to no other team", async () => {
    const app = await setup()
    await app.db.insert(issues).values({ id: "i1", teamId: "a", title: "Move me" })
    const [a, b, c] = [await app.start(alice), await app.start(bob), await app.start(carol)]

    await app.db.update(issues).set({ teamId: "b" }).where(eq(issues.id, "i1"))
    expect((await app.pull(alice, as(a))).body).toMatchObject({ reset: false, rows: [], deleted: ["i1"] })
    expect((await app.pull(bob, as(b))).body).toMatchObject({ reset: false, rows: [{ id: "i1", teamId: "b" }], deleted: [] })
    expect((await app.pull(carol, as(c))).body).toMatchObject({ reset: false, rows: [], deleted: [] })
  })

  it("records a move of a column that the writer's `where` does not have, once a pull used the column", async () => {
    // People see their own issues. The admin sees every issue and moves one to another person.
    const app = await setup(defineSync({ table: issues, where: ({ user }) => !user ? false : user.id === "admin" ? {} : { ownerId: user.id } }))
    await app.db.insert(issues).values({ id: "i1", teamId: "a", ownerId: "alice", title: "Mine" })
    const own = await app.start(alice)
    const other = await app.start(bob)
    const admin = await app.start({ user: "admin", teams: [] })

    const { body } = await app.push({ user: "admin", teams: [] }, { ...as(admin), mutations: [{ id: "m1", op: "update", key: "i1", patch: { ownerId: "bob" } }] })
    expect(body.results).toEqual([{ id: "m1", status: "applied" }])
    expect((await app.pull(alice, as(own))).body).toMatchObject({ reset: false, rows: [], deleted: ["i1"] })
    expect((await app.pull(bob, as(other))).body).toMatchObject({ reset: false, rows: [{ id: "i1", ownerId: "bob" }], deleted: [] })
    // The first pull of Alice registered the column.
    expect((await app.client.execute("SELECT table_name, \"column\" FROM vitehub_sync_columns")).rows).toEqual([{ table_name: "issues", column: "owner_id" }])
  })
})

describe("two definitions of one table", () => {
  it("starts, and each definition gets the writes of the other", async () => {
    const app = await setup()
    const mine = defineSync({ table: issues, where: ({ user }) => user ? { ownerId: user.id } : false })
    const team = defineSync({ table: issues, where: ({ user }) => user ? { teamId: teamsOf(user) } : false, write: false })
    const server = processOf(app, { mine, team })
    const dave = { user: "dave", teams: ["a"] }
    const writer = await server.pull("mine", alice)
    const reader = await server.pull("team", dave)
    const held = (pull: SyncPullResponse) => ({ cursor: pull.cursor, scope: pull.scope.id, version: pull.version })

    const pushed = await server.push("mine", alice, { account: writer.account, mutations: [{ id: "m1", op: "insert", value: { id: "i1", teamId: "a", title: "Through mine" } }] })
    expect(pushed.results).toEqual([{ id: "m1", status: "applied" }])
    const seen = await server.pull("team", dave, held(reader))
    expect(seen).toMatchObject({ reset: false, rows: [{ id: "i1", ownerId: "alice", title: "Through mine" }], deleted: [] })

    // A move to team `b` through `mine`, whose `where` has no `teamId`, still leaves team `a`.
    await server.push("mine", alice, { account: writer.account, mutations: [{ id: "m2", op: "update", key: "i1", patch: { teamId: "b" } }] })
    expect(await server.pull("team", dave, held(seen))).toMatchObject({ reset: false, rows: [], deleted: ["i1"] })
  })
})

describe("triggers and migrations", () => {
  it("names only the key and the columns of `where` and `subsets`, so a migration can drop another column", async () => {
    const app = await setup()
    await app.start(alice)
    const installed = await triggers(app)
    expect(installed.map(trigger => trigger.name)).toEqual(["vitehub_sync_issues_delete", "vitehub_sync_issues_insert", "vitehub_sync_issues_update"])
    expect(installed.find(trigger => trigger.name.endsWith("_delete"))?.sql).toContain("'team_id'")
    expect(installed.some(trigger => trigger.sql.includes("title"))).toBe(false)
    await app.client.execute("ALTER TABLE `issues` DROP COLUMN `title`")
    await app.client.execute("INSERT INTO `issues` (`id`, `team_id`) VALUES ('i1', 'a')")
    await app.client.execute("DELETE FROM `issues` WHERE `id` = 'i1'")
  })

  it("keeps writing the change log after a migration adds a column, and follows the new column after a restart", async () => {
    const app = await setup()
    const a = await app.start(alice)
    await app.client.execute("ALTER TABLE `issues` ADD COLUMN `label` text")
    await app.client.execute("INSERT INTO `issues` (`id`, `team_id`, `title`, `label`) VALUES ('i1', 'a', 'Bug', 'bug')")
    expect((await app.pull(alice, as(a))).body).toMatchObject({ reset: false, rows: [{ id: "i1" }] })

    // The next deploy has the column in its table and in `subsets`.
    const labeled = sqliteTable("issues", {
      id: text("id").primaryKey(),
      teamId: text("team_id").notNull(),
      ownerId: text("owner_id"),
      title: text("title").notNull(),
      done: integer("done", { mode: "boolean" }).notNull().default(false),
      label: text("label"),
    })
    const server = processOf(app, { issues: defineSync({ table: labeled, where: ({ user }) => user ? { teamId: teamsOf(user) } : false, subsets: ["label"] }) })
    const bugs = await server.pull("issues", alice, { where: { label: "bug" } })
    expect(bugs.rows.map(row => row.id)).toEqual(["i1"])
    expect((await triggers(app)).find(trigger => trigger.name.endsWith("_update"))?.sql).toContain("OLD.\"label\" IS NOT NEW.\"label\"")

    await app.client.execute("UPDATE `issues` SET `label` = 'feature' WHERE `id` = 'i1'")
    expect(await server.pull("issues", alice, { cursor: bugs.cursor, scope: bugs.scope.id, version: bugs.version, where: { label: "bug" } })).toMatchObject({ reset: false, rows: [], deleted: ["i1"] })
  })

  it("drops a scope column with the statements of the docs, and adds the triggers again", async () => {
    const app = await setup(defineSync({ table: issues, where: ({ user }) => user ? { ownerId: user.id } : false }))
    const a = await app.start(alice)
    await expect(app.client.execute("ALTER TABLE `issues` DROP COLUMN `owner_id`")).rejects.toThrow(/error in trigger vitehub_sync_issues_(?:update|delete) after drop column/)
    await app.client.executeMultiple([
      "DROP TRIGGER IF EXISTS vitehub_sync_issues_insert",
      "DROP TRIGGER IF EXISTS vitehub_sync_issues_update",
      "DROP TRIGGER IF EXISTS vitehub_sync_issues_delete",
      "DELETE FROM vitehub_sync_columns WHERE table_name = 'issues' AND \"column\" = 'owner_id'",
      "ALTER TABLE `issues` DROP COLUMN `owner_id`",
    ].join(";\n"))

    // The next deploy has no `ownerId`.
    const teams = sqliteTable("issues", { id: text("id").primaryKey(), teamId: text("team_id").notNull(), title: text("title").notNull(), done: integer("done", { mode: "boolean" }).notNull().default(false) })
    const server = processOf(app, { issues: defineSync({ table: teams, where: ({ user }) => user ? { teamId: teamsOf(user) } : false }) })
    expect(await server.pull("issues", alice, { cursor: a.cursor, scope: a.scope, version: a.version })).toMatchObject({ reset: true })
    expect((await triggers(app)).map(trigger => trigger.name)).toHaveLength(3)
    expect((await app.client.execute("SELECT \"column\" FROM vitehub_sync_columns")).rows).toEqual([{ column: "team_id" }])
  })

  it("adds the triggers again after a migration rebuilt the table, and resets clients that held a cursor", async () => {
    const app = await setup()
    const a = await app.start(alice)
    await app.db.insert(issues).values({ id: "i1", teamId: "a", title: "Before" })
    const before = (await app.pull(alice, as(a))).body
    // A restart without a migration keeps the triggers, and clients stay incremental.
    expect(await processOf(app, { issues: byTeam }).pull("issues", alice, { cursor: before.cursor, scope: before.scope.id, version: before.version })).toMatchObject({ reset: false, rows: [] })

    // drizzle-kit rebuilds a SQLite table for changes that ALTER TABLE cannot make. DROP TABLE drops its triggers.
    await app.client.executeMultiple([
      "CREATE TABLE `__new_issues` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `owner_id` text, `title` text NOT NULL, `done` integer DEFAULT 1 NOT NULL)",
      "INSERT INTO `__new_issues` SELECT `id`, `team_id`, `owner_id`, `title`, `done` FROM `issues`",
      "DROP TABLE `issues`",
      "ALTER TABLE `__new_issues` RENAME TO `issues`",
    ].join(";\n"))
    expect(await triggers(app)).toEqual([])
    // A write while no trigger is there.
    await app.client.execute("DELETE FROM `issues` WHERE `id` = 'i1'")

    const server = processOf(app, { issues: byTeam })
    const after = await server.pull("issues", alice, { cursor: before.cursor, scope: before.scope.id, version: before.version })
    expect(after).toMatchObject({ reset: true, rows: [] })
    expect(await triggers(app)).toHaveLength(3)
    await app.db.insert(issues).values({ id: "i2", teamId: "a", title: "After" })
    expect(await server.pull("issues", alice, { cursor: after.cursor, scope: after.scope.id, version: after.version })).toMatchObject({ reset: false, rows: [{ id: "i2" }] })
  })
})
