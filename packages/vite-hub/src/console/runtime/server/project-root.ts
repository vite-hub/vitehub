const rootKey: unique symbol = Symbol.for("vitehub.console.project-root")
// SAFETY: This module owns the process slot shared by separately bundled generated plugins and Console routes.
const scope = globalThis as typeof globalThis & { [rootKey]?: string }

/** Record the project root that this server runs. The local dev RPC names it in a response header. */
export function installConsoleProjectRoot(projectRoot: string): void {
  scope[rootKey] = projectRoot
}

export function installedConsoleProjectRoot(): string | undefined {
  return scope[rootKey]
}
