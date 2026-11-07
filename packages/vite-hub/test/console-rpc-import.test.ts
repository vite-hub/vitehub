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
})
