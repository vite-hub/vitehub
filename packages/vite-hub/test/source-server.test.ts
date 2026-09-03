import { beforeEach, describe, expect, it, vi } from "vitest"

const cache = new Map<string, unknown>()
const defineCachedFunction = vi.fn(
  (reader: (...args: unknown[]) => unknown, options: { name?: string }) => async (...args: unknown[]) => {
    const key = `${options.name}:${JSON.stringify(args)}`
    if (!cache.has(key)) {
      cache.set(key, await reader(...args))
    }
    return cache.get(key)
  },
)

vi.mock("nitro/cache", () => ({ defineCachedFunction }))

const { defineSource } = await import("../src/source/server.ts")

describe("server Source readers", () => {
  beforeEach(() => {
    cache.clear()
    defineCachedFunction.mockClear()
  })

  it("wraps keyed readers with the configured Nitro cache", async () => {
    const reader = {
      cache: { maxAge: 60, name: "uppercase" },
      async get(key: string) {
        return key.toUpperCase()
      },
    }

    const source = defineSource(reader)

    await expect(source.get("news")).resolves.toBe("NEWS")
    expect(defineCachedFunction).toHaveBeenCalledWith(expect.any(Function), {
      maxAge: 60,
      name: "uppercase",
      swr: false,
    })
  })

  it("isolates cached readers by name", async () => {
    const news = defineSource({
      cache: { name: "news" },
      async get(key: string) {
        return `news:${key}`
      },
    })
    const docs = defineSource({
      cache: { name: "docs" },
      async get(key: string) {
        return `docs:${key}`
      },
    })

    await expect(news.get("shared")).resolves.toBe("news:shared")
    await expect(docs.get("shared")).resolves.toBe("docs:shared")
  })

  it("requires a name for cached readers", () => {
    defineSource({
      // @ts-expect-error Cached readers require a stable namespace.
      cache: { maxAge: 60 },
      async get(key: string) {
        return key
      },
    })
  })

  it("leaves readers without cache settings unchanged", () => {
    const reader = {
      async get(key: string) {
        return key
      },
    }

    expect(defineSource(reader)).toBe(reader)
    expect(defineCachedFunction).not.toHaveBeenCalled()
  })

  it("leaves readers with caching disabled unchanged", () => {
    const reader = {
      cache: false as const,
      async get(key: string) {
        return key
      },
    }

    expect(defineSource(reader)).toBe(reader)
    expect(defineCachedFunction).not.toHaveBeenCalled()
  })
})
