import { isRuntimeObject } from "./runtime-type.ts"

interface RegisteredIdentity {
  name: string
  parents: readonly string[]
}

/** Identities are registered only while resolving an Agent Definition. */
const identities = new WeakMap<object, RegisteredIdentity>()
export const agentEnvIdentity: unique symbol = Symbol("vitehub.agentEnvIdentity")

/**
 * Register an identity for Env. `parents` are the names of the Agents that the Definition extends, nearest first.
 * Only the Agent runtime supplies them. Fields of `identity` never become parents.
 */
export function createAgentEnvIdentity<T extends { name: string }>(identity: T, definitionName: string = identity.name, parents: readonly string[] = []): Readonly<T> {
  const result = Object.freeze({ ...identity })
  identities.set(result, { name: definitionName, parents: Object.freeze(parents.filter(parent => parent !== definitionName)) })
  return result
}

/** Read-only proof for Env. Copies and caller-created objects have no identity. */
export function readAgentEnvIdentity(identity: unknown): string | undefined {
  return isRuntimeObject(identity) ? identities.get(identity)?.name : undefined
}

/** The Agents that a registered identity extends, nearest first. Copies and caller-created objects have none. */
export function readAgentEnvParents(identity: unknown): readonly string[] {
  return (isRuntimeObject(identity) ? identities.get(identity)?.parents : undefined) ?? []
}
