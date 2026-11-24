import { clearActiveCloudflareEnv, runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { describe, expect, it, vi } from "vitest"

import { createCloudflareKVStorage } from "../src/runtime/cloudflare-kv.ts"
import type { RuntimeStorage } from "../src/runtime/hosted-storage.ts"

function createNamespace() {
  const values = new Map<string, string>()
  return {
    values,
    delete: async (key: string) => { values.delete(key) },
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value) },
    list: async ({ prefix = "" }: { prefix?: string, cursor?: string }) => ({
      keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
    }),
  }
}

describe("Cloudflare KV binding", () => {
  it("reads the binding from the request-scoped Cloudflare env without a global env", async () => {
    expect((globalThis as { __env__?: unknown }).__env__).toBeUndefined()
    // SAFETY: The Cloudflare storage factory supplies the RuntimeStorage read, write, and list methods.
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage
    const first = createNamespace()
    const second = createNamespace()

    await runWithActiveCloudflareEnv({ KV: first }, () => storage.setItem("smoke", "first"))
    await runWithActiveCloudflareEnv({ KV: second }, () => storage.setItem("smoke", "second"))

    expect(first.values.get("smoke")).toBe("first")
    expect(second.values.get("smoke")).toBe("second")
    await expect(runWithActiveCloudflareEnv({ KV: first }, () => storage.listKeys({ limit: 10 }))).resolves.toEqual({ keys: ["smoke"] })
  })

  it("keeps continuation namespaces stable when request bindings are recreated", async () => {
    const storage = createCloudflareKVStorage({ binding: "KV", namespaceId: "stable-id", driver: "cloudflare" }) as RuntimeStorage
    const cursors: Array<string | undefined> = []
    const createPagedNamespace = () => {
      const namespace = createNamespace()
      namespace.list = async ({ cursor }: { cursor?: string }) => {
        cursors.push(cursor)
        return { cursor: cursor ? undefined : "next", keys: [], list_complete: cursor !== undefined }
      }
      return namespace
    }
    const first = createPagedNamespace()
    const second = createPagedNamespace()

    const page = await runWithActiveCloudflareEnv({ KV: first }, () => storage.listKeys({ limit: 1 }))
    await expect(runWithActiveCloudflareEnv({ KV: second }, () => storage.listKeys({ cursor: page.cursor, limit: 1 }))).resolves.toEqual({ keys: [] })
    expect(cursors).toEqual([undefined, "next"])
  })

  it("finds the binding after the Nitro middleware installs the request's env", async () => {
    const { default: middleware } = await import("../src/runtime/cloudflare-request-env.ts")
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage
    const namespace = createNamespace()

    try {
      await runWithActiveCloudflareEnv(undefined, async () => {
        middleware({ req: { runtime: { cloudflare: { env: { KV: namespace } } } } })
        await storage.setItem("theme", "dark")
        middleware({ req: { runtime: { name: "node" } } })
        await expect(storage.getItem("theme")).resolves.toBe("dark")
      })
      expect(namespace.values.get("theme")).toBe("dark")
    }
    finally {
      clearActiveCloudflareEnv()
    }
  })

  it("reports a missing binding outside a Cloudflare request", async () => {
    // SAFETY: The Cloudflare storage factory supplies the RuntimeStorage read, write, and list methods.
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage

    await expect(storage.getItem("smoke")).rejects.toThrow("Invalid binding `KV`")
  })

  it("rejects a continuation resumed against a different request binding", async () => {
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage
    const first = createNamespace()
    first.list = async () => ({ cursor: "next", keys: [], list_complete: false })
    const second = createNamespace()
    second.list = async () => ({ cursor: "done", keys: [], list_complete: true })

    const page = await runWithActiveCloudflareEnv({ KV: first }, () => storage.listKeys({ limit: 1 }))
    await expect(runWithActiveCloudflareEnv({ KV: second }, () => storage.listKeys({ cursor: page.cursor, limit: 1 }))).rejects.toThrow(
      "belongs to a different storage backend",
    )
  })

  it("rejects an incomplete page without a cursor", async () => {
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage
    const namespace = createNamespace()
    namespace.list = async () => ({ keys: [{ name: "smoke" }], list_complete: false })

    await expect(runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ limit: 10 }))).rejects.toThrow(
      "Cloudflare KV list returned an invalid page.",
    )
  })

  it("rejects an incomplete page whose cursor does not advance", async () => {
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage
    const namespace = createNamespace()
    namespace.list = async ({ cursor }: { prefix?: string, cursor?: string }) => ({
      cursor: cursor || "next",
      keys: [{ name: "smoke" }],
      list_complete: false,
    })

    const first = await runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ limit: 10 }))
    await expect(runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ cursor: first.cursor, limit: 10 }))).rejects.toThrow(
      "ViteHub rejected a repeated pagination cursor.",
    )
  })

  it("rejects a provider cursor echoed on a raw-cursor resume", async () => {
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage
    const namespace = createNamespace()
    namespace.list = async ({ cursor }: { prefix?: string, cursor?: string }) => ({
      cursor,
      keys: [{ name: "smoke" }],
      list_complete: false,
    })

    await expect(runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ cursor: "vhc:provider-cursor", limit: 1 }))).rejects.toThrow(
      "repeated pagination cursor",
    )
  })

  it("rejects a prior provider cursor after resuming on another instance", async () => {
    const firstStorage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage
    const secondStorage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage
    const namespace = createNamespace()
    const suppliedCursors: Array<string | undefined> = []
    namespace.list = async ({ cursor }: { prefix?: string, cursor?: string }) => {
      suppliedCursors.push(cursor)
      return { cursor: cursor === "first" ? "second" : "first", keys: [{ name: "smoke" }], list_complete: false }
    }

    const first = await runWithActiveCloudflareEnv({ KV: namespace }, () => firstStorage.listKeys({ limit: 1 }))
    const second = await runWithActiveCloudflareEnv({ KV: namespace }, () => firstStorage.listKeys({ cursor: first.cursor, limit: 1 }))
    await expect(runWithActiveCloudflareEnv({ KV: namespace }, () => secondStorage.listKeys({ cursor: second.cursor, limit: 1 }))).rejects.toThrow(
      "repeated pagination cursor",
    )
    expect(suppliedCursors).toEqual([undefined, "first", "second"])
  })

  it("pages past 1,024 pages and still rejects a recent repeated cursor", async () => {
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage
    const namespace = createNamespace()
    const keys = Array.from({ length: 1_100 }, (_, index) => `key-${String(index).padStart(4, "0")}`)
    namespace.list = async ({ cursor }: { prefix?: string, cursor?: string }) => {
      const start = cursor ? Number(cursor) : 0
      return start + 1 < keys.length
        ? { cursor: String(start + 1), keys: [{ name: keys[start]! }], list_complete: false }
        : { keys: [{ name: keys[start]! }], list_complete: true }
    }
    const listed: string[] = []
    let cursor: string | undefined
    do {
      const page = await runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ cursor, limit: 1 }))
      listed.push(...page.keys)
      cursor = page.cursor
    } while (cursor)
    expect(listed).toEqual(keys)

    namespace.list = async ({ cursor }: { prefix?: string, cursor?: string }) => ({ cursor: cursor === "a" ? "b" : "a", keys: [], list_complete: false })
    const first = await runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ limit: 1 }))
    const second = await runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ cursor: first.cursor, limit: 1 }))
    cursor = second.cursor
    await expect(runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ cursor, limit: 1 }))).rejects.toThrow(
      "repeated pagination cursor",
    )
  })

  it("clears a namespace that takes more than 1,024 list pages", async () => {
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage
    const namespace = createNamespace()
    for (let index = 0; index < 1_100; index++) namespace.values.set(`key-${String(index).padStart(4, "0")}`, "x")
    namespace.list = async ({ cursor, prefix = "" }: { prefix?: string, cursor?: string }) => {
      const keys = [...namespace.values.keys()].filter(key => key.startsWith(prefix)).sort()
      const start = cursor ? keys.findIndex(key => key > cursor) : 0
      if (start === -1) return { keys: [], list_complete: true }
      return start + 1 < keys.length
        ? { cursor: keys[start]!, keys: [{ name: keys[start]! }], list_complete: false }
        : { keys: [{ name: keys[start]! }], list_complete: true }
    }

    await runWithActiveCloudflareEnv({ KV: namespace }, () => storage.clear())
    expect(namespace.values.size).toBe(0)
  })
})

describe("Cloudflare KV cursors across isolates", () => {
  function createPagedNamespace(keys: string[]) {
    const namespace = createNamespace()
    namespace.list = async ({ cursor, limit = 1_000 }: { cursor?: string, limit?: number }) => {
      const start = cursor === undefined ? 0 : Number(/^cf-(\d+)$/.exec(cursor)?.[1] ?? Number.NaN)
      if (Number.isNaN(start)) throw new Error("Invalid cursor.")
      const end = start + limit
      return end < keys.length
        ? { cursor: `cf-${end}`, keys: keys.slice(start, end).map(name => ({ name })), list_complete: false }
        : { keys: keys.slice(start).map(name => ({ name })), list_complete: true }
    }
    return namespace
  }

  it("resumes a cursor in a fresh module instance", async () => {
    const binding = createPagedNamespace(["a", "b", "c"])
    const first = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage
    const page = await runWithActiveCloudflareEnv({ KV: binding }, () => first.listKeys({ limit: 1 }))
    expect(page).toMatchObject({ keys: ["a"], cursor: expect.stringMatching(/^vhc1:/) })

    vi.resetModules()
    const fresh = await import("../src/runtime/cloudflare-kv.ts")
    const second = fresh.createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage
    const next = await runWithActiveCloudflareEnv({ KV: binding }, () => second.listKeys({ cursor: page.cursor, limit: 1 }))
    expect(next).toMatchObject({ keys: ["b"], cursor: expect.stringMatching(/^vhc1:/) })
    await expect(runWithActiveCloudflareEnv({ KV: binding }, () => second.listKeys({ cursor: next.cursor, limit: 1 }))).resolves.toEqual({ keys: ["c"] })
  })
})
