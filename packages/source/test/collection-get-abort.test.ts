import { describe, expect, it, vi } from "vitest"

import { defineCollection } from "../src/index.ts"

interface Item { id: string }

function collectionWith(
  get: (key: string, options: { signal?: AbortSignal }) => Promise<Item | null | undefined>,
  transform: (item: Item) => Item | Promise<Item> = item => item,
) {
  return defineCollection(async () => ({ items: [] as Item[], nextCursor: null }), {
    pagination: "provider",
    get,
    transform,
  })
}

describe("Collection get cancellation", () => {
  it("rejects an aborted lookup before calling the loader", async () => {
    const reason = new Error("cancelled before lookup")
    const get = vi.fn(async () => ({ id: "one" }))
    const collection = collectionWith(get)

    await expect(collection.get("one", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    expect(get).not.toHaveBeenCalled()
  })

  it("rejects a result returned after cancellation without transforming it", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled during lookup")
    const transform = vi.fn((item: Item) => item)
    const collection = collectionWith(async (_key, { signal }) => {
      expect(signal).toBe(controller.signal)
      await Promise.resolve()
      controller.abort(reason)
      return { id: "one" }
    }, transform)

    await expect(collection.get("one", { signal: controller.signal })).rejects.toBe(reason)
    expect(transform).not.toHaveBeenCalled()
  })

  it.each([null, undefined])("rejects a missing result %s returned after cancellation", async (missing) => {
    const controller = new AbortController()
    const reason = new Error("cancelled during lookup")
    const collection = collectionWith(async () => {
      controller.abort(reason)
      return missing
    })

    await expect(collection.get("missing", { signal: controller.signal })).rejects.toBe(reason)
  })

  it("rejects a transform result completed after cancellation", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled during transform")
    const collection = collectionWith(async () => ({ id: "one" }), async item => {
      await Promise.resolve()
      controller.abort(reason)
      return item
    })

    await expect(collection.get("one", { signal: controller.signal })).rejects.toBe(reason)
  })
})
