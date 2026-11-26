import { consoleOperationModules } from "../../src/console/operation-modules.ts"
import { installConsoleOperations } from "../../src/console/runtime/server/operation-contributions.ts"

import type { ConsoleOperationContribution } from "../../src/console/runtime/server/operation-contributions.ts"
import type { OperationRegistry } from "@vite-hub/internal/operations"

export async function installViteHubConsoleOperations(contributed: readonly ConsoleOperationContribution[] = [], options: { invoke?: boolean } = {}): Promise<OperationRegistry> {
  const owned = await Promise.all(consoleOperationModules.map(entry => entry.load()))
  return installConsoleOperations([{ operations: owned.flat(), plugin: "vite-hub" }, ...contributed], options)
}
