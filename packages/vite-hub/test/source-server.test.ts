import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"

const cache = new Map<string, unknown>()
let cacheModuleLoads = 0
const defineCachedFunction = vi.fn(
  (reader: (...args: unknown[]) => unknown, options: { name?: string }) => async (...args: unknown[]) => {
    const key = `${options.name}:${JSON.stringify(args)}`
    if (!cache.has(key)) {
      cache.set(key, await reader(...args))
    }
    return cache.get(key)
  },
)

vi.mock("nitro/cache", () => {
  cacheModuleLoads += 1
  return { defineCachedFunction }
})

const { cachedSource } = await import("../src/source/server.ts")

describe("cached Source readers", () => {
  beforeEach(() => {
    cache.clear()
    defineCachedFunction.mockClear()
  })

  it("loads Nitro cache only on the first get", async () => {
    expect(cacheModuleLoads).toBe(0)

    const source = cachedSource({
      async get(key: string) {
        return key
      },
      async items() {
        return [{ key: "news" }]
      },
    }, { name: "lazy" })
    await expect(source.items()).resolves.toEqual([{ key: "news" }])
    expect(cacheModuleLoads).toBe(0)

    await expect(source.get("news")).resolves.toBe("news")
    expect(cacheModuleLoads).toBe(1)
  })

  it("caches keyed retrieval with the configured Nitro options", async () => {
    const get = vi.fn(async (key: string) => key.toUpperCase())
    const source = cachedSource({
      async get(key: string) {
        return get(key)
      },
    }, { maxAge: 60, name: "uppercase" })

    await expect(source.get("news")).resolves.toBe("NEWS")
    await expect(source.get("news")).resolves.toBe("NEWS")
    expect(get).toHaveBeenCalledTimes(1)
    expect(defineCachedFunction).toHaveBeenCalledTimes(1)
    expect(defineCachedFunction).toHaveBeenCalledWith(expect.any(Function), {
      maxAge: 60,
      name: "uppercase",
      swr: false,
    })
  })

  it("isolates cached readers by name", async () => {
    const news = cachedSource({
      async get(key: string) {
        return `news:${key}`
      },
    }, { name: "news" })
    const docs = cachedSource({
      async get(key: string) {
        return `docs:${key}`
      },
    }, { name: "docs" })

    await expect(news.get("shared")).resolves.toBe("news:shared")
    await expect(docs.get("shared")).resolves.toBe("docs:shared")
  })

  it("keeps get bound to the original reader and preserves other operations", async () => {
    const reader = {
      prefix: "news",
      async get(key: "today" | "yesterday") {
        expect(this).toBe(reader)
        return `${this.prefix}:${key}`
      },
      async items() {
        return [{ key: "today" as const }]
      },
    }
    const source = cachedSource(reader, { name: "bound" })

    expectTypeOf(source).toEqualTypeOf(reader)
    expect(source.prefix).toBe("news")
    await expect(source.get("today")).resolves.toBe("news:today")
    await expect(source.items()).resolves.toEqual([{ key: "today" }])
  })

  it("preserves prototype methods and accessors that use private state", async () => {
    class Reader {
      #prefix = "news"

      get prefix() {
        return this.#prefix
      }

      set prefix(value: string) {
        this.#prefix = value
      }

      async get(key: string) {
        return `${this.#prefix}:${key}`
      }

      async items() {
        return [{ key: this.#prefix }]
      }
    }

    const reader = new Reader()
    const source = cachedSource(reader, { name: "class" })

    expect(source).toBeInstanceOf(Reader)
    expect(source.prefix).toBe("news")
    source.prefix = "docs"
    expect(reader.prefix).toBe("docs")
    await expect(source.get("today")).resolves.toBe("docs:today")
    await expect(source.items()).resolves.toEqual([{ key: "docs" }])
  })

  it("wraps frozen readers and preserves their enumerable properties", async () => {
    const get = vi.fn(async (key: string) => key.toUpperCase())
    const reader = Object.freeze({
      name: "frozen",
      async get(key: string) {
        expect(this).toBe(reader)
        return get(key)
      },
      async items() {
        expect(this).toBe(reader)
        return [{ key: this.name }]
      },
    })
    const source = cachedSource(reader, { name: "frozen" })

    await expect(source.get("news")).resolves.toBe("NEWS")
    await expect(source.get("news")).resolves.toBe("NEWS")
    await expect(source.items()).resolves.toEqual([{ key: "frozen" }])
    expect(Object.keys(source)).toEqual(Object.keys(reader))

    const copy = { ...source }
    expect(copy.name).toBe("frozen")
    await expect(copy.get("news")).resolves.toBe("NEWS")
    await expect(copy.items()).resolves.toEqual([{ key: "frozen" }])
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("uses explicit options regardless of a reader's cache field", async () => {
    const source = cachedSource({
      cache: { name: "reader-owned", swr: false },
      async get(key: string) {
        return key
      },
    }, { name: "explicit", swr: true })

    await expect(source.get("news")).resolves.toBe("news")
    expect(source.cache.name).toBe("reader-owned")
    expect(defineCachedFunction).toHaveBeenCalledWith(expect.any(Function), {
      name: "explicit",
      swr: true,
    })
  })

  it("requires a name and infers cache callback types from the reader", () => {
    const reader = {
      async get(key: "today" | "yesterday") {
        return { title: key }
      },
    }

    // @ts-expect-error Cached readers require a stable namespace.
    cachedSource(reader, { maxAge: 60 })
    cachedSource(reader, {
      name: "typed",
      getKey(key) {
        expectTypeOf(key).toEqualTypeOf<"today" | "yesterday">()
        return key
      },
      validate(entry) {
        expectTypeOf(entry.value).toEqualTypeOf<{ title: "today" | "yesterday" } | undefined>()
        return Boolean(entry.value)
      },
    })
  })

  it("rejects retrieval signatures that cannot share one cache callback contract", () => {
    const generic = {
      async get<TKey extends string>(key: TKey) {
        return key
      },
    }
    // @ts-expect-error A generic result cannot be represented by one cache entry type.
    cachedSource(generic, { name: "generic" })

    function get(key: "news"): Promise<number>
    function get(key: "docs"): Promise<string>
    async function get(key: "news" | "docs"): Promise<number | string> {
      return key === "news" ? 1 : "docs"
    }
    // @ts-expect-error Cache callbacks cannot infer all overload key and result pairs.
    cachedSource({ get }, { name: "overloaded" })

    const options = {
      async get(key: string, uppercase = false) {
        return uppercase ? key.toUpperCase() : key
      },
    }
    // @ts-expect-error Only a single key can determine a cached result.
    cachedSource(options, { name: "extra-options" })
  })
})
