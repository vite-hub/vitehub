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
    list: async ({ prefix = "" }: { prefix?: string }) => ({
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

  it("reports a missing binding outside a Cloudflare request", async () => {
    // SAFETY: The Cloudflare storage factory supplies the RuntimeStorage read, write, and list methods.
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare-kv-binding" }) as RuntimeStorage

    await expect(storage.getItem("smoke")).rejects.toThrow("Invalid binding `KV`")
  })

  it("rejects an incomplete page without a cursor", async () => {
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare-kv-binding" }) as RuntimeStorage
    const namespace = createNamespace()
    namespace.list = async () => ({ keys: [{ name: "smoke" }], list_complete: false })

    await expect(runWithActiveCloudflareEnv({ KV: namespace }, () => storage.listKeys({ limit: 10 }))).rejects.toThrow(
      "Cloudflare KV list returned an invalid page.",
    )
  })
})
