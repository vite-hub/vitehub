import { numeric, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { defineSync } from "../src/define.ts"
import { createSyncHandler, recordSyncChanges } from "../src/runtime.ts"
import { createHarness, readEvents, teamsOf } from "./handler-harness.ts"

import type { SyncPullResponse } from "../src/protocol.ts"
import type { SyncServices } from "../src/runtime.ts"

const notes = sqliteTable("notes", { id: text("id").primaryKey(), teamId: text("team_id").notNull(), body: text("body").notNull() })
const ddl = "CREATE TABLE `notes` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `body` text NOT NULL)"

async function setup(live: SyncServices["live"], options: { live?: boolean } = {}) {
  const definition = defineSync({ table: notes, where: ({ user }) => user ? { teamId: teamsOf(user) } : false, ...options })
  return { ...await createHarness({ name: "notes", definition, ddl: [ddl], live }), definition }
}

const as = (held: { scope: string, version: string, account: string, cursor: number }) => ({ scope: held.scope, version: held.version, account: held.account, cursor: held.cursor })
const alice = { user: "alice", teams: ["a"] }
const bob = { user: "bob", teams: ["a"] }
const carol = { user: "carol", teams: ["c"] }

function pullOf(data: unknown): SyncPullResponse {
  // SAFETY: the data of a `pull` event is `{ pull }`, as `SyncLiveEvent` says.
  return (data as { pull: SyncPullResponse }).pull
}

describe("live", () => {
  it("streams a pull at once when another caller pushes in this process", async () => {
    // A check every minute: only the in-process wake can deliver the event in time.
    const app = await setup({ interval: 60_000, seconds: 30 })
    const held = await app.start(alice)
    const writer = await app.start(bob)
    const { response, abort } = await app.live(alice, as(held))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("x-accel-buffering")).toBe("no")
    const events = readEvents(response)
    // Nothing changed since the cursor of the client, so the stream sends no event when it opens. It sends a comment
    // at once, because Node sends the headers only with the first chunk of the body.
    expect(await events.next(100)).toBe("timeout")
    expect(events.comments).toEqual([": open"])

    const started = performance.now()
    await app.push(bob, { ...as(writer), mutations: [{ id: "m1", op: "insert", value: { id: "n1", teamId: "a", body: "Hello" } }] })
    const event = await events.next(2000)
    const elapsed = performance.now() - started
    expect(event).toMatchObject({ event: "pull" })
    if (typeof event !== "object") throw new Error("No event")
    const pull = pullOf(event.data)
    expect(pull).toMatchObject({ reset: false, rows: [{ id: "n1", body: "Hello" }], deleted: [], account: held.account, version: held.version })
    expect(event.id).toBe(String(pull.cursor))
    expect(elapsed).toBeLessThan(2000)

    abort()
    expect(await events.next(1000)).toBe("end")
  })

  it("checks the change log on an interval for writes of other processes, and skips other scopes", async () => {
    const app = await setup({ interval: 50, seconds: 30 })
    const held = await app.start(alice)
    // Another services object with its own `db` function stands for another server process: its pushes do not wake
    // this stream.
    const other: SyncServices = { ...app.services, db: () => app.db }
    const { response, abort } = await app.live(alice, as(held))
    const events = readEvents(response)

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
    if (typeof event !== "object") throw new Error("No event")
    expect(pullOf(event.data).rows).toEqual([{ id: "n2", teamId: "a", body: "Same team" }])
    abort()
  })

  it("sends a reset when the stream opens for a client without a cursor, and ends after `seconds`", async () => {
    const app = await setup({ interval: 50, seconds: 0.3 })
    await app.db.insert(notes).values({ id: "n1", teamId: "a", body: "There" })
    const started = performance.now()
    const { response } = await app.live(alice)
    const events = readEvents(response)
    const event = await events.next(1000)
    if (typeof event !== "object") throw new Error("No event")
    expect(pullOf(event.data)).toMatchObject({ reset: true, rows: [{ id: "n1" }] })
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
    const event = await readEvents(response).next(1000)
    if (typeof event !== "object") throw new Error(`No event: ${event}`)
    expect(pullOf(event.data).rows).toEqual([{ id: "c1", total: "9007199254740993" }])
    abort()
  })

  it("refuses before the stream starts", async () => {
    const app = await setup({ interval: 50, seconds: 1 })
    const anonymous = await app.live(null)
    expect(anonymous.response.status).toBe(401)
    expect(anonymous.response.headers.get("content-type")).toBe("application/json")
    expect((await app.live(alice, { where: { teamId: "c" } })).response.status).toBe(403)

    const off = await setup({ interval: 50, seconds: 1 }, { live: false })
    const refused = await off.live(alice)
    expect(refused.response.status).toBe(400)
    expect(await refused.response.json()).toMatchObject({ code: "SYNC_BAD_REQUEST" })
    // A normal pull still works.
    expect((await off.pull(alice)).status).toBe(200)
  })
})

it("wakes a stream of the installed handler at once after recordSyncChanges()", async () => {
  const app = await setup(undefined)
  // The installed handler checks the change log every second, and has its own services object, as in a ViteHub app.
  const handler = createSyncHandler({ definitions: { notes: app.definition }, databases: { default: { db: app.db } }, session: app.services.identify! })
  const held = await app.start(alice)
  const controller = new AbortController()
  const url = new URL(`/api/_vitehub/sync/notes?live=1&cursor=${held.cursor}&scope=${held.scope}&version=${held.version}`, "https://app.test")
  const response = await handler.fetch(new Request(url, { signal: controller.signal, headers: { "x-user": "alice", "x-teams": "a" } }))
  expect(response.status).toBe(200)
  const events = readEvents(response)
  expect(await events.next(100)).toBe("timeout")

  const started = performance.now()
  await app.db.insert(notes).values({ id: "n1", teamId: "a", body: "From a job" })
  expect(await recordSyncChanges("notes", { put: ["n1"] })).toEqual([undefined, { recorded: 1 }])
  const event = await events.next(2000)
  expect(performance.now() - started).toBeLessThan(500)
  if (typeof event !== "object") throw new Error("No event")
  expect(pullOf(event.data).rows).toEqual([{ id: "n1", teamId: "a", body: "From a job" }])
  controller.abort()
  expect(await events.next(1000)).toBe("end")
})
