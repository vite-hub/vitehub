import { effectScope, nextTick, ref } from "vue"
import { describe, expect, it } from "vitest"

import { useWorkspaceCollection, useWorkspaceCollectionItem } from "../src/collections/client.ts"

import type { WorkspaceCollectionItem, WorkspaceCollectionPage } from "../src/collections.ts"
import type { UseWorkspaceCollectionItemReturn, UseWorkspaceCollectionReturn, WorkspaceCollectionRequester } from "../src/collections/client.ts"

interface RequestCall {
  endpoint: string
  options: Parameters<WorkspaceCollectionRequester>[1]
  reject: (error: unknown) => void
  resolve: (value: any) => void
}

function controlledRequester() {
  const calls: RequestCall[] = []
  const request = (<T>(endpoint: string, options: Parameters<WorkspaceCollectionRequester>[1]) => new Promise<T>((resolve, reject) => {
    const call: RequestCall = { endpoint, options, reject, resolve }
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
    calls.push(call)
  })) as WorkspaceCollectionRequester
  return { calls, request }
}

function page(items: Array<{ id: number }>, nextCursor: string | null): WorkspaceCollectionPage<{ id: number }> {
  return { digest: "digest", facets: {}, items, nextCursor, total: 3 }
}

async function settle() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
}

describe("Workspace Collection Vue composables", () => {
  it("defers default relative requests during server setup", async () => {
    const scope = effectScope()
    let collection!: UseWorkspaceCollectionReturn<{ id: number }>
    scope.run(() => {
      collection = useWorkspaceCollection("/api/items")
    })
    await settle()
    expect(collection.pending.value).toBe(false)
    expect(collection.error.value).toBeNull()
    scope.stop()
  })

  it("fetches the first page separately and appends cursor pages", async () => {
    const { calls, request } = controlledRequester()
    const scope = effectScope()
    let collection!: UseWorkspaceCollectionReturn<{ id: number }>
    scope.run(() => {
      collection = useWorkspaceCollection("/api/items", { immediate: false, limit: 2, request })
    })

    const firstRequest = collection.refresh()
    expect(calls[0]).toMatchObject({ endpoint: "/api/items", options: { query: { cursor: undefined, limit: 2 } } })
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

    await expect(collection.loadMore()).resolves.toBeUndefined()
    expect(calls).toHaveLength(2)
    scope.stop()
  })

  it("aborts superseded reactive requests without clearing current pending state", async () => {
    const { calls, request } = controlledRequester()
    const query = ref({ search: "first" })
    const scope = effectScope()
    let collection!: UseWorkspaceCollectionReturn<{ id: number }>
    scope.run(() => {
      collection = useWorkspaceCollection("/api/items", { query, request })
    })
    expect(calls).toHaveLength(1)

    query.value = { search: "second" }
    await nextTick()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.options.signal.aborted).toBe(true)
    expect(collection.pending.value).toBe(true)

    calls[1]!.resolve(page([{ id: 2 }], null))
    await settle()
    expect(collection.items.value).toEqual([{ id: 2 }])
    expect(collection.pending.value).toBe(false)
    expect(collection.error.value).toBeNull()
    scope.stop()
  })

  it("replaces items when loadMore encounters a stale cursor", async () => {
    const { calls, request } = controlledRequester()
    const scope = effectScope()
    let collection!: UseWorkspaceCollectionReturn<{ id: number }>
    scope.run(() => {
      collection = useWorkspaceCollection("/api/items", { immediate: false, request })
    })
    const firstRequest = collection.refresh()
    calls[0]!.resolve(page([{ id: 1 }], "stale"))
    await firstRequest

    const moreRequest = collection.loadMore()
    calls[1]!.reject(Object.assign(new Error("stale"), { statusCode: 409 }))
    await settle()
    expect(calls).toHaveLength(3)
    expect(calls[2]!.options.query?.cursor).toBeUndefined()
    calls[2]!.resolve(page([{ id: 10 }, { id: 11 }], null))
    await moreRequest

    expect(collection.items.value).toEqual([{ id: 10 }, { id: 11 }])
    expect(collection.error.value).toBeNull()
    scope.stop()
  })

  it("refreshes item detail reactively and aborts on scope disposal", async () => {
    const { calls, request } = controlledRequester()
    const slug = ref<string | undefined>("alpha")
    const scope = effectScope()
    let item!: UseWorkspaceCollectionItemReturn<{ slug: string }>
    scope.run(() => {
      item = useWorkspaceCollectionItem("/api/items", slug, { request })
    })
    expect(calls[0]!.options.query).toEqual({ value: "alpha" })

    slug.value = "beta"
    await nextTick()
    expect(calls[0]!.options.signal.aborted).toBe(true)
    calls[1]!.resolve({ digest: "digest", item: { slug: "beta" } } satisfies WorkspaceCollectionItem<{ slug: string }>)
    await settle()
    expect(item.data.value).toEqual({ slug: "beta" })

    void item.refresh()
    expect(item.pending.value).toBe(true)
    scope.stop()
    expect(calls[2]!.options.signal.aborted).toBe(true)
    expect(item.pending.value).toBe(false)
  })

  it("clears stale item errors and requests empty-string keys", async () => {
    const { calls, request } = controlledRequester()
    const slug = ref<string | undefined>("missing")
    const scope = effectScope()
    let item!: UseWorkspaceCollectionItemReturn<{ slug: string }>
    scope.run(() => {
      item = useWorkspaceCollectionItem("/api/items", slug, { request })
    })

    calls[0]!.reject(new Error("not found"))
    await settle()
    expect(item.error.value).toBeInstanceOf(Error)

    slug.value = undefined
    await settle()
    expect(item.data.value).toBeNull()
    expect(item.error.value).toBeNull()

    slug.value = ""
    await nextTick()
    expect(calls[1]!.options.query).toEqual({ value: "" })
    scope.stop()
  })
})
