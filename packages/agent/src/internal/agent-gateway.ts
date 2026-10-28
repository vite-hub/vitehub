import { isChatGPTGateway, aiGatewaySupports, normalizeAiGateway, resolveAiGatewayDriverRoute } from "@vite-hub/gateways/internal"
import { resolveChatGPTGateway } from "./chatgpt-gateway.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { codexConfigArg } from "./codex-launch-args.ts"
import { gatewayEnvValue } from "./gateway-env.ts"
import type { AiGatewayDefinition, ChatGPTGateway } from "@vite-hub/gateways"
import type { AiGatewayDriverRoute } from "@vite-hub/gateways/internal"
import type { ChatGPTCredential } from "@vite-hub/connections/agent"
import type { AgentProviderCredentialContext, BuiltInAgentDriverName } from "../types.ts"

const codexProviderId = "vitehub"
const codexApiKeyEnvironment = "VITEHUB_GATEWAY_API_KEY"
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
}

/** Validate a gateway for `driver.gateway` and keep its Driver routes. */
export function normalizeAgentDriverGateway(value: unknown): AiGatewayDefinition | ChatGPTGateway {
  return isChatGPTGateway(value) ? Object.freeze({ ...value }) : normalizeAiGateway(value)
}

/** Fail at definition time when a gateway cannot serve the selected Driver. */
export function assertAgentDriverGatewaySupports(gateway: AiGatewayDefinition | ChatGPTGateway, driver: BuiltInAgentDriverName): void {
  if (isChatGPTGateway(gateway)) {
    if (driver !== "codex") throw agentDiagnostics.AGENT_R0976({ message: `[vitehub] The ChatGPT plan gateway does not serve the ${driver} Driver. Set driver.kind to "codex".` })
    return
  }
  if (!aiGatewaySupports(gateway, driver)) {
    throw agentDiagnostics.AGENT_R0976({ message: `[vitehub] Gateway "${gateway.name}" does not serve the ${driver} Driver. Set baseURL["${driver}"] or choose another gateway.` })
  }
}

function codexGateway(gateway: AiGatewayDefinition, { apiKey, auth, baseURL, headers }: AiGatewayDriverRoute): ResolvedAgentDriverGateway {
  const environment: Record<string, string> = { [codexApiKeyEnvironment]: apiKey }
  const headerEnvironment: Record<string, string> = {}
  if (auth === "x-api-key") headerEnvironment["x-api-key"] = codexApiKeyEnvironment
  headers.forEach(([name, value], index) => {
    const variable = `VITEHUB_GATEWAY_HEADER_${index}`
    environment[variable] = value
    headerEnvironment[name] = variable
  })
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
  return { environment, launchArgs: args.join(" ") }
}

function claudeGateway({ apiKey, auth, baseURL, headers }: AiGatewayDriverRoute): ResolvedAgentDriverGateway {
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

/** Resolve the gateway into the provider process environment and Codex launch arguments. Preset values come from Server Env. */
export async function resolveAgentDriverGateway(
  gateway: AiGatewayDefinition | ChatGPTGateway,
  driver: BuiltInAgentDriverName,
  context: AgentProviderCredentialContext,
): Promise<ResolvedAgentDriverGateway> {
  assertAgentDriverGatewaySupports(gateway, driver)
  if (isChatGPTGateway(gateway)) return await resolveChatGPTGateway(gateway, context)
  const route = await resolveAiGatewayDriverRoute(gateway, driver, {
    ...context,
    env: async (preset, field) => await gatewayEnvValue(preset, field, context),
  })
  return driver === "codex" ? codexGateway(gateway, route) : claudeGateway(route)
}

/** Merge gateway values into the resolved `driver.env`. A gateway owns its variables. */
export function withAgentDriverGatewayEnvironment<T extends Record<string, string | undefined>>(
  gateway: ResolvedAgentDriverGateway | undefined,
  environment: T | undefined,
  options: { auxiliary?: boolean } = {},
): T | Record<string, string | undefined> | undefined {
  if (!gateway) return environment
  const owned = [...Object.keys(gateway.environment), ...(gateway.launchArgs && !options.auxiliary ? ["T3CODE_CODEX_LAUNCH_ARGS"] : [])]
  const conflicts = owned.filter(name => environment?.[name] !== undefined)
  if (conflicts.length) {
    throw agentDiagnostics.AGENT_R0979({ message: `[vitehub] driver.gateway sets ${conflicts.join(", ")}. Remove ${conflicts.length === 1 ? "it" : "them"} from driver.env.` })
  }
  return { ...environment, ...gateway.environment }
}
