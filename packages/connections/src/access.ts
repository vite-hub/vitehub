import type { ConnectionAccess, ConnectionAccessDecision, ConnectionAccessRule, ConnectionActor, ConnectionEffect } from "./types.ts"

function patternToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)
}

export function matchesConnectionPattern(patterns: readonly string[] | undefined, operation: string): boolean {
  return Boolean(patterns?.some(pattern => patternToRegExp(pattern).test(operation)))
}

/** Returns the rule that applies to an actor. */
export function connectionAccessRule(access: ConnectionAccess | undefined, actor: ConnectionActor): ConnectionAccessRule | undefined {
  if (actor.kind === "agent") return access?.agents?.[actor.id]
  if (actor.kind === "route") return access?.routes?.[actor.id] ?? access?.server
  return access?.server
}

/** Deny wins, then approve, then allow. Without a match, reads are allowed and writes are denied. */
export function decideConnectionAccess(
  access: ConnectionAccess | undefined,
  actor: ConnectionActor,
  operation: { effect: ConnectionEffect, id: string },
): ConnectionAccessDecision {
  const rule = connectionAccessRule(access, actor)
  if (matchesConnectionPattern(rule?.deny, operation.id)) return "deny"
  if (matchesConnectionPattern(rule?.approve, operation.id)) return "require-approval"
  if (matchesConnectionPattern(rule?.allow, operation.id)) return "allow"
  return operation.effect === "read" ? "allow" : "deny"
}
