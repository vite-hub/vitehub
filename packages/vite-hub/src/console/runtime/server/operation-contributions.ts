import { createOperationRegistry, installOperationRegistry, operationsOf } from "@vite-hub/internal/operations"

import { consoleOperations } from "./operations.ts"

import type { AnyOperation, OperationRegistry } from "@vite-hub/internal/operations"

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
const rootKey: unique symbol = Symbol.for("vitehub.console.project-root")
const scope = globalThis as typeof globalThis & { [contributionKey]?: { contributed: readonly InstalledContribution[], registry: OperationRegistry }, [rootKey]?: string }

let builtin: OperationRegistry | undefined

/**
 * Install the operations of the app: the ones `vite-hub` owns and the ones that Vite plugins contribute. The generated
 * Console plugin calls this when the server starts, so agent tools see the operations before any RPC call.
 */
export function installConsoleOperations(contributed: readonly ConsoleOperationContribution[] = []): OperationRegistry {
  const installed = contributed.map(entry => ({ operations: operationsOf(entry.operations), ...(entry.plugin ? { plugin: entry.plugin } : {}) }))
  const registry = createOperationRegistry([{ operations: consoleOperations, plugin: "vite-hub" }, ...installed])
  scope[contributionKey] = { contributed: installed, registry }
  installOperationRegistry(registry)
  return registry
}

/** The installed operations. Without an install, the operations of `vite-hub`, built once. */
export function consoleOperationRegistry(): OperationRegistry {
  const installed = scope[contributionKey]
  if (installed) return installed.registry
  builtin ??= createOperationRegistry([{ operations: consoleOperations, plugin: "vite-hub" }])
  return builtin
}

/** Record the project root that this server runs. The local dev RPC names it in a response header. */
export function installConsoleProjectRoot(projectRoot: string): void {
  scope[rootKey] = projectRoot
}

export function installedConsoleProjectRoot(): string | undefined {
  return scope[rootKey]
}
