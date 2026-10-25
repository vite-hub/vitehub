import { createOperationRegistry, installOperationRegistry, operationsOf } from "@vite-hub/internal/operations"

import type { AnyOperation } from "@vite-hub/internal/operations"

export interface ConsoleOperationContribution {
  /** The export of the contributed module: one operation or a list of them. */
  operations: unknown
  plugin?: string
}

interface InstalledContribution {
  operations: readonly AnyOperation[]
  plugin?: string
}

const contributionKey: unique symbol = Symbol.for("vitehub.console.operations")
const scope = globalThis as typeof globalThis & { [contributionKey]?: readonly InstalledContribution[] }

/** Install the operations that Vite plugins contribute. Generated Console output calls this. */
export function installConsoleOperations(contributed: readonly ConsoleOperationContribution[]): void {
  const installed = contributed.map(entry => ({ operations: operationsOf(entry.operations), ...(entry.plugin ? { plugin: entry.plugin } : {}) }))
  scope[contributionKey] = installed
  // Agent capabilities that run before the first RPC call read the contributed operations from here.
  installOperationRegistry(createOperationRegistry(installed))
}

export function installedConsoleOperations(): readonly InstalledContribution[] | undefined {
  return scope[contributionKey]
}
