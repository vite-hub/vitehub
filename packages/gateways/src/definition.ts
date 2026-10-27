import { gatewayDiagnostics } from "./diagnostics.ts"

import type { AiGatewayContext, AiGatewayDefinition, AiGatewayDriver, AiGatewaySecret, AiGatewayValue } from "./types.ts"

const gatewayKeys = new Set(["apiKey", "apiKeyEnv", "auth", "baseURL", "headers", "name"])
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Marks an AI gateway that answers Jev questions. A symbol key, so key checks and copies skip it. Such a gateway may
 * have no Driver base URL.
 */
export const aiGatewayAsks: unique symbol = Symbol.for("vitehub.aiGateway.ask")

export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isResolver(value: unknown): boolean {
  return typeof value === "function" || (isRecord(value) && typeof value.resolve === "function")
}

function invalid(message: string): never {
  throw gatewayDiagnostics.GATEWAYS_R0001({ message: `[vitehub] ${message}` })
}

function validBaseURL(name: string, driver: string, url: unknown, fail: (message: string) => never): string {
  if (typeof url !== "string" || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    fail(`Gateway "${name}" baseURL.${driver} must be an http or https URL.`)
  }
  return url.replace(/\/+$/, "")
}

function isSecretInput(value: unknown): boolean {
  return typeof value === "string" || isResolver(value) || (isRecord(value) && typeof value.unseal === "function")
}

// An explicit undefined secret, such as an unset optional Server Env value, must fail the
// request rather than fall back to another credential.
const missingSecret = () => undefined

/** Validate a gateway definition and return a frozen copy with its Driver routes. */
export function normalizeAiGateway(value: unknown): AiGatewayDefinition {
  if (!isRecord(value)) invalid("A gateway must be an object.")
  const unknown = Object.keys(value).filter(key => !gatewayKeys.has(key))
  if (unknown.length) invalid(`A gateway does not support: ${unknown.join(", ")}.`)
  if (typeof value.name !== "string" || !value.name.trim()) invalid("A gateway name must be a non-empty string.")
  const name = value.name.trim()
  if (!isRecord(value.baseURL)) invalid(`Gateway "${name}" baseURL must be an object keyed by Driver.`)
  const baseURL: AiGatewayDefinition["baseURL"] = {}
  for (const [driver, url] of Object.entries(value.baseURL)) {
    if (driver !== "codex" && driver !== "claude-code") invalid(`Gateway "${name}" baseURL has an unknown Driver "${driver}". Use "codex" or "claude-code".`)
    if (url === undefined) continue
    if (isResolver(url)) {
      // SAFETY: The resolver shape is checked above; its URL is validated when it resolves.
      baseURL[driver] = url as AiGatewayValue<string>
      continue
    }
    baseURL[driver] = validBaseURL(name, driver, url, invalid)
  }
  if (!Object.keys(baseURL).length && Reflect.get(value, aiGatewayAsks) !== true) invalid(`Gateway "${name}" must set a baseURL for "codex" or "claude-code".`)
  if (value.auth !== undefined && value.auth !== "bearer" && value.auth !== "x-api-key") invalid(`Gateway "${name}" auth must be "bearer" or "x-api-key".`)
  if (value.apiKey !== undefined && !isSecretInput(value.apiKey)) invalid(`Gateway "${name}" apiKey must be a string, sealed secret, or resolver.`)
  if (value.apiKeyEnv !== undefined && (!Array.isArray(value.apiKeyEnv) || !value.apiKeyEnv.every(item => typeof item === "string" && environmentName.test(item)))) {
    invalid(`Gateway "${name}" apiKeyEnv must be a list of environment variable names.`)
  }
  const apiKey = Object.hasOwn(value, "apiKey") && value.apiKey === undefined ? missingSecret : value.apiKey
  const apiKeyEnv = Array.isArray(value.apiKeyEnv) ? value.apiKeyEnv.filter((item): item is string => typeof item === "string") : undefined
  if (apiKey === undefined && !apiKeyEnv?.length) invalid(`Gateway "${name}" needs apiKey or apiKeyEnv.`)
  let headers: AiGatewayDefinition["headers"]
  if (value.headers !== undefined) {
    if (!isRecord(value.headers)) invalid(`Gateway "${name}" headers must be an object.`)
    headers = {}
    for (const [header, item] of Object.entries(value.headers)) {
      if (!headerName.test(header)) invalid(`Gateway "${name}" header name "${header}" is not a valid HTTP header name.`)
      if (/^(?:authorization|x-api-key)$/i.test(header)) invalid(`Gateway "${name}" sets the API key with apiKey, not with the "${header}" header.`)
      if (item === undefined) {
        headers[header] = missingSecret
        continue
      }
      if (!isSecretInput(item)) invalid(`Gateway "${name}" header "${header}" must be a string, sealed secret, or resolver.`)
      // SAFETY: isSecretInput validated the secret input shape above.
      headers[header] = item as AiGatewaySecret
    }
  }
  return Object.freeze({
    name,
    baseURL: Object.freeze(baseURL),
    // SAFETY: isSecretInput validated the secret input shape above.
    ...(apiKey === undefined ? {} : { apiKey: apiKey as AiGatewaySecret }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv: Object.freeze(apiKeyEnv) }),
    ...(value.auth === undefined ? {} : { auth: value.auth }),
    ...(headers === undefined ? {} : { headers: Object.freeze(headers) }),
  })
}

/** A value or the result of its resolver. */
export async function resolveAiGatewayValue<T>(value: AiGatewayValue<T>, context: AiGatewayContext): Promise<T> {
  if (typeof value === "function") return await (value as (context: AiGatewayContext) => T | Promise<T>)(context)
  if (isRecord(value) && typeof value.resolve === "function") return await (value as { resolve: (context: AiGatewayContext) => T | Promise<T> }).resolve(context)
  return value as T
}

/** A secret as a trimmed string, or undefined when it is missing or empty. */
export async function resolveAiGatewaySecret(value: AiGatewaySecret, context: AiGatewayContext): Promise<string | undefined> {
  const resolved: unknown = await resolveAiGatewayValue(value, context)
  const secret = isRecord(resolved) && typeof resolved.unseal === "function" ? Reflect.apply(resolved.unseal, resolved, []) : resolved
  return typeof secret === "string" && secret.trim() ? secret.trim() : undefined
}

/** One Driver route of a gateway, with its key and headers resolved. */
export interface AiGatewayDriverRoute {
  apiKey: string
  auth: "bearer" | "x-api-key"
  baseURL: string
  headers: [string, string][]
}

/** Whether a gateway has a base URL for the Driver. */
export function aiGatewaySupports(gateway: AiGatewayDefinition, driver: AiGatewayDriver): boolean {
  return Boolean(gateway.baseURL[driver])
}

async function resolveApiKey(gateway: AiGatewayDefinition, context: AiGatewayContext): Promise<string> {
  if (gateway.apiKey !== undefined) {
    const apiKey = await resolveAiGatewaySecret(gateway.apiKey, context)
    if (apiKey) return apiKey
    throw gatewayDiagnostics.GATEWAYS_R0002({ message: `[vitehub] Gateway "${gateway.name}" apiKey resolved to an empty value.` })
  }
  for (const name of gateway.apiKeyEnv || []) {
    const value = globalThis.process?.env?.[name]?.trim()
    if (value) return value
  }
  throw gatewayDiagnostics.GATEWAYS_R0002({ message: `[vitehub] Gateway "${gateway.name}" needs an API key. Set ${(gateway.apiKeyEnv || []).join(" or ")}, or pass apiKey.` })
}

async function resolveHeaders(gateway: AiGatewayDefinition, context: AiGatewayContext): Promise<[string, string][]> {
  const headers: [string, string][] = []
  for (const [name, input] of Object.entries(gateway.headers || {})) {
    const value = await resolveAiGatewaySecret(input, context)
    // Codex drops a header whose variable is unset, so a missing value would surface later as a 401 or 403 from the gateway.
    if (!value) throw gatewayDiagnostics.GATEWAYS_R0003({ message: `[vitehub] Gateway "${gateway.name}" header "${name}" resolved to an empty value.` })
    if (/[\r\n]/.test(value)) throw gatewayDiagnostics.GATEWAYS_R0003({ message: `[vitehub] Gateway "${gateway.name}" header "${name}" must not contain line breaks.` })
    headers.push([name, value])
  }
  return headers
}

/** Resolve the base URL, key, and headers of one Driver route. The caller checks `aiGatewaySupports()` first. */
export async function resolveAiGatewayDriverRoute(gateway: AiGatewayDefinition, driver: AiGatewayDriver, context: AiGatewayContext): Promise<AiGatewayDriverRoute> {
  const input = gateway.baseURL[driver]
  if (input === undefined) throw gatewayDiagnostics.GATEWAYS_R0004({ message: `[vitehub] Gateway "${gateway.name}" does not serve the ${driver} Driver.` })
  const baseURL = validBaseURL(gateway.name, driver, await resolveAiGatewayValue(input, context), (message) => {
    throw gatewayDiagnostics.GATEWAYS_R0004({ message: `[vitehub] ${message}` })
  })
  const [apiKey, headers] = await Promise.all([resolveApiKey(gateway, context), resolveHeaders(gateway, context)])
  return { apiKey, auth: gateway.auth ?? "bearer", baseURL, headers }
}
