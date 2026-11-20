import { cloudflareJevBaseURL, askJev } from "./jev.ts"
import { aiGatewayAsks, aiGatewayModelCredentials, aiGatewayOptionalCredentials, aiGatewayStructuredOutputs, isRecord, normalizeAiGateway, resolveAiGatewaySecret } from "./definition.ts"
import { gatewayDiagnostics } from "./diagnostics.ts"
import { aiGatewayVendorNames, readAiGatewayEnv } from "./env.ts"

import type { AskQuestions } from "./ask.ts"
import type { AiGatewayEnvFieldName, AiGatewayEnvPreset } from "./env.ts"
import type { JevRequestContext, JevRoute } from "./jev.ts"
import type { AiGatewayModelCredentialsResolver, AiGatewayOptionalCredentials } from "./definition.ts"
import type { AiGateway, AiGatewayCapabilities, AiGatewayAsk, AiGatewayAskResult, AiGatewayContext, AiGatewayDefinition, AiGatewayRoute, AiGatewaySealedSecret, AiGatewaySecret, AiGatewayUsage, AiGatewayValue } from "./types.ts"

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

/** Options for `emulate()`. */
export interface EmulateGatewayOptions {
  /** Origin of the AI emulator, such as `http://localhost:4014`. A trailing `/v1` is removed. When it is not set, the preset reads `VITEHUB_EMULATE_URL`, then uses `http://localhost:4014`. */
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
  /** A Cloudflare gateway reads two keys. Pass `typesafeApiKey` for `ask()` or `providerApiKey` for models. */
  apiKey?: never
  /** AI Gateway ID. Defaults to `CLOUDFLARE_AI_GATEWAY_ID`. */
  gatewayId?: string
  /** Extra request headers, such as `cloudflareAccess()`. */
  headers?: Record<string, AiGatewaySecret>
  /**
   * Provider key of model requests, sent as `Authorization: Bearer`. Defaults to `CLOUDFLARE_AI_GATEWAY_API_KEY`. Leave it
   * unset when the gateway stores the provider keys or uses Unified Billing; the gateway token then authenticates.
   */
  providerApiKey?: AiGatewaySecret
  /** Custom provider slug of `ask()`; the gateway URL uses `custom-<slug>`. Defaults to `CLOUDFLARE_AI_GATEWAY_SLUG`, then `typesafe`. */
  slug?: string
  /** Gateway token of an authenticated gateway, sent as `cf-aig-authorization`. Defaults to `CLOUDFLARE_AI_GATEWAY_TOKEN`. */
  token?: AiGatewaySecret
  /** TypeSafe API key that the gateway forwards for `ask()`. Defaults to `TYPESAFE_API_KEY`. */
  typesafeApiKey?: AiGatewaySecret
}

/** Options for `cloudflareAccess()`. Each value defaults to its Server Env value. */
export interface CloudflareAccessOptions {
  /** Service token client ID. Defaults to `CF_ACCESS_CLIENT_ID`. */
  clientId?: AiGatewaySecret
  /** Service token client secret. Defaults to `CF_ACCESS_CLIENT_SECRET`. */
  clientSecret?: AiGatewaySecret
}


function origin(url: unknown, label: string): string {
  if (typeof url !== "string" || !url.trim()) throw gatewayDiagnostics.GATEWAYS_R0001({ message: `[vitehub] ${label}({ url }) must be a non-empty URL.` })
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

function present(value: unknown): boolean {
  return isRecord(value) || (typeof value === "string" && value.trim() !== "")
}

function requiredEnv<TPreset extends AiGatewayEnvPreset>(
  preset: TPreset,
  field: AiGatewayEnvFieldName<TPreset>,
  missing: (names: string) => never,
): (context: AiGatewayContext) => Promise<unknown> {
  return async (context) => {
    const value = await readAiGatewayEnv(context, preset, field)
    return present(value) ? value : missing(aiGatewayVendorNames(preset, field).join(" or "))
  }
}

function apiKeyFromEnv(gateway: "anthropic" | "cliproxy" | "litellm" | "openai" | "openrouter" | "typesafe" | "vercel"): AiGatewaySecret {
  // SAFETY: The environment holds a string or a sealed secret for these fields, which resolveAiGatewaySecret accepts.
  return requiredEnv(gateway, "apiKey", (names) => {
    throw gatewayDiagnostics.GATEWAYS_R0002({ message: `[vitehub] Gateway "${gateway}" needs an API key. Set ${names}, or pass apiKey.` })
  }) as AiGatewaySecret
}

type HostedRoutes = "claude-code" | "codex" | "openai-compatible"

function hostedBaseURL(gateway: "cliproxy" | "litellm" | "ollama", url: string | undefined, fallback?: string): Record<HostedRoutes, AiGatewayValue<string>> {
  if (url !== undefined || fallback !== undefined) {
    const root = origin(url ?? fallback, gateway)
    return { "codex": `${root}/v1`, "claude-code": root, "openai-compatible": `${root}/v1` }
  }
  const read = requiredEnv(gateway, "url", (names) => {
    throw gatewayDiagnostics.GATEWAYS_R0004({ message: `[vitehub] Gateway "${gateway}" needs a URL. Set ${names}, or pass url.` })
  })
  return {
    "codex": async context => `${origin(await read(context), gateway)}/v1`,
    "claude-code": async context => origin(await read(context), gateway),
    "openai-compatible": async context => `${origin(await read(context), gateway)}/v1`,
  }
}


interface JevAskSpec {
  apiKey: AiGatewaySecret
  baseURL: (context: AiGatewayContext) => Promise<string>
  fetch?: typeof globalThis.fetch
  headers?: Record<string, AiGatewaySecret>
  optionalHeaders?: Record<string, AiGatewaySecret>
  keyEnv?: string
  keyOption?: string
  label: string
  model: string | ((context: AiGatewayContext) => Promise<string>)
  protocol: JevRoute["protocol"]
  oidcToken?: AiGatewaySecret
}

/** The route resolver of an ask gateway. ViteHub Agents call it with their Server Env context. */
export const aiGatewayAskRoute: unique symbol = Symbol.for("vitehub.aiGateway.askRoute")

type AskRouteResolver = (context: AiGatewayContext) => Promise<JevRoute>

function jevRoute(name: string, spec: JevAskSpec): AskRouteResolver {
  return async (context) => {
      const resolvedKey = await resolveAiGatewaySecret(spec.apiKey, context)
      const oidcToken = resolvedKey ? undefined : await resolveAiGatewaySecret(spec.oidcToken, context)
      const apiKey = resolvedKey ?? oidcToken
      if (!apiKey) throw gatewayDiagnostics.GATEWAYS_R0002({ message: spec.keyEnv
        ? `[vitehub] Gateway "${name}" needs an API key. Set ${spec.keyEnv}, or pass apiKey.`
        : `[vitehub] Gateway "${name}" apiKey resolved to an empty value.` })
      const headers: Record<string, string> = {}
      for (const [header, input] of Object.entries(spec.optionalHeaders ?? {})) {
        const value = await resolveAiGatewaySecret(input, context)
        if (value) headers[header] = value
      }
      for (const [header, input] of Object.entries(spec.headers ?? {})) {
        const value = await resolveAiGatewaySecret(input, context)
        if (!value) throw gatewayDiagnostics.GATEWAYS_R0003({ message: `[vitehub] Gateway "${name}" header "${header}" resolved to an empty value.` })
        if (/[\r\n]/.test(value)) throw gatewayDiagnostics.GATEWAYS_R0003({ message: `[vitehub] Gateway "${name}" header "${header}" must not contain line breaks.` })
        headers[header] = value
      }
      if (oidcToken) headers["ai-gateway-auth-method"] = "oidc"
      return {
        ...(apiKey ? { apiKey } : {}),
        baseURL: await spec.baseURL(context),
        ...(spec.fetch ? { fetch: spec.fetch } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(spec.keyEnv ? { keyEnv: spec.keyEnv } : {}),
        ...(spec.keyOption ? { keyOption: spec.keyOption } : {}),
        label: spec.label,
        model: typeof spec.model === "string" ? spec.model : await spec.model(context),
        name,
        protocol: spec.protocol,
      }
  }
}

/** Asks through a gateway with a resolver context, observers, and usage records. ViteHub Agents use it for `driver.ask`. */
export async function askAiGateway<const Q extends AskQuestions>(
  gateway: AiGateway,
  state: unknown,
  questions: Q,
  options: { context?: AiGatewayContext, observe?: JevRequestContext["observe"], onUsage?: (usage: AiGatewayUsage) => void, signal?: AbortSignal } = {},
): Promise<AiGatewayAskResult<Q>> {
  const route: unknown = Reflect.get(gateway, aiGatewayAskRoute)
  if (typeof route !== "function") return await unsupportedAsk(gateway.name)(state, questions)
  const context: AiGatewayContext = { ...options.context, ...(options.signal ? { abortSignal: options.signal } : {}) }
  return await askJev({
    ...(options.signal ? { abortSignal: options.signal } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
    ...(options.onUsage ? { recordUsage: options.onUsage } : {}),
    // SAFETY: Only createAiGateway sets this symbol, with an AskRouteResolver.
    route: async () => await (route as AskRouteResolver)(context),
  }, state, questions)
}

function unsupportedAsk(name: string): AiGatewayAsk {
  return async () => {
    throw gatewayDiagnostics.GATEWAYS_R0005({ message: `[vitehub] Gateway "${name}" routes model requests and cannot answer Jev questions. Use typesafe(), vercel(), or cloudflare() for ask().` })
  }
}

interface AiGatewayExtras {
  route?: AskRouteResolver
  optional?: AiGatewayOptionalCredentials
  modelApis?: readonly AiGatewayCapabilities["apis"][]
  modelCredentials?: AiGatewayModelCredentialsResolver
  structuredOutputs?: true
}

function createAiGateway(definition: AiGatewayDefinition, { route, optional, modelApis, modelCredentials, structuredOutputs }: AiGatewayExtras = {}): AiGateway {
  const routes = normalizeAiGateway(route ? Object.defineProperty({ ...definition }, aiGatewayAsks, { value: true }) : definition)
  const gateway: AiGateway = { ...routes }
  if (modelApis) Object.defineProperty(gateway, "modelApis", { value: Object.freeze([...modelApis]) })
  if (optional) Object.defineProperty(gateway, aiGatewayOptionalCredentials, { value: Object.freeze({ ...optional, headers: Object.freeze([...optional.headers]) }) })
  if (modelCredentials) Object.defineProperty(gateway, aiGatewayModelCredentials, { value: modelCredentials })
  if (structuredOutputs) Object.defineProperty(gateway, aiGatewayStructuredOutputs, { value: true })
  Object.defineProperty(gateway, "ask", {
    value: route
      ? (async (state, questions, options = {}) => await askAiGateway(gateway, state, questions, options)) satisfies AiGatewayAsk
      : unsupportedAsk(routes.name),
  })
  if (route) Object.defineProperties(gateway, { [aiGatewayAsks]: { value: true }, [aiGatewayAskRoute]: { value: route } })
  return Object.freeze(gateway)
}

type AiRoutedGatewayDefinition<TRoutes extends AiGatewayRoute> = AiGatewayDefinition & { baseURL: Record<TRoutes, AiGatewayValue<string>> }

function preset<TRoutes extends AiGatewayRoute>(definition: AiRoutedGatewayDefinition<TRoutes>, options: AiGatewayPresetOptions | undefined): AiRoutedGatewayDefinition<TRoutes> {
  const value: AiRoutedGatewayDefinition<TRoutes> = { ...definition }
  if (options && Object.hasOwn(options, "apiKey")) value.apiKey = options.apiKey
  if (options?.headers !== undefined) value.headers = options.headers
  return value
}

function keyEnv(preset: "typesafe" | "vercel", options: { apiKey?: unknown } | undefined): string | undefined {
  if (options && Object.hasOwn(options, "apiKey")) return undefined
  return [...aiGatewayVendorNames(preset, "apiKey"), ...(preset === "vercel" ? aiGatewayVendorNames(preset, "oidcToken") : [])].join(" or ")
}

/** A gateway that routes model requests to `TRoutes` and has no `ask()`. */
export type AiModelGateway<TRoutes extends AiGatewayRoute> = AiGateway<{ ask: false, routes: TRoutes }>

function modelGateway<TRoutes extends AiGatewayRoute>(definition: AiRoutedGatewayDefinition<TRoutes>, extras?: Omit<AiGatewayExtras, "route">): AiModelGateway<TRoutes> {
  // SAFETY: Without an ask route, createAiGateway attaches the diagnostic that the type rejects. The baseURL has the TRoutes keys, and normalizeAiGateway keeps them.
  return createAiGateway(definition, extras) as AiModelGateway<TRoutes>
}

/**
 * Validate a custom gateway for an endpoint without a preset. Its type lists the model APIs in `baseURL`. It routes
 * model requests; only the `typesafe()`, `vercel()`, and `cloudflare()` presets answer Jev questions.
 */
export function defineAiGateway<const TRoutes extends AiGatewayRoute>(
  gateway: Omit<AiGatewayDefinition, "baseURL"> & { baseURL: Record<TRoutes, AiGatewayValue<string>> },
): AiModelGateway<TRoutes> {
  return modelGateway<TRoutes>(gateway)
}

/**
 * Cloudflare Access service-token headers for a gateway behind Access.
 * Reads `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` unless you pass the values.
 */
export function cloudflareAccess(options: CloudflareAccessOptions = {}): Record<string, AiGatewaySecret> {
  const fromEnv = (field: "clientId" | "clientSecret", header: string): AiGatewaySecret => {
    // SAFETY: The environment holds a string or a sealed secret for these fields, which resolveAiGatewaySecret accepts.
    return requiredEnv("cloudflareAccess", field, (names) => {
      throw gatewayDiagnostics.GATEWAYS_R0003({ message: `[vitehub] Gateway header "${header}" needs a value. Set ${names}, or pass cloudflareAccess({ ${field} }).` })
    }) as AiGatewaySecret
  }
  return {
    "CF-Access-Client-Id": Object.hasOwn(options, "clientId") ? options.clientId : fromEnv("clientId", "CF-Access-Client-Id"),
    "CF-Access-Client-Secret": Object.hasOwn(options, "clientSecret") ? options.clientSecret : fromEnv("clientSecret", "CF-Access-Client-Secret"),
  }
}

/** [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). Serves Codex and Claude Code. Reads `CLIPROXY_URL` and `CLIPROXY_API_KEY`. */
export function cliproxy(options: AiHostedGatewayOptions = {}): AiModelGateway<HostedRoutes> {
  return modelGateway<HostedRoutes>(preset({ name: "cliproxy", baseURL: hostedBaseURL("cliproxy", options.url), apiKey: apiKeyFromEnv("cliproxy") }, options))
}

/** [LiteLLM Proxy](https://docs.litellm.ai/docs/simple_proxy). Serves Codex and Claude Code. Reads `LITELLM_URL` and `LITELLM_API_KEY`. */
export function litellm(options: AiHostedGatewayOptions = {}): AiModelGateway<HostedRoutes> {
  return modelGateway<HostedRoutes>(preset({ name: "litellm", baseURL: hostedBaseURL("litellm", options.url), apiKey: apiKeyFromEnv("litellm") }, options))
}

/** [Ollama](https://docs.ollama.com). Serves Codex and Claude Code. Reads `OLLAMA_URL` and `OLLAMA_API_KEY`; defaults to `http://localhost:11434` without a key. */
export function ollama(options: AiHostedGatewayOptions = {}): AiModelGateway<HostedRoutes> {
  const read = (field: "apiKey" | "url") => async (context: AiGatewayContext) => {
    const value = await readAiGatewayEnv(context, "ollama", field)
    return present(value) ? value : undefined
  }
  const url = read("url")
  const root = async (context: AiGatewayContext) => origin(await url(context) ?? "http://localhost:11434", "ollama")
  return modelGateway<HostedRoutes>(preset({
    name: "ollama",
    baseURL: options.url !== undefined
      ? hostedBaseURL("ollama", options.url)
      : {
          "codex": async context => `${await root(context)}/v1`,
          "claude-code": root,
          "openai-compatible": async context => `${await root(context)}/v1`,
        },
    // SAFETY: The environment holds a string or a sealed secret for this field, which resolveAiGatewaySecret accepts.
    apiKey: (async (context: AiGatewayContext) => await read("apiKey")(context) ?? "ollama") as AiGatewaySecret,
  }, options))
}

type EmulateRoutes = "claude-code" | "openai-compatible"

/**
 * The [AI emulator](https://emulate.dev/docs/ai) (`@emulators/ai`) for dev and tests. Serves AI SDK models with OpenAI
 * Chat Completions (`api: "chat"`), OpenAI Responses (`"responses"`), and Anthropic Messages (`"messages"`), and answers
 * from scripted rules with no AI key. It does not serve the Claude Code Driver, because the emulator rejects its `system`
 * turns, or the Codex Driver, because the emulator rejects the tools that the Codex CLI sends. Reads
 * `VITEHUB_EMULATE_URL`; defaults to `http://localhost:4014`. It reads no credentials.
 */
export function emulate(options: EmulateGatewayOptions = {}): AiModelGateway<EmulateRoutes> {
  const root = async (context: AiGatewayContext) => {
    const value = await readAiGatewayEnv(context, "emulate", "url")
    return origin(present(value) ? value : "http://localhost:4014", "emulate")
  }
  const url = options.url !== undefined ? origin(options.url, "emulate") : undefined
  return modelGateway<EmulateRoutes>({
    name: "emulate",
    baseURL: url !== undefined
      ? { "claude-code": url, "openai-compatible": `${url}/v1` }
      : { "claude-code": root, "openai-compatible": async context => `${await root(context)}/v1` },
    apiKey: "emulate",
  }, { structuredOutputs: true })
}

/** [OpenRouter](https://openrouter.ai/docs). Serves Codex and Claude Code. Reads `OPENROUTER_API_KEY`. */
export function openrouter(options?: AiGatewayPresetOptions): AiModelGateway<HostedRoutes> {
  return modelGateway<HostedRoutes>(preset({
    name: "openrouter",
    baseURL: { "codex": "https://openrouter.ai/api/v1", "claude-code": "https://openrouter.ai/api", "openai-compatible": "https://openrouter.ai/api/v1" },
    apiKey: apiKeyFromEnv("openrouter"),
  }, options))
}

/**
 * [Vercel AI Gateway](https://vercel.com/docs/ai-gateway). Serves Codex, Claude Code, and AI SDK models, and answers
 * Jev questions as `typesafe-ai/jev`. Reads `AI_GATEWAY_API_KEY`, then `VERCEL_OIDC_TOKEN`.
 */
export function vercel(options?: VercelGatewayOptions): AiGateway<{ ask: true, routes: HostedRoutes }> {
  const envSecret = (field: "apiKey" | "oidcToken"): AiGatewaySecret => async context => {
    // SAFETY: Server Env supplies a string or a sealed secret for these fields.
    return await readAiGatewayEnv(context, "vercel", field) as string | AiGatewaySealedSecret | undefined
  }
  const apiKey = envSecret("apiKey")
  const oidcToken = envSecret("oidcToken")
  const explicitKey = options && Object.hasOwn(options, "apiKey")
  const definition = preset({
    name: "vercel",
    baseURL: { "codex": "https://ai-gateway.vercel.sh/codex/v1", "claude-code": "https://ai-gateway.vercel.sh/claude-code", "openai-compatible": "https://ai-gateway.vercel.sh/v1" },
    apiKey: async context => await resolveAiGatewaySecret(apiKey, context) ?? await resolveAiGatewaySecret(oidcToken, context),
  }, options)
  const modelCredentials: AiGatewayModelCredentialsResolver = async (context) => {
    const resolvedKey = await resolveAiGatewaySecret(explicitKey ? definition.apiKey : apiKey, context)
    const token = resolvedKey || explicitKey ? undefined : await resolveAiGatewaySecret(oidcToken, context)
    return { apiKey: resolvedKey ?? token, headers: [["ai-gateway-auth-method", token ? "oidc" : "api-key"]] }
  }
  const route = jevRoute("vercel", {
    apiKey: explicitKey ? definition.apiKey : apiKey,
    baseURL: async () => "https://ai-gateway.vercel.sh/v4/ai",
    ...(options?.fetch ? { fetch: options.fetch } : {}),
    ...(definition.headers ? { headers: definition.headers } : {}),
    ...(keyEnv("vercel", options) ? { keyEnv: keyEnv("vercel", options) } : {}),
    label: "Vercel AI Gateway",
    model: options?.model?.trim() || "typesafe-ai/jev",
    ...(!explicitKey ? { oidcToken } : {}),
    protocol: "vercel",
  })
  // SAFETY: createAiGateway attaches ask() for the route built above.
  return createAiGateway(definition, { route, modelCredentials }) as AiGateway<{ ask: true, routes: HostedRoutes }>
}

/** The OpenAI API with an API key. Serves Codex and AI SDK models. Reads `OPENAI_API_KEY`. */
export function openai(options?: AiGatewayPresetOptions): AiModelGateway<"codex" | "openai-compatible"> {
  return modelGateway<"codex" | "openai-compatible">(preset({
    name: "openai",
    baseURL: { "codex": "https://api.openai.com/v1", "openai-compatible": "https://api.openai.com/v1" },
    apiKey: apiKeyFromEnv("openai"),
  }, options))
}

/** The Anthropic API with an API key. Serves Claude Code and AI SDK models. Reads `ANTHROPIC_API_KEY`. */
export function anthropic(options?: AiGatewayPresetOptions): AiModelGateway<"claude-code"> {
  return modelGateway<"claude-code">(preset({ name: "anthropic", baseURL: { "claude-code": "https://api.anthropic.com" }, apiKey: apiKeyFromEnv("anthropic"), auth: "x-api-key" }, options))
}

/** [TypeSafe](https://typesafe.ai). Answers Jev questions; it serves no model API. Reads `TYPESAFE_API_KEY` and `TYPESAFE_DEFAULT_MODEL`. */
export function typesafe(options?: TypesafeGatewayOptions): AiGateway<{ ask: true, routes: never }> {
  const definition = preset({ name: "typesafe", baseURL: {}, apiKey: apiKeyFromEnv("typesafe") }, options)
  const route = jevRoute("typesafe", {
    apiKey: definition.apiKey,
    baseURL: async () => "https://api.typesafe.ai",
    ...(options?.fetch ? { fetch: options.fetch } : {}),
    ...(definition.headers ? { headers: definition.headers } : {}),
    ...(keyEnv("typesafe", options) ? { keyEnv: keyEnv("typesafe", options) } : {}),
    label: "TypeSafe",
    model: options?.model?.trim() || (async (context) => {
      const model = await readAiGatewayEnv(context, "typesafe", "model")
      return typeof model === "string" && model.trim() ? model.trim() : "jev-latest"
    }),
    protocol: "typesafe",
  })
  // SAFETY: createAiGateway attaches ask() for the route built above.
  return createAiGateway(definition, { route }) as AiGateway<{ ask: true, routes: never }>
}

function cloudflareRoot(options: { accountId?: string | undefined, gatewayId?: string | undefined }, preset: "cloudflare") {
  const required = async (context: AiGatewayContext, field: "accountId" | "gatewayId") => {
    const given = options[field]
    const read = given !== undefined ? given : await readAiGatewayEnv(context, preset, field)
    const resolved = typeof read === "string" ? read.trim() : ""
    if (resolved) return resolved
    const label = field === "accountId" ? "an account ID" : "a gateway ID"
    throw gatewayDiagnostics.GATEWAYS_R0004({ message: `[vitehub] Gateway "${preset}" needs ${label}. Set ${aiGatewayVendorNames(preset, field).join(" or ")}, or pass ${field}.` })
  }
  return async (context: AiGatewayContext) => ({ accountId: await required(context, "accountId"), gatewayId: await required(context, "gatewayId") })
}

function cloudflareToken(options: { token?: AiGatewaySecret }, preset: "cloudflare"): AiGatewaySecret {
  const token: AiGatewaySecret = Object.hasOwn(options, "token")
    ? options.token
    // SAFETY: The environment holds a string or a sealed secret for the token.
    : async context => await readAiGatewayEnv(context, preset, "token") as string | undefined
  return async (context: AiGatewayContext) => {
    const resolved = await resolveAiGatewaySecret(token, context)
    return resolved ? `Bearer ${resolved}` : undefined
  }
}

/**
 * [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/). Serves AI SDK models through its
 * [OpenAI-compatible endpoint](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/), with
 * Chat Completions (`api: "chat"`) only, with `{provider}/{model}` model IDs such as `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Answers Jev questions
 * through a TypeSafe [custom provider](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/).
 * Each capability reads its own key: model requests need the gateway token, `CLOUDFLARE_AI_GATEWAY_API_KEY`, or both;
 * `ask()` needs `TYPESAFE_API_KEY`. For Codex or Claude Code through Cloudflare, use `defineAiGateway()`.
 */
export function cloudflare(options: CloudflareGatewayOptions = {}): AiGateway<{ apis: "chat", ask: true, routes: "openai-compatible" }> {
  if (Object.hasOwn(options, "apiKey")) {
    throw gatewayDiagnostics.GATEWAYS_R0001({ message: "[vitehub] cloudflare() reads two keys and has no apiKey. Pass typesafeApiKey for ask(), or providerApiKey for model requests." })
  }
  const root = cloudflareRoot(options, "cloudflare")
  const token = cloudflareToken(options, "cloudflare")
  const fromEnv = (field: "providerApiKey" | "typesafeApiKey"): AiGatewaySecret => {
    // SAFETY: The environment holds a string or a sealed secret for the keys.
    return async context => await readAiGatewayEnv(context, "cloudflare", field) as string | undefined
  }
  const definition: AiGatewayDefinition = {
    name: "cloudflare",
    baseURL: {
      "openai-compatible": async (context) => {
        const { accountId, gatewayId } = await root(context)
        return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/compat`
      },
    },
    apiKey: Object.hasOwn(options, "providerApiKey") ? options.providerApiKey : fromEnv("providerApiKey"),
    headers: { ...options.headers, "cf-aig-authorization": token },
  }
  const slug = async (context: AiGatewayContext) => {
    const read = options.slug !== undefined ? options.slug : await readAiGatewayEnv(context, "cloudflare", "slug")
    return typeof read === "string" ? read.trim() : ""
  }
  const explicitTypesafeKey = Object.hasOwn(options, "typesafeApiKey")
  const route = jevRoute("cloudflare", {
    apiKey: explicitTypesafeKey ? options.typesafeApiKey : fromEnv("typesafeApiKey"),
    baseURL: async context => cloudflareJevBaseURL({ ...await root(context), slug: await slug(context) }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    optionalHeaders: { "cf-aig-authorization": token },
    ...(explicitTypesafeKey ? {} : { keyEnv: aiGatewayVendorNames("cloudflare", "typesafeApiKey").join(" or ") }),
    keyOption: "typesafeApiKey",
    label: "Cloudflare AI Gateway",
    model: options.model?.trim() || "jev-latest",
    protocol: "typesafe",
  })
  // SAFETY: createAiGateway attaches ask() for the route built above, and the baseURL has the openai-compatible key.
  return createAiGateway(definition, { route, modelApis: ["chat"], optional: {
    apiKey: true,
    headers: ["cf-aig-authorization"],
    missing: "Gateway \"cloudflare\" needs a gateway token or a provider key for model requests. Set CLOUDFLARE_AI_GATEWAY_TOKEN for stored provider keys or Unified Billing, or CLOUDFLARE_AI_GATEWAY_API_KEY, or pass token or providerApiKey.",
  } }) as AiGateway<{ apis: "chat", ask: true, routes: "openai-compatible" }>
}
