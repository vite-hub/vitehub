import { createConsoleProjectRegistry } from "../../project-registry.ts"

const rootKey = Symbol.for("vitehub.console.development.root")
const ambiguousRootKey = Symbol.for("vitehub.console.development.ambiguous-root")
const registry = createConsoleProjectRegistry<boolean>({
  root: rootKey,
  value: Symbol.for("vitehub.console.development"),
  registry: Symbol.for("vitehub.console.development.registry"),
})

// SAFETY: The registry adds only optional symbol-keyed state to the global object.
const scope = globalThis as typeof globalThis & { [key: symbol]: unknown }

const setupRegistry = createConsoleProjectRegistry<string>({
  root: Symbol.for("vitehub.console.setup.root"),
  value: Symbol.for("vitehub.console.setup"),
  registry: Symbol.for("vitehub.console.setup.registry"),
})

/**
 * Generated output records whether it was created for a development server. Development output also passes the route
 * of the dev Setup endpoints, so production output never contains it.
 */
export function installConsoleDevelopment(projectRoot: string, development: boolean, setupRoute?: string): void {
  if (scope[rootKey] && scope[rootKey] !== projectRoot) scope[ambiguousRootKey] = true
  registry.install(projectRoot, development, scope)
  if (development && setupRoute) setupRegistry.install(projectRoot, setupRoute, scope)
}

/** The route of the dev Setup endpoints. Undefined outside a development server. */
export function consoleSetupRoute(): string | undefined {
  return isConsoleDevelopmentBuild() ? setupRegistry.resolve(scope) : undefined
}

/** Unconfigured, ambiguous, and production output refuse framing, regardless of runtime NODE_ENV. */
export function isConsoleDevelopmentBuild(): boolean {
  // The last installed project cannot identify which project is serving this request.
  if (scope[ambiguousRootKey]) return false
  return registry.resolve(scope) === true
}
