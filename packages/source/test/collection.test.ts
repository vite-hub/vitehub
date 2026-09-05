import { describe, expect, it, vi } from "vitest"

import { combineSources } from "../src/index.ts"

function enumerable<const TKey extends string, TData>(key: TKey, data: TData) {
  return {
    async get(requested: TKey) {
      return { data, key: requested }
    },
    async items() {
      return [{ data, identity: ["reader", key], key, source: "reader" }]
    },
  }
}

describe("combined Sources", () => {
  it("keeps equal Source keys distinct by alias", async () => {
    const collection = combineSources({
      sources: {
        first: enumerable("same", 1),
        second: enumerable("same", 2),
      },
    })

    await expect(collection.items()).resolves.toEqual([
      { data: 1, identity: ["first", "same"], key: "same", source: "first" },
      { data: 2, identity: ["second", "same"], key: "same", source: "second" },
    ])
    await expect(collection.get(["second", "same"])).resolves.toEqual({ data: 2, key: "same" })
  })

  it("supports get-only readers and validates Collection failures", async () => {
    const keyed = {
      async get(key: string) {
        return key.toUpperCase()
      },
    }
    const collection = combineSources({ sources: { keyed } })

    await expect(collection.get(["keyed", "july"])).resolves.toBe("JULY")
    expect(collection).not.toHaveProperty("items")
    // SAFETY: The test deliberately supplies a missing alias to exercise runtime validation.
    const missingIdentity = ["missing" as "keyed", "july"] as const
    await expect(collection.get(missingIdentity)).rejects.toThrow('Combined Source alias "missing" is not defined')
    // SAFETY: The test deliberately supplies the pre-tuple legacy shape to exercise runtime validation.
    await expect(collection.get("keyed:july" as never)).rejects.toMatchObject({
      code: "SOURCE_R0010",
      message: "[vitehub] Combined Source identity must be a [source, key] string tuple.",
    })
  })

  it("omits enumeration when any reader only supports get", async () => {
    const items = vi.fn(async () => [{ key: "one" }])
    const collection = combineSources({
      sources: {
        enumerable: {
          async get(key: string) {
            return key
          },
          items,
        },
        keyed: {
          async get(key: string) {
            return key
          },
        },
      },
    })

    expect(collection).not.toHaveProperty("items")
    await expect(collection.get(["enumerable", "one"])).resolves.toBe("one")
    await expect(collection.get(["keyed", "two"])).resolves.toBe("two")
    expect(items).not.toHaveBeenCalled()
  })
})
