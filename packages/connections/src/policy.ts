import { envAccessActor } from "@vite-hub/env/internal/connections"

import type { EnvActor } from "@vite-hub/env/bridge"

import { ConnectionError } from "./errors.ts"

import { matchesPattern } from "./catalog.ts"
import type { ConnectionAccessRule, ConnectionDefinition, UseConnectionOptions } from "./types.ts"

export type ConnectionDecision = "allow" | "approve" | "deny"

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

/** Resolve the caller. An Agent actor comes only from an Env context that the Agent runtime created. */
export function callerActor(options: Pick<UseConnectionOptions, "access" | "actor">): string {
  if (options.access) {
    const actor = envAccessActor(options.access)
    if (actor.kind !== "agent" || options.actor !== undefined) {
      throw new ConnectionError("invalid", "Connection `access` must be the Env access context of an Agent, without `actor`.")
    }
    return `agent:${actor.id}`
  }
  if (options.actor?.startsWith("agent:")) {
    throw new ConnectionError("invalid", "Agent actors come from the Agent runtime. Use the Connection capabilities of the Agent.")
  }
  return options.actor ?? "server"
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
