import { effectScope, nextTick, ref } from "vue"
import { describe, expect, it, vi } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../src/index.ts"
import { useCollection } from "../src/client.ts"

import type { CollectionPage } from "../src/index.ts"
import type { CollectionRequester, UseCollectionReturn } from "../src/client.ts"

// SAFETY: The fixture loader intentionally returns no rows while retaining its row contract.
const definition = defineCollection(async () => [] as Array<{ id: number }>, {
  cursor: (item: { id: number }) => item.id,
  cursorSchema: v.number(),
  querySchema: v.object({ search: v.optional(v.string()) }),
})

declare global {
  interface ViteHubCollectionMap {
    items: typeof definition
  }
}

interface RequestCall {
  endpoint: string
  options: Parameters<CollectionRequester>[1]
  reject: (error: unknown) => void
  resolve: (value: unknown) => void
}

function controlledRequester() {
  const calls: RequestCall[] = []
  const request: CollectionRequester = (endpoint, options) =>
    new Promise<unknown>((resolve, reject) => {
      const call: RequestCall = { endpoint, options, reject, resolve }
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
      calls.push(call)
    })
  return { calls, request }
}

function page(items: Array<{ id: number }>, nextCursor: string | null): CollectionPage<{ id: number }> {
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
      collection = useCollection("items", {
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

  it("prefixes the generated endpoint with the application base URL", async () => {
    vi.stubGlobal("__VITEHUB_APP_BASE_URL__", "/portal/")
    try {
      const { calls, request } = controlledRequester()
      const scope = effectScope()
      let collection!: UseCollectionReturn<typeof definition>
      scope.run(() => {
        collection = useCollection("items", { immediate: false, request })
      })

      const refresh = collection.refresh()
      expect(calls[0]!.endpoint).toBe("/portal/api/items")
      calls[0]!.resolve(page([], null))
      await refresh
      scope.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each(["", "./", "../", "https://cdn.example.com/", "//cdn.example.com/"])(
    "anchors the non-root-relative application base %j at the deployment root",
    async baseURL => {
      vi.stubGlobal("__VITEHUB_APP_BASE_URL__", baseURL)
      try {
        const { calls, request } = controlledRequester()
        const scope = effectScope()
        let collection!: UseCollectionReturn<typeof definition>
        scope.run(() => {
          collection = useCollection("items", { immediate: false, request })
        })

        const refresh = collection.refresh()
        expect(calls[0]!.endpoint).toBe("/api/items")
        calls[0]!.resolve(page([], null))
        await refresh
        scope.stop()
      } finally {
        vi.unstubAllGlobals()
      }
    },
  )

  it("loads every cursor page with one stable filter", async () => {
    const { calls, request } = controlledRequester()
    const scope = effectScope()
    let collection!: UseCollectionReturn<typeof definition>
    scope.run(() => {
      collection = useCollection("items", {
        all: true,
        filter: { search: "Ada" },
        immediate: false,
        limit: 2,
        request,
      })
    })

    const refresh = collection.refresh()
    expect(calls[0]!.options.query).toEqual({
      cursor: undefined,
      limit: 2,
      search: "Ada",
    })
    calls[0]!.resolve(page([{ id: 1 }, { id: 2 }], "next"))
    await settle()
    expect(collection.items.value).toEqual([])
    expect(calls[1]!.options.query).toEqual({ cursor: "next", limit: 2, search: "Ada" })
    calls[1]!.resolve(page([{ id: 3 }], null))
    await refresh

    expect(collection.items.value).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(collection.hasMore.value).toBe(false)
    scope.stop()
  })

  it("stops an all-pages load when the server repeats a cursor", async () => {
    const { calls, request } = controlledRequester()
    const scope = effectScope()
    let collection!: UseCollectionReturn<typeof definition>
    scope.run(() => {
      collection = useCollection("items", { all: true, immediate: false, request })
    })

    const refresh = collection.refresh()
    calls[0]!.resolve(page([{ id: 1 }], "repeat"))
    await settle()
    calls[1]!.resolve(page([{ id: 2 }], "repeat"))
    await refresh

    expect(collection.items.value).toEqual([])
    expect(collection.error.value).toEqual(new TypeError("[vitehub] Collection returned the same cursor twice."))
    scope.stop()
  })

  it("rejects a cursor that does not advance during loadMore", async () => {
    const { calls, request } = controlledRequester()
    const scope = effectScope()
    let collection!: UseCollectionReturn<typeof definition>
    scope.run(() => {
      collection = useCollection("items", { immediate: false, request })
    })

    const refresh = collection.refresh()
    calls[0]!.resolve(page([{ id: 1 }], "repeat"))
    await refresh

    const loadMore = collection.loadMore()
    expect(calls[1]!.options.query).toMatchObject({ cursor: "repeat" })
    calls[1]!.resolve(page([{ id: 2 }], "repeat"))
    await loadMore

    expect(collection.items.value).toEqual([{ id: 1 }])
    expect(collection.error.value).toEqual(new TypeError("[vitehub] Collection returned the same cursor twice."))
    scope.stop()
  })

  it("retains cursor history across loadMore calls", async () => {
    const { calls, request } = controlledRequester()
    const scope = effectScope()
    let collection!: UseCollectionReturn<typeof definition>
    scope.run(() => {
      collection = useCollection("items", { immediate: false, request })
    })

    const refresh = collection.refresh()
    calls[0]!.resolve(page([{ id: 1 }], "cursor-a"))
    await refresh

    const firstLoadMore = collection.loadMore()
    calls[1]!.resolve(page([{ id: 2 }], "cursor-b"))
    await firstLoadMore
    expect(collection.items.value).toEqual([{ id: 1 }, { id: 2 }])

    const secondLoadMore = collection.loadMore()
    calls[2]!.resolve(page([{ id: 3 }], "cursor-a"))
    await secondLoadMore

    expect(collection.items.value).toEqual([{ id: 1 }, { id: 2 }])
    expect(collection.error.value).toEqual(new TypeError("[vitehub] Collection returned the same cursor twice."))
    scope.stop()
  })

  it("prevents pagination after a failed filter reset", async () => {
    const { calls, request } = controlledRequester()
    const filter = ref({ search: "first" })
    const scope = effectScope()
    let collection!: UseCollectionReturn<typeof definition>
    scope.run(() => {
      collection = useCollection("items", { filter, request })
    })

    calls[0]!.resolve(page([{ id: 1 }], "old-next"))
    await settle()
    filter.value = { search: "second" }
    await nextTick()
    expect(collection.hasMore.value).toBe(false)
    const failure = new Error("filtered request failed")
    calls[1]!.reject(failure)
    await settle()

    expect(collection.items.value).toEqual([{ id: 1 }])
    expect(collection.error.value).toBe(failure)
    await expect(collection.loadMore()).resolves.toBeUndefined()
    expect(calls).toHaveLength(2)
    scope.stop()
  })

  it("refreshes when typed filter input changes and aborts the old request", async () => {
    const { calls, request } = controlledRequester()
    const filter = ref({ search: "first" })
    const scope = effectScope()
    let collection!: UseCollectionReturn<typeof definition>
    scope.run(() => {
      collection = useCollection("items", { filter, request })
    })

    filter.value = { search: "second" }
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
