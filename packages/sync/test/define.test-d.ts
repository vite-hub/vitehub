import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { expectTypeOf, it } from "vitest"

import { defineSync } from "../src/index.ts"

import type { InferSyncActions, InferSyncRow, InferSyncSubsets, SyncDefinition, SyncJsonRow, SyncRowOf } from "../src/index.ts"

const todos = sqliteTable("todos", { id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), done: integer("done", { mode: "boolean" }).notNull() })

const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  at: integer("at", { mode: "timestamp" }).notNull(),
  endsAt: integer("ends_at", { mode: "timestamp_ms" }),
  count: blob("count", { mode: "bigint" }).notNull(),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
  done: integer("done", { mode: "boolean" }).notNull(),
})

declare global {
  interface ViteHubSyncMap {
    events: SyncDefinition<typeof events>
  }
}

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

it("infers the columns of `subsets`, and refuses a name that is not a column", () => {
  const listed = defineSync({ table: todos, where: () => ({}), subsets: ["ownerId"] })
  expectTypeOf<InferSyncSubsets<typeof listed>>().toEqualTypeOf<"ownerId">()
  const none = defineSync({ table: todos, where: () => ({}) })
  expectTypeOf<InferSyncSubsets<typeof none>>().toEqualTypeOf<never>()
  // @ts-expect-error `subsets` has column names of the table.
  defineSync({ table: todos, where: () => ({}), subsets: ["owner"] })
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

it("types the browser row as JSON: a Date and a bigint arrive as text", () => {
  interface EventJson { id: string, at: string, endsAt: string | null, count: string, tags: string[], done: boolean }
  expectTypeOf<SyncJsonRow<typeof events.$inferSelect>>().toEqualTypeOf<EventJson>()
  expectTypeOf<SyncRowOf<"events">>().toEqualTypeOf<EventJson>()
})

it("types the rows of another definition in an action from the Sync map", () => {
  defineSync({
    table: todos,
    where: () => ({}),
    actions: {
      log: async ({ sync }, { id }: { id: string }) => {
        const others = sync("events")
        const event = await others.get(id)
        // Server code gets the Drizzle row, so a timestamp is a Date.
        expectTypeOf(event).toEqualTypeOf<typeof events.$inferSelect | undefined>()
        expectTypeOf(others.insert({ at: new Date(), count: 1n, tags: [], done: false })).toEqualTypeOf<string>()
        // @ts-expect-error The rows of events have no `title`.
        others.update(id, { title: "x" })
        // @ts-expect-error The app has no Sync definition with this name.
        sync("notes")
      },
    },
  })
})

const issues = sqliteTable("issues", { id: text("id").primaryKey(), title: text("title").notNull() })
const comments = sqliteTable("comments", { id: text("id").primaryKey(), issueId: text("issue_id").notNull(), body: text("body").notNull() })

// Two definitions whose actions write each other, as two files of `server/sync/` in the generated map.
const issuesSync = defineSync({
  table: issues,
  where: () => ({}),
  actions: {
    open: ({ insert, sync }, { title, body }: { title: string, body: string }) => {
      const id = insert({ title })
      sync("cycleComments").insert({ issueId: id, body })
      return id
    },
  },
})
const commentsSync = defineSync({
  table: comments,
  where: () => ({}),
  actions: {
    rename: ({ sync }, { issueId, title }: { issueId: string, title: string }) => sync("cycleIssues").update(issueId, { title }),
  },
})

declare global {
  interface ViteHubSyncMap {
    cycleIssues: typeof issuesSync
    cycleComments: typeof commentsSync
  }
}

it("types two definitions whose actions write each other", () => {
  expectTypeOf<InferSyncActions<typeof issuesSync>>().toEqualTypeOf<{ open: { title: string, body: string } }>()
  expectTypeOf<SyncRowOf<"cycleComments">>().toEqualTypeOf<{ id: string, issueId: string, body: string }>()
})
