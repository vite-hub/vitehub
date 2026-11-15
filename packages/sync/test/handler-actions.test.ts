import { eq } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"

import { syncChanges, syncMutations } from "../src/database.ts"
import { defineSync } from "../src/define.ts"
import { syncErrors } from "../src/errors.ts"
import { handleSyncRequest } from "../src/runtime.ts"
import { createHarness, readEvents, teamsOf } from "./handler-harness.ts"

import type { SyncMutation } from "../src/protocol.ts"
import type { SyncDefinition } from "../src/types.ts"

const cards = sqliteTable("cards", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  title: text("title").notNull(),
  rating: integer("rating").notNull().default(0),
  reviews: integer("reviews").notNull().default(0),
})

const ddl = "CREATE TABLE `cards` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `title` text NOT NULL, `rating` integer DEFAULT 0 NOT NULL, `reviews` integer DEFAULT 0 NOT NULL)"

const activity = sqliteTable("activity", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  cardId: text("card_id").notNull(),
  by: text("by").notNull(),
  text: text("text").notNull(),
})

const activityDdl = "CREATE TABLE `activity` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `card_id` text NOT NULL, `by` text NOT NULL, `text` text NOT NULL)"

declare global {
  interface ViteHubSyncMap {
    activity: SyncDefinition<typeof activity>
    cards: SyncDefinition<typeof cards>
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function definition(write?: false) {
  return defineSync({
    table: cards,
    where: ({ user }) => user ? { teamId: teamsOf(user) } : false,
    ...(write === false ? { write } : {}),
    actions: {
      /** Rates a card and counts the review. Returns the new average for the caller. */
      rate: async ({ get, update }, { id, rating }: { id: string, rating: number }) => {
        const card = await get(id)
        if (!card) throw new HttpError(404, "No such card.")
        update(id, { rating: card.rating + rating, reviews: card.reviews + 1 })
        return { average: (card.rating + rating) / (card.reviews + 1) }
      },
      /** Splits a card into two: inserts the copies and deletes the card. */
      split: async ({ get, insert, delete: remove }, { id, copies }: { id: string, copies: { teamId: string, title: string }[] }) => {
        const card = await get(id)
        if (!card) throw new HttpError(404, "No such card.")
        const keys = copies.map(copy => insert(copy))
        remove(id)
        return keys
      },
      create: ({ insert }, args: { id: string, title: string }) => {
        insert({ id: args.id, teamId: "a", title: args.title })
      },
      checked: ({ insert }, args: unknown) => {
        const { title } = v.parse(v.object({ title: v.pipe(v.string(), v.minLength(3, "Write at least 3 letters.")) }), args)
        insert({ teamId: "a", title })
      },
      locked: ({ insert, refuse }, { id }: { id: string }) => {
        insert({ id, teamId: "a", title: "never" })
        refuse("The card is locked.")
      },
      broken: () => {
        throw new Error("connect ECONNREFUSED 10.0.0.7:5432")
      },
      diagnostic: () => {
        throw syncErrors.SYNC_NOT_FOUND({ message: "The card is archived." })
      },
      late: ({ insert }) => {
        setTimeout(() => {
          try {
            insert({ teamId: "a", title: "late" })
          }
          catch {
            // The action returned already.
          }
        }, 0)
      },
      nothing: () => () => "a function is not JSON",
    },
  })
}

async function setup(write?: false) {
  const app = await createHarness({ name: "cards", definition: definition(write), ddl: [ddl] })
  const rows = async () => await app.db.select().from(cards).orderBy(cards.title)
  return { ...app, rows }
}

const action = (id: string, name: string, args?: unknown): SyncMutation => ({ id, op: "action", name, args })
const as = (held: { scope: string, version: string, account: string }) => ({ scope: held.scope, version: held.version, account: held.account })
const dave = { user: "dave", teams: ["a", "b"] }

afterEach(() => {
  vi.restoreAllMocks()
})

describe("actions", () => {
  it("applies the writes and returns the result", async () => {
    const app = await setup()
    await app.db.insert(cards).values({ id: "c1", teamId: "a", title: "Card", rating: 4, reviews: 1 })
    const held = await app.start(dave)
    const { body } = await app.push(dave, { ...as(held), cursor: held.cursor, mutations: [action("m1", "rate", { id: "c1", rating: 2 })] })
    expect(body.results).toEqual([{ id: "m1", status: "applied", result: { average: 3 } }])
    expect(body.pull).toMatchObject({ reset: false, rows: [{ id: "c1", rating: 6, reviews: 2 }] })
    // A return value that is not JSON is left out.
    expect((await app.push(dave, { ...as(held), mutations: [action("m2", "nothing")] })).body.results).toEqual([{ id: "m2", status: "applied" }])
  })

  it("applies every write of an action in one batch, or none", async () => {
    const app = await setup()
    await app.db.insert(cards).values({ id: "c1", teamId: "a", title: "Card" })
    const held = await app.start(dave)
    const { body } = await app.push(dave, { ...as(held), cursor: held.cursor, mutations: [action("m1", "split", { id: "c1", copies: [{ teamId: "b", title: "Left" }, { teamId: "b", title: "Right" }] })] })
    expect(body.results[0]).toMatchObject({ id: "m1", status: "applied", result: [expect.any(String), expect.any(String)] })
    expect((await app.rows()).map(row => [row.title, row.teamId])).toEqual([["Left", "b"], ["Right", "b"]])
    expect(body.pull).toMatchObject({ rows: [{ title: "Left" }, { title: "Right" }], deleted: ["c1"] })

    // The second copy goes to a team that Dave is not in: nothing of the action applies, also not the first copy.
    await app.db.insert(cards).values({ id: "c2", teamId: "a", title: "Keep" })
    const before = await app.db.select().from(syncChanges)
    const refused = await app.push(dave, { ...as(held), mutations: [action("m2", "split", { id: "c2", copies: [{ teamId: "a", title: "Fine" }, { teamId: "c", title: "Elsewhere" }] })] })
    expect(refused.body.results).toEqual([{ id: "m2", status: "rejected", error: expect.objectContaining({ code: "SYNC_OUT_OF_SCOPE" }) }])
    expect((await app.rows()).map(row => row.title)).toEqual(["Keep", "Left", "Right"])
    expect(await app.db.select().from(syncChanges)).toEqual(before)
    expect((await app.db.select().from(syncMutations)).map(row => row.id)).toEqual(["m1"])
  })

  it("answers a duplicate of an action with the result of its first run", async () => {
    const app = await setup()
    await app.db.insert(cards).values({ id: "c1", teamId: "a", title: "Card", rating: 4, reviews: 1 })
    const held = await app.start(dave)
    const push = async () => (await app.push(dave, { ...as(held), mutations: [action("m1", "rate", { id: "c1", rating: 2 })] })).body.results
    expect(await push()).toEqual([{ id: "m1", status: "applied", result: { average: 3 } }])
    // The answer was lost, and the client sends the action again.
    expect(await push()).toEqual([{ id: "m1", status: "duplicate", result: { average: 3 } }])
    expect(await app.rows()).toMatchObject([{ rating: 6, reviews: 2 }])
  })

  it("keeps the key that the client passed, and answers a second run of the same id with duplicate", async () => {
    const app = await setup()
    const held = await app.start(dave)
    const first = await app.push(dave, { ...as(held), mutations: [action("m1", "create", { id: "k1", title: "One" })] })
    expect(first.body.results).toEqual([{ id: "m1", status: "applied" }])
    const again = await app.push(dave, { ...as(held), mutations: [action("m1", "create", { id: "k1", title: "One" })] })
    expect(again.body.results).toEqual([{ id: "m1", status: "duplicate" }])
    expect((await app.rows()).map(row => row.id)).toEqual(["k1"])
    // Another id with the same key is a write like any other.
    const exists = await app.push(dave, { ...as(held), mutations: [action("m2", "create", { id: "k1", title: "Two" })] })
    expect(exists.body.results[0]).toMatchObject({ status: "rejected", error: { code: "SYNC_KEY_EXISTS" } })
  })

  it("refuses thrown errors with a message only when it is meant for the caller", async () => {
    const app = await setup()
    const held = await app.start(dave)
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const { body } = await app.push(dave, {
      ...as(held),
      mutations: [
        action("m1", "rate", { id: "nope", rating: 1 }),
        action("m2", "broken"),
        action("m3", "diagnostic"),
        action("m4", "checked", { title: "x" }),
        action("m5", "missing"),
        action("m6", "locked", { id: "k1" }),
      ],
    })
    expect(body.results).toEqual([
      { id: "m1", status: "rejected", error: { code: "SYNC_ACTION_REFUSED", message: "No such card." } },
      { id: "m2", status: "rejected", error: { code: "SYNC_ACTION_REFUSED", message: "The action failed." } },
      { id: "m3", status: "rejected", error: { code: "SYNC_ACTION_REFUSED", message: "The card is archived." } },
      { id: "m4", status: "rejected", error: { code: "SYNC_ACTION_REFUSED", message: "Write at least 3 letters.", issues: [{ path: "title", message: "Write at least 3 letters." }] } },
      { id: "m5", status: "rejected", error: expect.objectContaining({ code: "SYNC_INVALID" }) },
      { id: "m6", status: "rejected", error: { code: "SYNC_ACTION_REFUSED", message: "The card is locked." } },
    ])
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]?.[0])).toContain("\"broken\"")
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED")
    expect(await app.rows()).toEqual([])
    expect(await app.db.select().from(syncMutations)).toEqual([])
  })

  it("runs actions of a read-only definition, and ignores writes after the action returned", async () => {
    const app = await setup(false)
    const held = await app.start(dave)
    const { body } = await app.push(dave, { ...as(held), mutations: [action("m1", "create", { id: "k1", title: "One" }), { id: "m2", op: "insert", value: { id: "k2", teamId: "a", title: "Two" } }, action("m3", "late")] })
    expect(body.results.map(result => result.status === "rejected" ? result.error.code : result.status)).toEqual(["applied", "SYNC_READ_ONLY", "applied"])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect((await app.rows()).map(row => row.id)).toEqual(["k1"])
  })
})

describe("actions across definitions", () => {
  /**
   * Activity rows of the caller's teams, written by the caller. Eve may not see activity. `write` runs `race` once.
   * `readOnly` gives both definitions `write: false`.
   */
  async function crossSetup({ readOnly = false } = {}) {
    let race: (() => Promise<void>) | undefined
    const activityDefinition = defineSync({
      table: activity,
      where: ({ user }) => user && user.id !== "eve" ? { teamId: teamsOf(user), by: user.id } : false,
      schema: v.looseObject({ text: v.pipe(v.string(), v.minLength(2, "Write at least 2 letters.")) }),
      write: readOnly
        ? false
        : async ({ row }) => {
          const run = race
          race = undefined
          await run?.()
          return row.text !== "locked"
        },
    })
    const board = defineSync({
      table: cards,
      where: ({ user }) => user ? { teamId: teamsOf(user) } : false,
      ...(readOnly ? { write: false } : {}),
      actions: {
        /** Moves a card to another team and logs it in the same batch. */
        move: async ({ get, update, sync, refuse }, { id, teamId, noteId, text, by }: { id: string, teamId: string, noteId: string, text: string, by?: string }) => {
          const card = await get(id)
          if (!card) refuse("No such card.")
          update(id, { teamId })
          return sync("activity").insert({ id: noteId, teamId, cardId: id, text, ...(by ? { by } : {}) })
        },
        /** Adds `!` to a note, from the note as the action read it. */
        shout: async ({ sync, refuse }, { id }: { id: string }) => {
          const note = await sync("activity").get(id)
          if (!note) refuse("No such note.")
          else sync("activity").update(id, { text: `${note.text}!` })
        },
        unknown: ({ sync }) => {
          // @ts-expect-error The app has no Sync definition with this name.
          sync("nope").delete("x")
        },
        /** Renames a card through its own definition, by both ways. */
        rename: ({ update, sync }, { id, title }: { id: string, title: string }) => {
          update(id, { title })
          sync("cards").update(id, { reviews: 1 })
        },
        /** Adds a note when the caller sees no note with this key. */
        note: async ({ sync }, { id, cardId }: { id: string, cardId: string }) => {
          if (!await sync("activity").get(id)) sync("activity").insert({ id, teamId: "a", cardId, text: "Once" })
        },
        /** Reads each card and each note of `ids`, and counts the read. */
        bulk: async ({ get, update, sync }, { ids }: { ids: string[] }) => {
          for (const id of ids) {
            const card = await get(id)
            if (card) update(id, { reviews: card.reviews + 1 })
            const note = await sync("activity").get(id)
            if (note) sync("activity").update(id, { text: `${note.text}!` })
          }
        },
      },
    })
    const app = await createHarness({ name: "cards", definition: board, ddl: [ddl, activityDdl], definitions: { cards: board, activity: activityDefinition }, live: { interval: 60_000, seconds: 30 } })
    const pullActivity = async (caller: { user: string, teams: string[] }, query: string) => await handleSyncRequest("activity", activityDefinition, new Request(`https://app.test/api/_vitehub/sync/activity${query}`, { headers: { "x-user": caller.user, "x-teams": caller.teams.join(",") } }), app.services)
    return {
      ...app,
      rows: async () => await app.db.select().from(cards).orderBy(cards.title),
      activity: async () => await app.db.select().from(activity).orderBy(activity.id),
      pullActivity,
      race: (run: () => Promise<void>) => {
        race = run
      },
    }
  }

  it("writes another definition in the same batch, with its `where`, and wakes its live streams", async () => {
    const app = await crossSetup()
    await app.db.insert(cards).values({ id: "c1", teamId: "a", title: "Card" })
    const held = await app.start(dave)
    const first = await (await app.pullActivity(dave, "")).json() as { cursor: number, scope: { id: string }, version: string }
    const stream = await app.pullActivity(dave, `?live&cursor=${first.cursor}&scope=${first.scope.id}&version=${first.version}`)
    const events = readEvents(stream)
    expect(await events.next(50)).toBe("timeout")

    const { body } = await app.push(dave, { ...as(held), cursor: held.cursor, mutations: [action("m1", "move", { id: "c1", teamId: "b", noteId: "n1", text: "Moved to b" })] })
    expect(body.results).toEqual([{ id: "m1", status: "applied", result: "n1" }])
    expect(await app.rows()).toMatchObject([{ id: "c1", teamId: "b" }])
    // `where` of activity stamps `by`, as for a write from the browser.
    expect(await app.activity()).toEqual([{ id: "n1", teamId: "b", cardId: "c1", by: "dave", text: "Moved to b" }])
    expect((await app.db.select().from(syncMutations)).map(row => [row.id, row.name])).toEqual([["m1", "cards"]])
    // The triggers of activity logged the row, so its browsers get it, here at once on the live stream.
    const event = await events.next(2000)
    expect(event).toMatchObject({ event: "pull", data: { pull: { rows: [{ id: "n1", text: "Moved to b" }] } } })
    await events.cancel()
  })

  it("refuses the whole action when the other definition refuses one write", async () => {
    const app = await crossSetup()
    await app.db.insert(cards).values({ id: "c1", teamId: "a", title: "Card" })
    const held = await app.start(dave)
    const before = await app.db.select().from(syncChanges)
    const move = (id: string, teamId: string, text: string, by?: string) => action(id, "move", { id: "c1", teamId, noteId: `n-${id}`, text, by })
    const { body } = await app.push(dave, { ...as(held), mutations: [move("m1", "b", "locked"), move("m2", "b", "x"), move("m3", "b", "As Bob", "bob"), action("m4", "unknown")] })
    expect(body.results).toEqual([
      { id: "m1", status: "rejected", error: expect.objectContaining({ code: "SYNC_FORBIDDEN" }) },
      { id: "m2", status: "rejected", error: expect.objectContaining({ code: "SYNC_INVALID", issues: [{ path: "text", message: "Write at least 2 letters." }] }) },
      // `where` of activity sets `by` to the caller.
      { id: "m3", status: "rejected", error: expect.objectContaining({ code: "SYNC_OUT_OF_SCOPE" }) },
      { id: "m4", status: "rejected", error: expect.objectContaining({ code: "SYNC_ACTION_REFUSED", message: expect.stringContaining("\"nope\"") }) },
    ])
    // Eve may move cards, and `where` of activity refuses her.
    const eve = { user: "eve", teams: ["a", "b"] }
    const eveHeld = await app.start(eve)
    expect((await app.push(eve, { ...as(eveHeld), mutations: [move("m5", "b", "Moved")] })).body.results).toEqual([
      { id: "m5", status: "rejected", error: expect.objectContaining({ code: "SYNC_FORBIDDEN" }) },
    ])
    expect(await app.rows()).toMatchObject([{ id: "c1", teamId: "a" }])
    expect(await app.activity()).toEqual([])
    expect(await app.db.select().from(syncChanges)).toEqual(before)
    expect(await app.db.select().from(syncMutations)).toEqual([])
  })

  it("runs the action again when a write at the same time changed a row of the other definition that it read", async () => {
    const app = await crossSetup()
    await app.db.insert(activity).values({ id: "n1", teamId: "a", cardId: "c1", by: "dave", text: "Hello" })
    const held = await app.start(dave)
    // After the action read the note, and before its batch applies, someone edits the note.
    app.race(async () => {
      await app.db.update(activity).set({ text: "Edited" }).where(eq(activity.id, "n1"))
    })
    const { body } = await app.push(dave, { ...as(held), mutations: [action("m1", "shout", { id: "n1" })] })
    expect(body.results).toEqual([{ id: "m1", status: "applied" }])
    expect(await app.activity()).toMatchObject([{ id: "n1", text: "Edited!" }])
  })

  it("runs the action again when a row that it did not find appears before its batch applies", async () => {
    const app = await crossSetup()
    const held = await app.start(dave)
    app.race(async () => {
      await app.db.insert(activity).values({ id: "n1", teamId: "a", cardId: "c1", by: "dave", text: "Other" })
    })
    const { body } = await app.push(dave, { ...as(held), mutations: [action("m1", "note", { id: "n1", cardId: "c1" })] })
    expect(body.results).toEqual([{ id: "m1", status: "applied" }])
    expect(await app.activity()).toMatchObject([{ id: "n1", text: "Other" }])
  })

  it("refuses a write into another definition with `write: false`, and lets an action write its own read-only table", async () => {
    const app = await crossSetup({ readOnly: true })
    await app.db.insert(cards).values({ id: "c1", teamId: "a", title: "Card" })
    const held = await app.start(dave)
    const { body } = await app.push(dave, { ...as(held), mutations: [action("m1", "move", { id: "c1", teamId: "b", noteId: "n1", text: "Moved" }), action("m2", "rename", { id: "c1", title: "Renamed" })] })
    expect(body.results).toEqual([
      { id: "m1", status: "rejected", error: expect.objectContaining({ code: "SYNC_READ_ONLY" }) },
      { id: "m2", status: "applied" },
    ])
    expect(await app.rows()).toMatchObject([{ id: "c1", teamId: "a", title: "Renamed", reviews: 1 }])
    expect(await app.activity()).toEqual([])
    expect((await app.db.select().from(syncMutations)).map(row => row.id)).toEqual(["m2"])
  })

  it("keeps the guard of many read rows below the D1 limit of 100 parameters", async () => {
    const app = await crossSetup()
    const ids = Array.from({ length: 100 }, (_, index) => `k${index}`)
    await app.db.insert(cards).values(ids.map(id => ({ id, teamId: "a", title: id })))
    await app.db.insert(activity).values(ids.map(id => ({ id, teamId: "b", cardId: id, by: "dave", text: "Hi" })))
    const held = await app.start(dave)
    const start = app.parameters.length
    // 200 rows that are there, and 2 keys of each table that are not.
    const { body } = await app.push(dave, { ...as(held), mutations: [action("m1", "bulk", { ids: [...ids, "gone", "lost"] })] })
    expect(body.results).toEqual([{ id: "m1", status: "applied" }])
    expect((await app.rows()).every(row => row.reviews === 1)).toBe(true)
    expect((await app.activity()).every(row => row.text === "Hi!")).toBe(true)
    expect(Math.max(...app.parameters.slice(start))).toBeLessThanOrEqual(100)
  })
})
