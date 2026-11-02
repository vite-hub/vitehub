import { installOperationRegistryLoader } from "@vite-hub/internal/operations"

/**
 * The Console runtime installs the operations, Definitions, Schedules, Database, Blob, and Env of the Console. It
 * imports every primitive's operations, so the generated plugin loads it on the first Console request or agent tool
 * that needs it, not when the server starts.
 */
interface ConsoleRuntimeState {
  load: () => Promise<() => void>
  pending?: Promise<void>
}

const runtimeKey: unique symbol = Symbol.for("vitehub.console.runtime")
// SAFETY: This module owns the process slot shared by separately bundled generated plugins and Console routes.
const scope = globalThis as typeof globalThis & { [runtimeKey]?: ConsoleRuntimeState }

/** The generated plugin calls this at startup. `load` imports the runtime and returns its synchronous installer. */
export function installConsoleRuntime(load: () => Promise<() => void>): void {
  scope[runtimeKey] = { load }
  installOperationRegistryLoader(loadConsoleRuntime)
}

/** Load the Console runtime once. Without an installed runtime, there is nothing to load. */
export async function loadConsoleRuntime(): Promise<void> {
  while (true) {
    const state = scope[runtimeKey]
    if (!state) return
    await (state.pending ??= state.load().then((install) => {
      // A development replacement may have finished loading while these imports were in flight.
      if (scope[runtimeKey] === state) install()
    }).catch((error: unknown) => {
      // A failed import or install can succeed on the next request, for example after a development rebuild.
      state.pending = undefined
      throw error
    }))
    if (scope[runtimeKey] === state) return
    // Requests already waiting on the replaced loader also need the current installation.
  }
}
