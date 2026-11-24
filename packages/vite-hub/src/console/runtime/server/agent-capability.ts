import { installOperationRegistryLoader } from "@vite-hub/internal/operation-registry"

import { agentConsole as consoleCapability, type ConsoleRuntime } from "../../server.ts"
import { loadConsoleRuntime } from "./runtime.ts"

import type { RuntimeHostContext } from "@vite-hub/runtime"

function withConsoleOperations<Capability>(capability: Capability): Capability {
  installOperationRegistryLoader(async () => {
    await import("#vitehub/console/app")
    await loadConsoleRuntime()
  })
  return capability
}

/**
 * The `console` Agent capability. Importing it installs the loader of the Console operations, so `operations()` loads
 * them on the first use without a Console request.
 */
export const agentConsole: { resolve: (context: RuntimeHostContext<unknown>) => ConsoleRuntime } = withConsoleOperations(consoleCapability)
