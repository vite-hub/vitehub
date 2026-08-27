import type { AgentInvocations } from "@vite-hub/agent"
import type { KVStorage } from "@vite-hub/kv"
import type { ConsoleSectionId } from "./runtime/sections.ts"

export const consoleInvocationsKey: unique symbol = Symbol.for("vitehub.console.invocations")
export const consoleInvocationsFallbackKey: unique symbol = Symbol.for("vitehub.console.invocations.fallback")
export const consoleInvocationsRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.registry")
export const consoleKVKey: unique symbol = Symbol.for("vitehub.console.kv")
export const consoleKVRegistryKey: unique symbol = Symbol.for("vitehub.console.kv.registry")
export const consoleKVRootKey: unique symbol = Symbol.for("vitehub.console.kv.root")
export const consoleProjectRootKey: unique symbol = Symbol.for("vitehub.console.project.root")
export const consoleSectionsKey: unique symbol = Symbol.for("vitehub.console.sections")
export const consoleSectionsRootKey: unique symbol = Symbol.for("vitehub.console.sections.root")
export const consoleSectionsRegistryKey: unique symbol = Symbol.for("vitehub.console.sections.registry")

type ConsoleInvocationsByRoot = {
  get(key: string): AgentInvocations | undefined
  set(key: string, value: AgentInvocations): unknown
  readonly size: number
}

export interface ConsoleKVInspection {
  storage: KVStorage
  stores: readonly string[]
}

type ConsoleKVByRoot = {
  get(key: string): ConsoleKVInspection | undefined
  set(key: string, value: ConsoleKVInspection): unknown
  readonly size: number
}

type ConsoleSectionsByRoot = {
  get(key: string): readonly ConsoleSectionId[] | undefined
  set(key: string, value: readonly ConsoleSectionId[]): unknown
  readonly size: number
}

type ConsoleRuntimeRegistry = Record<
  symbol,
  | AgentInvocations
  | ConsoleInvocationsByRoot
  | ConsoleKVByRoot
  | ConsoleKVInspection
  | ConsoleSectionsByRoot
  | readonly ConsoleSectionId[]
  | string
  | undefined
>

export type ConsoleInvocationScope = {
  process?: unknown
  [consoleInvocationsKey]?: AgentInvocations
  [consoleInvocationsRegistryKey]?: ConsoleInvocationsByRoot
  [consoleKVKey]?: ConsoleKVInspection
  [consoleKVRegistryKey]?: ConsoleKVByRoot
  [consoleKVRootKey]?: string
  [consoleProjectRootKey]?: string
  [consoleSectionsKey]?: readonly ConsoleSectionId[]
  [consoleSectionsRootKey]?: string
  [consoleSectionsRegistryKey]?: ConsoleSectionsByRoot
}

function defaultConsoleInvocationScope(): ConsoleInvocationScope {
  // SAFETY: ConsoleInvocationScope only adds optional symbol-keyed state to the global object.
  return globalThis as ConsoleInvocationScope
}

function invocationsByRoot(value: unknown): ConsoleInvocationsByRoot | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry values cross Vite SSR realms, so realm-local prototypes cannot establish this boundary.
  if (!value || (typeof value !== "object" && typeof value !== "function")) return
  // SAFETY: The structural checks below validate every ConsoleInvocationsByRoot member before use.
  const registry = value as Partial<ConsoleInvocationsByRoot>
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Callable members are the realm-independent registry contract.
  if (typeof registry.get !== "function"
    || typeof registry.set !== "function"
    || !Number.isInteger(registry.size)) return
  // SAFETY: The preceding checks validate every ConsoleInvocationsByRoot member.
  return registry as ConsoleInvocationsByRoot
}

function kvByRoot(value: unknown): ConsoleKVByRoot | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry values cross Vite SSR realms, so realm-local prototypes cannot establish this boundary.
  if (!value || (typeof value !== "object" && typeof value !== "function")) return
  // SAFETY: The structural checks below validate every ConsoleKVByRoot member before use.
  const registry = value as Partial<ConsoleKVByRoot>
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Callable members are the realm-independent registry contract.
  if (typeof registry.get !== "function" || typeof registry.set !== "function" || !Number.isInteger(registry.size)) return
  // SAFETY: The preceding checks validate every ConsoleKVByRoot member.
  return registry as ConsoleKVByRoot
}

function sectionsByRoot(value: unknown): ConsoleSectionsByRoot | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry values cross Vite SSR realms, so realm-local prototypes cannot establish this boundary.
  if (!value || (typeof value !== "object" && typeof value !== "function")) return
  // SAFETY: The structural checks below validate every ConsoleSectionsByRoot member before use.
  const registry = value as Partial<ConsoleSectionsByRoot>
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Callable members are the realm-independent registry contract.
  if (typeof registry.get !== "function" || typeof registry.set !== "function" || !Number.isInteger(registry.size)) return
  // SAFETY: The preceding checks validate every ConsoleSectionsByRoot member.
  return registry as ConsoleSectionsByRoot
}

function processRegistry(scope: ConsoleInvocationScope): ConsoleRuntimeRegistry | undefined {
  // Vite SSR module runners isolate globalThis but retain the host Node process object.
  return scope.process && (typeof scope.process === "object" || typeof scope.process === "function") ? (scope.process as ConsoleRuntimeRegistry) : undefined
}

export function resolveConsoleInvocations(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): AgentInvocations | undefined {
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
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
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

export function installConsoleKVScope(
  projectRoot: string,
  inspection: ConsoleKVInspection,
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
): ConsoleKVInspection {
  scope[consoleKVRootKey] = projectRoot
  scope[consoleKVKey] = inspection
  const registry = processRegistry(scope)
  if (registry) {
    const inspections = kvByRoot(registry[consoleKVRegistryKey]) ?? new Map<string, ConsoleKVInspection>()
    inspections.set(projectRoot, inspection)
    registry[consoleKVRegistryKey] = inspections
    registry[consoleKVKey] = inspection
  }
  return inspection
}

export function resolveConsoleKV(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): ConsoleKVInspection | undefined {
  const root = scope[consoleKVRootKey]
  const registered = kvByRoot(processRegistry(scope)?.[consoleKVRegistryKey])
  if (root) return registered?.get(root) ?? scope[consoleKVKey]
  if (registered && registered.size > 1) return scope[consoleKVKey]
  // SAFETY: installConsoleKVScope is the only writer for this process registry key.
  return (processRegistry(scope)?.[consoleKVKey] as ConsoleKVInspection | undefined) ?? scope[consoleKVKey]
}

export function installConsoleSectionScope(
  projectRoot: string,
  sections: readonly ConsoleSectionId[],
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
): readonly ConsoleSectionId[] {
  const installed = [...new Set(sections)]
  scope[consoleSectionsRootKey] = projectRoot
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

export function resolveConsoleSections(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): readonly ConsoleSectionId[] {
  const root = scope[consoleSectionsRootKey]
  const registered = sectionsByRoot(processRegistry(scope)?.[consoleSectionsRegistryKey])
  if (root) return registered?.get(root) ?? scope[consoleSectionsKey] ?? []
  if (registered && registered.size > 1) return scope[consoleSectionsKey] ?? []
  // SAFETY: installConsoleSectionScope is the only writer for this process registry key.
  return (processRegistry(scope)?.[consoleSectionsKey] as readonly ConsoleSectionId[] | undefined) ?? scope[consoleSectionsKey] ?? []
}

export function resolveConsoleProjectRoot(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): string | undefined {
  return scope[consoleProjectRootKey]
}
