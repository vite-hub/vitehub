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
      const resolveModel = gateway("zai/glm-5v-turbo", async () => ({
        apiKey: { unseal: () => "gateway-token" },
        baseURL: "https://gateway.example",
      }))

      if (typeof resolveModel !== "function") throw new Error("Expected a model resolver.")
      await expect(resolveModel({} as never)).resolves.toBe(model)
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

  it("rejects empty model identifiers", async () => {
    const { gateway } = await import("../src/gateway.ts")
    expect(() => gateway(" ")).toThrow("non-empty model identifier")
  })
})
