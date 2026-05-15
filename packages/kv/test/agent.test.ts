import { describe, expect, it, vi } from "vitest"

import { createKvTools } from "../src/agent.ts"

describe("createKvTools", () => {
  it("gates tools by access level without exposing clear", () => {
    expect(Object.keys(createKvTools({ access: "read", kv: {} as never })).sort()).toEqual([
      "kv_get",
      "kv_has",
      "kv_keys",
    ])
    expect(Object.keys(createKvTools({ access: "write", kv: {} as never })).sort()).toEqual([
      "kv_delete",
      "kv_get",
      "kv_has",
      "kv_keys",
      "kv_set",
    ])
    expect(createKvTools({ access: "write", kv: {} as never })).not.toHaveProperty("kv_clear")
  })

  it("calls the KV runtime handle", async () => {
    const kv = {
      del: vi.fn(async () => {}),
      get: vi.fn(async () => ({ enabled: true })),
      has: vi.fn(async () => true),
      keys: vi.fn(async () => ["settings"]),
      set: vi.fn(async () => {}),
    }
    const tools = createKvTools({ access: "write", kv })

    await expect(tools.kv_get.execute?.({ key: "settings" })).resolves.toEqual({ key: "settings", value: { enabled: true } })
    await expect(tools.kv_has.execute?.({ key: "settings" })).resolves.toEqual({ exists: true, key: "settings" })
    await expect(tools.kv_keys.execute?.({ base: "settings" })).resolves.toEqual({ keys: ["settings"] })
    await expect(tools.kv_set.execute?.({ key: "settings", value: { enabled: true } })).resolves.toEqual({ key: "settings" })
    await expect(tools.kv_delete.execute?.({ key: "settings" })).resolves.toEqual({ key: "settings" })
    expect(kv.get).toHaveBeenCalledWith("settings", undefined)
    expect(kv.set).toHaveBeenCalledWith("settings", { enabled: true }, undefined)
    expect(kv.del).toHaveBeenCalledWith("settings", undefined)
  })
})
