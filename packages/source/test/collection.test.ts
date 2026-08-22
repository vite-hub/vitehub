import { describe, expect, it, vi } from "vitest"

import { combineSources, createSource, defineSource } from "../src/index.ts"

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

  it("supports keyed context Sources and validates Collection failures", async () => {
    const definition = defineSource(context => ({
      async get(key: string) {
        return `${context.rootDir}:${key.toUpperCase()}`
      },
    }))
    const keyed = createSource(definition, { rootDir: "/recaps" })
    const collection = combineSources({ sources: { keyed } })

    await expect(collection.get(["keyed", "july"])).resolves.toBe("/recaps:JULY")
    await expect(collection.items()).rejects.toMatchObject({
      code: "SOURCE_FAILED",
      name: "ViteHubError",
    })
    // SAFETY: The test deliberately supplies a missing alias to exercise runtime validation.
    const missingIdentity = ["missing" as "keyed", "july"] as const
    await expect(collection.get(missingIdentity)).rejects.toThrow('Combined Source alias "missing" is not defined')
    // SAFETY: The test deliberately supplies the pre-tuple legacy shape to exercise runtime validation.
    await expect(collection.get("keyed:july" as never)).rejects.toBeInstanceOf(TypeError)
  })

  it("rejects non-enumerable Collections before reading any Source", async () => {
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

    await expect(collection.items()).rejects.toThrow('Combined Source alias "keyed" is not enumerable')
    expect(items).not.toHaveBeenCalled()
  })
})
