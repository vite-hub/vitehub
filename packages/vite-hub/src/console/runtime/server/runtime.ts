import { installOperationRegistryLoader } from "@vite-hub/internal/operations"

/**
 * The Console runtime installs the operations, Definitions, Schedules, Database, Blob, and Env of the Console. It
 * imports every primitive's operations, so the generated plugin loads it on the first Console request or agent tool
 * that needs it, not when the server starts.
 */
interface ConsoleRuntimeState {
  load: () => Promise<unknown>
  pending?: Promise<void>
}

const runtimeKey: unique symbol = Symbol.for("vitehub.console.runtime")
// SAFETY: This module owns the process slot shared by separately bundled generated plugins and Console routes.
const scope = globalThis as typeof globalThis & { [runtimeKey]?: ConsoleRuntimeState }

/** The generated Console plugin calls this when the server starts. `load` imports and installs the Console runtime. */
export function installConsoleRuntime(load: () => Promise<unknown>): void {
  scope[runtimeKey] = { load }
  installOperationRegistryLoader(loadConsoleRuntime)
}

/** Load the Console runtime once. Without an installed runtime, there is nothing to load. */
export async function loadConsoleRuntime(): Promise<void> {
  const state = scope[runtimeKey]
  if (!state) return
  await (state.pending ??= state.load().then(() => undefined, (error: unknown) => {
    // A failed import can succeed on the next request, for example after a development rebuild.
    state.pending = undefined
    throw error
  }))
}
