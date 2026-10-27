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

  it("loads on h3 1, because Nuxt 4 bundles every h3 import as its own h3 1", async () => {
    vi.resetModules()
    vi.doMock("h3", () => import("h3-v1"))
    try {
      const { default: handler } = await import("../src/console/runtime/server/rpc.ts")

      expect(handler).toBeTypeOf("function")
    }
    finally {
      vi.doUnmock("h3")
      vi.resetModules()
    }
  }, 60_000)
})
