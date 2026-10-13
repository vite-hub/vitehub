import { createConsoleProjectRegistry, type ConsoleProjectRegistry } from "./project-registry.ts"
import type { ServerEnvDescription, ServerEnvInspection } from "@vite-hub/env"
import type { AgentInvocations } from "@vite-hub/agent"
import type { BlobStorage } from "@vite-hub/blob"
import type { RuntimeDatabaseEntry } from "@vite-hub/database/drizzle"
import type { KVStorage } from "@vite-hub/kv"
import type { ScheduleDefinitionRegistry } from "@vite-hub/schedule"
import type { ConsoleSectionCatalog } from "./runtime/definitions.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"
import type { ConsoleRequestEvent } from "./runtime/server/request.ts"

export const consoleDefinitionsKey: unique symbol = Symbol.for("vitehub.console.definitions")
export const consoleDefinitionsRegistryKey: unique symbol = Symbol.for("vitehub.console.definitions.registry")
export const consoleDefinitionsRootKey: unique symbol = Symbol.for("vitehub.console.definitions.root")
export const consoleDatabaseKey: unique symbol = Symbol.for("vitehub.console.database")
export const consoleDatabaseRegistryKey: unique symbol = Symbol.for("vitehub.console.database.registry")
export const consoleDatabaseRootKey: unique symbol = Symbol.for("vitehub.console.database.root")
export const consoleInvocationsKey: unique symbol = Symbol.for("vitehub.console.invocations")
export const consoleInvocationsFallbackKey: unique symbol = Symbol.for("vitehub.console.invocations.fallback")
export const consoleInvocationsRootKey: unique symbol = Symbol.for("vitehub.console.invocations.root")
export const consoleInvocationsIdentityKey: unique symbol = Symbol.for("vitehub.console.invocations.identity")
export const consoleInvocationsIdentityRootKey: unique symbol = Symbol.for("vitehub.console.invocations.identity-root")
export const consoleInvocationsBindingKey: unique symbol = Symbol.for("vitehub.console.invocations.binding")
export const consoleInvocationsBindingRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.bindings")
export const consoleInvocationsBindingRootRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.binding-roots")
export const consoleInvocationsRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.registry")
export const consoleBlobKey: unique symbol = Symbol.for("vitehub.console.blob")
export const consoleBlobRegistryKey: unique symbol = Symbol.for("vitehub.console.blob.registry")
export const consoleBlobRootKey: unique symbol = Symbol.for("vitehub.console.blob.root")
export const consoleKVKey: unique symbol = Symbol.for("vitehub.console.kv")
export const consoleKVRegistryKey: unique symbol = Symbol.for("vitehub.console.kv.registry")
export const consoleKVRootKey: unique symbol = Symbol.for("vitehub.console.kv.root")
export const consoleEnvKey: unique symbol = Symbol.for("vitehub.console.env")
export const consoleEnvRegistryKey: unique symbol = Symbol.for("vitehub.console.env.registry")
export const consoleEnvRootKey: unique symbol = Symbol.for("vitehub.console.env.root")
export const consoleSchedulesKey: unique symbol = Symbol.for("vitehub.console.schedules")
export const consoleSchedulesRegistryKey: unique symbol = Symbol.for("vitehub.console.schedules.registry")
export const consoleSchedulesRootKey: unique symbol = Symbol.for("vitehub.console.schedules.root")
export const consoleInvocationsRootIdentityRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.root-identities")
export const consoleInvocationsRevisionRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.revisions")
export const consoleProjectRootKey: typeof consoleInvocationsRootKey = consoleInvocationsRootKey
export const consoleSectionsKey: unique symbol = Symbol.for("vitehub.console.sections")
export const consoleAuthKey: unique symbol = Symbol.for("vitehub.console.auth")
export const consoleProjectNameKey: unique symbol = Symbol.for("vitehub.console.project-name")
export const consoleSectionsRootKey: unique symbol = Symbol.for("vitehub.console.sections.root")
const consoleSectionsAmbiguousRootKey: unique symbol = Symbol.for("vitehub.console.sections.ambiguous-root")
export const consoleSectionsRegistryKey: unique symbol = Symbol.for("vitehub.console.sections.registry")

type ConsoleInvocationsByRoot = {
  delete(key: string): boolean
  get(key: string): AgentInvocations | undefined
  set(key: string, value: AgentInvocations): unknown
  readonly size: number
}

type ConsoleDefinitionsByRoot = ConsoleProjectRegistry<ConsoleSectionCatalog>

export type ConsoleEnvInspection = ServerEnvDescription & {
  inspect?: (event: ConsoleRequestEvent) => Promise<ServerEnvInspection>
  manage?: (request: Request) => Promise<Response>
}

export interface ConsoleKVInspection {
  storage: KVStorage
  stores: readonly string[]
}

export interface ConsoleDatabaseInspection {
  databases: Record<string, RuntimeDatabaseEntry<Record<string, unknown>>>
  names: readonly string[]
}

export interface ConsoleBlobInspection {
  storage: BlobStorage
  stores: readonly string[]
}

type ConsoleBlobByRoot = ConsoleProjectRegistry<ConsoleBlobInspection>

type ConsoleKVByRoot = ConsoleProjectRegistry<ConsoleKVInspection>

type ConsoleEnvByRoot = ConsoleProjectRegistry<ConsoleEnvInspection>

type ConsoleSchedulesByRoot = ConsoleProjectRegistry<ScheduleDefinitionRegistry>

type ConsoleDatabaseByRoot = ConsoleProjectRegistry<ConsoleDatabaseInspection>

type ConsoleInvocationRegistry = Record<
  symbol,
  AgentInvocations | boolean | ConsoleBlobByRoot | ConsoleBlobInspection | ConsoleDatabaseByRoot | ConsoleDatabaseInspection | ConsoleSectionCatalog | ConsoleDefinitionsByRoot | string | readonly ConsoleSectionId[] | ConsoleInvocationsByRoot | ConsoleInvocationIdentitiesByRoot | ConsoleKVByRoot | ConsoleKVInspection | ConsoleEnvByRoot | ConsoleEnvInspection | ConsoleSchedulesByRoot | ScheduleDefinitionRegistry | ConsoleSectionsByRoot | undefined
>

type ConsoleInvocationIdentitiesByRoot = {
  delete(key: string): boolean
  entries(): IterableIterator<[string, string]>
  get(key: string): string | undefined
  set(key: string, value: string): unknown
  values(): IterableIterator<string>
}

/** Independent Console Auth that serves the Console: a Better Auth session (`true`) or Cloudflare Access. */
export type ConsoleAuthMode = true | "cloudflare-access"

interface ConsoleSectionRegistration {
  auth?: ConsoleAuthMode | false
  projectName?: string
  sections: readonly ConsoleSectionId[]
}

type ConsoleSectionsByRoot = {
  get(key: string): ConsoleSectionRegistration | undefined
  set(key: string, value: ConsoleSectionRegistration): unknown
  readonly size: number
  values(): IterableIterator<ConsoleSectionRegistration>
}

export type ConsoleInvocationScope = {
  process?: unknown
  [consoleInvocationsBindingKey]?: string
  [consoleBlobKey]?: ConsoleBlobInspection
  [consoleBlobRegistryKey]?: ConsoleBlobByRoot
  [consoleBlobRootKey]?: string
  [consoleDatabaseKey]?: ConsoleDatabaseInspection
  [consoleDatabaseRegistryKey]?: ConsoleDatabaseByRoot
  [consoleDatabaseRootKey]?: string
  [consoleDefinitionsKey]?: ConsoleSectionCatalog
  [consoleDefinitionsRegistryKey]?: ConsoleDefinitionsByRoot
  [consoleDefinitionsRootKey]?: string
  [consoleInvocationsKey]?: AgentInvocations
  [consoleInvocationsIdentityKey]?: string
  [consoleInvocationsIdentityRootKey]?: string
  [consoleInvocationsRootKey]?: string
  [consoleInvocationsRegistryKey]?: ConsoleInvocationsByRoot
  [consoleKVKey]?: ConsoleKVInspection
  [consoleKVRegistryKey]?: ConsoleKVByRoot
  [consoleKVRootKey]?: string
  [consoleEnvKey]?: ConsoleEnvInspection
  [consoleEnvRegistryKey]?: ConsoleEnvByRoot
  [consoleEnvRootKey]?: string
  [consoleSchedulesKey]?: ScheduleDefinitionRegistry
  [consoleSchedulesRegistryKey]?: ConsoleSchedulesByRoot
  [consoleSchedulesRootKey]?: string
  [consoleProjectRootKey]?: string
  [consoleInvocationsRootIdentityRegistryKey]?: ConsoleInvocationIdentitiesByRoot
  [consoleSectionsKey]?: readonly ConsoleSectionId[]
  [consoleAuthKey]?: ConsoleAuthMode | false
  [consoleProjectNameKey]?: string
  [consoleSectionsRootKey]?: string
  [consoleSectionsAmbiguousRootKey]?: boolean
  [consoleSectionsRegistryKey]?: ConsoleSectionsByRoot
}

const definitionsRegistry = createConsoleProjectRegistry<ConsoleSectionCatalog>({
  root: consoleDefinitionsRootKey,
  value: consoleDefinitionsKey,
  registry: consoleDefinitionsRegistryKey,
})
const blobRegistry = createConsoleProjectRegistry<ConsoleBlobInspection>({
  root: consoleBlobRootKey,
  value: consoleBlobKey,
  registry: consoleBlobRegistryKey,
})
const kvRegistry = createConsoleProjectRegistry<ConsoleKVInspection>({
  root: consoleKVRootKey,
  value: consoleKVKey,
  registry: consoleKVRegistryKey,
})
const envRegistry = createConsoleProjectRegistry<ConsoleEnvInspection>({
  root: consoleEnvRootKey,
  value: consoleEnvKey,
  registry: consoleEnvRegistryKey,
})
const schedulesRegistry = createConsoleProjectRegistry<ScheduleDefinitionRegistry>({
  root: consoleSchedulesRootKey,
  value: consoleSchedulesKey,
  registry: consoleSchedulesRegistryKey,
})
const databaseRegistry = createConsoleProjectRegistry<ConsoleDatabaseInspection>({
  root: consoleDatabaseRootKey,
  value: consoleDatabaseKey,
  registry: consoleDatabaseRegistryKey,
})

function defaultConsoleInvocationScope(): ConsoleInvocationScope {
  // SAFETY: ConsoleInvocationScope adds only optional symbol-keyed state to the global object.
  return globalThis as ConsoleInvocationScope
}

export function createConsoleInvocationsIdentity(
  projectRoot: string,
  fixture?: string,
  revision?: string,
  runtimeBinding?: string,
): string {
  if (!fixture) return `sqlite:${projectRoot}`
  const identity = `fixture:${projectRoot}:${fixture}${runtimeBinding ? `:${runtimeBinding}` : ""}`
  return revision ? `${identity}:${revision}` : identity
}

export function resolveConsoleInvocationsRevision(
  identity: string,
  scope: ConsoleInvocationScope = globalThis,
): string | undefined {
  const registry = processRegistry(scope)
  // SAFETY: installConsoleInvocationFallback is the only writer for this process registry key.
  const revisions = registry?.[consoleInvocationsRevisionRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
  return revisions?.get(identity)
}

export function resolveConsoleInvocationsByIdentity(
  identity: string,
  scope: ConsoleInvocationScope = globalThis,
): AgentInvocations | undefined {
  const registry = processRegistry(scope)
  const registered = invocationsByRoot(registry?.[consoleInvocationsRegistryKey])
  return registered?.get(identity)
    ?? (scope[consoleInvocationsIdentityKey] === identity ? scope[consoleInvocationsKey] : undefined)
}

function invocationsByRoot(value: unknown): ConsoleInvocationsByRoot | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry values cross Vite SSR realms, so realm-local prototypes cannot establish this boundary.
  if (!value || (typeof value !== "object" && typeof value !== "function")) return
  // SAFETY: The structural checks below validate every ConsoleInvocationsByRoot member before use.
  const registry = value as Partial<ConsoleInvocationsByRoot>
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Callable members are the realm-independent registry contract.
  return typeof registry.get === "function"
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Callable members are the realm-independent registry contract.
    && typeof registry.delete === "function"
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
      registry as ConsoleSectionsByRoot
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
  // SAFETY: installConsoleInvocationFallback is the only writer for this process registry key.
  const revisions = registry[consoleInvocationsRevisionRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
  revisions?.delete(identity)
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

export function installConsoleInvocationFallback(
  invocations: AgentInvocations,
  projectRoot: string,
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
  identity: string = projectRoot,
  revision?: string,
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
    if (revision) {
      // SAFETY: installConsoleInvocationFallback is the only writer for this process registry key.
      const revisions = registry[consoleInvocationsRevisionRegistryKey] as ConsoleInvocationIdentitiesByRoot | undefined
        ?? new Map<string, string>()
      revisions.set(identity, revision)
      registry[consoleInvocationsRevisionRegistryKey] = revisions
    }
    registry[consoleInvocationsKey] = invocations
  }
}

export function installConsoleDefinitionScope(
  projectRoot: string,
  catalog: ConsoleSectionCatalog,
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
): ConsoleSectionCatalog {
  return definitionsRegistry.install(projectRoot, catalog, scope)
}

export function resolveConsoleDefinitions(
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
): ConsoleSectionCatalog | undefined {
  return definitionsRegistry.resolve(scope)
}

export function installConsoleBlobScope(
  projectRoot: string,
  inspection: ConsoleBlobInspection,
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
): ConsoleBlobInspection {
  return blobRegistry.install(projectRoot, inspection, scope)
}

export function resolveConsoleBlob(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): ConsoleBlobInspection | undefined {
  return blobRegistry.resolve(scope)
}

export function installConsoleKVScope(
  projectRoot: string,
  inspection: ConsoleKVInspection,
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
): ConsoleKVInspection {
  return kvRegistry.install(projectRoot, inspection, scope)
}

export function resolveConsoleKV(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): ConsoleKVInspection | undefined {
  return kvRegistry.resolve(scope)
}

export function installConsoleEnvScope(
  projectRoot: string,
  inspection: ConsoleEnvInspection,
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
): ConsoleEnvInspection {
  return envRegistry.install(projectRoot, inspection, scope)
}

export function resolveConsoleEnv(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): ConsoleEnvInspection | undefined {
  return envRegistry.resolve(scope)
}

/** Stores the Static Schedule Definitions that the Console may run. Only Console invocation installs them. */
export function installConsoleSchedulesScope(
  projectRoot: string,
  registry: ScheduleDefinitionRegistry,
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
): ScheduleDefinitionRegistry {
  return schedulesRegistry.install(projectRoot, registry, scope)
}

export function resolveConsoleSchedules(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): ScheduleDefinitionRegistry | undefined {
  return schedulesRegistry.resolve(scope)
}

export function installConsoleDatabaseScope(
  projectRoot: string,
  inspection: ConsoleDatabaseInspection,
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
): ConsoleDatabaseInspection {
  return databaseRegistry.install(projectRoot, inspection, scope)
}

export function resolveConsoleDatabase(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): ConsoleDatabaseInspection | undefined {
  return databaseRegistry.resolve(scope)
}

export function installConsoleSectionScope(
  projectRoot: string,
  sections: readonly ConsoleSectionId[],
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
  independentAuth: ConsoleAuthMode | false = false,
): readonly ConsoleSectionId[] {
  const installed = [...new Set(sections)]
  if (scope[consoleSectionsRootKey] && scope[consoleSectionsRootKey] !== projectRoot) scope[consoleSectionsAmbiguousRootKey] = true
  scope[consoleSectionsRootKey] = projectRoot
  scope[consoleSectionsKey] = installed
  scope[consoleAuthKey] = independentAuth
  const registry = processRegistry(scope)
  if (registry) {
    const sectionsRegistry = sectionsByRoot(registry[consoleSectionsRegistryKey]) ?? new Map<string, ConsoleSectionRegistration>()
    const projectName = sectionsRegistry.get(projectRoot)?.projectName
    const registration: ConsoleSectionRegistration = { auth: independentAuth, sections: installed }
    if (projectName) registration.projectName = projectName
    sectionsRegistry.set(projectRoot, registration)
    registry[consoleSectionsRegistryKey] = sectionsRegistry
    registry[consoleSectionsKey] = installed
  }
  return installed
}

export function installConsoleProjectNameScope(
  projectRoot: string,
  projectName: string,
  scope: ConsoleInvocationScope = defaultConsoleInvocationScope(),
): string {
  if (scope[consoleSectionsRootKey] && scope[consoleSectionsRootKey] !== projectRoot) scope[consoleSectionsAmbiguousRootKey] = true
  scope[consoleSectionsRootKey] = projectRoot
  scope[consoleProjectNameKey] = projectName
  const registry = processRegistry(scope)
  if (registry) {
    const sectionsRegistry = sectionsByRoot(registry[consoleSectionsRegistryKey]) ?? new Map<string, ConsoleSectionRegistration>()
    const sections = sectionsRegistry.get(projectRoot)?.sections ?? scope[consoleSectionsKey] ?? []
    sectionsRegistry.set(projectRoot, { ...sectionsRegistry.get(projectRoot), projectName, sections })
    registry[consoleSectionsRegistryKey] = sectionsRegistry
  }
  return projectName
}

export function resolveConsoleSections(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): readonly ConsoleSectionId[] {
  const root = scope[consoleSectionsRootKey]
  const registry = processRegistry(scope)
  const registered = sectionsByRoot(registry?.[consoleSectionsRegistryKey])
  if (root) return registered?.get(root)?.sections ?? scope[consoleSectionsKey] ?? []
  if (registered && registered.size > 1) return scope[consoleSectionsKey] ?? []
  // SAFETY: installConsoleSectionScope is the only writer for this process registry key.
  return (registry?.[consoleSectionsKey] as readonly ConsoleSectionId[] | undefined) ?? scope[consoleSectionsKey] ?? []
}

export function resolveConsoleAuth(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): ConsoleAuthMode | false {
  // A shared scope can register several projects. Its last root cannot identify the current request.
  if (scope[consoleSectionsAmbiguousRootKey]) return false
  const root = scope[consoleSectionsRootKey]
  const registered = sectionsByRoot(processRegistry(scope)?.[consoleSectionsRegistryKey])
  if (root) return registered?.get(root)?.auth ?? scope[consoleAuthKey] ?? false
  if (registered && registered.size > 1) return false
  return registered?.values().next().value?.auth ?? scope[consoleAuthKey] ?? false
}

export function resolveConsoleProjectName(scope: ConsoleInvocationScope = defaultConsoleInvocationScope()): string | undefined {
  const root = scope[consoleSectionsRootKey]
  const registered = sectionsByRoot(processRegistry(scope)?.[consoleSectionsRegistryKey])
  if (root) return registered?.get(root)?.projectName ?? scope[consoleProjectNameKey]
  if (registered && registered.size > 1) return scope[consoleProjectNameKey]
  return registered?.values().next().value?.projectName ?? scope[consoleProjectNameKey]
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
