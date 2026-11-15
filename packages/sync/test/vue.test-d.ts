import { expectTypeOf, test } from "vitest"
import { ref } from "vue"

import { createSync } from "../src/client.ts"
import { useSync } from "../src/vue.ts"

import type { SyncWrite } from "../src/client.ts"
import type { SyncDefinition } from "../src/types.ts"

interface Todo { id: string, ownerId: string, title: string, done: boolean, listId?: string, teamId?: string }

declare global {
  interface ViteHubSyncMap {
    todos: SyncDefinition<unknown, Todo, { complete: { id: string }, add: { id?: string, title: string } }>
    meetings: SyncDefinition<unknown, { id: string, at: Date, count: bigint }>
    comments: SyncDefinition<unknown, { id: string, issueId: string, body: string }, Record<string, never>, "issueId">
    memos: SyncDefinition<unknown, { id: string, body: string }, Record<string, never>, never>
  }
}

test("useSync() and createSync() type the rows from the Sync map", () => {
  const todos = useSync("todos")
  expectTypeOf(todos.rows).toEqualTypeOf<readonly Todo[]>()
  expectTypeOf(todos.get("a")).toEqualTypeOf<Todo | undefined>()
  expectTypeOf(todos.insert).parameter(0).toEqualTypeOf<Partial<Todo>>()
  expectTypeOf(todos.update).parameter(1).toEqualTypeOf<Partial<Todo>>()
  expectTypeOf(createSync("todos").getState().rows).toEqualTypeOf<readonly Todo[]>()
  // @ts-expect-error The app has no Sync definition with this name.
  useSync("notes")
})

test("useSync() and createSync() type rows, inserts and updates as JSON, so a Date or a bigint column is text", () => {
  const meetings = useSync("meetings")
  expectTypeOf(meetings.rows).toEqualTypeOf<readonly { id: string, at: string, count: string }[]>()
  meetings.insert({ at: "2026-11-14T10:00:00.000Z", count: "1" })
  // @ts-expect-error The browser sends JSON, so a Date column takes text.
  meetings.insert({ at: new Date() })
  // @ts-expect-error The browser sends JSON, so a bigint column takes text.
  createSync("meetings").update("a", { count: 1n })
})

test("useSync() and createSync() take only the `subsets` columns in `where`", () => {
  useSync("comments", { where: () => ({ issueId: "i1" }) })
  createSync("comments", { where: { issueId: "i1" } })
  // @ts-expect-error `body` is not in `subsets`.
  useSync("comments", { where: { body: "x" } })
  // @ts-expect-error `body` is not in `subsets`.
  createSync("comments", { where: { body: "x" } })
  // @ts-expect-error A subset value has the type of its column.
  createSync("comments", { where: { issueId: 1 } })
  useSync("memos")
  // @ts-expect-error A definition without `subsets` takes no subset.
  createSync("memos", { where: { body: "x" } })
  // @ts-expect-error A definition without `subsets` takes no subset.
  useSync("memos", { where: () => ({ body: "x" }) })
})

test("useSync() and createSync() type the subset, the actions and their optimistic functions", () => {
  const todos = useSync("todos", {
    where: () => ({ listId: "l1" }),
    actions: {
      complete: (local, { id }) => {
        expectTypeOf(local.get(id)).toEqualTypeOf<Todo | undefined>()
        local.update(id, { done: true })
      },
    },
  })
  expectTypeOf(todos.actions.complete).parameter(0).toEqualTypeOf<{ id: string }>()
  expectTypeOf(todos.actions.complete({ id: "a" })).toEqualTypeOf<SyncWrite<unknown>>()
  expectTypeOf(todos.pending).toEqualTypeOf<(key: string) => boolean>()
  expectTypeOf(todos.live).toEqualTypeOf<boolean>()
  // @ts-expect-error The definition has no action with this name.
  todos.actions.archive({})
  // @ts-expect-error The arguments of `complete` have an `id`.
  todos.actions.complete({ key: "a" })
  useSync("todos", { where: ref({ listId: "l1" }) })
  // @ts-expect-error A subset sets columns of the table.
  useSync("todos", { where: { nope: 1 } })
  expectTypeOf(createSync("todos", { where: { listId: "l1" } }).actions.add).parameter(0).toEqualTypeOf<{ id?: string, title: string }>()
})
