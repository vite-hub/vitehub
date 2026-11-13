import type { ServerEnvDescription, ServerEnvInspection } from "@vite-hub/env"
import type { AgentInvocations } from "@vite-hub/agent"
import type { BlobStorage } from "@vite-hub/blob"
import type { RuntimeDatabaseEntry } from "@vite-hub/database"
import type { ConsoleSectionCatalog } from "./runtime/definitions.ts"
import type { ConsoleDocumentEditors } from "./runtime/server/documents.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"
import type { ConsoleRequestEvent } from "./runtime/server/request.ts"

export const consoleInvocationsKey: unique symbol = Symbol.for("vitehub.console.invocations")
export const consoleInvocationsRootKey: unique symbol = Symbol.for("vitehub.console.invocations.root")
export const consoleInvocationsIdentityKey: unique symbol = Symbol.for("vitehub.console.invocations.identity")
export const consoleInvocationsIdentityRootKey: unique symbol = Symbol.for("vitehub.console.invocations.identity-root")
export const consoleInvocationsBindingKey: unique symbol = Symbol.for("vitehub.console.invocations.binding")
export const consoleInvocationsBindingRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.bindings")
export const consoleInvocationsBindingRootRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.binding-roots")
export const consoleInvocationsRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.registry")
export const consoleInvocationsRootIdentityRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.root-identities")
export const consoleProjectRootKey: typeof consoleInvocationsRootKey = consoleInvocationsRootKey
export const consoleStateKey: unique symbol = Symbol.for("vitehub.console.state")
/** `@vite-hub/schedule` reads the Schedules that the Console may run from this slot of the global object. */
export const consoleSchedulesKey: unique symbol = Symbol.for("vitehub.console.schedules")

type ConsoleInvocationsByRoot = {
  delete(key: string): boolean
  get(key: string): AgentInvocations | undefined
  set(key: string, value: AgentInvocations): unknown
  readonly size: number
}

export type ConsoleEnvInspection = ServerEnvDescription & {
  inspect?: (event: ConsoleRequestEvent) => Promise<ServerEnvInspection>
}

/** The Console reads each database with `db` and lists its tables from `schema`. */
export type ConsoleDatabaseEntry = Pick<RuntimeDatabaseEntry<Record<string, unknown>>, "db" | "schema">

export interface ConsoleDatabaseInspection {
  databases: Record<string, ConsoleDatabaseEntry>
  names: readonly string[]
}

export interface ConsoleMediaLibrary {
  runConsoleMediaAction: typeof import("./runtime/server/media.ts").runConsoleMediaAction
  uploadConsoleMedia: typeof import("./runtime/server/media.ts").uploadConsoleMedia
}

export interface ConsoleBlobInspection {
  storage: BlobStorage
  stores: readonly string[]
  /** Loads the media library. Only builds with Blob install it, so other builds ship without it. */
  media?: () => Promise<ConsoleMediaLibrary>
}

type ConsoleInvocationRegistry = Record<
  symbol,
  AgentInvocations | ConsoleInvocationsByRoot | ConsoleInvocationIdentitiesByRoot | undefined
>

type ConsoleInvocationIdentitiesByRoot = {
  delete(key: string): boolean
  entries(): IterableIterator<[string, string]>
  get(key: string): string | undefined
  set(key: string, value: string): unknown
  values(): IterableIterator<string>
}

/**
 * What generated Console output installs: the sections, the project name, and the readers of each
 * section. One server bundle serves one project, so the Console keeps one state and does not key it by project root.
 * The state lives on the global object, because a development server runs server code in more than one Vite module
 * runner, such as the `nitro` and `ssr` environments of a Nitro dev worker. Each runner loads its own copy of the
 * Console modules, and all of them share the global object.
 */
export interface ConsoleState {
  blob?: ConsoleBlobInspection
  database?: ConsoleDatabaseInspection
  definitions?: ConsoleSectionCatalog
  /** Whether generated output was created for a development server. */
  development?: boolean
  /** The Setup endpoint route, installed only in development output. */
  setupRoute?: string
  documents?: ConsoleDocumentEditors
  env?: ConsoleEnvInspection
  projectName?: string
  sections?: readonly ConsoleSectionId[]
  /** Sections shown in navigation when local operations have more runtime sections installed. */
  navigationSections?: readonly ConsoleSectionId[]
}

export function consoleState(): ConsoleState {
  // SAFETY: Only this module writes the Console state slot of the global object.
  const scope = globalThis as typeof globalThis & { [consoleStateKey]?: ConsoleState }
  return scope[consoleStateKey] ??= {}
}

export type ConsoleInvocationScope = {
  process?: unknown
  [consoleInvocationsBindingKey]?: string
  [consoleInvocationsKey]?: AgentInvocations
  [consoleInvocationsIdentityKey]?: string
  [consoleInvocationsIdentityRootKey]?: string
  [consoleInvocationsRootKey]?: string
  [consoleInvocationsRegistryKey]?: ConsoleInvocationsByRoot
  [consoleInvocationsRootIdentityRegistryKey]?: ConsoleInvocationIdentitiesByRoot
}

function defaultConsoleInvocationScope(): ConsoleInvocationScope {
  // SAFETY: ConsoleInvocationScope adds only optional symbol-keyed state to the global object.
  return globalThis as ConsoleInvocationScope
}

export function createConsoleInvocationsIdentity(projectRoot: string): string {
  return `sqlite:${projectRoot}`
}

function invocationsByRoot(value: unknown): ConsoleInvocationsByRoot | undefined {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return
  // SAFETY: The structural checks below validate every ConsoleInvocationsByRoot member before use.
  const registry = value as Partial<ConsoleInvocationsByRoot>
  return typeof registry.get === "function"
    && typeof registry.delete === "function"
    && typeof registry.set === "function"
    && Number.isInteger(registry.size)
    // SAFETY: The preceding checks validate every ConsoleInvocationsByRoot member.
    ? registry as ConsoleInvocationsByRoot
    : undefined
}

function retireConsoleInvocationsIdentity(registry: ConsoleInvocationRegistry, identity: string): boolean {
  // SAFETY: bindConsoleInvocationsIdentity is the only writer for this process registry key.
  const bindings = registry[consoleInvocationsBindingRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
  if (bindings && [...bindings.values()].includes(identity)) return false
  // SAFETY: installConsoleInvocationFallback is the only writer for this process registry key.
  const roots = registry[consoleInvocationsRootIdentityRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
  if (roots && [...roots.values()].includes(identity)) return false
  invocationsByRoot(registry[consoleInvocationsRegistryKey])?.delete(identity)
  return true
}

function processRegistry(scope: ConsoleInvocationScope): ConsoleInvocationRegistry | undefined {
  // Vite SSR module runners isolate globalThis but retain the host Node process object.
  if (!scope.process || (typeof scope.process !== "object" && typeof scope.process !== "function")) return
  // SAFETY: ConsoleInvocationRegistry uses only optional symbol keys on the shared process object.
  return scope.process as ConsoleInvocationRegistry
}

export function bindConsoleInvocationsIdentity(
  binding: string,
  identity: string,
  projectRoot: string,
  scope: ConsoleInvocationScope = globalThis,
): void {
  const registry = processRegistry(scope)
  if (!registry) return
  // SAFETY: bindConsoleInvocationsIdentity is the only writer for this process registry key.
  const bindings = registry[consoleInvocationsBindingRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
    ?? new Map<string, string>()
  const previousIdentity = bindings.get(binding)
  // SAFETY: bindConsoleInvocationsIdentity is the only writer for this process registry key.
  const bindingRoots = registry[consoleInvocationsBindingRootRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
    ?? new Map<string, string>()
  bindings.set(binding, identity)
  bindingRoots.set(binding, projectRoot)
  registry[consoleInvocationsBindingRegistryKey] = bindings
  registry[consoleInvocationsBindingRootRegistryKey] = bindingRoots
  if (previousIdentity && previousIdentity !== identity) {
    retireConsoleInvocationsIdentity(registry, previousIdentity)
  }
}

export function releaseConsoleInvocationsBinding(
  binding: string,
  scope: ConsoleInvocationScope = globalThis,
): void {
  const registry = processRegistry(scope)
  if (!registry) return
  // SAFETY: bindConsoleInvocationsIdentity is the only writer for this process registry key.
  const bindings = registry[consoleInvocationsBindingRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
  const identity = bindings?.get(binding)
  if (!identity) return
  bindings?.delete(binding)
  // SAFETY: bindConsoleInvocationsIdentity is the only writer for this process registry key.
  const bindingRoots = registry[consoleInvocationsBindingRootRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
  const projectRoot = bindingRoots?.get(binding)
  bindingRoots?.delete(binding)
  // SAFETY: installConsoleInvocationFallback is the only writer for this process registry key.
  const roots = registry[consoleInvocationsRootIdentityRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
  if (projectRoot && roots?.get(projectRoot) === identity) {
    let survivingIdentity: string | undefined
    for (const [candidateBinding, candidateRoot] of bindingRoots?.entries() ?? []) {
      if (candidateRoot === projectRoot) survivingIdentity = bindings?.get(candidateBinding)
    }
    if (survivingIdentity) roots.set(projectRoot, survivingIdentity)
    else roots.delete(projectRoot)
  }
  const journals = invocationsByRoot(registry[consoleInvocationsRegistryKey])
  const releasedInvocations = journals?.get(identity)
  if (!retireConsoleInvocationsIdentity(registry, identity)) return
  const survivingIdentity = projectRoot ? roots?.get(projectRoot) : undefined
  const survivingInvocations = survivingIdentity ? journals?.get(survivingIdentity) : undefined
  if (releasedInvocations && registry[consoleInvocationsKey] === releasedInvocations) {
    if (survivingInvocations) registry[consoleInvocationsKey] = survivingInvocations
    else delete registry[consoleInvocationsKey]
  }
  if (scope[consoleInvocationsIdentityKey] !== identity) return
  if (survivingIdentity && survivingInvocations && projectRoot) {
    scope[consoleInvocationsKey] = survivingInvocations
    scope[consoleInvocationsIdentityKey] = survivingIdentity
    scope[consoleInvocationsIdentityRootKey] = projectRoot
    return
  }
  delete scope[consoleInvocationsKey]
  delete scope[consoleInvocationsIdentityKey]
  delete scope[consoleInvocationsIdentityRootKey]
  if (scope[consoleInvocationsRootKey] === projectRoot) delete scope[consoleInvocationsRootKey]
}

export function resolveConsoleInvocations(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): AgentInvocations | undefined {
  const root = scope[consoleInvocationsRootKey]
  const registry = processRegistry(scope)
  // SAFETY: installConsoleInvocationFallback is the only writer for this process registry key.
  const identities = registry?.[consoleInvocationsRootIdentityRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
  const registered = invocationsByRoot(registry?.[consoleInvocationsRegistryKey])
  const scopeOwnsRoot = scope[consoleInvocationsIdentityRootKey] === root
  const scopeIdentity = scopeOwnsRoot
    ? scope[consoleInvocationsIdentityKey]
    : undefined
  // SAFETY: bindConsoleInvocationsIdentity is the only writer for this process registry key.
  const bindings = registry?.[consoleInvocationsBindingRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
  const boundIdentity = scopeOwnsRoot && scope[consoleInvocationsBindingKey]
    ? bindings?.get(scope[consoleInvocationsBindingKey])
    : undefined
  const boundInvocations = boundIdentity ? registered?.get(boundIdentity) : undefined
  const identity = root
    ? scopeIdentity && registered?.get(scopeIdentity) ? scopeIdentity : identities?.get(root) ?? root
    : scope[consoleInvocationsIdentityKey]
  if (root) {
    if (boundInvocations) return boundInvocations
    return scopeIdentity
      ? scope[consoleInvocationsKey] ?? registered?.get(scopeIdentity)
      : registered?.get(identity ?? root)
  }
  if (!root && registered && registered.size > 1) {
    return scope[consoleInvocationsKey]
  }
  // SAFETY: installConsoleInvocationFallback is the only writer for this process registry key.
  return processRegistry(scope)?.[consoleInvocationsKey] as AgentInvocations | undefined
    ?? scope[consoleInvocationsKey]
}

const consoleSuppliedInvocationsKey: unique symbol = Symbol.for("vitehub.console.invocations.supplied")

/**
 * Marks a journal that the Console supplies to discovered Agents through `installConsoleAgentDefinitions()`.
 * It replaces the app-wide Agent journal.
 */
export function markConsoleSuppliedInvocations(invocations: AgentInvocations): void {
  Object.defineProperty(invocations, consoleSuppliedInvocationsKey, { configurable: true, enumerable: false, value: true })
}

/** The Console journal when the Console supplies it. The Console reads every other journal from its owner. */
export function resolveConsoleSuppliedInvocations(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): AgentInvocations | undefined {
  const invocations = resolveConsoleInvocations(scope)
  return invocations && Reflect.get(invocations, consoleSuppliedInvocationsKey) === true ? invocations : undefined
}

export function installConsoleInvocationFallback(
  invocations: AgentInvocations,
  projectRoot: string,
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
  identity: string = projectRoot,
): void {
  scope[consoleInvocationsKey] = invocations
  scope[consoleInvocationsRootKey] = projectRoot
  scope[consoleInvocationsIdentityKey] = identity
  scope[consoleInvocationsIdentityRootKey] = projectRoot
  const registry = processRegistry(scope)
  if (registry) {
    const journals = invocationsByRoot(registry[consoleInvocationsRegistryKey])
      ?? new Map<string, AgentInvocations>()
    journals.set(identity, invocations)
    registry[consoleInvocationsRegistryKey] = journals
    // SAFETY: installConsoleInvocationFallback is the only writer for this process registry key.
    const identities = registry[consoleInvocationsRootIdentityRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
      ?? new Map<string, string>()
    identities.set(projectRoot, identity)
    registry[consoleInvocationsRootIdentityRegistryKey] = identities
    registry[consoleInvocationsKey] = invocations
  }
}

export function resolveConsoleProjectRoot(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): string | undefined {
  return scope[consoleInvocationsRootKey]
}

export function resolveConsoleInvocationsRoot(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): string | undefined {
  return scope[consoleInvocationsRootKey]
}

export function resolveConsoleInvocationsIdentity(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): string | undefined {
  return scope[consoleInvocationsIdentityKey] ?? scope[consoleInvocationsRootKey]
}
