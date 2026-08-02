import { describe, expect, it, vi } from "vitest"

describe("gateway model", () => {
  it("resolves ViteHub settings before creating the provider model", async () => {
    vi.resetModules()
    const model = { id: "gateway-model" }
    const selectModel = vi.fn(() => model)
    const createGateway = vi.fn(() => selectModel)
    vi.doMock("@ai-sdk/gateway", () => ({ createGateway }))
    try {
      const { gateway } = await import("../src/gateway.ts")
      const { getModelCallSettings } = await import("../src/internal/model-call-settings.ts")
      const resolveModel = gateway("zai/glm-5v-turbo", async () => ({
        apiKey: { unseal: () => "gateway-token" },
        baseURL: "https://gateway.example",
        fallbacks: ["google/gemini-3-flash", "openai/gpt-5.4-mini"],
      }))

      if (typeof resolveModel !== "function") throw new Error("Expected a model resolver.")
      await expect(resolveModel({
        cloudflare: { env: { AI_GATEWAY_API_KEY: "cloudflare-gateway-token" } },
      } as never)).resolves.toBe(model)
      expect(getModelCallSettings(model)).toEqual({
        providerOptions: {
          gateway: {
            models: ["google/gemini-3-flash", "openai/gpt-5.4-mini"],
          },
        },
      })
      expect(createGateway).toHaveBeenCalledWith({
        apiKey: "gateway-token",
        baseURL: "https://gateway.example",
      })
      expect(selectModel).toHaveBeenCalledWith("zai/glm-5v-turbo")
    }
    finally {
      vi.doUnmock("@ai-sdk/gateway")
      vi.resetModules()
    }
  })

  it("uses the standard Cloudflare gateway binding when no key is configured", async () => {
    vi.resetModules()
    const createGateway = vi.fn(() => () => ({}))
    vi.doMock("@ai-sdk/gateway", () => ({ createGateway }))
    try {
      const { gateway } = await import("../src/gateway.ts")
      const resolveModel = gateway("moonshotai/kimi-k3")
      if (typeof resolveModel !== "function") throw new Error("Expected a model resolver.")
      await resolveModel({
        cloudflare: { env: { AI_GATEWAY_API_KEY: "cloudflare-gateway-token" } },
      } as never)
      expect(createGateway).toHaveBeenCalledWith({ apiKey: "cloudflare-gateway-token" })
    }
    finally {
      vi.doUnmock("@ai-sdk/gateway")
      vi.resetModules()
    }
  })

  it("rejects empty model identifiers", async () => {
    const { gateway } = await import("../src/gateway.ts")
    expect(() => gateway(" ")).toThrow("non-empty model identifier")
  })

  it("rejects empty fallback model identifiers", async () => {
    vi.resetModules()
    vi.doMock("@ai-sdk/gateway", () => ({ createGateway: () => () => ({}) }))
    try {
      const { gateway } = await import("../src/gateway.ts")
      const resolveModel = gateway("moonshotai/kimi-k3", { fallbacks: [" "] })
      if (typeof resolveModel !== "function") throw new Error("Expected a model resolver.")
      await expect(resolveModel({} as never)).rejects.toThrow("non-empty model identifiers")
    }
    finally {
      vi.doUnmock("@ai-sdk/gateway")
      vi.resetModules()
    }
  })
})
