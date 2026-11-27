import { aiGatewayHarnessRoute, aiGatewayHarnessRoutes } from "@vite-hub/gateways"
import { isChatGPTGateway, normalizeAiGateway, resolveAiGatewayRoute } from "@vite-hub/gateways/internal"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { resolveChatGPTGateway } from "./chatgpt-gateway.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { codexConfigArg } from "./codex-launch-args.ts"
import { gatewayEnvValue } from "./gateway-env.ts"
import { providerHarnessProfile } from "./provider-profiles.ts"
import type { AiGatewayDefinition, AiGatewayRoute, ChatGPTGateway } from "@vite-hub/gateways"
import type { AiGatewayResolvedRoute } from "@vite-hub/gateways/internal"
import type { ChatGPTCredential } from "@vite-hub/connections/agent"
import type { AgentProviderCredentialContext, BuiltInAgentDriverName } from "../types.ts"

const codexProviderId = "vitehub"
const codexApiKeyEnvironment = "VITEHUB_GATEWAY_API_KEY"
const gatewayProviderId = "vitehub"
// A gateway can answer 200 and then relay an upstream error, such as `server_is_overloaded`.
// Codex then sees a stream that closes before `response.completed`, and only Codex can retry it.
// Its default of 5 retries backs off for about 6 seconds in total; 10 backs off for about 3.5 minutes.
const codexGatewayStreamRetries = 10

export interface ResolvedAgentDriverGateway {
  /** Runtime-only grant. Never forward this object to the provider process. */
  chatgpt?: ChatGPTCredential
  /** Values for the provider process. Every value is a secret. */
  environment: Record<string, string>
  /** Codex `-c` overrides that select the gateway. */
  launchArgs?: string
  /** Files for a folder that ViteHub creates and names in `env`. They reference secrets through the environment and hold none. */
  home?: { env: string, files: Readonly<Record<string, string>> }
  /** The model id the session selects when the gateway configuration renames `driver.model`, or null when `environment` selects it. */
  model?: string | null
}

/** The model the provider session selects. ACP agents reject a model id outside their own list, so the gateway environment selects it instead. */
export function agentDriverSessionModel(gateway: ResolvedAgentDriverGateway | undefined, model: string | undefined): string | undefined {
  if (gateway?.model === null) return
  return gateway?.model ?? model
}

/** Validate a gateway for `driver.gateway` and keep its Driver routes. */
export function normalizeAgentDriverGateway(value: unknown): AiGatewayDefinition | ChatGPTGateway {
  return isChatGPTGateway(value) ? Object.freeze({ ...value }) : normalizeAiGateway(value)
}

/** Fail at definition time when a gateway cannot serve the selected Driver. Returns the route that serves it. */
export function assertAgentDriverGatewaySupports(gateway: AiGatewayDefinition | ChatGPTGateway, driver: BuiltInAgentDriverName): AiGatewayRoute | undefined {
  const profile = providerHarnessProfile(driver)
  if (profile.signInOnly) {
    const credentials = profile.authEnv.length ? ` or set ${profile.authEnv.join(" or ")} in driver.env` : ""
    throw agentDiagnostics.AGENT_R0976({ message: `[vitehub] ${profile.displayName} signs in to its own service, so no gateway serves the ${driver} Driver. Remove driver.gateway and sign in to ${profile.displayName}${credentials}.` })
  }
  if (isChatGPTGateway(gateway)) {
    if (!profile.gateway.chatgpt) throw agentDiagnostics.AGENT_R0976({ message: `[vitehub] The ChatGPT plan gateway does not serve the ${driver} Driver. Use codexDriver({ gateway: chatgpt() }) or a model-backed Driver: { model, gateway: chatgpt() }.` })
    return
  }
  const route = aiGatewayHarnessRoute(gateway, driver)
  if (!route) {
    const keys = aiGatewayHarnessRoutes[driver].map(key => `baseURL["${key}"]`).join(" or ")
    throw agentDiagnostics.AGENT_R0976({ message: `[vitehub] Gateway "${gateway.name}" does not serve the ${driver} Driver. Set ${keys} or choose another gateway.` })
  }
  return route
}

function headerVariables(headers: AiGatewayResolvedRoute["headers"]): { environment: Record<string, string>, names: [string, string][] } {
  const environment: Record<string, string> = {}
  const names = headers.map(([name, value], index): [string, string] => {
    const variable = `VITEHUB_GATEWAY_HEADER_${index}`
    environment[variable] = value
    return [name, variable]
  })
  return { environment, names }
}

/** The provider environment and launch arguments that send Codex to a gateway route. */
export function codexGateway(gateway: AiGatewayDefinition, { apiKey, auth, baseURL, headers }: AiGatewayResolvedRoute): ResolvedAgentDriverGateway {
  const extra = headerVariables(headers)
  const headerEnvironment: Record<string, string> = {}
  if (auth === "x-api-key") headerEnvironment["x-api-key"] = codexApiKeyEnvironment
  for (const [name, variable] of extra.names) headerEnvironment[name] = variable
  const provider = `model_providers.${codexProviderId}`
  const args = [
    codexConfigArg("model_provider", JSON.stringify(codexProviderId)),
    codexConfigArg(`${provider}.name`, JSON.stringify(gateway.name)),
    codexConfigArg(`${provider}.base_url`, JSON.stringify(baseURL)),
    codexConfigArg(`${provider}.wire_api`, JSON.stringify("responses")),
    codexConfigArg(`${provider}.stream_max_retries`, String(codexGatewayStreamRetries)),
    ...(auth === "x-api-key" ? [] : [codexConfigArg(`${provider}.env_key`, JSON.stringify(codexApiKeyEnvironment))]),
    ...(Object.keys(headerEnvironment).length
      ? [codexConfigArg(`${provider}.env_http_headers`, `{${Object.entries(headerEnvironment).map(([name, variable]) => `${JSON.stringify(name)}=${JSON.stringify(variable)}`).join(",")}}`)]
      : []),
  ]
  return { environment: { [codexApiKeyEnvironment]: apiKey, ...extra.environment }, launchArgs: args.join(" ") }
}

function claudeGateway({ apiKey, auth, baseURL, headers }: AiGatewayResolvedRoute): ResolvedAgentDriverGateway {
  return {
    environment: {
      ANTHROPIC_BASE_URL: baseURL,
      // Claude Code prefers ANTHROPIC_API_KEY when it is non-empty, so set only the variable for the selected header.
      ...(auth === "x-api-key"
        ? { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: "" }
        : { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: apiKey }),
      // Own this variable even without extra headers, just like the authentication variables.
      ANTHROPIC_CUSTOM_HEADERS: headers.map(([name, value]) => `${name}: ${value}`).join("\n"),
    },
  }
}

function geminiGateway({ apiKey, baseURL, headers }: AiGatewayResolvedRoute, model: string | undefined): ResolvedAgentDriverGateway {
  return {
    environment: {
      GOOGLE_GEMINI_BASE_URL: baseURL,
      GEMINI_API_KEY: apiKey,
      GEMINI_CLI_CUSTOM_HEADERS: headers.map(([name, value]) => `${name}: ${value}`).join(", "),
      ...(model ? { GEMINI_MODEL: model } : {}),
    },
    ...(model ? { model: null } : {}),
  }
}

function kimiGateway(gateway: AiGatewayDefinition, { apiKey, auth, baseURL, headers }: AiGatewayResolvedRoute, model: string | undefined): ResolvedAgentDriverGateway {
  if (auth === "x-api-key" || headers.length) {
    throw agentDiagnostics.AGENT_R0976({ message: `[vitehub] Gateway "${gateway.name}" needs ${auth === "x-api-key" ? "an x-api-key header" : "extra headers"}, which Kimi CLI cannot send. Use a gateway that takes a bearer key.` })
  }
  return { environment: { KIMI_BASE_URL: baseURL, KIMI_API_KEY: apiKey, ...(model ? { KIMI_MODEL_NAME: model } : {}) }, ...(model ? { model: null } : {}) }
}

function opencodeGateway(gateway: AiGatewayDefinition, { apiKey, auth, baseURL, headers }: AiGatewayResolvedRoute, model: string | undefined): ResolvedAgentDriverGateway {
  const extra = headerVariables(headers)
  const optionHeaders = Object.fromEntries([
    ...(auth === "x-api-key" ? [["x-api-key", `{env:${codexApiKeyEnvironment}}`]] : []),
    ...extra.names.map(([name, variable]) => [name, `{env:${variable}}`]),
  ])
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [gatewayProviderId]: {
        npm: "@ai-sdk/openai-compatible",
        name: gateway.name,
        options: {
          baseURL,
          ...(auth === "x-api-key" ? {} : { apiKey: `{env:${codexApiKeyEnvironment}}` }),
          ...(Object.keys(optionHeaders).length ? { headers: optionHeaders } : {}),
        },
        models: model ? { [model]: {} } : {},
      },
    },
    ...(model ? { model: `${gatewayProviderId}/${model}` } : {}),
  }
  return {
    environment: { [codexApiKeyEnvironment]: apiKey, ...extra.environment, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    ...(model ? { model: `${gatewayProviderId}/${model}` } : {}),
  }
}

function piGateway(gateway: AiGatewayDefinition, { apiKey, auth, baseURL, headers }: AiGatewayResolvedRoute, model: string | undefined): ResolvedAgentDriverGateway {
  const extra = headerVariables(headers)
  const providerHeaders = Object.fromEntries([
    ...(auth === "x-api-key" ? [["x-api-key", `$${codexApiKeyEnvironment}`]] : []),
    ...extra.names.map(([name, variable]) => [name, `$${variable}`]),
  ])
  const models = {
    providers: {
      [gatewayProviderId]: {
        name: gateway.name,
        baseUrl: baseURL,
        api: "openai-completions",
        apiKey: `$${codexApiKeyEnvironment}`,
        ...(Object.keys(providerHeaders).length ? { headers: providerHeaders } : {}),
        models: model ? [{ id: model }] : [],
      },
    },
  }
  return {
    environment: { [codexApiKeyEnvironment]: apiKey, ...extra.environment },
    home: { env: "PI_CODING_AGENT_DIR", files: { "models.json": `${JSON.stringify(models, null, 2)}\n` } },
    ...(model ? { model: `${gatewayProviderId}/${model}` } : {}),
  }
}

/** Resolve the gateway into the provider process environment and Codex launch arguments. Preset values come from Server Env. */
export async function resolveAgentDriverGateway(
  gateway: AiGatewayDefinition | ChatGPTGateway,
  driver: BuiltInAgentDriverName,
  context: AgentProviderCredentialContext,
  options: { model?: string } = {},
): Promise<ResolvedAgentDriverGateway> {
  const routeKey = assertAgentDriverGatewaySupports(gateway, driver)
  if (isChatGPTGateway(gateway)) return await resolveChatGPTGateway(gateway, context)
  const profile = providerHarnessProfile(driver)
  if (profile.signInOnly || !routeKey) throw agentDiagnostics.AGENT_R0976({ message: `[vitehub] Gateway "${gateway.name}" does not serve the ${driver} Driver.` })
  const route = await resolveAiGatewayRoute(gateway, routeKey, {
    ...context,
    env: async (preset, field) => await gatewayEnvValue(preset, field, context),
  })
  switch (profile.gateway.delivery) {
    case "codex-config": return codexGateway(gateway, route)
    case "anthropic-env": return claudeGateway(route)
    case "gemini-env": return geminiGateway(route, options.model)
    case "kimi-env": return kimiGateway(gateway, route, options.model)
    case "opencode-config": return opencodeGateway(gateway, route, options.model)
    case "pi-models": return piGateway(gateway, route, options.model)
  }
}

/** Write the gateway configuration folder to `directory` and name it in the gateway environment. */
export async function materializeAgentDriverGatewayHome(gateway: ResolvedAgentDriverGateway, directory: string): Promise<ResolvedAgentDriverGateway> {
  if (!gateway.home) return gateway
  await mkdir(directory, { mode: 0o700, recursive: true })
  for (const [path, content] of Object.entries(gateway.home.files)) await writeFile(join(directory, path), content, { mode: 0o600 })
  return { ...gateway, environment: { ...gateway.environment, [gateway.home.env]: directory } }
}

/** Merge gateway values into the resolved `driver.env`. A gateway owns its variables. */
export function withAgentDriverGatewayEnvironment<T extends Record<string, string | undefined>>(
  gateway: ResolvedAgentDriverGateway | undefined,
  environment: T | undefined,
  options: { auxiliary?: boolean } = {},
): T | Record<string, string | undefined> | undefined {
  if (!gateway) return environment
  const owned = [
    ...Object.keys(gateway.environment),
    ...(gateway.home && !Object.hasOwn(gateway.environment, gateway.home.env) ? [gateway.home.env] : []),
    ...(gateway.launchArgs && !options.auxiliary ? ["T3CODE_CODEX_LAUNCH_ARGS"] : []),
  ]
  const conflicts = owned.filter(name => environment?.[name] !== undefined)
  if (conflicts.length) {
    throw agentDiagnostics.AGENT_R0979({ message: `[vitehub] driver.gateway sets ${conflicts.join(", ")}. Remove ${conflicts.length === 1 ? "it" : "them"} from driver.env.` })
  }
  return { ...environment, ...gateway.environment }
}
