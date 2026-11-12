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

// Agents create AI Gateway models with the `createGateway` that `ai` re-exports, so the bundle keeps one gateway copy.
function mockCreateGateway(createGateway: unknown) {
  vi.doMock("ai", async importOriginal => ({ ...await importOriginal<typeof import("ai")>(), createGateway }))
}

describe("Agent model materialization", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.doUnmock("ai")
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it("materializes a model string through AI Gateway before instrumentation", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "ambient-token")
    const model = languageModel()
    const selectModel = vi.fn(() => model)
    const createGateway = vi.fn(() => selectModel)
    mockCreateGateway(createGateway)
    const instrumentation = vi.fn(({ model }) => model)
    const { defineAgent } = await import("../src/index.ts")
    const { runAgentWithContext } = await import("../src/internal/agent-run.ts")
    const agent = defineAgent({
      driver: {
        execution: { instrumentation: { model: instrumentation } },
        model: "zai/glm-5v-turbo",
      },
    })

    await runAgentWithContext(agent, runtime, { prompt: "hello" })
    expect(createGateway).toHaveBeenCalledWith({ apiKey: "ambient-token" })
    expect(selectModel).toHaveBeenCalledWith("zai/glm-5v-turbo")
    expect(instrumentation).toHaveBeenCalledWith(expect.objectContaining({ model }))
  })

  it("answers through the AI Gateway client that ai ships", async () => {
    const requests: Request[] = []
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return Response.json({ ...generateResult, content: [{ type: "text", text: "Hello from the gateway." }] })
    })
    const { defineAgent } = await import("../src/index.ts")
    const { runAgentWithContext } = await import("../src/internal/agent-run.ts")
    const agent = defineAgent({ driver: { model: { apiKey: "gateway-token", id: "zai/glm-5v-turbo" } } })

    await expect(runAgentWithContext(agent, runtime, { prompt: "hello" })).resolves.toMatchObject({ text: "Hello from the gateway." })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("https://ai-gateway.vercel.sh/v4/ai/language-model")
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer gateway-token")
    expect(requests[0]!.headers.get("ai-language-model-id")).toBe("zai/glm-5v-turbo")
  })

  it("uses explicit descriptor credentials and Cloudflare credential discovery", async () => {
    const createGateway = vi.fn(() => vi.fn(() => languageModel()))
    mockCreateGateway(createGateway)
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

  it("rejects empty explicit credentials instead of using ambient credentials", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "ambient-token")
    const createGateway = vi.fn(() => vi.fn(() => languageModel()))
    mockCreateGateway(createGateway)
    const { materializeAgentModel } = await import("../src/internal/agent-model.ts")

    await expect(materializeAgentModel({ apiKey: "", id: "zai/glm-5v-turbo" }, {} as never))
      .rejects.toThrow("apiKey must be non-empty")
    expect(createGateway).not.toHaveBeenCalled()
  })

  it("resolves descriptor credentials for each invocation", async () => {
    const createGateway = vi.fn(() => vi.fn(() => languageModel()))
    mockCreateGateway(createGateway)
    const { defineAgent } = await import("../src/index.ts")
    const { runAgentWithContext } = await import("../src/internal/agent-run.ts")
    const agent = defineAgent<{ gatewayKey: string }>({
      driver: {
        model: ({ runtimeConfig }) => ({
          apiKey: runtimeConfig.gatewayKey,
          id: "zai/glm-5v-turbo",
        }),
      },
    })

    await runAgentWithContext(agent, { ...runtime, capabilities: {}, runtimeConfig: { gatewayKey: "tenant-token" } }, { prompt: "hello" })

    expect(createGateway).toHaveBeenCalledWith({ apiKey: "tenant-token" })
  })

  it("materializes Capability models with invocation runtime config", async () => {
    const model = languageModel()
    const selectModel = vi.fn(() => model)
    const createGateway = vi.fn(() => selectModel)
    mockCreateGateway(createGateway)
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let resolvedModel: unknown

    await resolveAgentCapabilities({
      capabilities: [defineCapability<{ gatewayKey: string }>()({
        id: "model-consumer",
        async resolve(context) {
          resolvedModel = await context.model.resolve(({ runtimeConfig }) => ({
            apiKey: runtimeConfig.gatewayKey,
            id: "zai/glm-5v-turbo",
          }))
        },
      })],
    }, { ...runtime, capabilities: {}, runtimeConfig: { gatewayKey: "capability-token" } }, {})

    expect(createGateway).toHaveBeenCalledWith({ apiKey: "capability-token" })
    expect(selectModel).toHaveBeenCalledWith("zai/glm-5v-turbo")
    expect(resolvedModel).toBe(model)
  })

  it("leaves conventional Gateway credential discovery intact", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "")
    const createGateway = vi.fn(() => vi.fn(() => languageModel()))
    mockCreateGateway(createGateway)
    const { materializeAgentModel } = await import("../src/internal/agent-model.ts")

    await materializeAgentModel("zai/glm-5v-turbo", {} as never)

    expect(createGateway).toHaveBeenCalledWith()
  })

  it("passes concrete AI SDK models through unchanged", async () => {
    const model = languageModel("direct-model", "direct-provider") as AgentModelInput
    const { materializeAgentModel } = await import("../src/internal/agent-model.ts")

    await expect(materializeAgentModel(model, {} as never)).resolves.toBe(model)
  })

  it("passes class-backed AI SDK models with an enumerable id through unchanged", async () => {
    class ClassBackedModel {
      id = "direct-id"
      get modelId() { return "direct-model" }
      get provider() { return "direct-provider" }
      async doGenerate() { return generateResult }
      async doStream() { return { stream: new ReadableStream() } }
    }
    // SAFETY: This fixture implements the model members materializeAgentModel reads.
    const model = new ClassBackedModel() as AgentModelInput
    const { materializeAgentModel } = await import("../src/internal/agent-model.ts")

    expect(Object.keys(model as object)).toEqual(["id"])
    await expect(materializeAgentModel(model, {} as never)).resolves.toBe(model)
  })

  it("inspects Gateway declarations without exposing credentials", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { createAgentInspectionMetadata, resolveAgentInspectionMetadata } = await import("../src/workspace-agent.ts")
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
