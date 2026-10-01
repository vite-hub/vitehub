import type { EnvActor } from "@vite-hub/env/bridge"

import { ConnectionError } from "./errors.ts"

import { isConnectionReadMethod } from "./types.ts"
import type { ConnectionAccessRule, ConnectionActionInfo, ConnectionApiCatalog, ConnectionDefinition } from "./types.ts"

export type ConnectionDecision = "allow" | "approve" | "deny"

/** Match an id against a pattern with an optional trailing `.*`. */
export function matchesPattern(id: string, pattern: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith(".*")) return id.startsWith(pattern.slice(0, -1))
  return id === pattern
}

/** Validate an actor string and map it to an Env Bridge actor. */
export function envActor(actor: string): EnvActor {
  const mapped: EnvActor = actor.startsWith("agent:")
    ? { id: actor.slice(6), kind: "agent" }
    : actor.startsWith("user:")
      ? { id: actor.slice(5), kind: "user" }
      : { id: actor, kind: "service" }
  if (!mapped.id || mapped.id.length > 512 || /[\u0000-\u001f]/.test(mapped.id)) {
    throw new ConnectionError("invalid", "Connection actor IDs must contain 1 to 512 characters and no control characters.")
  }
  return mapped
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
    const patterns = selection ? selection[api] : ["*"]
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

function allowsWrite(rule: ConnectionAccessRule, action: string, highRisk: boolean): boolean {
  const write = rule.write
  if (!write) return false
  if (write === true || write === "approve") return !highRisk && action !== "fetch"
  return write.some(pattern => highRisk || action === "fetch" ? pattern === action : matchesPattern(action, pattern))
}

/**
 * Decide one call. `approved` is set when a stored approval replays the call, so
 * the policy can still deny it but does not ask for approval again.
 */
export function decide(input: {
  action: string
  actor: string
  approved?: boolean
  definition: ConnectionDefinition
  highRisk: boolean
  write: boolean
}): ConnectionDecision {
  const agent = input.actor.startsWith("agent:")
  const access: Readonly<Record<string, ConnectionAccessRule>> | undefined = input.definition.access
  if (!access) {
    if (!input.write) return "allow"
    if (input.highRisk || input.action === "fetch") return "deny"
    return agent && !input.approved ? "approve" : "allow"
  }
  const rule = Object.hasOwn(access, input.actor) ? access[input.actor] : undefined
  if (!rule) return "deny"
  if (!input.write) return rule.read ? "allow" : "deny"
  if (!allowsWrite(rule, input.action, input.highRisk)) return "deny"
  if (input.approved) return "allow"
  return rule.write === "approve" || (rule.approve ?? agent) ? "approve" : "allow"
}
