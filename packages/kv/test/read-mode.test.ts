import { rm } from "node:fs/promises"

import { afterAll, describe, expect, it, vi } from "vitest"

import { kv } from "../src/runtime/storage.ts"
import type { KVStoreOptions } from "../src/types.ts"

const fixture = vi.hoisted(() => ({
  base: `${process.env.TMPDIR || "/tmp"}/vitehub-kv-read-mode-${process.pid}-${Date.now()}`,
}))
vi.mock("#vitehub/kv/config", () => ({
  kv: {
    store: { driver: "fs-lite", base: `${fixture.base}/default` },
    stores: {
      default: { driver: "fs-lite", base: `${fixture.base}/default` },
      settings: { driver: "fs-lite", base: `${fixture.base}/settings` },
    },
  },
}))

afterAll(async () => {
  await rm(fixture.base, { force: true, recursive: true })
})

describe("kv.store(name, { mode: \"read\" })", () => {
  it("reads keys of the selected store", async () => {
    expect((await kv.store("settings").set("settings:theme", { dark: true }))[0]).toBeUndefined()

    const reader = kv.store("settings", { mode: "read" })
    expect((await reader.get("settings:theme"))[1]).toEqual({ dark: true })
    expect((await reader.has("settings:theme"))[1]).toBe(true)
    expect((await reader.keys("settings"))[1]).toEqual(["settings:theme"])
    expect((await reader.list({ limit: 10, prefix: "settings:" }))[1]).toEqual({ keys: ["settings:theme"] })
  })

  it("has no write methods at runtime", () => {
    const reader = kv.store("default", { mode: "read" })
    for (const method of ["set", "setIfAbsent", "del", "clear", "getAndDelete", "increment", "store"]) {
      expect(method in reader).toBe(false)
    }
    expect(Object.keys(reader).sort()).toEqual(["get", "has", "keys", "list"])
  })

  it.each(["readonly", null])("rejects the invalid mode %j instead of returning a writable handle", (mode) => {
    // SAFETY: A JavaScript caller can pass a mode that the type rejects.
    const options = { mode } as unknown as KVStoreOptions
    expect(() => kv.store("default", options)).toThrow(expect.objectContaining({ code: "KV_INVALID_STORE_MODE" }))
  })

  it("keeps the writable handle by default", () => {
    expect(typeof kv.store("default").set).toBe("function")
    expect(typeof kv.store("default", {}).set).toBe("function")
    expect(typeof kv.store("default", { mode: undefined }).set).toBe("function")
    expect(typeof kv.store("default", { mode: "write" }).del).toBe("function")
  })
})
