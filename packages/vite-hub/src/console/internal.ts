import type { AgentInvocations } from "@vite-hub/agent"

export const consoleInvocationsKey = Symbol.for("vitehub.console.invocations")
export const consoleInvocationsRootKey = Symbol.for("vitehub.console.invocations.root")

type ConsoleInvocationRegistry = Record<symbol, AgentInvocations | string | undefined>

export type ConsoleInvocationScope = {
  process?: unknown
  [consoleInvocationsKey]?: AgentInvocations
  [consoleInvocationsRootKey]?: string
}

function processRegistry(scope: ConsoleInvocationScope): ConsoleInvocationRegistry | undefined {
  // Vite SSR module runners isolate globalThis but retain the host Node process object.
  return scope.process && (typeof scope.process === "object" || typeof scope.process === "function")
    ? scope.process as ConsoleInvocationRegistry
    : undefined
}

export function resolveConsoleInvocations(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): AgentInvocations | undefined {
  return processRegistry(scope)?.[consoleInvocationsKey] as AgentInvocations | undefined
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
    registry[consoleInvocationsKey] = invocations
    registry[consoleInvocationsRootKey] = projectRoot
  }
}

export function resolveConsoleInvocationsRoot(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): string | undefined {
  return processRegistry(scope)?.[consoleInvocationsRootKey] as string | undefined
    ?? scope[consoleInvocationsRootKey]
}
