import { resolveRuntimeValue } from "@vite-hub/runtime"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { codexConfigArg } from "./codex-launch-args.ts"
import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"
import type { AgentDriverGateway, AgentDriverGatewaySecret, AgentProviderCredentialContext, BuiltInAgentDriverName } from "../types.ts"

const gatewayKeys = new Set(["apiKey", "apiKeyEnv", "auth", "baseURL", "headers", "name"])
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/
const codexProviderId = "vitehub"
const codexApiKeyEnvironment = "VITEHUB_GATEWAY_API_KEY"

export interface ResolvedAgentDriverGateway {
  /** Values for the provider process. Every value is a secret. */
  environment: Record<string, string>
  /** Codex `-c` overrides that select the gateway. */
  launchArgs?: string
}

function invalid(message: string): never {
  throw agentDiagnostics.AGENT_R0975({ message: `[vitehub] ${message}` })
}

function validBaseURL(name: string, driver: string, url: unknown, fail: (message: string) => never): string {
  if (!hasRuntimeType(url, "string") || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    fail(`Gateway "${name}" baseURL.${driver} must be an http or https URL.`)
  }
  return url.replace(/\/+$/, "")
}

function isSecretInput(value: unknown): boolean {
  return hasRuntimeType(value, "string")
    || hasRuntimeType(value, "function")
    || (isRuntimeRecord(value) && (hasRuntimeType(value.unseal, "function") || hasRuntimeType(value.resolve, "function")))
}

// An explicit undefined secret, such as an unset optional Server Env value, must fail the
// invocation rather than fall back to another credential.
const missingSecret = () => undefined

/** Validate a gateway definition and return a frozen copy. */
export function normalizeAgentDriverGateway(value: unknown): AgentDriverGateway {
  if (!isRuntimeRecord(value) || Array.isArray(value)) invalid("A driver gateway must be an object.")
  const unknown = Object.keys(value).filter(key => !gatewayKeys.has(key))
  if (unknown.length) invalid(`A driver gateway does not support: ${unknown.join(", ")}.`)
  if (!hasRuntimeType(value.name, "string") || !value.name.trim()) invalid("A driver gateway name must be a non-empty string.")
  const name = value.name.trim()
  if (!isRuntimeRecord(value.baseURL) || Array.isArray(value.baseURL)) invalid(`Gateway "${name}" baseURL must be an object keyed by Driver.`)
  const baseURL: AgentDriverGateway["baseURL"] = {}
  for (const [driver, url] of Object.entries(value.baseURL)) {
    if (driver !== "codex" && driver !== "claude-code") invalid(`Gateway "${name}" baseURL has an unknown Driver "${driver}". Use "codex" or "claude-code".`)
    if (url === undefined) continue
    if (hasRuntimeType(url, "function") || (isRuntimeRecord(url) && hasRuntimeType(url.resolve, "function"))) {
      // SAFETY: The resolver shape is checked above; its URL is validated when an invocation resolves it.
      baseURL[driver] = url as NonNullable<AgentDriverGateway["baseURL"][typeof driver]>
      continue
    }
    baseURL[driver] = validBaseURL(name, driver, url, invalid)
  }
  if (!Object.keys(baseURL).length) invalid(`Gateway "${name}" must set a baseURL for "codex" or "claude-code".`)
  if (value.auth !== undefined && value.auth !== "bearer" && value.auth !== "x-api-key") invalid(`Gateway "${name}" auth must be "bearer" or "x-api-key".`)
  if (value.apiKey !== undefined && !isSecretInput(value.apiKey)) invalid(`Gateway "${name}" apiKey must be a string, sealed Server Env value, or resolver.`)
  if (value.apiKeyEnv !== undefined && (!Array.isArray(value.apiKeyEnv) || !value.apiKeyEnv.every(item => hasRuntimeType(item, "string") && environmentName.test(item)))) {
    invalid(`Gateway "${name}" apiKeyEnv must be a list of environment variable names.`)
  }
  const apiKey = Object.hasOwn(value, "apiKey") && value.apiKey === undefined ? missingSecret : value.apiKey
  const apiKeyEnv = Array.isArray(value.apiKeyEnv) ? value.apiKeyEnv.filter((item): item is string => hasRuntimeType(item, "string")) : undefined
  if (apiKey === undefined && !apiKeyEnv?.length) invalid(`Gateway "${name}" needs apiKey or apiKeyEnv.`)
  let headers: AgentDriverGateway["headers"]
  if (value.headers !== undefined) {
    if (!isRuntimeRecord(value.headers) || Array.isArray(value.headers)) invalid(`Gateway "${name}" headers must be an object.`)
    headers = {}
    for (const [header, item] of Object.entries(value.headers)) {
      if (!headerName.test(header)) invalid(`Gateway "${name}" header name "${header}" is not a valid HTTP header name.`)
      if (/^(?:authorization|x-api-key)$/i.test(header)) invalid(`Gateway "${name}" sets the API key with apiKey, not with the "${header}" header.`)
      if (item === undefined) {
        headers[header] = missingSecret
        continue
      }
      if (!isSecretInput(item)) invalid(`Gateway "${name}" header "${header}" must be a string, sealed Server Env value, or resolver.`)
      // SAFETY: isSecretInput validated the credential input shape above.
      headers[header] = item as NonNullable<AgentDriverGateway["headers"]>[string]
    }
  }
  return Object.freeze({
    name,
    baseURL: Object.freeze(baseURL),
    // SAFETY: isSecretInput validated the credential input shape above.
    ...(apiKey === undefined ? {} : { apiKey: apiKey as AgentDriverGateway["apiKey"] }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv: Object.freeze(apiKeyEnv) }),
    ...(value.auth === undefined ? {} : { auth: value.auth }),
    ...(headers === undefined ? {} : { headers: Object.freeze(headers) }),
  })
}

/** Fail at definition time when a gateway cannot serve the selected Driver. */
export function assertAgentDriverGatewaySupports(gateway: AgentDriverGateway, driver: BuiltInAgentDriverName): void {
  if (!gateway.baseURL[driver]) {
    throw agentDiagnostics.AGENT_R0976({ message: `[vitehub] Gateway "${gateway.name}" does not serve the ${driver} Driver. Set baseURL["${driver}"] or choose another gateway.` })
  }
}

async function resolveSecret(value: AgentDriverGatewaySecret, context: AgentProviderCredentialContext): Promise<string | undefined> {
  const resolved: unknown = await resolveRuntimeValue(value, context)
  const unseal = isRuntimeRecord(resolved) ? resolved.unseal : undefined
  const secret = hasRuntimeType(unseal, "function") ? Reflect.apply(unseal, resolved, []) : resolved
  return hasRuntimeType(secret, "string") && secret.trim() ? secret.trim() : undefined
}

async function resolveApiKey(gateway: AgentDriverGateway, context: AgentProviderCredentialContext): Promise<string> {
  if (gateway.apiKey !== undefined) {
    const apiKey = await resolveSecret(gateway.apiKey, context)
    if (apiKey) return apiKey
    throw agentDiagnostics.AGENT_R0977({ message: `[vitehub] Gateway "${gateway.name}" apiKey resolved to an empty value.` })
  }
  for (const name of gateway.apiKeyEnv || []) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  throw agentDiagnostics.AGENT_R0977({ message: `[vitehub] Gateway "${gateway.name}" needs an API key. Set ${(gateway.apiKeyEnv || []).join(" or ")}, or pass apiKey.` })
}

async function resolveHeaders(gateway: AgentDriverGateway, context: AgentProviderCredentialContext): Promise<[string, string][]> {
  const headers: [string, string][] = []
  for (const [name, input] of Object.entries(gateway.headers || {})) {
    const value = await resolveSecret(input, context)
    // Codex drops a header whose variable is unset, so a missing value would surface later as a 401 or 403 from the gateway.
    if (!value) throw agentDiagnostics.AGENT_R0978({ message: `[vitehub] Gateway "${gateway.name}" header "${name}" resolved to an empty value.` })
    if (/[\r\n]/.test(value)) throw agentDiagnostics.AGENT_R0978({ message: `[vitehub] Gateway "${gateway.name}" header "${name}" must not contain line breaks.` })
    headers.push([name, value])
  }
  return headers
}

function codexGateway(gateway: AgentDriverGateway, baseURL: string, apiKey: string, headers: [string, string][]): ResolvedAgentDriverGateway {
  const environment: Record<string, string> = { [codexApiKeyEnvironment]: apiKey }
  const headerEnvironment: Record<string, string> = {}
  if (gateway.auth === "x-api-key") headerEnvironment["x-api-key"] = codexApiKeyEnvironment
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
    ...(gateway.auth === "x-api-key" ? [] : [codexConfigArg(`${provider}.env_key`, JSON.stringify(codexApiKeyEnvironment))]),
    ...(Object.keys(headerEnvironment).length
      ? [codexConfigArg(`${provider}.env_http_headers`, `{${Object.entries(headerEnvironment).map(([name, variable]) => `${JSON.stringify(name)}=${JSON.stringify(variable)}`).join(",")}}`)]
      : []),
  ]
  return { environment, launchArgs: args.join(" ") }
}

function claudeGateway(gateway: AgentDriverGateway, baseURL: string, apiKey: string, headers: [string, string][]): ResolvedAgentDriverGateway {
  return {
    environment: {
      ANTHROPIC_BASE_URL: baseURL,
      // Claude Code prefers ANTHROPIC_API_KEY when it is non-empty, so set only the variable for the selected header.
      ...(gateway.auth === "x-api-key"
        ? { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: "" }
        : { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: apiKey }),
      // Own this variable even without extra headers, just like the authentication variables.
      ANTHROPIC_CUSTOM_HEADERS: headers.map(([name, value]) => `${name}: ${value}`).join("\n"),
    },
  }
}

/** Resolve the gateway into the provider process environment and Codex launch arguments. */
export async function resolveAgentDriverGateway(
  gateway: AgentDriverGateway,
  driver: BuiltInAgentDriverName,
  context: AgentProviderCredentialContext,
): Promise<ResolvedAgentDriverGateway> {
  assertAgentDriverGatewaySupports(gateway, driver)
  const baseURL = validBaseURL(gateway.name, driver, await resolveRuntimeValue(gateway.baseURL[driver], context), (message) => {
    throw agentDiagnostics.AGENT_R0980({ message: `[vitehub] ${message}` })
  })
  const [apiKey, headers] = await Promise.all([resolveApiKey(gateway, context), resolveHeaders(gateway, context)])
  return driver === "codex"
    ? codexGateway(gateway, baseURL, apiKey, headers)
    : claudeGateway(gateway, baseURL, apiKey, headers)
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
