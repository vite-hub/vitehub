import { agentDiagnostics } from "./agent-diagnostics.ts"
import { aiGatewayAsks, normalizeAgentDriverGateway, resolveSecret } from "./internal/agent-gateway.ts"
import { askJev, cloudflareJevBaseURL } from "./internal/ask-runtime.ts"
import { gatewayEnvNames, gatewayEnvValue } from "./internal/gateway-env.ts"
import { hasRuntimeType, isRuntimeRecord } from "./internal/runtime-type.ts"
import type { JevRoute } from "./internal/ask-runtime.ts"
import type { BuiltInGatewayEnv } from "./internal/gateway-env.ts"
import type { AgentProviderCredentialContext, AiGateway, AiGatewayAsk, AiGatewayDefinition, AiGatewaySecret } from "./types.ts"

export type { AiGateway, AiGatewayAsk, AiGatewayAskOptions, AiGatewayCapabilities, AiGatewayDefinition, AiGatewaySecret } from "./types.ts"

/** Options shared by every gateway preset. */
export interface AiGatewayPresetOptions {
  /** API key. When it is not set, the preset reads its Server Env value, such as `CLIPROXY_API_KEY`. */
  apiKey?: AiGatewaySecret
  /** Extra request headers, such as `cloudflareAccess()`. */
  headers?: Record<string, AiGatewaySecret>
}

/** Options for a gateway that you host. */
export interface AiHostedGatewayOptions extends AiGatewayPresetOptions {
  /** Origin of the gateway, such as `https://proxy.example.com`. A trailing `/v1` is removed. When it is not set, the preset reads its Server Env value, such as `CLIPROXY_URL`. */
  url?: string
}

/** Options for a gateway that answers TypeSafe Jev questions. */
export interface AiAskGatewayOptions {
  /** Custom fetch implementation for Jev requests. Default: `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch
  /** Jev model ID for `ask()`. Default: `jev-latest`, or `typesafe-ai/jev` through Vercel AI Gateway. */
  model?: string
}

/** Options for `typesafe()`. */
export interface TypesafeGatewayOptions extends AiAskGatewayOptions, AiGatewayPresetOptions {}

/** Options for `vercel()`. `model` selects the Jev model of `ask()`; Driver models come from `driver.model`. */
export interface VercelGatewayOptions extends AiAskGatewayOptions, AiGatewayPresetOptions {}

/** Options for `cloudflare()`. Each value defaults to its Server Env value. */
export interface CloudflareGatewayOptions extends AiAskGatewayOptions {
  /** Cloudflare account ID. Defaults to `CLOUDFLARE_ACCOUNT_ID`. */
  accountId?: string
  /** TypeSafe API key that the gateway forwards. Defaults to `TYPESAFE_API_KEY`. */
  apiKey?: AiGatewaySecret
  /** AI Gateway ID. Defaults to `CLOUDFLARE_AI_GATEWAY_ID`. */
  gatewayId?: string
  /** Custom provider slug; the gateway URL uses `custom-<slug>`. Defaults to `CLOUDFLARE_AI_GATEWAY_SLUG`, then `typesafe`. */
  slug?: string
  /** Gateway token of an authenticated gateway, sent as `cf-aig-authorization`. Defaults to `CLOUDFLARE_AI_GATEWAY_TOKEN`. */
  token?: AiGatewaySecret
}

/** Options for `cloudflareAccess()`. Each value defaults to its Server Env value. */
export interface CloudflareAccessOptions {
  /** Service token client ID. Defaults to `CF_ACCESS_CLIENT_ID`. */
  clientId?: AiGatewaySecret
  /** Service token client secret. Defaults to `CF_ACCESS_CLIENT_SECRET`. */
  clientSecret?: AiGatewaySecret
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

function apiKeyFromEnv(gateway: keyof BuiltInGatewayEnv & ("anthropic" | "cliproxy" | "cloudflare" | "litellm" | "openai" | "openrouter" | "typesafe" | "vercel")): AiGatewaySecret {
  // SAFETY: Server Env returns a string or a sealed secret for these fields, which resolveSecret accepts.
  return requiredEnv(gateway, "apiKey", (names) => {
    throw agentDiagnostics.AGENT_R0977({ message: `[vitehub] Gateway "${gateway}" needs an API key. Set ${names}, or pass apiKey.` })
  }) as AiGatewaySecret
}

/** Base URLs for a hosted gateway. Without `url`, each invocation reads it from Server Env. */
function hostedBaseURL(gateway: "cliproxy" | "litellm" | "ollama", url: string | undefined, fallback?: string): AiGatewayDefinition["baseURL"] {
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


/** How a gateway answers Jev questions. Secrets resolve for each `ask()` call. */
interface JevAskSpec {
  apiKey: AiGatewaySecret
  baseURL: () => Promise<string>
  fetch?: typeof globalThis.fetch
  /** Header values that may resolve to nothing, such as the token of an open gateway. */
  headers?: Record<string, AiGatewaySecret>
  /** The variables that hold the key, for the fix of a rejected key. Undefined when the caller passed it. */
  keyEnv?: string
  label: string
  model: string
  protocol: JevRoute["protocol"]
  /** Vercel: without its own key, advocaat signs in with VERCEL_OIDC_TOKEN. */
  oidc?: boolean
}

function askContext(signal: AbortSignal | undefined): AgentProviderCredentialContext {
  // SAFETY: Jev requests run outside an Invocation. Preset resolvers read only the abort signal and the host Env.
  return { abortSignal: signal } as AgentProviderCredentialContext
}

function jevAsk(name: string, spec: JevAskSpec): AiGatewayAsk {
  return async (state, questions, { onUsage, signal } = {}) => await askJev({
    ...(signal ? { abortSignal: signal } : {}),
    ...(onUsage ? { recordUsage: onUsage } : {}),
    route: async () => {
      const context = askContext(signal)
      const resolvedKey = await resolveSecret(spec.apiKey, context)
      // A Vercel OIDC token signs in as OIDC, not as an AI Gateway key.
      const apiKey = spec.oidc && resolvedKey === globalThis.process?.env?.VERCEL_OIDC_TOKEN?.trim() ? undefined : resolvedKey
      if (!apiKey && !spec.oidc) throw agentDiagnostics.AGENT_R0977({ message: `[vitehub] Gateway "${name}" apiKey resolved to an empty value.` })
      const headers: Record<string, string> = {}
      for (const [header, input] of Object.entries(spec.headers ?? {})) {
        const value = await resolveSecret(input, context)
        if (value) headers[header] = value
      }
      return {
        ...(apiKey ? { apiKey } : {}),
        baseURL: await spec.baseURL(),
        ...(spec.fetch ? { fetch: spec.fetch } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(spec.keyEnv ? { keyEnv: spec.keyEnv } : {}),
        label: spec.label,
        model: spec.model,
        name,
        protocol: spec.protocol,
      }
    },
  }, state, questions)
}

function unsupportedAsk(name: string): AiGatewayAsk {
  return async () => {
    throw agentDiagnostics.AGENT_R1013({ message: `[vitehub] Gateway "${name}" routes Driver model requests and cannot answer Jev questions. Use typesafe(), vercel(), or cloudflare() for ask().` })
  }
}

function createAiGateway(definition: AiGatewayDefinition, ask?: AiGatewayAsk): AiGateway {
  const routes = normalizeAgentDriverGateway(ask ? Object.defineProperty({ ...definition }, aiGatewayAsks, { value: true }) : definition)
  const gateway = { ...routes }
  // Not enumerable, so copies and `driver.gateway` keep only the Driver routes.
  Object.defineProperty(gateway, "ask", { value: ask ?? unsupportedAsk(routes.name) })
  if (ask) Object.defineProperty(gateway, aiGatewayAsks, { value: true })
  return Object.freeze(gateway)
}

function preset(definition: AiGatewayDefinition, options: AiGatewayPresetOptions | undefined): AiGatewayDefinition {
  const value: AiGatewayDefinition = { ...definition }
  // A present apiKey replaces the preset variable even when it is undefined, so the invocation fails
  // instead of using another account from the environment.
  if (options && Object.hasOwn(options, "apiKey")) value.apiKey = options.apiKey
  if (options?.headers !== undefined) value.headers = options.headers
  return value
}

/** Variables of the key, or undefined when the caller passed it. */
function keyEnv(gateway: keyof BuiltInGatewayEnv, options: { apiKey?: unknown } | undefined): string | undefined {
  return options && Object.hasOwn(options, "apiKey") ? undefined : gatewayEnvNames(gateway, "apiKey" as never).join(" or ")
}

/**
 * Validate a custom gateway for an endpoint without a preset. It routes Driver model requests; only the `typesafe()`,
 * `vercel()`, and `cloudflare()` presets answer Jev questions.
 */
export function defineAiGateway(gateway: AiGatewayDefinition): AiGateway<{ ask: false }> {
  // SAFETY: Without an ask route, createAiGateway attaches the diagnostic that the type rejects.
  return createAiGateway(gateway) as AiGateway<{ ask: false }>
}

/**
 * Cloudflare Access service-token headers for a gateway behind Access.
 * Reads `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` unless you pass the values.
 */
export function cloudflareAccess(options: CloudflareAccessOptions = {}): Record<string, AiGatewaySecret> {
  const fromEnv = (field: "clientId" | "clientSecret", header: string): AiGatewaySecret => {
    // SAFETY: Server Env returns a string or a sealed secret for these fields, which resolveSecret accepts.
    return requiredEnv("cloudflareAccess", field, (names) => {
      throw agentDiagnostics.AGENT_R0978({ message: `[vitehub] Gateway header "${header}" needs a value. Set ${names}, or pass cloudflareAccess({ ${field} }).` })
    }) as AiGatewaySecret
  }
  // A present option replaces its variable even when it is undefined, so the invocation fails instead.
  return {
    "CF-Access-Client-Id": Object.hasOwn(options, "clientId") ? options.clientId : fromEnv("clientId", "CF-Access-Client-Id"),
    "CF-Access-Client-Secret": Object.hasOwn(options, "clientSecret") ? options.clientSecret : fromEnv("clientSecret", "CF-Access-Client-Secret"),
  }
}

/** [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). Serves Codex and Claude Code. Reads `CLIPROXY_URL` and `CLIPROXY_API_KEY`. */
export function cliproxy(options: AiHostedGatewayOptions = {}): AiGateway<{ ask: false }> {
  return defineAiGateway(preset({ name: "cliproxy", baseURL: hostedBaseURL("cliproxy", options.url), apiKey: apiKeyFromEnv("cliproxy") }, options))
}

/** [LiteLLM Proxy](https://docs.litellm.ai/docs/simple_proxy). Serves Codex and Claude Code. Reads `LITELLM_URL` and `LITELLM_API_KEY`. */
export function litellm(options: AiHostedGatewayOptions = {}): AiGateway<{ ask: false }> {
  return defineAiGateway(preset({ name: "litellm", baseURL: hostedBaseURL("litellm", options.url), apiKey: apiKeyFromEnv("litellm") }, options))
}

/** [Ollama](https://docs.ollama.com). Serves Codex and Claude Code. Reads `OLLAMA_URL` and `OLLAMA_API_KEY`; defaults to `http://localhost:11434` without a key. */
export function ollama(options: AiHostedGatewayOptions = {}): AiGateway<{ ask: false }> {
  const read = (field: "apiKey" | "url") => async (context: AgentProviderCredentialContext) => {
    const value = await gatewayEnvValue("ollama", field, context)
    return present(value) ? value : undefined
  }
  const url = read("url")
  return defineAiGateway(preset({
    name: "ollama",
    baseURL: options.url !== undefined
      ? hostedBaseURL("ollama", options.url)
      : {
          "codex": async context => `${origin(await url(context) ?? "http://localhost:11434", "ollama")}/v1`,
          "claude-code": async context => origin(await url(context) ?? "http://localhost:11434", "ollama"),
        },
    // A local server does not check the key, but both CLIs need one to skip their own sign-in.
    // SAFETY: Server Env returns a string or a sealed secret for this field, which resolveSecret accepts.
    apiKey: (async (context: AgentProviderCredentialContext) => await read("apiKey")(context) ?? "ollama") as AiGatewaySecret,
  }, options))
}

/** [OpenRouter](https://openrouter.ai/docs). Serves Codex and Claude Code. Reads `OPENROUTER_API_KEY`. */
export function openrouter(options?: AiGatewayPresetOptions): AiGateway<{ ask: false }> {
  return defineAiGateway(preset({
    name: "openrouter",
    baseURL: { "codex": "https://openrouter.ai/api/v1", "claude-code": "https://openrouter.ai/api" },
    apiKey: apiKeyFromEnv("openrouter"),
  }, options))
}

/**
 * [Vercel AI Gateway](https://vercel.com/docs/ai-gateway). Serves Codex and Claude Code, and answers Jev questions as
 * `typesafe-ai/jev`. Reads `AI_GATEWAY_API_KEY`, then `VERCEL_OIDC_TOKEN`.
 */
export function vercel(options?: VercelGatewayOptions): AiGateway<{ ask: true }> {
  const definition = preset({
    name: "vercel",
    baseURL: { "codex": "https://ai-gateway.vercel.sh/codex/v1", "claude-code": "https://ai-gateway.vercel.sh/claude-code" },
    apiKey: apiKeyFromEnv("vercel"),
  }, options)
  const ask = jevAsk("vercel", {
    apiKey: definition.apiKey,
    baseURL: async () => "https://ai-gateway.vercel.sh/v4/ai",
    ...(options?.fetch ? { fetch: options.fetch } : {}),
    ...(definition.headers ? { headers: definition.headers } : {}),
    ...(keyEnv("vercel", options) ? { keyEnv: keyEnv("vercel", options) } : {}),
    label: "Vercel AI Gateway",
    model: options?.model?.trim() || "typesafe-ai/jev",
    oidc: !(options && Object.hasOwn(options, "apiKey")),
    protocol: "vercel",
  })
  // SAFETY: createAiGateway attaches the ask route built above.
  return createAiGateway(definition, ask) as AiGateway<{ ask: true }>
}

/** The OpenAI API with an API key. Serves Codex. Reads `OPENAI_API_KEY`. */
export function openai(options?: AiGatewayPresetOptions): AiGateway<{ ask: false }> {
  return defineAiGateway(preset({ name: "openai", baseURL: { codex: "https://api.openai.com/v1" }, apiKey: apiKeyFromEnv("openai") }, options))
}

/** The Anthropic API with an API key. Serves Claude Code. Reads `ANTHROPIC_API_KEY`. */
export function anthropic(options?: AiGatewayPresetOptions): AiGateway<{ ask: false }> {
  return defineAiGateway(preset({ name: "anthropic", baseURL: { "claude-code": "https://api.anthropic.com" }, apiKey: apiKeyFromEnv("anthropic"), auth: "x-api-key" }, options))
}

/** [TypeSafe](https://typesafe.ai). Answers Jev questions; it serves no Driver. Reads `TYPESAFE_API_KEY`. */
export function typesafe(options?: TypesafeGatewayOptions): AiGateway<{ ask: true }> {
  const definition = preset({ name: "typesafe", baseURL: {}, apiKey: apiKeyFromEnv("typesafe") }, options)
  const ask = jevAsk("typesafe", {
    apiKey: definition.apiKey,
    baseURL: async () => "https://api.typesafe.ai",
    ...(options?.fetch ? { fetch: options.fetch } : {}),
    ...(definition.headers ? { headers: definition.headers } : {}),
    ...(keyEnv("typesafe", options) ? { keyEnv: keyEnv("typesafe", options) } : {}),
    label: "TypeSafe",
    model: options?.model?.trim() || "jev-latest",
    protocol: "typesafe",
  })
  // SAFETY: createAiGateway attaches the ask route built above.
  return createAiGateway(definition, ask) as AiGateway<{ ask: true }>
}

/**
 * TypeSafe through a [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
 * custom provider whose base URL is `https://api.typesafe.ai`. Answers Jev questions; it serves no Driver. Reads
 * `TYPESAFE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_GATEWAY_TOKEN`, and
 * `CLOUDFLARE_AI_GATEWAY_SLUG`.
 */
export function cloudflare(options: CloudflareGatewayOptions = {}): AiGateway<{ ask: true }> {
  const definition = preset({ name: "cloudflare", baseURL: {}, apiKey: apiKeyFromEnv("cloudflare") }, options)
  const value = async (field: "accountId" | "gatewayId" | "slug", given: string | undefined) => {
    if (given !== undefined) return given.trim()
    const read = await gatewayEnvValue("cloudflare", field, askContext(undefined))
    return hasRuntimeType(read, "string") ? read.trim() : ""
  }
  const required = async (field: "accountId" | "gatewayId", given: string | undefined) => {
    const resolved = await value(field, given)
    if (resolved) return resolved
    const label = field === "accountId" ? "an account ID" : "a gateway ID"
    throw agentDiagnostics.AGENT_R0980({ message: `[vitehub] Gateway "cloudflare" needs ${label}. Set ${gatewayEnvNames("cloudflare", field).join(" or ")}, or pass ${field}.` })
  }
  // An open gateway has no token, so a missing one is left out instead of failing.
  const token: AiGatewaySecret = Object.hasOwn(options, "token")
    ? options.token
    : async context => await gatewayEnvValue("cloudflare", "token", context) as string | undefined
  const ask = jevAsk("cloudflare", {
    apiKey: definition.apiKey,
    baseURL: async () => cloudflareJevBaseURL({
      accountId: await required("accountId", options.accountId),
      gatewayId: await required("gatewayId", options.gatewayId),
      slug: await value("slug", options.slug),
    }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    headers: { "cf-aig-authorization": async (context: AgentProviderCredentialContext) => {
      const resolved = await resolveSecret(token, context)
      return resolved ? `Bearer ${resolved}` : undefined
    } },
    ...(Object.hasOwn(options, "apiKey") ? {} : { keyEnv: "TYPESAFE_API_KEY or CLOUDFLARE_AI_GATEWAY_TOKEN" }),
    label: "Cloudflare AI Gateway",
    model: options.model?.trim() || "jev-latest",
    protocol: "typesafe",
  })
  // SAFETY: createAiGateway attaches the ask route built above.
  return createAiGateway(definition, ask) as AiGateway<{ ask: true }>
}
