import { createConsoleProjectRegistry } from "../../project-registry.ts"

const registry = createConsoleProjectRegistry<boolean>({
  root: Symbol.for("vitehub.console.development.root"),
  value: Symbol.for("vitehub.console.development"),
  registry: Symbol.for("vitehub.console.development.registry"),
})

// SAFETY: The registry adds only optional symbol-keyed state to the global object.
const scope = globalThis as typeof globalThis & { [key: symbol]: unknown }

/** Generated output records whether it was created for a development server. */
export function installConsoleDevelopment(projectRoot: string, development: boolean): void {
  registry.install(projectRoot, development, scope)
}

/** Unconfigured and production output refuse framing, regardless of runtime NODE_ENV. */
export function isConsoleDevelopmentBuild(): boolean {
  return registry.resolve(scope) === true
}
