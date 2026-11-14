import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"

import { syncChanges, syncMutations } from "../src/database.ts"
import { defineSync } from "../src/define.ts"
import { syncErrors } from "../src/errors.ts"
import { createHarness, teamsOf } from "./handler-harness.ts"

import type { SyncMutation } from "../src/protocol.ts"

const cards = sqliteTable("cards", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  title: text("title").notNull(),
  rating: integer("rating").notNull().default(0),
  reviews: integer("reviews").notNull().default(0),
})

const ddl = "CREATE TABLE `cards` (`id` text PRIMARY KEY NOT NULL, `team_id` text NOT NULL, `title` text NOT NULL, `rating` integer DEFAULT 0 NOT NULL, `reviews` integer DEFAULT 0 NOT NULL)"

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
