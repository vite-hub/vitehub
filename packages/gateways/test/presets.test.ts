import { afterEach, describe, expect, it, vi } from "vitest"

import { aiGatewayEnv, aiGatewayHarnessRoute, alibaba, anthropic, cliproxy, cloudflare, cloudflareAccess, deepseek, defineAiGateway, google, litellm, minimax, moonshot, ollama, openai, openrouter, typesafe, vercel, zai } from "../src/index.ts"
import { resolveAiGatewayRoute } from "../src/internal.ts"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("AI gateway presets", () => {
  it("maps each preset to the base URL that each Driver expects", () => {
    expect(cliproxy({ url: "https://proxy.example/v1/" }).baseURL).toEqual({ "codex": "https://proxy.example/v1", "claude-code": "https://proxy.example", "gemini": "https://proxy.example", "openai-compatible": "https://proxy.example/v1" })
    expect(litellm({ url: "http://litellm:4000" }).baseURL).toEqual({ "codex": "http://litellm:4000/v1", "claude-code": "http://litellm:4000", "gemini": "http://litellm:4000", "openai-compatible": "http://litellm:4000/v1" })
    expect(ollama({ url: "http://gpu:11434" }).baseURL).toEqual({ "codex": "http://gpu:11434/v1", "claude-code": "http://gpu:11434", "openai-compatible": "http://gpu:11434/v1" })
    expect(openrouter().baseURL).toEqual({ "codex": "https://openrouter.ai/api/v1", "claude-code": "https://openrouter.ai/api", "openai-compatible": "https://openrouter.ai/api/v1" })
    expect(vercel().baseURL).toEqual({ "codex": "https://ai-gateway.vercel.sh/codex/v1", "claude-code": "https://ai-gateway.vercel.sh/claude-code", "openai-compatible": "https://ai-gateway.vercel.sh/v1" })
    expect(openai().baseURL).toEqual({ "codex": "https://api.openai.com/v1", "openai-compatible": "https://api.openai.com/v1" })
    expect(anthropic().baseURL).toEqual({ "claude-code": "https://api.anthropic.com" })
    expect(typesafe().baseURL).toEqual({})
    expect(Object.keys(cloudflare().baseURL)).toEqual(["openai-compatible"])
  })

  it("validates custom gateways", () => {
    expect(() => defineAiGateway({ name: "x", baseURL: {} })).toThrow('must set a baseURL for "codex", "claude-code", "gemini", "openai-compatible"')
    // @ts-expect-error The type rejects an unknown model API too.
    expect(() => defineAiGateway({ name: "x", baseURL: { chat: "https://proxy" }, apiKey: "k" })).toThrow('unknown model API "chat"')
    expect(() => defineAiGateway({ name: "x", baseURL: { codex: "ftp://proxy" }, apiKey: "k" })).toThrow("http or https URL")
    expect(() => defineAiGateway({ name: "x", baseURL: { codex: "https://proxy" } })).toThrow("needs apiKey or apiKeyEnv")
    expect(() => defineAiGateway({ name: "x", baseURL: { codex: "https://proxy" }, apiKey: "k", headers: { Authorization: "v" } })).toThrow("sets the API key with apiKey")
    expect(() => cliproxy({ url: " " })).toThrow(expect.objectContaining({ code: "GATEWAYS_R0001" }))
  })

  it("resolves a Driver route from passed values, process.env, or the caller's env reader", async () => {
    vi.stubEnv("CLIPROXY_URL", "https://env-proxy.example")
    vi.stubEnv("CLIPROXY_API_KEY", "env-key")
    vi.stubEnv("CF_ACCESS_CLIENT_ID", "id")
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", "secret")
    expect(await resolveAiGatewayRoute(cliproxy({ headers: cloudflareAccess() }), "codex", {})).toEqual({
      apiKey: "env-key",
      auth: "bearer",
      baseURL: "https://env-proxy.example/v1",
      headers: [["CF-Access-Client-Id", "id"], ["CF-Access-Client-Secret", "secret"]],
    })
    const env = vi.fn((preset: string, field: string) => `${preset}-${field}`)
    expect(await resolveAiGatewayRoute(openrouter(), "claude-code", { env })).toMatchObject({ apiKey: "openrouter-apiKey", baseURL: "https://openrouter.ai/api" })
    expect(env).toHaveBeenCalledWith("openrouter", "apiKey")
    await expect(resolveAiGatewayRoute(anthropic({ apiKey: undefined }), "claude-code", {})).rejects.toMatchObject({ code: "GATEWAYS_R0002" })
  })

  it("keeps Vercel OIDC as the Driver credential fallback", async () => {
    vi.stubEnv("VITEHUB_VERCEL_API_KEY", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    vi.stubEnv("VERCEL_OIDC_TOKEN", "oidc-token")
    expect(await resolveAiGatewayRoute(vercel(), "codex", {})).toMatchObject({ apiKey: "oidc-token" })
  })

  it("maps each model provider to its documented endpoints, in each region", () => {
    expect(google().baseURL).toEqual({ "gemini": "https://generativelanguage.googleapis.com", "openai-compatible": "https://generativelanguage.googleapis.com/v1beta/openai" })
    expect(moonshot().baseURL).toEqual({ "codex": "https://api.moonshot.ai/v1", "claude-code": "https://api.moonshot.ai/anthropic", "openai-compatible": "https://api.moonshot.ai/v1" })
    expect(moonshot({ region: "china" }).baseURL).toEqual({ "codex": "https://api.moonshot.cn/v1", "claude-code": "https://api.moonshot.cn/anthropic", "openai-compatible": "https://api.moonshot.cn/v1" })
    expect(zai().baseURL).toEqual({ "codex": "https://api.z.ai/api/v1", "claude-code": "https://api.z.ai/api/anthropic", "openai-compatible": "https://api.z.ai/api/paas/v4" })
    expect(zai({ region: "china", codingPlan: true }).baseURL).toEqual({ "codex": "https://open.bigmodel.cn/api/v1", "claude-code": "https://open.bigmodel.cn/api/anthropic", "openai-compatible": "https://open.bigmodel.cn/api/coding/paas/v4" })
    expect(deepseek().baseURL).toEqual({ "claude-code": "https://api.deepseek.com/anthropic", "openai-compatible": "https://api.deepseek.com" })
    expect(minimax().baseURL).toEqual({ "codex": "https://api.minimax.io/v1", "claude-code": "https://api.minimax.io/anthropic", "openai-compatible": "https://api.minimax.io/v1" })
    expect(minimax({ region: "china" }).baseURL).toEqual({ "codex": "https://api.minimax.cn/v1", "claude-code": "https://api.minimax.cn/anthropic", "openai-compatible": "https://api.minimax.cn/v1" })
    expect(alibaba().baseURL).toEqual({ "claude-code": "https://dashscope-intl.aliyuncs.com/apps/anthropic", "openai-compatible": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" })
    expect(alibaba({ region: "cn-beijing" }).baseURL).toEqual({ "claude-code": "https://dashscope.aliyuncs.com/apps/anthropic", "openai-compatible": "https://dashscope.aliyuncs.com/compatible-mode/v1" })
    expect(alibaba({ region: "us-east-1", workspaceId: "ws-123" }).baseURL).toEqual({
      "codex": "https://ws-123.us-east-1.maas.aliyuncs.com/compatible-mode/v1",
      "claude-code": "https://ws-123.us-east-1.maas.aliyuncs.com/apps/anthropic",
      "openai-compatible": "https://ws-123.us-east-1.maas.aliyuncs.com/compatible-mode/v1",
    })
    expect(google().modelApis).toEqual(["chat"])
    expect(deepseek().modelApis).toEqual(["chat", "messages"])
    expect(moonshot().modelApis).toBeUndefined()
  })

  it("rejects a region that the provider does not have", () => {
    // @ts-expect-error The type rejects an unknown region too.
    expect(() => moonshot({ region: "eu" })).toThrow('moonshot({ region }) must be "china" or "international"')
    expect(() => alibaba({ region: "us-east-1" })).toThrow(expect.objectContaining({ code: "GATEWAYS_R0001", message: expect.stringContaining("Pass alibaba({ region, workspaceId })") }))
    expect(() => alibaba({ workspaceId: "ws/1" })).toThrow("must be a Model Studio workspace ID")
  })

  it("resolves each provider's key from its documented variable", async () => {
    const keys = { DASHSCOPE_API_KEY: alibaba, DEEPSEEK_API_KEY: deepseek, GEMINI_API_KEY: google, KIMI_API_KEY: moonshot, MINIMAX_API_KEY: minimax, ZAI_API_KEY: zai }
    for (const [name, gateway] of Object.entries(keys)) {
      vi.stubEnv(name, `${name}-value`)
      expect(await resolveAiGatewayRoute(gateway(), "openai-compatible", {})).toMatchObject({ apiKey: `${name}-value`, auth: "bearer" })
    }
    vi.stubEnv("MOONSHOT_API_KEY", "moonshot-first")
    expect(await resolveAiGatewayRoute(moonshot(), "codex", {})).toMatchObject({ apiKey: "moonshot-first" })
    expect(aiGatewayEnv.moonshot.apiKey?.names).toEqual(["MOONSHOT_API_KEY", "KIMI_API_KEY"])
    await expect(resolveAiGatewayRoute(deepseek({ apiKey: undefined }), "claude-code", {})).rejects.toMatchObject({ code: "GATEWAYS_R0002" })
  })

  it("sends the key of the gemini route in x-goog-api-key, the header that the Gemini CLI sends", async () => {
    expect(await resolveAiGatewayRoute(google({ apiKey: "g" }), "gemini", {})).toEqual({ apiKey: "g", auth: "x-goog-api-key", baseURL: "https://generativelanguage.googleapis.com", headers: [] })
    expect(await resolveAiGatewayRoute(google({ apiKey: "g" }), "openai-compatible", {})).toMatchObject({ auth: "bearer", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" })
    expect(await resolveAiGatewayRoute(cliproxy({ url: "http://127.0.0.1:8317", apiKey: "k" }), "gemini", {})).toMatchObject({ auth: "x-goog-api-key", baseURL: "http://127.0.0.1:8317" })
    expect(await resolveAiGatewayRoute(defineAiGateway({ name: "x", baseURL: { gemini: "https://proxy.example/" }, apiKey: "k", auth: "x-api-key" }), "gemini", {})).toMatchObject({ auth: "x-goog-api-key", baseURL: "https://proxy.example" })
  })

  it("tells which route each harness calls on a gateway", () => {
    expect(aiGatewayHarnessRoute(google(), "gemini")).toBe("gemini")
    expect(aiGatewayHarnessRoute(google(), "codex")).toBeUndefined()
    expect(aiGatewayHarnessRoute(cliproxy({ url: "http://proxy" }), "gemini")).toBe("gemini")
    expect(aiGatewayHarnessRoute(ollama(), "gemini")).toBeUndefined()
    expect(aiGatewayHarnessRoute(deepseek(), "codex")).toBeUndefined()
    expect(aiGatewayHarnessRoute(deepseek(), "claude-code")).toBe("claude-code")
    for (const harness of ["kimi", "opencode", "pi"] as const) expect(aiGatewayHarnessRoute(zai(), harness)).toBe("openai-compatible")
    expect(aiGatewayHarnessRoute(anthropic(), "opencode")).toBeUndefined()
    // @ts-expect-error The type rejects an unknown harness too.
    expect(aiGatewayHarnessRoute(openai(), "toString")).toBeUndefined()
  })
})
