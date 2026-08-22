import { effectScope, nextTick, ref } from "vue"
import { describe, expect, it } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../src/index.ts"
import { useCollection } from "../src/client.ts"

import type { CollectionPage } from "../src/index.ts"
import type { CollectionRequester, UseCollectionReturn } from "../src/client.ts"

const definition = defineCollection(async () => [] as Array<{ id: number }>, {
  cursor: (item: { id: number }) => item.id,
  cursorSchema: v.number(),
  querySchema: v.object({ search: v.optional(v.string()) }),
})

interface RequestCall {
  endpoint: string
  options: Parameters<CollectionRequester>[1]
  reject: (error: unknown) => void
  resolve: (value: any) => void
}

function controlledRequester() {
  const calls: RequestCall[] = []
  const request = (<T>(endpoint: string, options: Parameters<CollectionRequester>[1]) =>
    new Promise<T>((resolve, reject) => {
      const call: RequestCall = { endpoint, options, reject, resolve }
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      )
      calls.push(call)
    })) as CollectionRequester
  return { calls, request }
}

function page(
  items: Array<{ id: number }>,
  nextCursor: string | null,
): CollectionPage<{ id: number }> {
  return { items, nextCursor }
}

async function settle() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
}

describe("useCollection", () => {
  it("fetches the first page and appends cursor pages", async () => {
    const { calls, request } = controlledRequester()
    const scope = effectScope()
    let collection!: UseCollectionReturn<typeof definition>
    scope.run(() => {
      collection = useCollection<typeof definition>("/api/items", {
        immediate: false,
        limit: 2,
        request,
      })
    })

    const firstRequest = collection.refresh()
    expect(calls[0]).toMatchObject({
      endpoint: "/api/items",
      options: { query: { cursor: undefined, limit: 2 } },
    })
    calls[0]!.resolve(page([{ id: 1 }, { id: 2 }], "next"))
    await firstRequest
    expect(collection.items.value).toEqual([{ id: 1 }, { id: 2 }])
    expect(collection.hasMore.value).toBe(true)

    const nextRequest = collection.loadMore()
    expect(calls[1]!.options.query).toMatchObject({ cursor: "next", limit: 2 })
    calls[1]!.resolve(page([{ id: 3 }], null))
    await nextRequest
    expect(collection.items.value).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(collection.hasMore.value).toBe(false)
    scope.stop()
  })

  it("refreshes when typed query input changes and aborts the old request", async () => {
    const { calls, request } = controlledRequester()
    const query = ref({ search: "first" })
    const scope = effectScope()
    let collection!: UseCollectionReturn<typeof definition>
    scope.run(() => {
      collection = useCollection<typeof definition>("/api/items", { query, request })
    })

    query.value = { search: "second" }
    await nextTick()
    expect(calls[0]!.options.signal.aborted).toBe(true)
    expect(collection.pending.value).toBe(true)
    calls[1]!.resolve(page([{ id: 2 }], null))
    await settle()
    expect(collection.items.value).toEqual([{ id: 2 }])
    expect(collection.error.value).toBeNull()
    scope.stop()
  })
})
