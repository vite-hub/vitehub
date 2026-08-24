import type { AgentInvocations } from "@vite-hub/agent"

export const consoleInvocationsKey: unique symbol = Symbol.for("vitehub.console.invocations")
export const consoleInvocationsRootKey: unique symbol = Symbol.for("vitehub.console.invocations.root")
export const consoleInvocationsRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.registry")

type ConsoleInvocationsByRoot = {
  get(key: string): AgentInvocations | undefined
  set(key: string, value: AgentInvocations): unknown
  readonly size: number
}

type ConsoleInvocationRegistry = Record<symbol, AgentInvocations | string | ConsoleInvocationsByRoot | undefined>

export type ConsoleInvocationScope = {
  process?: unknown
  [consoleInvocationsKey]?: AgentInvocations
  [consoleInvocationsRootKey]?: string
  [consoleInvocationsRegistryKey]?: ConsoleInvocationsByRoot
}

function invocationsByRoot(value: unknown): ConsoleInvocationsByRoot | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry values cross Vite SSR realms, so realm-local prototypes cannot establish this boundary.
  if (!value || (typeof value !== "object" && typeof value !== "function")) return
  // SAFETY: The structural checks below validate every ConsoleInvocationsByRoot member before use.
  const registry = value as Partial<ConsoleInvocationsByRoot>
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Callable members are the realm-independent registry contract.
  return typeof registry.get === "function"
    && typeof registry.set === "function"
    && Number.isInteger(registry.size)
    // SAFETY: The preceding checks validate every ConsoleInvocationsByRoot member.
    ? registry as ConsoleInvocationsByRoot
    : undefined
}

function processRegistry(scope: ConsoleInvocationScope): ConsoleInvocationRegistry | undefined {
  // Vite SSR module runners isolate globalThis but retain the host Node process object.
  return scope.process && (typeof scope.process === "object" || typeof scope.process === "function")
    ? scope.process as ConsoleInvocationRegistry
    : undefined
}

export function resolveConsoleInvocations(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): AgentInvocations | undefined {
  const root = scope[consoleInvocationsRootKey]
  const registered = invocationsByRoot(processRegistry(scope)?.[consoleInvocationsRegistryKey])
  if (root) {
    return registered?.get(root) ?? scope[consoleInvocationsKey]
  }
  if (!root && registered && registered.size > 1) {
    return scope[consoleInvocationsKey]
  }
  // SAFETY: installConsoleInvocationFallback is the only writer for this process registry key.
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
    const journals = invocationsByRoot(registry[consoleInvocationsRegistryKey])
      ?? new Map<string, AgentInvocations>()
    journals.set(projectRoot, invocations)
    registry[consoleInvocationsRegistryKey] = journals
    registry[consoleInvocationsKey] = invocations
  }
}

export function resolveConsoleInvocationsRoot(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): string | undefined {
  return scope[consoleInvocationsRootKey]
}
