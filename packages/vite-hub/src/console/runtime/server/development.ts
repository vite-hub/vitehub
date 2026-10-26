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

/** Generated output records whether it was created for a development server. */
export function installConsoleDevelopment(projectRoot: string, development: boolean): void {
  if (scope[rootKey] && scope[rootKey] !== projectRoot) scope[ambiguousRootKey] = true
  registry.install(projectRoot, development, scope)
}

/** Unconfigured, ambiguous, and production output refuse framing, regardless of runtime NODE_ENV. */
export function isConsoleDevelopmentBuild(): boolean {
  // The last installed project cannot identify which project is serving this request.
  if (scope[ambiguousRootKey]) return false
  return registry.resolve(scope) === true
}
