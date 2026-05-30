import { describe, expect, it, vi } from "vitest"

describe("agent Nitro entrypoint", () => {
  it("does not import Nitro runtime handlers during Nitro module setup", async () => {
    vi.resetModules()
    vi.doMock("nitro/runtime-config", () => {
      throw new Error("nitro runtime config should not load from @vite-hub/agent/nitro")
    })

    const module = await import("../src/nitro.ts")

    expect(module.default).toMatchObject({ name: "@vite-hub/agent" })
    expect(module.agentNitro).toBeTypeOf("function")

    vi.doUnmock("nitro/runtime-config")
  })
})
