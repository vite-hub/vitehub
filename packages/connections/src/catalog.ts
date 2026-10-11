import * as v from "valibot"

import { ConnectionError } from "./errors.ts"
import { isConnectionReadMethod } from "./types.ts"
import type { ConnectionActionInfo, ConnectionApiCatalog, ConnectionDefinition } from "./types.ts"

/** Match an id against a pattern with an optional trailing `.*`. */
export function matchesPattern(id: string, pattern: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith(".*")) return id.startsWith(pattern.slice(0, -1))
  return id === pattern
}

/** The provider API catalogs of a definition, by API name. */
export function providerApis(definition: ConnectionDefinition): Readonly<Record<string, ConnectionApiCatalog>> {
  // SAFETY: ConnectionProvider maps each named API to a ConnectionApiCatalog; the default object generic erases those keys.
  return definition.provider.apis as Readonly<Record<string, ConnectionApiCatalog>>
}

/** List the API methods that a definition exposes, as action ids. */
export function connectionActions(definition: ConnectionDefinition): ConnectionActionInfo[] {
  const apis = providerApis(definition)
  // SAFETY: ConnectionApiSelection maps each named API to optional string patterns; the default object generic erases those keys.
  const selection = definition.api as Readonly<Record<string, readonly string[] | undefined>> | undefined
  const actions: ConnectionActionInfo[] = []
  for (const [api, catalog] of Object.entries(apis)) {
    // A selection only applies when the API name is an own property. Reading
    // inherited keys would treat names such as `constructor` as patterns and
    // can call methods on a prototype value instead of the declared config.
    const patterns = selection
      ? Object.hasOwn(selection, api) ? selection[api] : undefined
      : ["*"]
    if (!patterns?.length) continue
    for (const [method, [httpMethod]] of Object.entries(catalog.methods)) {
      if (!patterns.some(pattern => matchesPattern(method, pattern))) continue
      const write = !isConnectionReadMethod(httpMethod)
      actions.push({
        highRisk: write && (catalog.highRisk ?? []).some(pattern => matchesPattern(method, pattern)),
        id: `${api}.${method}`,
        method: httpMethod,
        write,
      })
    }
  }
  return actions
}

export function prepareConnectionMethod(name: string, definition: ConnectionDefinition, action: string, input: unknown) {
  const apis = providerApis(definition)
  const api = action.slice(0, action.indexOf("."))
  const catalog = Object.hasOwn(apis, api) ? apis[api] : undefined
  const info = connectionActions(definition).find(candidate => candidate.id === action)
  if (!catalog || !info) {
    throw new ConnectionError("invalid", `Connection "${name}" does not expose ${action}.`, { details: { action, connection: name } })
  }
  return {
    ...buildMethodRequest(catalog, action.slice(api.length + 1), input),
    action,
    highRisk: info.highRisk,
    write: info.write,
  }
}

function buildMethodRequest(catalog: ConnectionApiCatalog, method: string, input: unknown): { body?: string, method: string, url: string } {
  const entry = catalog.methods[method]
  if (!entry) throw new ConnectionError("invalid", `Unknown method "${method}".`)
  const [httpMethod, template, acceptsBody] = entry
  const parsedInput = v.safeParse(v.record(v.string(), v.unknown()), input)
  const params: Record<string, unknown> = parsedInput.success ? { ...parsedInput.output } : {}
  const body = params.requestBody
  delete params.requestBody
  const path = template.replace(/\{(\+?)([^}]+)\}/g, (_match, reserved: string, parameter: string) => {
    const value = params[parameter]
    if (value === undefined || value === null || value === "") throw new ConnectionError("invalid", `Method "${method}" requires "${parameter}".`)
    delete params[parameter]
    return reserved ? encodeURI(String(value)) : encodeURIComponent(String(value))
  })
  const url = new URL(path, catalog.rootUrl)
  for (const [parameter, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(parameter, String(item))
  }
  return {
    body: acceptsBody && body !== undefined ? JSON.stringify(body) : undefined,
    method: httpMethod,
    url: url.toString(),
  }
}
