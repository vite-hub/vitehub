import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { expectTypeOf, it } from "vitest"

import { defineSync } from "../src/index.ts"

import type { InferSyncActions, InferSyncRow, SyncRowOf } from "../src/index.ts"

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

it("infers the arguments of each action from its annotation", () => {
  const definition = defineSync({
    table: todos,
    where: () => ({ ownerId: ["a", "b"] }),
    actions: {
      complete: async ({ get, update, user }, { id }: { id: string }) => {
        expectTypeOf(user?.id).toEqualTypeOf<string | undefined>()
        const row = await get(id)
        expectTypeOf(row).toEqualTypeOf<{ id: string, ownerId: string, done: boolean } | undefined>()
        update(id, { done: true })
        return { done: true }
      },
      add: ({ insert }, { ownerId }: { ownerId: string }) => insert({ ownerId, done: false }),
    },
  })
  expectTypeOf<InferSyncActions<typeof definition>>().toEqualTypeOf<{ complete: { id: string }, add: { ownerId: string } }>()
  defineSync({
    table: todos,
    where: () => ({}),
    // @ts-expect-error `update` takes columns of the table.
    actions: { wrong: ({ update }, { id }: { id: string }) => update(id, { color: "red" }) },
  })
})
