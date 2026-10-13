import { agentDiagnostics } from "./agent-diagnostics.ts"
import { normalizeAgentDriverGateway } from "./internal/agent-gateway.ts"
import { gatewayEnvNames, gatewayEnvValue } from "./internal/gateway-env.ts"
import { hasRuntimeType, isRuntimeRecord } from "./internal/runtime-type.ts"
import type { BuiltInGatewayEnv } from "./internal/gateway-env.ts"
import type { AgentDriverGateway, AgentDriverGatewaySecret, AgentProviderCredentialContext } from "./types.ts"

export type { AgentDriverGateway, AgentDriverGatewaySecret } from "./types.ts"

/** Options shared by every gateway preset. */
export interface AgentGatewayPresetOptions {
  /** API key. When it is not set, the preset reads its Server Env value, such as `CLIPROXY_API_KEY`. */
  apiKey?: AgentDriverGatewaySecret
  /** Extra request headers, such as `cloudflareAccess()`. */
  headers?: Record<string, AgentDriverGatewaySecret>
}

/** Options for a gateway that you host. */
export interface AgentHostedGatewayOptions extends AgentGatewayPresetOptions {
  /** Origin of the gateway, such as `https://proxy.example.com`. A trailing `/v1` is removed. When it is not set, the preset reads its Server Env value, such as `CLIPROXY_URL`. */
  url?: string
}

/** Options for `cloudflareAccess()`. Each value defaults to its Server Env value. */
export interface CloudflareAccessOptions {
  /** Service token client ID. Defaults to `CF_ACCESS_CLIENT_ID`. */
  clientId?: AgentDriverGatewaySecret
  /** Service token client secret. Defaults to `CF_ACCESS_CLIENT_SECRET`. */
  clientSecret?: AgentDriverGatewaySecret
}

type GatewayField<TGateway extends keyof BuiltInGatewayEnv> = keyof BuiltInGatewayEnv[TGateway] & string

function origin(url: unknown, label: string): string {
  if (!hasRuntimeType(url, "string") || !url.trim()) throw agentDiagnostics.AGENT_R0975({ message: `[vitehub] ${label}({ url }) must be a non-empty URL.` })
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

function present(value: unknown): boolean {
  return isRuntimeRecord(value) || (hasRuntimeType(value, "string") && value.trim() !== "")
}

/** A resolver that reads one Server Env value and names its variables when the value is missing. */
function requiredEnv<TGateway extends keyof BuiltInGatewayEnv>(
  gateway: TGateway,
  field: GatewayField<TGateway>,
  missing: (names: string) => never,
): (context: AgentProviderCredentialContext) => Promise<unknown> {
  return async (context) => {
    const value = await gatewayEnvValue(gateway, field, context)
    return present(value) ? value : missing(gatewayEnvNames(gateway, field).join(" or "))
  }
}

function apiKeyFromEnv(gateway: keyof BuiltInGatewayEnv & ("anthropic" | "cliproxy" | "litellm" | "openai" | "openrouter" | "vercel")): AgentDriverGatewaySecret {
  // SAFETY: Server Env returns a string or a sealed secret for these fields, which resolveSecret accepts.
  return requiredEnv(gateway, "apiKey", (names) => {
    throw agentDiagnostics.AGENT_R0977({ message: `[vitehub] Gateway "${gateway}" needs an API key. Set ${names}, or pass apiKey.` })
  }) as AgentDriverGatewaySecret
}

/** Base URLs for a hosted gateway. Without `url`, each invocation reads it from Server Env. */
function hostedBaseURL(gateway: "cliproxy" | "litellm" | "ollama", url: string | undefined, fallback?: string): AgentDriverGateway["baseURL"] {
  if (url !== undefined || fallback !== undefined) {
    const root = origin(url ?? fallback, gateway)
    return { "codex": `${root}/v1`, "claude-code": root }
  }
  const read = requiredEnv(gateway, "url", (names) => {
    throw agentDiagnostics.AGENT_R0980({ message: `[vitehub] Gateway "${gateway}" needs a URL. Set ${names}, or pass url.` })
  })
  return {
    "codex": async context => `${origin(await read(context), gateway)}/v1`,
    "claude-code": async context => origin(await read(context), gateway),
  }
}

function preset(gateway: AgentDriverGateway, options: AgentGatewayPresetOptions | undefined): AgentDriverGateway {
  const value: AgentDriverGateway = { ...gateway }
  // A present apiKey replaces the preset variable even when it is undefined, so the invocation fails
  // instead of using another account from the environment.
  if (options && Object.hasOwn(options, "apiKey")) value.apiKey = options.apiKey
  if (options?.headers !== undefined) value.headers = options.headers
  return defineGateway(value)
}

/** Validate a custom gateway. Use it for an endpoint without a preset. */
export function defineGateway(gateway: AgentDriverGateway): AgentDriverGateway {
  return normalizeAgentDriverGateway(gateway)
}

/**
 * Cloudflare Access service-token headers for a gateway behind Access.
 * Reads `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` unless you pass the values.
 */
export function cloudflareAccess(options: CloudflareAccessOptions = {}): Record<string, AgentDriverGatewaySecret> {
  const fromEnv = (field: "clientId" | "clientSecret", header: string): AgentDriverGatewaySecret => {
    // SAFETY: Server Env returns a string or a sealed secret for these fields, which resolveSecret accepts.
    return requiredEnv("cloudflareAccess", field, (names) => {
      throw agentDiagnostics.AGENT_R0978({ message: `[vitehub] Gateway header "${header}" needs a value. Set ${names}, or pass cloudflareAccess({ ${field} }).` })
    }) as AgentDriverGatewaySecret
  }
  // A present option replaces its variable even when it is undefined, so the invocation fails instead.
  return {
    "CF-Access-Client-Id": Object.hasOwn(options, "clientId") ? options.clientId : fromEnv("clientId", "CF-Access-Client-Id"),
    "CF-Access-Client-Secret": Object.hasOwn(options, "clientSecret") ? options.clientSecret : fromEnv("clientSecret", "CF-Access-Client-Secret"),
  }
}

/** [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). Serves Codex and Claude Code. Reads `CLIPROXY_URL` and `CLIPROXY_API_KEY`. */
export function cliproxy(options: AgentHostedGatewayOptions = {}): AgentDriverGateway {
  return preset({ name: "cliproxy", baseURL: hostedBaseURL("cliproxy", options.url), apiKey: apiKeyFromEnv("cliproxy") }, options)
}

/** [LiteLLM Proxy](https://docs.litellm.ai/docs/simple_proxy). Serves Codex and Claude Code. Reads `LITELLM_URL` and `LITELLM_API_KEY`. */
export function litellm(options: AgentHostedGatewayOptions = {}): AgentDriverGateway {
  return preset({ name: "litellm", baseURL: hostedBaseURL("litellm", options.url), apiKey: apiKeyFromEnv("litellm") }, options)
}

/** [Ollama](https://docs.ollama.com). Serves Codex and Claude Code. Reads `OLLAMA_URL` and `OLLAMA_API_KEY`; defaults to `http://localhost:11434` without a key. */
export function ollama(options: AgentHostedGatewayOptions = {}): AgentDriverGateway {
  const read = (field: "apiKey" | "url") => async (context: AgentProviderCredentialContext) => {
    const value = await gatewayEnvValue("ollama", field, context)
    return present(value) ? value : undefined
  }
  const url = read("url")
  return preset({
    name: "ollama",
    baseURL: options.url !== undefined
      ? hostedBaseURL("ollama", options.url)
      : {
          "codex": async context => `${origin(await url(context) ?? "http://localhost:11434", "ollama")}/v1`,
          "claude-code": async context => origin(await url(context) ?? "http://localhost:11434", "ollama"),
        },
    // A local server does not check the key, but both CLIs need one to skip their own sign-in.
    // SAFETY: Server Env returns a string or a sealed secret for this field, which resolveSecret accepts.
    apiKey: (async (context: AgentProviderCredentialContext) => await read("apiKey")(context) ?? "ollama") as AgentDriverGatewaySecret,
  }, options)
}

/** [OpenRouter](https://openrouter.ai/docs). Serves Codex and Claude Code. Reads `OPENROUTER_API_KEY`. */
export function openrouter(options?: AgentGatewayPresetOptions): AgentDriverGateway {
  return preset({
    name: "openrouter",
    baseURL: { "codex": "https://openrouter.ai/api/v1", "claude-code": "https://openrouter.ai/api" },
    apiKey: apiKeyFromEnv("openrouter"),
  }, options)
}

/** [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/coding-agents). Serves Codex and Claude Code. Reads `AI_GATEWAY_API_KEY`, then `VERCEL_OIDC_TOKEN`. */
export function vercel(options?: AgentGatewayPresetOptions): AgentDriverGateway {
  return preset({
    name: "vercel",
    baseURL: { "codex": "https://ai-gateway.vercel.sh/codex/v1", "claude-code": "https://ai-gateway.vercel.sh/claude-code" },
    apiKey: apiKeyFromEnv("vercel"),
  }, options)
}

/** The OpenAI API with an API key. Serves Codex. Reads `OPENAI_API_KEY`. */
export function openai(options?: AgentGatewayPresetOptions): AgentDriverGateway {
  return preset({ name: "openai", baseURL: { codex: "https://api.openai.com/v1" }, apiKey: apiKeyFromEnv("openai") }, options)
}

/** The Anthropic API with an API key. Serves Claude Code. Reads `ANTHROPIC_API_KEY`. */
export function anthropic(options?: AgentGatewayPresetOptions): AgentDriverGateway {
  return preset({ name: "anthropic", baseURL: { "claude-code": "https://api.anthropic.com" }, apiKey: apiKeyFromEnv("anthropic"), auth: "x-api-key" }, options)
}
