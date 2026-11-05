import { afterEach, describe, expect, it, vi } from "vitest"

import { anthropic, cliproxy, cloudflare, cloudflareAccess, defineAiGateway, litellm, ollama, openai, openrouter, typesafe, vercel } from "../src/index.ts"
import { resolveAiGatewayRoute } from "../src/internal.ts"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("AI gateway presets", () => {
  it("maps each preset to the base URL that each Driver expects", () => {
    expect(cliproxy({ url: "https://proxy.example/v1/" }).baseURL).toEqual({ "codex": "https://proxy.example/v1", "claude-code": "https://proxy.example", "openai-compatible": "https://proxy.example/v1" })
    expect(litellm({ url: "http://litellm:4000" }).baseURL).toEqual({ "codex": "http://litellm:4000/v1", "claude-code": "http://litellm:4000", "openai-compatible": "http://litellm:4000/v1" })
    expect(ollama({ url: "http://gpu:11434" }).baseURL).toEqual({ "codex": "http://gpu:11434/v1", "claude-code": "http://gpu:11434", "openai-compatible": "http://gpu:11434/v1" })
    expect(openrouter().baseURL).toEqual({ "codex": "https://openrouter.ai/api/v1", "claude-code": "https://openrouter.ai/api", "openai-compatible": "https://openrouter.ai/api/v1" })
    expect(vercel().baseURL).toEqual({ "codex": "https://ai-gateway.vercel.sh/codex/v1", "claude-code": "https://ai-gateway.vercel.sh/claude-code", "openai-compatible": "https://ai-gateway.vercel.sh/v1" })
    expect(openai().baseURL).toEqual({ "codex": "https://api.openai.com/v1", "openai-compatible": "https://api.openai.com/v1" })
    expect(anthropic().baseURL).toEqual({ "claude-code": "https://api.anthropic.com" })
    expect(typesafe().baseURL).toEqual({})
    expect(Object.keys(cloudflare().baseURL)).toEqual(["openai-compatible"])
  })

  it("validates custom gateways", () => {
    expect(() => defineAiGateway({ name: "x", baseURL: {} })).toThrow('must set a baseURL for "codex", "claude-code", "openai-compatible"')
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
})
