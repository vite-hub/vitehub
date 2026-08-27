import type { AgentInvocations } from "@vite-hub/agent"
import type { ConsoleSectionId } from "./runtime/sections.ts"

export const consoleInvocationsKey: unique symbol = Symbol.for("vitehub.console.invocations")
export const consoleInvocationsFallbackKey: unique symbol = Symbol.for("vitehub.console.invocations.fallback")
export const consoleInvocationsRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.registry")
export const consoleProjectRootKey: unique symbol = Symbol.for("vitehub.console.project.root")
export const consoleSectionsKey: unique symbol = Symbol.for("vitehub.console.sections")
export const consoleSectionsRegistryKey: unique symbol = Symbol.for("vitehub.console.sections.registry")

type ConsoleInvocationsByRoot = {
  get(key: string): AgentInvocations | undefined
  set(key: string, value: AgentInvocations): unknown
  readonly size: number
}

type ConsoleSectionsByRoot = {
  get(key: string): readonly ConsoleSectionId[] | undefined
  set(key: string, value: readonly ConsoleSectionId[]): unknown
  readonly size: number
}

type ConsoleRuntimeRegistry = Record<
  symbol,
  AgentInvocations | string | readonly ConsoleSectionId[] | ConsoleInvocationsByRoot | ConsoleSectionsByRoot | undefined
>

export type ConsoleInvocationScope = {
  process?: unknown
  [consoleInvocationsKey]?: AgentInvocations
  [consoleInvocationsRegistryKey]?: ConsoleInvocationsByRoot
  [consoleProjectRootKey]?: string
  [consoleSectionsKey]?: readonly ConsoleSectionId[]
  [consoleSectionsRegistryKey]?: ConsoleSectionsByRoot
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

function sectionsByRoot(value: unknown): ConsoleSectionsByRoot | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry values cross Vite SSR realms, so realm-local prototypes cannot establish this boundary.
  if (!value || (typeof value !== "object" && typeof value !== "function")) return
  // SAFETY: The structural checks below validate every ConsoleSectionsByRoot member before use.
  const registry = value as Partial<ConsoleSectionsByRoot>
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Callable members are the realm-independent registry contract.
  return typeof registry.get === "function" && typeof registry.set === "function" && Number.isInteger(registry.size)
    ? // SAFETY: The preceding checks validate every ConsoleSectionsByRoot member.
      (registry as ConsoleSectionsByRoot)
    : undefined
}

function processRegistry(scope: ConsoleInvocationScope): ConsoleRuntimeRegistry | undefined {
  // Vite SSR module runners isolate globalThis but retain the host Node process object.
  return scope.process && (typeof scope.process === "object" || typeof scope.process === "function") ? (scope.process as ConsoleRuntimeRegistry) : undefined
}

export function resolveConsoleInvocations(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): AgentInvocations | undefined {
  const root = scope[consoleProjectRootKey]
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
  scope[consoleProjectRootKey] = projectRoot
  const registry = processRegistry(scope)
  if (registry) {
    const journals = invocationsByRoot(registry[consoleInvocationsRegistryKey]) ?? new Map<string, AgentInvocations>()
    journals.set(projectRoot, invocations)
    registry[consoleInvocationsRegistryKey] = journals
    registry[consoleInvocationsKey] = invocations
  }
}

export function installConsoleSectionScope(
  projectRoot: string,
  sections: readonly ConsoleSectionId[],
  scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope,
): readonly ConsoleSectionId[] {
  const installed = [...new Set(sections)]
  scope[consoleProjectRootKey] = projectRoot
  scope[consoleSectionsKey] = installed
  const registry = processRegistry(scope)
  if (registry) {
    const sectionsRegistry = sectionsByRoot(registry[consoleSectionsRegistryKey]) ?? new Map<string, readonly ConsoleSectionId[]>()
    sectionsRegistry.set(projectRoot, installed)
    registry[consoleSectionsRegistryKey] = sectionsRegistry
    registry[consoleSectionsKey] = installed
  }
  return installed
}

export function resolveConsoleSections(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): readonly ConsoleSectionId[] {
  const root = scope[consoleProjectRootKey]
  const registered = sectionsByRoot(processRegistry(scope)?.[consoleSectionsRegistryKey])
  if (root) return registered?.get(root) ?? scope[consoleSectionsKey] ?? []
  if (registered && registered.size > 1) return scope[consoleSectionsKey] ?? []
  // SAFETY: installConsoleSectionScope is the only writer for this process registry key.
  return (processRegistry(scope)?.[consoleSectionsKey] as readonly ConsoleSectionId[] | undefined) ?? scope[consoleSectionsKey] ?? []
}

export function resolveConsoleProjectRoot(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): string | undefined {
  return scope[consoleProjectRootKey]
}
