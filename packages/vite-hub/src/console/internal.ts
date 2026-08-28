import type { AgentInvocations } from "@vite-hub/agent"
import type { ConsoleSectionId } from "./runtime/sections.ts"

export const consoleInvocationsKey: unique symbol = Symbol.for("vitehub.console.invocations")
export const consoleInvocationsFallbackKey: unique symbol = Symbol.for("vitehub.console.invocations.fallback")
export const consoleInvocationsRootKey: unique symbol = Symbol.for("vitehub.console.invocations.root")
export const consoleInvocationsIdentityKey: unique symbol = Symbol.for("vitehub.console.invocations.identity")
export const consoleInvocationsIdentityRootKey: unique symbol = Symbol.for("vitehub.console.invocations.identity-root")
export const consoleInvocationsBindingKey: unique symbol = Symbol.for("vitehub.console.invocations.binding")
export const consoleInvocationsBindingRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.bindings")
export const consoleInvocationsBindingRootRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.binding-roots")
export const consoleInvocationsRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.registry")
export const consoleInvocationsRootIdentityRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.root-identities")
export const consoleInvocationsRevisionRegistryKey: unique symbol = Symbol.for("vitehub.console.invocations.revisions")
export const consoleProjectRootKey: typeof consoleInvocationsRootKey = consoleInvocationsRootKey
export const consoleSectionsKey: unique symbol = Symbol.for("vitehub.console.sections")
export const consoleSectionsRootKey: unique symbol = Symbol.for("vitehub.console.sections.root")
export const consoleSectionsRegistryKey: unique symbol = Symbol.for("vitehub.console.sections.registry")

type ConsoleInvocationsByRoot = {
  delete(key: string): boolean
  get(key: string): AgentInvocations | undefined
  set(key: string, value: AgentInvocations): unknown
  readonly size: number
}

type ConsoleInvocationRegistry = Record<
  symbol,
  AgentInvocations | string | readonly ConsoleSectionId[] | ConsoleInvocationsByRoot | ConsoleInvocationIdentitiesByRoot | ConsoleSectionsByRoot | undefined
>

type ConsoleInvocationIdentitiesByRoot = {
  delete(key: string): boolean
  entries(): IterableIterator<[string, string]>
  get(key: string): string | undefined
  set(key: string, value: string): unknown
  values(): IterableIterator<string>
}

type ConsoleSectionsByRoot = {
  get(key: string): readonly ConsoleSectionId[] | undefined
  set(key: string, value: readonly ConsoleSectionId[]): unknown
  readonly size: number
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
  [consoleSectionsKey]?: readonly ConsoleSectionId[]
  [consoleSectionsRootKey]?: string
  [consoleSectionsRegistryKey]?: ConsoleSectionsByRoot
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
    ? registry as ConsoleSectionsByRoot
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

export function resolveConsoleInvocations(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): AgentInvocations | undefined {
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
  scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope,
  identity = projectRoot,
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

export function installConsoleSectionScope(
  projectRoot: string,
  sections: readonly ConsoleSectionId[],
  scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope,
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

export function resolveConsoleSections(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): readonly ConsoleSectionId[] {
  const root = scope[consoleSectionsRootKey]
  const registry = processRegistry(scope)
  const registered = sectionsByRoot(registry?.[consoleSectionsRegistryKey])
  if (root) return registered?.get(root) ?? scope[consoleSectionsKey] ?? []
  if (registered && registered.size > 1) return scope[consoleSectionsKey] ?? []
  // SAFETY: installConsoleSectionScope is the only writer for this process registry key.
  return (registry?.[consoleSectionsKey] as readonly ConsoleSectionId[] | undefined) ?? scope[consoleSectionsKey] ?? []
}

export function resolveConsoleProjectRoot(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): string | undefined {
  return scope[consoleInvocationsRootKey]
}

export function resolveConsoleInvocationsRoot(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): string | undefined {
  return scope[consoleInvocationsRootKey]
}

// doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The default scope uses only the optional symbol properties declared by ConsoleInvocationScope.
export function resolveConsoleInvocationsIdentity(scope: ConsoleInvocationScope = globalThis as ConsoleInvocationScope): string | undefined {
  return scope[consoleInvocationsIdentityKey] ?? scope[consoleInvocationsRootKey]
}
