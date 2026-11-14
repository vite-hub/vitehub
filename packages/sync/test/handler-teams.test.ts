import { eq, sql } from "drizzle-orm"
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it, vi } from "vitest"

import { fingerprint } from "../src/canonical.ts"
import { syncChanges, syncState } from "../src/database.ts"
import { defineSync } from "../src/define.ts"
import { createSyncHandler, recordSyncChanges } from "../src/runtime.ts"
import { createHarness, day, teamsOf } from "./handler-harness.ts"

import type { SyncMutation } from "../src/protocol.ts"
import type { DefineSyncOptions } from "../src/types.ts"

const issues = sqliteTable("issues", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  title: text("title").notNull(),
  note: text("note"),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date(0)),
  rank: integer("rank").default(sql`0`),
})

const ddl = "CREATE TABLE `issues` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `title` text NOT NULL, `note` text, `done` integer DEFAULT 0 NOT NULL, `created_at` integer, `rank` integer DEFAULT 0)"

async function setup(options: Partial<DefineSyncOptions<typeof issues>> = {}) {
  const definition = defineSync({ table: issues, where: ({ user }) => user ? { teamId: teamsOf(user) } : false, ...options })
  const harness = await createHarness({ name: "issues", definition, ddl: [ddl] })
  const rows = async () => (await harness.db.select().from(issues).orderBy(issues.id)).map(row => ({ id: row.id, teamId: row.teamId, title: row.title }))
  return { ...harness, definition, rows }
}

const insert = (id: string, value: Record<string, unknown>): SyncMutation => ({ id, op: "insert", value })
const update = (id: string, key: string, patch: Record<string, unknown>): SyncMutation => ({ id, op: "update", key, patch })
const remove = (id: string, key: string): SyncMutation => ({ id, op: "delete", key })
const as = (held: { scope: string, version: string, account: string }) => ({ scope: held.scope, version: held.version, account: held.account })

const alice = { user: "alice", teams: ["a"] }
const bob = { user: "bob", teams: ["b"] }
const carol = { user: "carol", teams: ["c"] }
const dave = { user: "dave", teams: ["a", "b"] }

describe("version and defaults", () => {
  it("answers each pull with the version, the defaults, and the account", async () => {
    const app = await setup()
    const { body } = await app.pull(alice)
    expect(body.version).toMatch(/^[0-9a-f]{32}$/)
    // `$defaultFn()` and SQL defaults are not static, so the client gets them with the confirmed row.
    expect(body.defaults).toEqual({ note: null, done: false })
    expect(body.account).toMatch(/^[0-9a-f]{32}$/)
    expect(body.account).toBe((await app.pull({ user: "alice", teams: ["a", "b"] })).body.account)
    expect(body.account).not.toBe((await app.pull({ user: "bob", teams: ["a"] })).body.account)
  })

  it("uses the scope as the account without a user", async () => {
    const app = await setup({ where: () => ({}) })
    const { body } = await app.pull(null)
    expect(body.account).toBe(body.scope.id)
  })

  it("changes the version when a column changes, and resets a client of another version", async () => {
    const app = await setup()
    const held = await app.start(alice)
    const changed = defineSync({ table: sqliteTable("issues", { id: text("id").primaryKey(), teamId: text("team_id").notNull(), title: text("title").notNull(), note: text("note"), done: integer("done", { mode: "boolean" }).notNull().default(false), createdAt: integer("created_at", { mode: "timestamp_ms" }), rank: real("rank") }), where: () => ({}) })
    const other = await createHarness({ name: "issues", definition: changed, ddl: [ddl] })
    expect((await other.pull(alice)).body.version).not.toBe(held.version)
    // The same table gives the same version.
    expect((await (await setup({ where: () => ({}) })).pull(alice)).body.version).toBe(held.version)

    await app.push(alice, { ...as(held), mutations: [insert("m1", { id: "i1", teamId: "a", title: "One" })] })
    expect((await app.pull(alice, { ...as(held), cursor: held.cursor })).body).toMatchObject({ reset: false, rows: [{ id: "i1" }] })
    expect((await app.pull(alice, { ...as(held), cursor: held.cursor, version: "0".repeat(32) })).body).toMatchObject({ reset: true, rows: [{ id: "i1" }], version: held.version })
    const pushed = await app.push(alice, { ...as(held), version: "old", cursor: held.cursor, mutations: [] })
    expect(pushed.body.pull.reset).toBe(true)
  })
})

describe("team scopes", () => {
  it("shows the rows of every team of the caller", async () => {
    const app = await setup()
    await app.db.insert(issues).values([{ id: "i1", teamId: "a", title: "A" }, { id: "i2", teamId: "b", title: "B" }, { id: "i3", teamId: "c", title: "C" }])
    const { body } = await app.pull(dave)
    expect(body.scope.values).toEqual({ teamId: ["a", "b"] })
    expect(body.rows.map(row => row.id).sort()).toEqual(["i1", "i2"])
    // The order of the teams does not change the scope.
    expect((await app.pull({ user: "dave", teams: ["b", "a", "b"] })).body.scope.id).toBe(body.scope.id)
    // No team matches nothing.
    expect((await app.pull({ user: "erin", teams: [] })).body.rows).toEqual([])
  })

  it("inserts into an allowed team, and refuses another team or no team", async () => {
    const app = await setup()
    const held = await app.start(dave)
    const { body } = await app.push(dave, {
      ...as(held),
      mutations: [
        insert("m1", { id: "i1", teamId: "a", title: "A" }),
        insert("m2", { id: "i2", teamId: "b", title: "B" }),
        insert("m3", { id: "i3", teamId: "c", title: "C" }),
        insert("m4", { id: "i4", title: "No team" }),
      ],
    })
    expect(body.results.map(result => result.status === "rejected" ? result.error.code : result.status)).toEqual(["applied", "applied", "SYNC_OUT_OF_SCOPE", "SYNC_OUT_OF_SCOPE"])
    expect(await app.rows()).toEqual([{ id: "i1", teamId: "a", title: "A" }, { id: "i2", teamId: "b", title: "B" }])
  })

  it("filters a list of more than 100 teams with one parameter, within D1's limit", async () => {
    const app = await setup()
    const teams = Array.from({ length: 150 }, (_, index) => `t${index}`)
    const many = { user: "zoe", teams }
    await app.db.insert(issues).values([{ id: "i1", teamId: "t149", title: "Last" }, { id: "i2", teamId: "x", title: "Other" }])
    const held = await app.start(many)
    app.parameters.length = 0
    const { body } = await app.push(many, { ...as(held), cursor: held.cursor, mutations: [insert("m1", { id: "i3", teamId: "t120", title: "New" }), update("m2", "i1", { title: "Last!" }), remove("m3", "i3")] })
    expect(body.results.map(result => result.status)).toEqual(["applied", "applied", "applied"])
    expect(body.pull).toMatchObject({ reset: false, rows: [{ id: "i1", title: "Last!" }], deleted: ["i3"] })
    expect((await app.pull(many)).body.rows.map(row => row.id)).toEqual(["i1"])
    expect(app.parameters.length).toBeGreaterThan(0)
    expect(Math.max(...app.parameters)).toBeLessThanOrEqual(100)
  })

  it("accepts a push of the same account after the caller joined a team, and resets its pull", async () => {
    const app = await setup()
    const before = await app.start(alice)
    const joined = { user: "alice", teams: ["a", "b"] }
    const { status, body } = await app.push(joined, { ...as(before), cursor: before.cursor, mutations: [insert("m1", { id: "i1", teamId: "b", title: "In b" })] })
    expect(status).toBe(200)
    expect(body.results).toEqual([{ id: "m1", status: "applied" }])
    expect(body.pull).toMatchObject({ reset: true, rows: [{ id: "i1", teamId: "b" }] })
    expect(body.pull.scope.id).not.toBe(before.scope)

    // Another person on the same device: the writes stay out.
    const other = await app.push({ user: "bob", teams: ["a"] }, { ...as(before), mutations: [insert("m2", { id: "i2", teamId: "a", title: "x" })] })
    expect(other).toMatchObject({ status: 409, body: { code: "SYNC_SCOPE_CHANGED" } })
    expect((await app.rows()).map(row => row.id)).toEqual(["i1"])
  })
})

describe("accounts of apps with their own sign-in", () => {
  /** An app that reads the user and the teams from its own session: here, from headers. */
  async function ownSignIn(name: string, account?: DefineSyncOptions<typeof issues>["account"]) {
    const definition = defineSync({
      table: issues,
      where: ({ request }) => ({ teamId: (request.headers.get("x-app-teams") ?? "").split(",").filter(Boolean) }),
      ...(account ? { account } : {}),
    })
    return await createHarness({ name, definition, ddl: [ddl] })
  }
  const session = (user: string, teams: string) => ({ "x-app-user": user, "x-app-teams": teams })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("keeps the account of the `account` option when the caller joins a team", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = await ownSignIn("own-account", ({ request }) => request.headers.get("x-app-user"))
    const held = await app.start(null, undefined, session("u1", "a"))
    expect(held.account).toBe(await fingerprint("account\nu1"))
    const joined = await app.push(null, { ...as(held), cursor: held.cursor, mutations: [insert("m1", { id: "i1", teamId: "b", title: "In b" })] }, session("u1", "a,b"))
    expect(joined.status).toBe(200)
    expect(joined.body.results).toEqual([{ id: "m1", status: "applied" }])
    expect(joined.body.pull).toMatchObject({ reset: true, account: held.account })
    // Another user on the same device: the writes stay out.
    expect(await app.push(null, { ...as(held), mutations: [insert("m2", { id: "i2", teamId: "a", title: "x" })] }, session("u2", "a"))).toMatchObject({ status: 409, body: { code: "SYNC_SCOPE_CHANGED" } })
    // `null` makes the scope the account.
    const anonymous = await ownSignIn("own-anonymous", () => null)
    const { body } = await anonymous.pull(null, {}, session("", "a"))
    expect(body.account).toBe(body.scope.id)
    expect(warn).not.toHaveBeenCalled()
  })

  it("warns once in development when a list scope stands for the account, because a team change holds back queued writes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = await ownSignIn("own-scope")
    const held = await app.start(null, undefined, session("u1", "a"))
    expect(held.account).toBe(held.scope)
    expect(await app.push(null, { ...as(held), mutations: [insert("m1", { id: "i1", teamId: "b", title: "In b" })] }, session("u1", "a,b"))).toMatchObject({ status: 409, body: { code: "SYNC_SCOPE_CHANGED" } })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("Return the caller's own user id from `account` in server/sync/own-scope.ts")
  })

  it("refuses an `account` that is not a function or returns no text", async () => {
    // @ts-expect-error `account` is a function.
    expect(() => defineSync({ table: issues, where: () => ({}), account: "u1" })).toThrow("`account` must be a function")
    // @ts-expect-error `account` returns text or `null`.
    const app = await ownSignIn("own-number", () => 42)
    await expect(app.pull(null, {}, session("u1", "a"))).rejects.toMatchObject({ code: "SYNC_INVALID_DEFINITION" })
  })
})

describe("rows that leave a scope", () => {
  it("sends a move between teams to the old team as deleted and to the new team as a row, and to no other team", async () => {
    const app = await setup()
    const writer = await app.start(dave)
    await app.push(dave, { ...as(writer), mutations: [insert("m1", { id: "i1", teamId: "a", title: "Move me" })] })
    const [a, b, c, both] = [await app.start(alice), await app.start(bob), await app.start(carol), await app.start(dave)]

    const { body } = await app.push(dave, { ...as(writer), mutations: [update("m2", "i1", { teamId: "b" })] })
    expect(body.results).toEqual([{ id: "m2", status: "applied" }])
    expect((await app.pull(alice, { ...as(a), cursor: a.cursor })).body).toMatchObject({ reset: false, rows: [], deleted: ["i1"] })
    expect((await app.pull(bob, { ...as(b), cursor: b.cursor })).body).toMatchObject({ reset: false, rows: [{ id: "i1", teamId: "b" }], deleted: [] })
    expect((await app.pull(carol, { ...as(c), cursor: c.cursor })).body).toMatchObject({ reset: false, rows: [], deleted: [] })
    expect((await app.pull(dave, { ...as(both), cursor: both.cursor })).body).toMatchObject({ reset: false, rows: [{ id: "i1", teamId: "b" }], deleted: [] })

    // Back to `a`: `a` gets the row, and not a stale delete.
    await app.push(dave, { ...as(writer), mutations: [update("m3", "i1", { teamId: "a" })] })
    expect((await app.pull(alice, { ...as(a), cursor: a.cursor })).body).toMatchObject({ rows: [{ id: "i1", teamId: "a" }], deleted: [] })
    expect((await app.pull(bob, { ...as(b), cursor: b.cursor })).body).toMatchObject({ rows: [], deleted: ["i1"] })
  })

  it("refuses a move to a team that the caller is not in", async () => {
    const app = await setup()
    const held = await app.start(alice)
    await app.push(alice, { ...as(held), mutations: [insert("m1", { id: "i1", teamId: "a", title: "x" })] })
    const { body } = await app.push(alice, { ...as(held), mutations: [update("m2", "i1", { teamId: "b" })] })
    expect(body.results[0]).toMatchObject({ status: "rejected", error: { code: "SYNC_OUT_OF_SCOPE" } })
    expect(await app.rows()).toEqual([{ id: "i1", teamId: "a", title: "x" }])
  })

  it("sends a move by server code with recordSyncChanges({ moved })", async () => {
    const app = await setup()
    createSyncHandler({ definitions: { issues: app.definition }, databases: { default: { db: app.db } } })
    await app.db.insert(issues).values({ id: "i1", teamId: "a", title: "Server" })
    expect(await recordSyncChanges("issues", { put: ["i1"] })).toEqual([undefined, { recorded: 1 }])
    const [a, b, c] = [await app.start(alice), await app.start(bob), await app.start(carol)]

    const [before] = await app.db.select().from(issues).where(eq(issues.id, "i1"))
    await app.db.update(issues).set({ teamId: "b" }).where(eq(issues.id, "i1"))
    expect(await recordSyncChanges("issues", { moved: [before!] })).toEqual([undefined, { recorded: 1 }])
    expect((await app.pull(alice, { ...as(a), cursor: a.cursor })).body).toMatchObject({ rows: [], deleted: ["i1"] })
    expect((await app.pull(bob, { ...as(b), cursor: b.cursor })).body).toMatchObject({ rows: [{ id: "i1", teamId: "b" }], deleted: [] })
    expect((await app.pull(carol, { ...as(c), cursor: c.cursor })).body).toMatchObject({ rows: [], deleted: [] })

    const [missing] = await recordSyncChanges("issues", { moved: [{ title: "no key" }] })
    expect(missing?.code).toBe("SYNC_INVALID")
  })

  it("keeps one put for each key and appends one exit for each delete or move", async () => {
    const app = await setup()
    const held = await app.start(dave)
    await app.push(dave, { ...as(held), mutations: [insert("m1", { id: "i1", teamId: "a", title: "x" }), update("m2", "i1", { title: "y" }), update("m3", "i1", { teamId: "b" }), update("m4", "i1", { teamId: "a" }), remove("m5", "i1")] })
    const entries = await app.db.select({ op: syncChanges.op, key: syncChanges.key, row: syncChanges.row }).from(syncChanges).orderBy(syncChanges.seq)
    expect(entries.map(entry => entry.op)).toEqual(["move", "move", "delete"])
    expect(entries.map(entry => JSON.parse(entry.row ?? "null").teamId)).toEqual(["a", "b", "a"])
  })

  it("keeps every column of a wide table in an exit, also past SQLite's limit of function arguments", async () => {
    const extra = Array.from({ length: 70 }, (_, index) => `c${index}`)
    const wide = sqliteTable("wide", { id: text("id").primaryKey(), teamId: text("team_id").notNull(), flag: integer("flag", { mode: "boolean" }), ...Object.fromEntries(extra.map(name => [name, text(name)])) })
    const definition = defineSync({ table: wide, where: ({ user }) => user ? { teamId: teamsOf(user) } : false })
    const app = await createHarness({ name: "wide", definition, ddl: [`CREATE TABLE \`wide\` (\`id\` text PRIMARY KEY NOT NULL, \`team_id\` text NOT NULL, \`flag\` integer, ${extra.map(name => `\`${name}\` text`).join(", ")})`] })
    const held = await app.start(dave)
    const a = await app.start(alice)
    await app.push(dave, { ...as(held), mutations: [insert("m1", { id: "w1", teamId: "a", flag: true, c0: "first", c69: "last" })] })
    const before = await app.start(alice)
    await app.push(dave, { ...as(held), mutations: [update("m2", "w1", { teamId: "b" })] })
    const [exit] = await app.db.select({ row: syncChanges.row }).from(syncChanges).where(eq(syncChanges.op, "move"))
    // A later part drops its `null` values, and a missing column reads as `null`.
    expect(JSON.parse(exit?.row ?? "null")).toMatchObject({ id: "w1", teamId: "a", flag: 1, c0: "first", c1: null, c69: "last" })
    expect((await app.pull(alice, { ...as(before), cursor: before.cursor })).body).toMatchObject({ deleted: ["w1"] })
    expect((await app.pull(alice, { ...as(a), cursor: a.cursor })).body).toMatchObject({ rows: [], deleted: ["w1"] })
  })

  it("compacts exits after 30 days and resets older cursors", async () => {
    const app = await setup()
    const writer = await app.start(dave)
    await app.push(dave, { ...as(writer), mutations: [insert("m1", { id: "i1", teamId: "a", title: "x" }), insert("m2", { id: "i2", teamId: "a", title: "y" })] })
    const old = await app.start(alice)
    await app.push(dave, { ...as(writer), mutations: [update("m3", "i1", { teamId: "b" })] })
    const moved = (await app.pull(dave)).body.cursor

    app.clock.now += 31 * day
    await app.push(dave, { ...as(writer), mutations: [update("m4", "i2", { title: "z" })] })
    expect(await app.db.select().from(syncState)).toEqual([{ name: "issues", floor: moved - 1 }])
    expect((await app.db.select({ op: syncChanges.op }).from(syncChanges)).map(entry => entry.op)).toEqual(["put", "put"])
    expect((await app.pull(alice, { ...as(old), cursor: old.cursor })).body).toMatchObject({ reset: true, rows: [{ id: "i2", title: "z" }] })
  })
})

describe("writes that race", () => {
  /** A `write` check that runs `race` once, after the handler read the row and before it applies the write. */
  async function racing() {
    let race: (() => Promise<void>) | undefined
    const app = await setup({
      write: async () => {
        const run = race
        race = undefined
        await run?.()
        return true
      },
    })
    return { ...app, race: (run: () => Promise<void>) => { race = run } }
  }

  it("records the exit of a move with the row as it is when the write applies", async () => {
    const app = await racing()
    const erin = { user: "erin", teams: ["a", "b", "c"] }
    const first = await app.start(dave)
    const second = await app.start(erin)
    await app.db.insert(issues).values({ id: "i1", teamId: "a", title: "Race" })
    let b = await app.start(bob)

    // Erin read the row in `a`. Before her move to `c` applies, Dave moves it to `b`, and Bob loads it.
    app.race(async () => {
      await app.push(dave, { ...as(first), mutations: [update("m1", "i1", { teamId: "b" })] })
      const loaded = await app.pull(bob, { ...as(b), cursor: b.cursor })
      expect(loaded.body.rows).toMatchObject([{ id: "i1", teamId: "b" }])
      b = { ...b, cursor: loaded.body.cursor }
    })
    expect((await app.push(erin, { ...as(second), mutations: [update("m2", "i1", { teamId: "c" })] })).body.results[0]?.status).toBe("applied")
    expect(await app.rows()).toEqual([{ id: "i1", teamId: "c", title: "Race" }])
    // The second exit holds `b`, so Bob drops the row.
    expect((await app.pull(bob, { ...as(b), cursor: b.cursor })).body).toMatchObject({ rows: [], deleted: ["i1"] })
    const exits = await app.db.select({ op: syncChanges.op, row: syncChanges.row }).from(syncChanges).where(eq(syncChanges.op, "move")).orderBy(syncChanges.seq)
    expect(exits.map(exit => JSON.parse(exit.row ?? "null").teamId)).toEqual(["a", "b"])
  })

  it("keeps the put and records no exit when a scoped delete finds no row", async () => {
    const app = await racing()
    const writer = await app.start(dave)
    const deleter = await app.start(alice)
    await app.push(dave, { ...as(writer), mutations: [insert("m1", { id: "i1", teamId: "a", title: "Stay" })] })
    const b = await app.start(bob)

    // Alice read the row in `a`. Before her delete applies, Dave moves it to `b`.
    app.race(async () => {
      await app.push(dave, { ...as(writer), mutations: [update("m2", "i1", { teamId: "b" })] })
    })
    await app.push(alice, { ...as(deleter), mutations: [remove("m3", "i1")] })
    expect(await app.rows()).toEqual([{ id: "i1", teamId: "b", title: "Stay" }])
    expect((await app.pull(bob, { ...as(b), cursor: b.cursor })).body).toMatchObject({ rows: [{ id: "i1", teamId: "b" }], deleted: [] })
    const entries = await app.db.select({ op: syncChanges.op }).from(syncChanges).orderBy(syncChanges.seq)
    expect(entries.map(entry => entry.op)).toEqual(["move", "put"])
  })
})

describe("subsets", () => {
  it("narrows the scope, stamps the subset on insert, and has its own scope id", async () => {
    const app = await setup()
    await app.db.insert(issues).values([{ id: "i1", teamId: "a", title: "A" }, { id: "i2", teamId: "b", title: "B" }])
    const full = await app.pull(dave)
    const { body } = await app.pull(dave, { where: { teamId: "b" } })
    expect(body.scope.values).toEqual({ teamId: "b" })
    expect(body.scope.id).not.toBe(full.body.scope.id)
    expect(body.rows.map(row => row.id)).toEqual(["i2"])
    // The account does not depend on the subset.
    expect(body.account).toBe(full.body.account)

    const subset = await app.start(dave, { teamId: "b" })
    const pushed = await app.push(dave, { ...as(subset), cursor: subset.cursor, where: { teamId: "b" }, mutations: [insert("m1", { id: "i3", title: "Stamped" })] })
    expect(pushed.body.results).toEqual([{ id: "m1", status: "applied" }])
    expect(pushed.body.pull).toMatchObject({ reset: false, rows: [{ id: "i3", teamId: "b" }] })

    // A column of `subsets` narrows further.
    const titled = await setup({ subsets: ["title"] })
    await titled.db.insert(issues).values([{ id: "i1", teamId: "a", title: "A" }, { id: "i2", teamId: "b", title: "B" }])
    const narrow = await titled.pull(dave, { where: { title: "B" } })
    expect(narrow.body.scope.values).toEqual({ teamId: ["a", "b"], title: "B" })
    expect(narrow.body.rows.map(row => row.id)).toEqual(["i2"])
  })

  it("refuses a subset on a column that is not in `subsets` and names the fix", async () => {
    const app = await setup()
    const { status, body } = await app.pull(dave, { where: { title: "B" } })
    expect(status).toBe(400)
    expect(body.code).toBe("SYNC_BAD_REQUEST")
    expect(body.message).toContain("Add \"title\" to `subsets` in `server/sync/issues.ts`")
    const held = await app.start(dave)
    expect(await app.push(dave, { ...as(held), where: { title: "B" }, mutations: [] })).toMatchObject({ status: 400, body: { code: "SYNC_BAD_REQUEST" } })
    // A column that `where` sets needs no entry in `subsets`.
    expect((await app.pull(dave, { where: { teamId: "a" } })).status).toBe(200)
  })

  it("sends a row to the subsets that it leaves when a broader store, an action, or server code changes a subset column", async () => {
    const definition = defineSync({
      table: issues,
      where: ({ user }) => user ? { teamId: teamsOf(user) } : false,
      subsets: ["note", "done", "createdAt"],
      actions: { annotate: ({ update }, { id, note }: { id: string, note: string }) => update(id, { note }) },
    })
    const app = await createHarness({ name: "issues", definition, ddl: [ddl] })
    createSyncHandler({ definitions: { issues: definition }, databases: { default: { db: app.db } } })
    const full = await app.start(dave)
    await app.push(dave, { ...as(full), mutations: [
      insert("m1", { id: "i1", teamId: "a", title: "One", note: "x", createdAt: new Date(5).toISOString() }),
      insert("m2", { id: "i2", teamId: "a", title: "Two", note: "x" }),
      insert("m3", { id: "i3", teamId: "a", title: "Three", note: "x" }),
    ] })
    const x = await app.start(dave, { note: "x" })
    const open = await app.start(dave, { done: false })
    const at = await app.start(dave, { createdAt: new Date(5).toISOString() })
    expect((await app.pull(dave, { where: { createdAt: new Date(5).toISOString() } })).body.rows.map(row => row.id)).toEqual(["i1"])

    // From the full store: a new note and `done`.
    await app.push(dave, { ...as(full), mutations: [update("m4", "i1", { note: "y", done: true, createdAt: new Date(6).toISOString() })] })
    // From an action.
    await app.push(dave, { ...as(full), mutations: [{ id: "m5", op: "action", name: "annotate", args: { id: "i2", note: "y" } }] })
    // From server code.
    const [before] = await app.db.select().from(issues).where(eq(issues.id, "i3"))
    await app.db.update(issues).set({ note: "y" }).where(eq(issues.id, "i3"))
    expect(await recordSyncChanges("issues", { moved: [before!] })).toEqual([undefined, { recorded: 1 }])

    const deleted = async (held: typeof x, where: Record<string, unknown>) => (await app.pull(dave, { ...as(held), cursor: held.cursor, where })).body.deleted.sort()
    expect(await deleted(x, { note: "x" })).toEqual(["i1", "i2", "i3"])
    expect(await deleted(open, { done: false })).toEqual(["i1"])
    expect(await deleted(at, { createdAt: new Date(5).toISOString() })).toEqual(["i1"])
    // A change of another column records no exit.
    await app.push(dave, { ...as(full), mutations: [update("m6", "i2", { title: "Renamed" })] })
    expect((await app.db.select({ op: syncChanges.op }).from(syncChanges).where(eq(syncChanges.op, "move"))).length).toBe(3)
  })

  it("refuses a subset outside `where`, and a subset that is not single column values", async () => {
    const app = await setup()
    expect(await app.pull(alice, { where: { teamId: "b" } })).toMatchObject({ status: 403, body: { code: "SYNC_OUT_OF_SCOPE" } })
    const single = await setup({ where: ({ user }) => user ? { teamId: teamsOf(user)[0] ?? "" } : false })
    expect(await single.pull(alice, { where: { teamId: "b" } })).toMatchObject({ status: 403, body: { code: "SYNC_OUT_OF_SCOPE" } })
    expect((await single.pull(alice, { where: { teamId: "a" } })).status).toBe(200)

    expect(await app.pull(alice, { where: { color: "red" } })).toMatchObject({ status: 400, body: { code: "SYNC_BAD_REQUEST" } })
    expect(await app.pull(alice, { where: { teamId: ["a"] } })).toMatchObject({ status: 400, body: { code: "SYNC_BAD_REQUEST" } })
    const held = await app.start(alice)
    expect(await app.push(alice, { ...as(held), where: { teamId: "b" }, mutations: [insert("m1", { id: "i1", title: "x" })] })).toMatchObject({ status: 403, body: { code: "SYNC_OUT_OF_SCOPE" } })
    expect(await app.rows()).toEqual([])
  })
})
