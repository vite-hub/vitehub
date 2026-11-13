import { expectTypeOf, test } from "vitest"

import { createSync } from "../src/client.ts"
import { useSync } from "../src/vue.ts"

import type { SyncDefinition } from "../src/types.ts"

interface Todo { id: string, ownerId: string, title: string, done: boolean }

declare global {
  interface ViteHubSyncMap {
    todos: SyncDefinition<unknown, Todo>
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
