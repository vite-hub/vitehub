import type { AgentInvocations } from "@vite-hub/agent"

export const consoleInvocationsKey = Symbol.for("vitehub.console.invocations")
export const consoleInvocationsRootKey = Symbol.for("vitehub.console.invocations.root")
export const consoleInvocationsRegistryKey = Symbol.for("vitehub.console.invocations.registry")

type ConsoleInvocationRegistry = Record<symbol, AgentInvocations | string | Map<string, AgentInvocations> | undefined>

export type ConsoleInvocationScope = {
  process?: unknown
  [consoleInvocationsKey]?: AgentInvocations
  [consoleInvocationsRootKey]?: string
  [consoleInvocationsRegistryKey]?: Map<string, AgentInvocations>
}

function processRegistry(scope: ConsoleInvocationScope): ConsoleInvocationRegistry | undefined {
  // Vite SSR module runners isolate globalThis but retain the host Node process object.
  return scope.process && (typeof scope.process === "object" || typeof scope.process === "function")
    ? scope.process as ConsoleInvocationRegistry
    : undefined
}

export function resolveConsoleInvocations(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): AgentInvocations | undefined {
  const root = scope[consoleInvocationsRootKey]
  const registered = processRegistry(scope)?.[consoleInvocationsRegistryKey]
  const rooted = root && registered instanceof Map ? registered.get(root) : undefined
  return rooted
    ?? processRegistry(scope)?.[consoleInvocationsKey] as AgentInvocations | undefined
    ?? scope[consoleInvocationsKey]
}

export function installConsoleInvocationFallback(
  invocations: AgentInvocations,
  projectRoot: string,
  scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope,
): void {
  scope[consoleInvocationsKey] = invocations
  scope[consoleInvocationsRootKey] = projectRoot
  const registry = processRegistry(scope)
  if (registry) {
    const installed = registry[consoleInvocationsRegistryKey]
    const journals = installed instanceof Map ? installed : new Map<string, AgentInvocations>()
    journals.set(projectRoot, invocations)
    registry[consoleInvocationsRegistryKey] = journals
    registry[consoleInvocationsKey] = invocations
  }
}

export function resolveConsoleInvocationsRoot(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): string | undefined {
  return scope[consoleInvocationsRootKey]
}
