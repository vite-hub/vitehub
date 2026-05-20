import { describe, expect, it, vi } from "vitest"

describe("Nitro runtime config", () => {
  it("applies ViteHub Runtime Env values to agent runtimeConfig", async () => {
    vi.resetModules()
    vi.doMock("nitro/runtime-config", () => ({
      useRuntimeConfig: vi.fn(() => ({ agent: false })),
    }))

    const event = { env: { VERTEX_API_KEY: "secret" } }
    const apply = vi.fn((runtimeConfig: Record<string, unknown>, receivedEvent: unknown) => {
      expect(receivedEvent).toBe(event)
      runtimeConfig.vertex = { apiKey: "secret" }
      return runtimeConfig
    })
    globalThis.__vitehubApplyRuntimeEnvToRuntimeConfig = apply

    const { getAgentRuntimeConfig } = await import("../src/runtime/nitro-runtime-config.ts")

    expect(getAgentRuntimeConfig(event)).toMatchObject({
      agent: false,
      vertex: { apiKey: "secret" },
    })
    expect(apply).toHaveBeenCalledOnce()

    delete globalThis.__vitehubApplyRuntimeEnvToRuntimeConfig
    vi.doUnmock("nitro/runtime-config")
  })
})
