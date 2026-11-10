import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import createCloudflareKVLocalDriver from "../src/runtime/cloudflare-kv-local.ts"
import createFsLiteKVDriver from "../src/runtime/fs-lite.ts"

vi.mock("../src/runtime/fs-lite.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/fs-lite.ts")>()
  return { default: vi.fn(actual.default) }
})

let directory: string
beforeEach(async () => {
  vi.clearAllMocks()
  directory = await mkdtemp(join(tmpdir(), "vitehub-kv-cloudflare-local-"))
})
afterEach(async () => {
  await rm(directory, { force: true, recursive: true })
})

it("serves every binding operation when the local store cannot open, including after a fallback failure", async () => {
  const localBase = join(directory, "blocked")
  await writeFile(localBase, "not a directory")
  const driver = await createCloudflareKVLocalDriver({ binding: "KV", driver: "cloudflare-kv-binding", localBase })
  const values = new Map<string, string>()
  const binding = {
    delete: async (key: string) => { values.delete(key) },
    get: async (key: string) => values.get(key) ?? null,
    list: async () => ({ keys: [...values.keys()].map(name => ({ name })), list_complete: true }),
    put: async (key: string, value: string) => { values.set(key, value) },
  }
  try {
    await runWithActiveCloudflareEnv({ KV: binding }, async () => {
      await driver.setItem?.("theme", "dark", {})
      expect(values.get("theme")).toBe("dark")
      await expect(driver.getItem("theme")).resolves.toBe("dark")
      await expect(driver.hasItem("theme", {})).resolves.toBe(true)
      await expect(driver.getKeys("", {})).resolves.toEqual(["theme"])
      await expect(driver.listKeys({ limit: 10 })).resolves.toEqual({ keys: ["theme"] })
      await driver.removeItem?.("theme", {})
      expect(values.has("theme")).toBe(false)
      await driver.setItem?.("theme", "light", {})
      await driver.clear?.("", {})
      expect(values.size).toBe(0)
    })
    expect(createFsLiteKVDriver).not.toHaveBeenCalled()
    await expect(driver.getItem("theme")).rejects.toMatchObject({ code: "EEXIST" })
    expect(createFsLiteKVDriver).toHaveBeenCalledTimes(1)
    await expect(runWithActiveCloudflareEnv({ KV: binding }, () => driver.getItem("theme"))).resolves.toBeNull()
    expect(createFsLiteKVDriver).toHaveBeenCalledTimes(1)
  }
  finally {
    await driver.dispose?.()
  }
})

it("retries a failed fallback and shares one initialization across concurrent and later operations", async () => {
  const localBase = join(directory, "blocked")
  await writeFile(localBase, "not a directory")
  const driver = await createCloudflareKVLocalDriver({ binding: "KV", driver: "cloudflare-kv-binding", localBase })
  try {
    const failures = await Promise.allSettled([driver.getItem("counter"), driver.getKeys("", {})])
    expect(failures).toEqual([
      { reason: expect.objectContaining({ code: "EEXIST" }), status: "rejected" },
      { reason: expect.objectContaining({ code: "EEXIST" }), status: "rejected" },
    ])
    expect(createFsLiteKVDriver).toHaveBeenCalledTimes(1)
    await rm(localBase)
    await Promise.all([driver.setItem?.("counter", "1", {}), driver.setItem?.("counter:reset-at", "tomorrow", {})])
    expect(createFsLiteKVDriver).toHaveBeenCalledTimes(2)
    await expect(driver.getItem("counter")).resolves.toBe("1")
    await expect(driver.getItem("counter:reset-at")).resolves.toBe("tomorrow")
    expect((await driver.getKeys("", {})).sort()).toEqual(["counter", "counter:reset-at"])
    await expect(driver.setItem?.("k".repeat(513), "value", {})).rejects.toMatchObject({ code: "KV_KEY_TOO_LONG" })
    expect(createFsLiteKVDriver).toHaveBeenCalledTimes(2)
  }
  finally {
    await driver.dispose?.()
  }
})
