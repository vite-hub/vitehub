import { resolve } from "node:path"

import { consoleInvocationsRootKey } from "../../internal.ts"

export const consoleAgentsKey: unique symbol = Symbol.for("vitehub.console.agents")
export const consoleAgentsRegistryKey: unique symbol = Symbol.for("vitehub.console.agents.registry")

type ConsoleAgentsByRoot = {
  get(key: string): readonly string[] | undefined
  set(key: string, value: readonly string[]): unknown
  readonly size: number
}

type ConsoleAgentRegistry = Record<symbol, ConsoleAgentsByRoot | readonly string[] | undefined>

export type ConsoleAgentScope = {
  process?: unknown
  [consoleAgentsKey]?: readonly string[]
  [consoleAgentsRegistryKey]?: ConsoleAgentsByRoot
  [consoleInvocationsRootKey]?: string
}

function agentsByRoot(value: unknown): ConsoleAgentsByRoot | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry values cross Vite SSR realms, so realm-local prototypes cannot establish this boundary.
  if (!value || (typeof value !== "object" && typeof value !== "function")) return
  // SAFETY: The structural checks below validate every ConsoleAgentsByRoot member before use.
  const registry = value as Partial<ConsoleAgentsByRoot>
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Callable members are the realm-independent registry contract.
  return typeof registry.get === "function"
    && typeof registry.set === "function"
    && Number.isInteger(registry.size)
    // SAFETY: The preceding checks validate every ConsoleAgentsByRoot member.
    ? registry as ConsoleAgentsByRoot
    : undefined
}

function processRegistry(scope: ConsoleAgentScope): ConsoleAgentRegistry | undefined {
  return scope.process && (typeof scope.process === "object" || typeof scope.process === "function")
    ? scope.process as ConsoleAgentRegistry
    : undefined
}

function normalizedAgentNames(agentNames: readonly string[]): readonly string[] {
  return [...new Set(agentNames.map(name => name.trim()).filter(Boolean))].sort()
}

export function resolveConsoleAgents(
  scope: ConsoleAgentScope = globalThis as ConsoleAgentScope,
): readonly string[] | undefined {
  const root = scope[consoleInvocationsRootKey]
  const registered = agentsByRoot(processRegistry(scope)?.[consoleAgentsRegistryKey])
  if (root) return registered?.get(root) ?? scope[consoleAgentsKey]
  if (!root && registered && registered.size > 1) return scope[consoleAgentsKey]
  return processRegistry(scope)?.[consoleAgentsKey] as readonly string[] | undefined
    ?? scope[consoleAgentsKey]
}

export function installConsoleAgents(
  agentNames: readonly string[],
  projectRoot: string,
  scope: ConsoleAgentScope = globalThis as ConsoleAgentScope,
): readonly string[] {
  const root = resolve(projectRoot)
  const agents = normalizedAgentNames(agentNames)
  scope[consoleAgentsKey] = agents
  scope[consoleInvocationsRootKey] = root
  const registry = processRegistry(scope)
  if (registry) {
    const agentsByProject = agentsByRoot(registry[consoleAgentsRegistryKey])
      ?? new Map<string, readonly string[]>()
    agentsByProject.set(root, agents)
    registry[consoleAgentsRegistryKey] = agentsByProject
    registry[consoleAgentsKey] = agents
  }
  return agents
}

export function getConsoleAgents(): readonly string[] {
  return resolveConsoleAgents() ?? []
}
