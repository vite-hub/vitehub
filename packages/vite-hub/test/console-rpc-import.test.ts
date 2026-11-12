import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

describe("Console RPC module", () => {
  it("starts no timers or requests in the host runtime's global scope", async () => {
    const timers = [vi.spyOn(globalThis, "setInterval"), vi.spyOn(globalThis, "setTimeout")]
    const fetch = vi.spyOn(globalThis, "fetch")
    try {
      await import("../src/console/runtime/server/rpc.ts")

      for (const timer of timers) expect(timer).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    }
    finally {
      for (const spy of [...timers, fetch]) spy.mockRestore()
    }
  }, 60_000)

  it.each([
    "logs.get", "rpc", "status.get", "usage.get",
  ])("serves %s as a Fetchable route that imports nothing from h3", async (name) => {
    const { default: route } = await import(`../src/console/runtime/server/${name}.ts`)

    expect(route.fetch).toBeTypeOf("function")
    expect(await readFile(new URL(`../src/console/runtime/server/${name}.ts`, import.meta.url), "utf8")).not.toMatch(/from "h3"/)
  }, 60_000)
})
