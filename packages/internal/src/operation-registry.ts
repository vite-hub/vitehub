import type { OperationRegistry, OperationSectionResolver } from "./operations.ts"

// The process slots of the installed operations. They have no other imports, so a server can install a registry
// loader when it starts without loading the operation runtime.

/** Where a registry is installed for code that has no import path to it, such as agent capabilities. */
const registryKey: unique symbol = Symbol.for("vitehub.operations.registry")
const registryLoaderKey: unique symbol = Symbol.for("vitehub.operations.registry-loader")
const scope = globalThis as typeof globalThis & { [registryKey]?: OperationRegistry, [registryLoaderKey]?: () => Promise<void> }

export function installOperationRegistry(registry: OperationRegistry): void {
  scope[registryKey] = registry
}

/**
 * Install the function that installs the registry on first use. The Console installs its operations only when the
 * first Console request or agent tool needs them, so the app does not load every primitive's operations at start.
 */
export function installOperationRegistryLoader(load: (() => Promise<void>) | undefined): void {
  scope[registryLoaderKey] = load
}

export async function installedOperationRegistry(): Promise<OperationRegistry | undefined> {
  await scope[registryLoaderKey]?.()
  return scope[registryKey]
}

const sectionResolverKey: unique symbol = Symbol.for("vitehub.operations.section-resolver")
const resolverScope = globalThis as typeof globalThis & { [sectionResolverKey]?: OperationSectionResolver }

export function installOperationSectionResolver(resolver: OperationSectionResolver | undefined): void {
  resolverScope[sectionResolverKey] = resolver
}

export function installedOperationSectionResolver(): OperationSectionResolver | undefined {
  return resolverScope[sectionResolverKey]
}
