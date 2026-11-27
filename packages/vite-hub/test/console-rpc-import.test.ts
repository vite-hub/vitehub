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
    ["logs.get", "../src/logs/console/logs.get.ts", () => import("../src/logs/console/logs.get.ts")],
    ["rpc", "../src/console/runtime/server/rpc.ts", () => import("../src/console/runtime/server/rpc.ts")],
    ["status.get", "../src/agent/console/status.get.ts", () => import("../src/agent/console/status.get.ts")],
    ["invocations.usage", "../src/agent/console/invocations.usage.ts", () => import("../src/agent/console/invocations.usage.ts")],
  ] as const)("serves %s as a Fetchable route that imports nothing from h3", async (_name, file, load) => {
    const { default: route } = await load()

    expect(route.fetch).toBeTypeOf("function")
    expect(await readFile(new URL(file, import.meta.url), "utf8")).not.toMatch(/from "h3"/)
  }, 60_000)
})
