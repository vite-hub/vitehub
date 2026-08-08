import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentModelInput } from "../src/types.ts"

const generateResult = {
  content: [{ text: "ok", type: "text" }],
  finishReason: { raw: "stop", unified: "stop" },
  usage: {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 3, total: 3 },
    outputTokens: { reasoning: 0, text: 1, total: 1 },
  },
  warnings: [],
}

function languageModel(modelId = "zai/glm-5v-turbo", provider = "gateway") {
  return {
    doGenerate: vi.fn(async () => generateResult),
    doStream: vi.fn(),
    modelId,
    provider,
    specificationVersion: "v3",
    supportedUrls: {},
  }
}

const runtime = {
  memo: vi.fn((_key, create) => create()),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
}

describe("Agent model materialization", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it("materializes a model string through AI Gateway before instrumentation", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "ambient-token")
    const model = languageModel()
    const selectModel = vi.fn(() => model)
    const createGateway = vi.fn(() => selectModel)
    vi.doMock("@ai-sdk/gateway", () => ({ createGateway }))
    const instrumentation = vi.fn(({ model }) => model)
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      driver: {
        execution: { instrumentation: { model: instrumentation } },
        model: "zai/glm-5v-turbo",
      },
    })

    await runAgent(agent, runtime, { prompt: "hello" })
    expect(createGateway).toHaveBeenCalledWith({ apiKey: "ambient-token" })
    expect(selectModel).toHaveBeenCalledWith("zai/glm-5v-turbo")
    expect(instrumentation).toHaveBeenCalledWith(expect.objectContaining({ model }))
  })

  it("uses explicit descriptor credentials and Cloudflare credential discovery", async () => {
    const createGateway = vi.fn(() => vi.fn(() => languageModel()))
    vi.doMock("@ai-sdk/gateway", () => ({ createGateway }))
    const { materializeAgentModel } = await import("../src/internal/agent-model.ts")

    await materializeAgentModel({
      apiKey: { unseal: () => "explicit-token" },
      id: "zai/glm-5v-turbo",
    }, {} as never)
    await materializeAgentModel("zai/glm-5v-turbo", {
      cloudflare: { env: { AI_GATEWAY_API_KEY: "cloudflare-token" } },
    } as never)

    expect(createGateway).toHaveBeenNthCalledWith(1, { apiKey: "explicit-token" })
    expect(createGateway).toHaveBeenNthCalledWith(2, { apiKey: "cloudflare-token" })
  })

  it("resolves descriptor credentials for each invocation", async () => {
    const createGateway = vi.fn(() => vi.fn(() => languageModel()))
    vi.doMock("@ai-sdk/gateway", () => ({ createGateway }))
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent<{ gatewayKey: string }>({
      driver: {
        model: ({ runtimeConfig }) => ({
          apiKey: runtimeConfig.gatewayKey,
          id: "zai/glm-5v-turbo",
        }),
      },
    })

    await runAgent(agent, { ...runtime, runtimeConfig: { gatewayKey: "tenant-token" } }, { prompt: "hello" })

    expect(createGateway).toHaveBeenCalledWith({ apiKey: "tenant-token" })
  })

  it("materializes Capability models with invocation runtime config", async () => {
    const model = languageModel()
    const selectModel = vi.fn(() => model)
    const createGateway = vi.fn(() => selectModel)
    vi.doMock("@ai-sdk/gateway", () => ({ createGateway }))
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let resolvedModel: unknown

    await resolveAgentCapabilities({
      capabilities: [defineCapability<{ gatewayKey: string }>({
        id: "model-consumer",
        async resolve(context) {
          resolvedModel = await context.model.resolve(({ runtimeConfig }) => ({
            apiKey: runtimeConfig.gatewayKey,
            id: "zai/glm-5v-turbo",
          }))
        },
      })],
    }, { ...runtime, runtimeConfig: { gatewayKey: "capability-token" } }, {})

    expect(createGateway).toHaveBeenCalledWith({ apiKey: "capability-token" })
    expect(selectModel).toHaveBeenCalledWith("zai/glm-5v-turbo")
    expect(resolvedModel).toBe(model)
  })

  it("leaves conventional Gateway credential discovery intact", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "")
    const createGateway = vi.fn(() => vi.fn(() => languageModel()))
    vi.doMock("@ai-sdk/gateway", () => ({ createGateway }))
    const { materializeAgentModel } = await import("../src/internal/agent-model.ts")

    await materializeAgentModel("zai/glm-5v-turbo", {} as never)

    expect(createGateway).toHaveBeenCalledWith()
  })

  it("passes concrete AI SDK models through unchanged", async () => {
    const model = languageModel("direct-model", "direct-provider") as AgentModelInput
    const { materializeAgentModel } = await import("../src/internal/agent-model.ts")

    await expect(materializeAgentModel(model, {} as never)).resolves.toBe(model)
  })

  it("inspects Gateway declarations without exposing credentials", async () => {
    const { createAgentInspectionMetadata, defineAgent, resolveAgentInspectionMetadata } = await import("../src/index.ts")
    const agent = defineAgent({
      driver: {
        model: { apiKey: "secret-token", id: "zai/glm-5v-turbo" },
      },
    })
    const expected = {
      id: "zai/glm-5v-turbo",
      provider: "zai",
      transport: "gateway",
    }

    expect(createAgentInspectionMetadata(agent).config?.driver.model).toEqual(expected)
    expect((await resolveAgentInspectionMetadata(agent)).config?.driver.model).toEqual(expected)
    expect(JSON.stringify(createAgentInspectionMetadata(agent))).not.toContain("secret-token")
  })
})
