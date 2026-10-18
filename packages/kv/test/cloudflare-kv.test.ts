import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { describe, expect, it } from "vitest"

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
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare-kv-binding" }) as RuntimeStorage
    const first = createNamespace()
    const second = createNamespace()

    await runWithActiveCloudflareEnv({ KV: first }, () => storage.setItem("smoke", "first"))
    await runWithActiveCloudflareEnv({ KV: second }, () => storage.setItem("smoke", "second"))

    expect(first.values.get("smoke")).toBe("first")
    expect(second.values.get("smoke")).toBe("second")
    await expect(runWithActiveCloudflareEnv({ KV: first }, () => storage.listKeys({ limit: 10 }))).resolves.toEqual({ keys: ["smoke"] })
  })

  it("keeps continuation namespaces stable when request bindings are recreated", async () => {
    const storage = createCloudflareKVStorage({ binding: "KV", namespaceId: "stable-id", driver: "cloudflare-kv-binding" }) as RuntimeStorage
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

  it("reports a missing binding outside a Cloudflare request", async () => {
    // SAFETY: The Cloudflare storage factory supplies the RuntimeStorage read, write, and list methods.
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare-kv-binding" }) as RuntimeStorage

    await expect(storage.getItem("smoke")).rejects.toThrow("Invalid binding `KV`")
  })

  it("rejects a continuation resumed against a different request binding", async () => {
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare-kv-binding" }) as RuntimeStorage
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
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare-kv-binding" }) as RuntimeStorage
    const namespace = createNamespace()
    namespace.list = async () => ({ keys: [{ name: "smoke" }], list_complete: false })

    await expect(runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ limit: 10 }))).rejects.toThrow(
      "Cloudflare KV list returned an invalid page.",
    )
  })

  it("rejects an incomplete page whose cursor does not advance", async () => {
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare-kv-binding" }) as RuntimeStorage
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
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare-kv-binding" }) as RuntimeStorage
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
    const firstStorage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare-kv-binding" }) as RuntimeStorage
    const secondStorage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare-kv-binding" }) as RuntimeStorage
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

  it("fails closed at the cursor history limit without discarding earlier cursors", async () => {
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare-kv-binding" }) as RuntimeStorage
    const namespace = createNamespace()
    let page = 0
    namespace.list = async () => ({ cursor: String(++page), keys: [], list_complete: false })
    let cursor: string | undefined
    for (let index = 0; index < 1_024; index++) {
      cursor = (await runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ cursor, limit: 1 }))).cursor
    }

    await expect(runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ cursor, limit: 1 }))).rejects.toThrow(
      "cursor history limit",
    )
    namespace.list = async () => ({ cursor: "1", keys: [], list_complete: false })
    await expect(runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ cursor, limit: 1 }))).rejects.toThrow(
      "repeated pagination cursor",
    )
  })
})
