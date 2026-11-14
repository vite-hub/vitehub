import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { expectTypeOf, it } from "vitest"

import { defineSync } from "../src/index.ts"

import type { InferSyncRow, SyncRowOf } from "../src/index.ts"

const todos = sqliteTable("todos", { id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), done: integer("done", { mode: "boolean" }).notNull() })

it("infers the row from the table", () => {
  const definition = defineSync({
    table: todos,
    where: ({ user }) => user ? { ownerId: user.id } : false,
    write: ({ row }) => {
      expectTypeOf(row.done).toEqualTypeOf<boolean>()
      return true
    },
  })
  expectTypeOf<InferSyncRow<typeof definition>>().toEqualTypeOf<{ id: string, ownerId: string, done: boolean }>()
  // @ts-expect-error `where` returns column values of the table.
  defineSync({ table: todos, where: () => ({ owner: "x" }) })
  expectTypeOf<SyncRowOf<"unknown">>().toEqualTypeOf<Record<string, unknown>>()
})
