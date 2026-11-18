import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expectTypeOf, it } from "vitest"

import type { BatchItem } from "drizzle-orm/batch"
import type { RuntimeDrizzleDatabase } from "../src/index.ts"

const events = sqliteTable("events", { name: text("name").notNull() })
declare const db: RuntimeDrizzleDatabase<{ events: typeof events }>

describe("db.batch()", () => {
  it("takes a list of queries that the app builds", async () => {
    const writes: BatchItem<"sqlite">[] = [db.delete(events)]
    writes.push(db.insert(events).values({ name: "signup" }))
    expectTypeOf(await db.batch(writes)).toMatchTypeOf<readonly unknown[]>()

    const reads: readonly BatchItem<"sqlite">[] = [db.select().from(events)]
    expectTypeOf(await db.batch(reads)).toMatchTypeOf<readonly unknown[]>()
  })

  it("types each result of a literal list", async () => {
    const [rows, names] = await db.batch([db.select().from(events), db.select({ name: events.name }).from(events)])
    expectTypeOf(rows).toEqualTypeOf<Array<{ name: string }>>()
    expectTypeOf(names).toEqualTypeOf<Array<{ name: string }>>()
  })
})
