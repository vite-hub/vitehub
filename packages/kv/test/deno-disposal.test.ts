import { afterEach, expect, it, vi } from "vitest"

import createDenoKVDriver from "../src/runtime/deno-kv.ts"

afterEach(() => vi.unstubAllGlobals())

it.each([false, true])("closes a Deno connection once during concurrent disposal, pending open: %s", async (pendingOpen) => {
  const opened = Promise.withResolvers<void>()
  const close = vi.fn()
  const native = {
    close,
    async get() { return { key: ["key"], value: null, versionstamp: null } },
  }
  vi.stubGlobal("Deno", { openKv: async () => { await opened.promise; return native } })
  const driver = createDenoKVDriver()
  const read = driver.getItem("key", {})
  if (!pendingOpen) {
    opened.resolve()
    await read
  }
  const first = driver.dispose?.()
  const second = driver.dispose?.()
  opened.resolve()
  await Promise.all([read, first, second])
  expect(close).toHaveBeenCalledOnce()
  await driver.dispose?.()
  expect(close).toHaveBeenCalledOnce()
  await expect(driver.getItem("key", {})).rejects.toThrow("disposed")
})
