import { numeric, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { defineSync } from "../src/define.ts"
import { liveResponse } from "../src/live.ts"
import { syncLiveRoute } from "../src/protocol.ts"
import { createSyncHandler, handleSyncRequest } from "../src/runtime.ts"
import { createHarness, origin, readEvents, teamsOf } from "./handler-harness.ts"

import type { SyncPullResponse, SyncWireError } from "../src/protocol.ts"
import type { SyncServices } from "../src/runtime.ts"
import type { SyncContext } from "../src/types.ts"
import type { ParsedEvent } from "./handler-harness.ts"

const notes = sqliteTable("notes", { id: text("id").primaryKey(), teamId: text("team_id").notNull(), body: text("body").notNull() })
const ddl = "CREATE TABLE `notes` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `body` text NOT NULL)"
const tasks = sqliteTable("tasks", { id: text("id").primaryKey(), teamId: text("team_id").notNull(), title: text("title").notNull() })
const tasksDdl = "CREATE TABLE `tasks` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `title` text NOT NULL)"

const byTeam = ({ user }: SyncContext) => user ? { teamId: teamsOf(user) } : false as const

async function setup(live: SyncServices["live"], options: { live?: boolean } = {}) {
  const definition = defineSync({ table: notes, where: byTeam, ...options })
  const others = {
    tasks: defineSync({ table: tasks, where: byTeam }),
    quiet: defineSync({ table: tasks, where: byTeam, live: false }),
  }
  return { ...await createHarness({ name: "notes", definition, definitions: others, ddl: [ddl, tasksDdl], live }), definition, others }
}

const as = (held: { scope: string, version: string, account: string, cursor: number }) => ({ scope: held.scope, version: held.version, cursor: held.cursor })
const alice = { user: "alice", teams: ["a"] }
const bob = { user: "bob", teams: ["a"] }
const carol = { user: "carol", teams: ["c"] }

interface PullData { name: string, where?: Record<string, unknown>, pull: SyncPullResponse }
interface ErrorData { name: string, where?: Record<string, unknown>, error: SyncWireError }

/** Reads the `open` event, which comes after the refusals and before the first pull. */
async function opened(events: { next: (ms: number) => Promise<ParsedEvent | "timeout" | "end"> }): Promise<void> {
  expect(await events.next(1000)).toMatchObject({ event: "open", data: {} })
}

function dataOf<T>(event: ParsedEvent | "timeout" | "end"): T {
  if (typeof event !== "object") throw new Error(`No event: ${event}`)
  // SAFETY: the tests read the documented data of `SyncLiveEvent`.
  return event.data as T
}

describe("live", () => {
  it("streams a pull at once when another caller pushes in this process", async () => {
    // A check every minute: only the in-process wake can deliver the event in time.
    const app = await setup({ interval: 60_000, seconds: 30 })
    const held = await app.start(alice)
    const writer = await app.start(bob)
    const { response, abort } = await app.live(alice, [as(held)])
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("x-accel-buffering")).toBe("no")
    const events = readEvents(response)
    // Nothing changed since the cursor of the client, so the stream sends no pull when it opens. It sends a comment
    // at once, because Node sends the headers only with the first chunk of the body.
    await opened(events)
    expect(events.comments).toEqual([": open"])
    expect(await events.next(100)).toBe("timeout")

    const started = performance.now()
    await app.push(bob, { ...as(writer), account: writer.account, mutations: [{ id: "m1", op: "insert", value: { id: "n1", teamId: "a", body: "Hello" } }] })
    const event = await events.next(2000)
    const elapsed = performance.now() - started
    expect(event).toMatchObject({ event: "pull" })
    const data = dataOf<PullData>(event)
    expect(data).toEqual({ name: "notes", pull: expect.objectContaining({ reset: false, rows: [{ id: "n1", teamId: "a", body: "Hello" }], deleted: [], account: held.account, version: held.version }) })
    expect(elapsed).toBeLessThan(2000)

    abort()
    expect(await events.next(1000)).toBe("end")
  })

  it("streams the pulls of several names and subsets in one response, and each event names its store", async () => {
    const app = await setup({ interval: 60_000, seconds: 30 })
    const caller = { user: "alice", teams: ["a", "b"] }
    const all = await app.start(caller)
    const teamB = await app.start(caller, { teamId: "b" })
    const { response, abort } = await app.live(caller, [as(all), { ...as(teamB), where: { teamId: "b" } }, { name: "tasks" }])
    const events = readEvents(response)
    await opened(events)
    // The entry without a cursor gets a full snapshot at once.
    expect(dataOf<PullData>(await events.next(1000))).toMatchObject({ name: "tasks", pull: { reset: true, rows: [] } })

    await app.push(caller, { ...as(teamB), account: teamB.account, where: { teamId: "b" }, mutations: [{ id: "m1", op: "insert", value: { id: "n1", teamId: "b", body: "Team b" } }] })
    const first = dataOf<PullData>(await events.next(2000))
    const second = dataOf<PullData>(await events.next(2000))
    expect([first, second].map(({ name, where, pull }) => ({ name, where, rows: pull.rows }))).toEqual([
      { name: "notes", where: undefined, rows: [{ id: "n1", teamId: "b", body: "Team b" }] },
      { name: "notes", where: { teamId: "b" }, rows: [{ id: "n1", teamId: "b", body: "Team b" }] },
    ])

    const tasksRoute = new URL("/api/_vitehub/sync/tasks", origin)
    const start = await (await handleSyncRequest("tasks", app.others.tasks, new Request(tasksRoute, { headers: { "x-user": "alice", "x-teams": "a,b" } }), app.services)).json() as SyncPullResponse
    await handleSyncRequest("tasks", app.others.tasks, new Request(tasksRoute, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "x-user": "alice", "x-teams": "a,b" },
      body: JSON.stringify({ account: start.account, mutations: [{ id: "m2", op: "insert", value: { id: "t1", teamId: "a", title: "Task" } }] }),
    }), app.services)
    expect(dataOf<PullData>(await events.next(2000))).toMatchObject({ name: "tasks", pull: { reset: false, rows: [{ id: "t1", title: "Task" }] } })
    expect(await events.next(100)).toBe("timeout")
    abort()
  })

  it("checks the change log once for each interval, whatever the number of stores in the stream", async () => {
    const app = await setup({ interval: 50, seconds: 30 })
    const teams = ["a", "b", "c", "d", "e", "f"]
    const caller = { user: "alice", teams }
    const held = await Promise.all(teams.map(async teamId => ({ ...as(await app.start(caller, { teamId })), where: { teamId } })))
    const { response, abort } = await app.live(caller, held)
    const events = readEvents(response)
    await opened(events)
    expect(await events.next(100)).toBe("timeout")
    const before = app.parameters.length
    await new Promise(resolve => setTimeout(resolve, 500))
    const statements = app.parameters.length - before
    // About ten checks of one statement each. A check for each store would be about sixty.
    expect(statements).toBeGreaterThan(3)
    expect(statements).toBeLessThan(20)
    abort()
  })

  it("checks the change log on an interval for writes of other processes, and skips other scopes", async () => {
    const app = await setup({ interval: 50, seconds: 30 })
    const held = await app.start(alice)
    // Another services object with its own `db` function stands for another server process: its pushes do not wake
    // this stream.
    const other: SyncServices = { ...app.services, db: () => app.db }
    const { response, abort } = await app.live(alice, [as(held)])
    const events = readEvents(response)
    await opened(events)

    await app.call(new Request("https://app.test/api/_vitehub/sync/notes", {
      method: "POST",
      headers: { "content-type": "application/json", "origin": "https://app.test", "x-user": "carol", "x-teams": "c" },
      body: JSON.stringify({ account: (await app.start(carol)).account, mutations: [{ id: "m1", op: "insert", value: { id: "n1", teamId: "c", body: "Other team" } }] }),
    }), other)
    expect(await events.next(400)).toBe("timeout")

    await app.call(new Request("https://app.test/api/_vitehub/sync/notes", {
      method: "POST",
      headers: { "content-type": "application/json", "origin": "https://app.test", "x-user": "bob", "x-teams": "a" },
      body: JSON.stringify({ account: (await app.start(bob)).account, mutations: [{ id: "m2", op: "insert", value: { id: "n2", teamId: "a", body: "Same team" } }] }),
    }), other)
    const event = await events.next(2000)
    expect(event).toMatchObject({ event: "pull" })
    expect(dataOf<PullData>(event).pull.rows).toEqual([{ id: "n2", teamId: "a", body: "Same team" }])
    abort()
  })

  it("sends a reset when the stream opens for a client without a cursor, and ends after `seconds`", async () => {
    const app = await setup({ interval: 50, seconds: 0.3 })
    await app.db.insert(notes).values({ id: "n1", teamId: "a", body: "There" })
    const started = performance.now()
    const { response } = await app.live(alice)
    const events = readEvents(response)
    await opened(events)
    expect(dataOf<PullData>(await events.next(1000)).pull).toMatchObject({ reset: true, rows: [{ id: "n1" }] })
    expect(await events.next(2000)).toBe("end")
    expect(performance.now() - started).toBeLessThan(1500)
  })

  it("sends bigint columns as text, as a normal pull does", async () => {
    const counters = sqliteTable("counters", { id: text("id").primaryKey(), total: numeric("total", { mode: "bigint" }).notNull() })
    const definition = defineSync({ table: counters, where: () => ({}) })
    const app = await createHarness({ name: "counters", definition, ddl: ["CREATE TABLE `counters` (`id` text PRIMARY KEY NOT NULL, `total` numeric NOT NULL)"], live: { interval: 50, seconds: 1 } })
    await app.db.insert(counters).values({ id: "c1", total: 9007199254740993n })
    expect((await app.pull(null)).body.rows).toEqual([{ id: "c1", total: "9007199254740993" }])
    const { response, abort } = await app.live(null)
    const events = readEvents(response)
    await opened(events)
    expect(dataOf<PullData>(await events.next(1000)).pull.rows).toEqual([{ id: "c1", total: "9007199254740993" }])
    abort()
  })

  it("refuses an entry that the caller may not see, and streams the others", async () => {
    const app = await setup({ interval: 50, seconds: 30 })
    const held = await app.start(alice)
    const writer = await app.start(bob)
    const { response, abort } = await app.live(alice, [
      { where: { teamId: "c" } },
      { where: { body: "x" } },
      { name: "missing" },
      { name: "quiet" },
      as(held),
    ])
    expect(response.status).toBe(200)
    const events = readEvents(response)
    const refused = [await events.next(1000), await events.next(1000), await events.next(1000), await events.next(1000)].map(event => dataOf<ErrorData>(event))
    expect(refused.map(({ name, where, error }) => ({ name, where, code: error.code }))).toEqual([
      { name: "notes", where: { teamId: "c" }, code: "SYNC_OUT_OF_SCOPE" },
      { name: "notes", where: { body: "x" }, code: "SYNC_BAD_REQUEST" },
      { name: "missing", where: undefined, code: "SYNC_BAD_REQUEST" },
      { name: "quiet", where: undefined, code: "SYNC_BAD_REQUEST" },
    ])
    expect(refused[3]!.error.message).toContain("live: false")
    await opened(events)

    await app.push(bob, { ...as(writer), account: writer.account, mutations: [{ id: "m1", op: "insert", value: { id: "n1", teamId: "a", body: "Hello" } }] })
    expect(dataOf<PullData>(await events.next(2000))).toMatchObject({ name: "notes", pull: { rows: [{ id: "n1" }] } })
    abort()
  })

  it("ends the stream when every entry is refused, such as for a caller without a session", async () => {
    const app = await setup({ interval: 50, seconds: 30 })
    const { response } = await app.live(null, [{}, { name: "tasks" }])
    expect(response.status).toBe(200)
    const events = readEvents(response)
    expect([dataOf<ErrorData>(await events.next(1000)), dataOf<ErrorData>(await events.next(1000))].map(({ name, error }) => [name, error.code])).toEqual([["notes", "SYNC_UNAUTHORIZED"], ["tasks", "SYNC_UNAUTHORIZED"]])
    expect(await events.next(1000)).toBe("end")
  })

  it("refuses a request that is not a live request before the stream starts", async () => {
    const app = await setup({ interval: 50, seconds: 1 })
    const url = new URL(syncLiveRoute, origin)
    const get = await app.liveCall(new Request(url))
    expect(get.status).toBe(405)
    expect(get.headers.get("allow")).toBe("POST")
    const json = { "content-type": "application/json", origin, "x-user": "alice", "x-teams": "a" }
    expect((await app.liveCall(new Request(url, { method: "POST", headers: { ...json, origin: "https://evil.test" }, body: JSON.stringify({ pulls: [{ name: "notes" }] }) }))).status).toBe(403)
    expect((await app.liveCall(new Request(url, { method: "POST", headers: { origin }, body: JSON.stringify({ pulls: [{ name: "notes" }] }) }))).status).toBe(415)
    const wrong = await app.liveCall(new Request(url, { method: "POST", headers: json, body: JSON.stringify({ pulls: [{ cursor: 1 }] }) }))
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({ code: "SYNC_BAD_REQUEST" })
  })
})

it("streams a write of server code on the next check of the change log", async () => {
  const app = await setup({ interval: 50, seconds: 30 })
  const held = await app.start(alice)
  const { response, abort } = await app.live(alice, [as(held)])
  const events = readEvents(response)
  await opened(events)
  expect(await events.next(100)).toBe("timeout")

  const started = performance.now()
  await app.db.insert(notes).values({ id: "n1", teamId: "a", body: "From a job" })
  const event = await events.next(2000)
  expect(performance.now() - started).toBeLessThan(1000)
  expect(dataOf<PullData>(event).pull.rows).toEqual([{ id: "n1", teamId: "a", body: "From a job" }])
  abort()
  expect(await events.next(1000)).toBe("end")
})

it("routes the live stream of the installed handler, and wakes it at once after a push to another definition of the table", async () => {
  const app = await setup(undefined)
  // Two definitions of one table in one installed handler, which checks the change log every second and has its own
  // services object, as in a ViteHub app.
  const everyone = defineSync({ table: notes, where: () => ({}), write: false })
  const handler = createSyncHandler({ definitions: { notes: app.definition, everyone }, db: () => app.db, session: app.services.identify! })
  const first = await (await handler.fetch(new Request(new URL("/app/api/_vitehub/sync/everyone", origin), { headers: { "x-user": "alice", "x-teams": "a" } }))).json() as SyncPullResponse
  const controller = new AbortController()
  const response = await handler.fetch(new Request(new URL(`/app${syncLiveRoute}`, origin), {
    method: "POST",
    signal: controller.signal,
    headers: { "content-type": "application/json", origin, "x-user": "alice", "x-teams": "a" },
    body: JSON.stringify({ pulls: [{ name: "everyone", cursor: first.cursor, scope: first.scope.id, version: first.version }] }),
  }))
  expect(response.status).toBe(200)
  const events = readEvents(response)
  await opened(events)
  expect(await events.next(100)).toBe("timeout")

  const held = await (await handler.fetch(new Request(new URL("/app/api/_vitehub/sync/notes", origin), { headers: { "x-user": "bob", "x-teams": "a" } }))).json() as SyncPullResponse
  const started = performance.now()
  const pushed = await handler.fetch(new Request(new URL("/app/api/_vitehub/sync/notes", origin), {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-user": "bob", "x-teams": "a" },
    body: JSON.stringify({ account: held.account, mutations: [{ id: "m1", op: "insert", value: { id: "n1", teamId: "a", body: "Hello" } }] }),
  }))
  expect(pushed.status).toBe(200)
  const event = await events.next(2000)
  expect(performance.now() - started).toBeLessThan(500)
  expect(dataOf<PullData>(event)).toMatchObject({ name: "everyone", pull: { rows: [{ id: "n1", teamId: "a", body: "Hello" }] } })
  controller.abort()
  expect(await events.next(1000)).toBe("end")
})

describe("live deadline", () => {
  async function ends(check: () => Promise<{ again?: boolean }>) {
    const controller = new AbortController()
    const started = performance.now()
    const response = liveResponse({ key: {}, tables: ["deadline"], signal: controller.signal, interval: 50, seconds: 0.2, check })
    const result = await readEvents(response).next(2000)
    const elapsed = performance.now() - started
    controller.abort()
    return { result, elapsed }
  }

  it("ends after `seconds` while it drains a backlog of pages", async () => {
    let checks = 0
    const { result, elapsed } = await ends(async () => {
      checks++
      await new Promise(resolve => setTimeout(resolve, 20))
      return { again: true }
    })
    expect(result).toBe("end")
    expect(elapsed).toBeLessThan(600)
    const after = checks
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(checks).toBe(after)
  })

  it("ends after `seconds` while a check hangs", async () => {
    const { result, elapsed } = await ends(() => new Promise(() => {}))
    expect(result).toBe("end")
    expect(elapsed).toBeLessThan(600)
  })
})
