import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { discoverAgentGatewayEnv } from "../src/channel-env-discovery.ts"
import { anthropic, cliproxy, cloudflare, cloudflareAccess, cloudflareTypesafe, defineAiGateway, litellm, ollama, openai, openrouter, typesafe, vercel } from "@vite-hub/gateways"
import { createAgentInspectionMetadata, defineAgent } from "../src/index.ts"
import { languageModel } from "@vite-hub/gateways/ai-sdk"
import { normalizeAgentDriver } from "../src/internal/agent-driver.ts"
import { materializeAgentModel } from "../src/internal/agent-model.ts"
import { resolveAgentDriverGateway } from "../src/internal/agent-gateway.ts"

const context = { purpose: "inspection" } as never

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("gateway presets", () => {
  it("maps each preset to the base URL that each Driver expects", () => {
    expect(cliproxy({ url: "https://proxy.example/v1/" }).baseURL).toEqual({ "codex": "https://proxy.example/v1", "claude-code": "https://proxy.example", "openai-compatible": "https://proxy.example/v1" })
    expect(litellm({ url: "http://litellm:4000" }).baseURL).toEqual({ "codex": "http://litellm:4000/v1", "claude-code": "http://litellm:4000", "openai-compatible": "http://litellm:4000/v1" })
    expect(ollama({ url: "http://gpu:11434" }).baseURL).toEqual({ "codex": "http://gpu:11434/v1", "claude-code": "http://gpu:11434", "openai-compatible": "http://gpu:11434/v1" })
    expect(openrouter().baseURL).toEqual({ "codex": "https://openrouter.ai/api/v1", "claude-code": "https://openrouter.ai/api", "openai-compatible": "https://openrouter.ai/api/v1" })
    expect(vercel().baseURL).toEqual({ "codex": "https://ai-gateway.vercel.sh/codex/v1", "claude-code": "https://ai-gateway.vercel.sh/claude-code", "openai-compatible": "https://ai-gateway.vercel.sh/v1" })
    expect(openai().baseURL).toEqual({ "codex": "https://api.openai.com/v1", "openai-compatible": "https://api.openai.com/v1" })
    expect(anthropic().baseURL).toEqual({ "claude-code": "https://api.anthropic.com" })
  })

  it("rejects an empty explicit URL", () => {
    expect(() => cliproxy({ url: " " })).toThrow("cliproxy({ url })")
  })

  it("validates custom gateways", () => {
    expect(() => defineAiGateway({ name: "x", baseURL: {} })).toThrow('must set a baseURL for "codex", "claude-code", "openai-compatible"')
    expect(() => defineAiGateway({ name: "x", baseURL: { codex: "ftp://proxy" }, apiKey: "k" })).toThrow("http or https URL")
    expect(() => defineAiGateway({ name: "x", baseURL: { codex: "https://proxy" } })).toThrow("needs apiKey or apiKeyEnv")
    expect(() => defineAiGateway({ name: "x", baseURL: { codex: "https://proxy" }, apiKey: "k", headers: { "bad header": "v" } })).toThrow("not a valid HTTP header name")
    expect(() => defineAiGateway({ name: "x", baseURL: { codex: "https://proxy" }, apiKey: "k", headers: { Authorization: "v" } })).toThrow("sets the API key with apiKey")
    // SAFETY: This fixture supplies an unknown option to test runtime validation.
    expect(() => defineAiGateway({ name: "x", baseURL: { codex: "https://proxy" }, apiKey: "k", url: "https://proxy" } as never)).toThrow("does not support: url")
  })
})

describe("gateway resolution", () => {
  it("selects a generated Codex provider and keeps secrets out of the arguments", async () => {
    const gateway = cliproxy({
      url: "https://proxy.example",
      apiKey: { unseal: () => "proxy-key" },
      headers: { "CF-Access-Client-Id": "client-id", "CF-Access-Client-Secret": async () => "client-secret" },
    })

    const resolved = await resolveAgentDriverGateway(gateway, "codex", context)

    expect(resolved.environment).toEqual({
      VITEHUB_GATEWAY_API_KEY: "proxy-key",
      VITEHUB_GATEWAY_HEADER_0: "client-id",
      VITEHUB_GATEWAY_HEADER_1: "client-secret",
    })
    expect(resolved.launchArgs).toBe([
      '-c "model_provider=\\"vitehub\\""',
      '-c "model_providers.vitehub.name=\\"cliproxy\\""',
      '-c "model_providers.vitehub.base_url=\\"https://proxy.example/v1\\""',
      '-c "model_providers.vitehub.wire_api=\\"responses\\""',
      '-c "model_providers.vitehub.stream_max_retries=10"',
      '-c "model_providers.vitehub.env_key=\\"VITEHUB_GATEWAY_API_KEY\\""',
      '-c "model_providers.vitehub.env_http_headers={\\"CF-Access-Client-Id\\"=\\"VITEHUB_GATEWAY_HEADER_0\\",\\"CF-Access-Client-Secret\\"=\\"VITEHUB_GATEWAY_HEADER_1\\"}"',
    ].join(" "))
    expect(resolved.launchArgs).not.toContain("proxy-key")
    expect(resolved.launchArgs).not.toContain("client-secret")
  })

  it("sends an x-api-key gateway key as a Codex header", async () => {
    const gateway = defineAiGateway({ name: "keyed", baseURL: { codex: "https://keyed.example/v1" }, apiKey: "k", auth: "x-api-key" })
    const resolved = await resolveAgentDriverGateway(gateway, "codex", context)
    expect(resolved.launchArgs).not.toContain("env_key")
    expect(resolved.launchArgs).toContain('env_http_headers={\\"x-api-key\\"=\\"VITEHUB_GATEWAY_API_KEY\\"}')
  })

  it("sets the Claude Code gateway environment", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "vercel-key")
    expect(await resolveAgentDriverGateway(vercel({ headers: { "X-Team": "quiver" } }), "claude-code", context)).toEqual({
      environment: {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "vercel-key",
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh/claude-code",
        ANTHROPIC_CUSTOM_HEADERS: "X-Team: quiver",
      },
    })
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key")
    expect((await resolveAgentDriverGateway(anthropic(), "claude-code", context)).environment).toMatchObject({
      ANTHROPIC_API_KEY: "anthropic-key",
      ANTHROPIC_AUTH_TOKEN: "",
    })
  })

  it("reads the preset key variable and names it when it is missing", async () => {
    vi.stubEnv("CLIPROXY_API_KEY", "")
    await expect(resolveAgentDriverGateway(cliproxy({ url: "https://proxy.example" }), "codex", context)).rejects.toThrow("Set CLIPROXY_API_KEY, or pass apiKey")
    vi.stubEnv("CLIPROXY_API_KEY", "env-key")
    expect((await resolveAgentDriverGateway(cliproxy({ url: "https://proxy.example" }), "codex", context)).environment.VITEHUB_GATEWAY_API_KEY).toBe("env-key")
    expect((await resolveAgentDriverGateway(ollama(), "claude-code", context)).environment.ANTHROPIC_AUTH_TOKEN).toBe("ollama")
  })

  it("fails an explicit undefined key instead of using the preset variable", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "ambient-key")
    const optionalKey: string | undefined = undefined
    await expect(resolveAgentDriverGateway(vercel({ apiKey: optionalKey }), "codex", context)).rejects.toThrow('Gateway "vercel" apiKey resolved to an empty value')
    await expect(resolveAgentDriverGateway(ollama({ apiKey: optionalKey }), "codex", context)).rejects.toThrow('Gateway "ollama" apiKey resolved to an empty value')
    const header = cliproxy({ url: "https://proxy.example", apiKey: "k", headers: { "CF-Access-Client-Id": optionalKey } })
    await expect(resolveAgentDriverGateway(header, "codex", context)).rejects.toThrow('header "CF-Access-Client-Id" resolved to an empty value')
  })

  it("rejects empty header values instead of letting Codex drop them", async () => {
    const gateway = cliproxy({ url: "https://proxy.example", apiKey: "k", headers: { "CF-Access-Client-Id": () => undefined } })
    await expect(resolveAgentDriverGateway(gateway, "codex", context)).rejects.toThrow('header "CF-Access-Client-Id" resolved to an empty value')
  })
})

describe("gateway Server Env", () => {
  it("reads the URL and key of a hosted preset for each invocation", async () => {
    vi.stubEnv("CLIPROXY_URL", "https://env-proxy.example/v1/")
    vi.stubEnv("CLIPROXY_API_KEY", "env-key")
    const gateway = cliproxy()
    expect((await resolveAgentDriverGateway(gateway, "claude-code", context)).environment).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "env-key",
      ANTHROPIC_BASE_URL: "https://env-proxy.example",
    })
    vi.stubEnv("CLIPROXY_URL", "https://rotated.example")
    expect((await resolveAgentDriverGateway(gateway, "codex", context)).launchArgs).toContain('base_url=\\"https://rotated.example/v1\\"')
  })

  it("reads canonical VITEHUB_ names before vendor names", async () => {
    vi.stubEnv("CLIPROXY_URL", "https://vendor.example")
    vi.stubEnv("VITEHUB_CLIPROXY_URL", "https://canonical.example")
    vi.stubEnv("CLIPROXY_API_KEY", "vendor-key")
    vi.stubEnv("VITEHUB_CLIPROXY_API_KEY", "")
    vi.stubEnv("CF_ACCESS_CLIENT_ID", "vendor-id")
    vi.stubEnv("VITEHUB_CLOUDFLARE_ACCESS_CLIENT_ID", "canonical-id")
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", "secret")
    const resolved = await resolveAgentDriverGateway(cliproxy({ headers: cloudflareAccess() }), "claude-code", context)
    // An empty canonical value counts as unset, so the vendor key supplies it.
    expect(resolved.environment).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "vendor-key",
      ANTHROPIC_BASE_URL: "https://canonical.example",
      ANTHROPIC_CUSTOM_HEADERS: "CF-Access-Client-Id: canonical-id\nCF-Access-Client-Secret: secret",
    })
  })

  it("names the URL variable when it is missing", async () => {
    vi.stubEnv("CLIPROXY_URL", "")
    vi.stubEnv("LITELLM_URL", "")
    await expect(resolveAgentDriverGateway(cliproxy({ apiKey: "k" }), "codex", context)).rejects.toThrow('Gateway "cliproxy" needs a URL. Set CLIPROXY_URL, or pass url.')
    await expect(resolveAgentDriverGateway(litellm({ apiKey: "k" }), "codex", context)).rejects.toThrow("Set LITELLM_URL, or pass url.")
  })

  it("defaults Ollama to a local server without a key", async () => {
    vi.stubEnv("OLLAMA_URL", "")
    vi.stubEnv("OLLAMA_API_KEY", "")
    expect((await resolveAgentDriverGateway(ollama(), "claude-code", context)).environment).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_BASE_URL: "http://localhost:11434",
    })
  })

  it("reads Cloudflare Access service-token headers", async () => {
    vi.stubEnv("CF_ACCESS_CLIENT_ID", "client-id")
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", "client-secret")
    const gateway = cliproxy({ url: "https://proxy.example", apiKey: "k", headers: cloudflareAccess() })
    expect((await resolveAgentDriverGateway(gateway, "claude-code", context)).environment.ANTHROPIC_CUSTOM_HEADERS)
      .toBe("CF-Access-Client-Id: client-id\nCF-Access-Client-Secret: client-secret")
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", "")
    await expect(resolveAgentDriverGateway(gateway, "codex", context)).rejects.toThrow("Set CF_ACCESS_CLIENT_SECRET, or pass cloudflareAccess({ clientSecret })")
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", "env-secret")
    const unset = cliproxy({ url: "https://proxy.example", apiKey: "k", headers: cloudflareAccess({ clientSecret: undefined }) })
    await expect(resolveAgentDriverGateway(unset, "codex", context)).rejects.toThrow('header "CF-Access-Client-Secret" resolved to an empty value')
    const explicit = cliproxy({ url: "https://proxy.example", apiKey: "k", headers: cloudflareAccess({ clientId: "id", clientSecret: { unseal: () => "secret" } }) })
    expect((await resolveAgentDriverGateway(explicit, "codex", context)).environment).toMatchObject({ VITEHUB_GATEWAY_HEADER_0: "id", VITEHUB_GATEWAY_HEADER_1: "secret" })
  })

  it("declares optional Server Env for the presets that Agents use", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-gateway-env-"))
    try {
      await mkdir(join(root, "server", "agents", "dev"), { recursive: true })
      await mkdir(join(root, "server", "agents", "plain"), { recursive: true })
      await writeFile(join(root, "server", "agents", "dev", "agent.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { cliproxy, cloudflareAccess as access } from "vite-hub/gateways"`,
        `export default defineAgent({ driver: { kind: "codex", gateway: cliproxy({ headers: access() }) } })`,
      ].join("\n"))
      await mkdir(join(root, "server", "agents", "labels"), { recursive: true })
      await writeFile(join(root, "server", "agents", "labels", "agent.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { cloudflareTypesafe } from "vite-hub/gateways"`,
        `const gateway = cloudflareTypesafe()`,
        `export default defineAgent({ driver: { run: async ({ prompt }) => ({ output: await gateway.ask(prompt, {}) }) } })`,
      ].join("\n"))
      await writeFile(join(root, "server", "agents", "plain", "agent.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `const vercel = () => ({})`,
        `export default defineAgent({ driver: { kind: "codex", gateway: vercel() } })`,
      ].join("\n"))

      expect(discoverAgentGatewayEnv({ rootDir: root })).toEqual({
        cliproxy: {
          apiKey: { names: ["CLIPROXY_API_KEY"], required: false, secret: true },
          url: { names: ["CLIPROXY_URL"], required: false, secret: false },
        },
        cloudflareAccess: {
          clientId: { names: ["CF_ACCESS_CLIENT_ID"], required: false, secret: true },
          clientSecret: { names: ["CF_ACCESS_CLIENT_SECRET"], required: false, secret: true },
        },
        cloudflareTypesafe: {
          accountId: { names: ["CLOUDFLARE_ACCOUNT_ID"], required: false, secret: false },
          apiKey: { names: ["TYPESAFE_API_KEY"], required: false, secret: true },
          gatewayId: { names: ["CLOUDFLARE_AI_GATEWAY_ID"], required: false, secret: false },
          slug: { names: ["CLOUDFLARE_AI_GATEWAY_SLUG"], required: false, secret: false },
          token: { names: ["CLOUDFLARE_AI_GATEWAY_TOKEN"], required: false, secret: true },
        },
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("AI SDK models through a gateway", () => {
  it("runs an AI SDK model Driver on languageModel() without the Vercel AI Gateway", async () => {
    const model = languageModel(openrouter({ apiKey: "k" }), "google/gemini-3-flash")
    expect(() => defineAgent({ driver: { model } })).not.toThrow()
    await expect(materializeAgentModel(model, {})).resolves.toBe(model)
  })
})

describe("driver.gateway", () => {
  it("replaces inherited Codex credentials and reports the gateway", () => {
    const parent = defineAgent({ name: "stable", driver: { kind: "codex", credentials: () => "{}" } })
    const agent = defineAgent({ extends: parent, name: "dev", driver: { gateway: cliproxy({ url: "https://proxy.example", apiKey: "k" }) } })
    const metadata = createAgentInspectionMetadata(agent).config?.driver
    expect(metadata?.provider).toMatchObject({ gateway: "cliproxy" })
    expect(metadata?.provider).not.toHaveProperty("credentials")
    expect(metadata?.executionAuthority.credentials).toBe("provisioned")
  })

  it("skips credential-only rules for credentials that a gateway replaces", () => {
    const parent = defineAgent({ name: "stable", driver: { kind: "codex", credentials: () => "{}", credentialProfile: "stable" } })
    expect(() => defineAgent({
      extends: parent,
      name: "dev",
      driver: { gateway: cliproxy({ url: "https://proxy.example", apiKey: "k" }), providerSettings: { shadowHomePath: "/tmp/codex" }, env: { CODEX_HOME: "/tmp/codex" } },
    })).not.toThrow()
    const child = defineAgent({ extends: defineAgent({ name: "stable", driver: { kind: "codex", credentials: () => "{}" } }), name: "dev", driver: { gateway: cliproxy({ url: "https://proxy.example", apiKey: "k" }), sessionStorePath: ".vitehub/sessions.db" } })
    expect(createAgentInspectionMetadata(child).config?.driver.provider).toMatchObject({ gateway: "cliproxy", sessionStore: "sqlite" })
  })

  it("rejects a gateway that does not serve the Driver", () => {
    // @ts-expect-error The Claude Code Driver type accepts only gateways with a claude-code URL.
    expect(() => defineAgent({ driver: { kind: "claude-code", gateway: openai() } })).toThrow('Gateway "openai" does not serve the claude-code Driver')
    // @ts-expect-error The Codex Driver type accepts only gateways with a codex URL.
    expect(() => defineAgent({ driver: { kind: "codex", gateway: typesafe({ apiKey: "k" }) } })).toThrow('Gateway "typesafe" does not serve the codex Driver')
    // @ts-expect-error cloudflare() serves AI SDK models only.
    expect(() => defineAgent({ driver: { kind: "codex", gateway: cloudflare({ apiKey: "k" }) } })).toThrow('Gateway "cloudflare" does not serve the codex Driver')
    // @ts-expect-error cloudflareTypesafe() answers Jev questions only.
    expect(() => defineAgent({ driver: { kind: "codex", gateway: cloudflareTypesafe({ apiKey: "k" }) } })).toThrow('Gateway "cloudflareTypesafe" does not serve the codex Driver')
  })

  it("routes Driver requests through a gateway that also answers Jev questions", async () => {
    const gateway = vercel({ apiKey: "gateway-key" })
    expect(() => defineAgent({ driver: { kind: "codex", gateway } })).not.toThrow()
    expect((await resolveAgentDriverGateway(gateway, "codex", context)).environment).toEqual({ VITEHUB_GATEWAY_API_KEY: "gateway-key" })
  })

  it("rejects driver.env values that the gateway owns", () => {
    expect(() => normalizeAgentDriver({
      driver: { kind: "claude-code", env: { ANTHROPIC_BASE_URL: "https://other.example" }, gateway: vercel() },
    })).toThrow("driver.gateway }) sets ANTHROPIC_BASE_URL")
  })

  it("is not accepted by model drivers", () => {
    // SAFETY: This fixture sets a provider-only option on a model Driver to test runtime validation.
    expect(() => defineAgent({ driver: { model: "openai/gpt-5", gateway: vercel() } } as never)).toThrow()
  })
})
