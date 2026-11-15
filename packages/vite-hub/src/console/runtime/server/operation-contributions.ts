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
const scope = globalThis as typeof globalThis & { [contributionKey]?: { contributed: readonly InstalledContribution[], heldBack: ReadonlySet<string>, registry: OperationRegistry } }

let builtin: OperationRegistry | undefined

/**
 * Install the operations of the app: the ones `vite-hub` owns and the ones that Vite plugins contribute. The generated
 * Console runtime calls this when it loads. Agent tools load it through `installedOperationRegistry()`, so they need no
 * prior RPC call.
 */
export function installConsoleOperations(contributed: readonly ConsoleOperationContribution[] = [], options: { invoke?: boolean } = {}): OperationRegistry {
  // An operation that runs app code is registered only when `console.invoke` is on. Without options, nothing is held back.
  const heldBack = new Set<string>()
  const installed = contributed.map(entry => ({
    operations: operationsOf(entry.operations).filter((operation) => {
      if (!operation.invoke || options.invoke !== false) return true
      heldBack.add(operation.name)
      return false
    }),
    ...(entry.plugin ? { plugin: entry.plugin } : {}),
  }))
  const registry = createOperationRegistry([{ operations: consoleOperations, plugin: "vite-hub" }, ...installed])
  scope[contributionKey] = { contributed: installed, heldBack, registry }
  installOperationRegistry(registry)
  return registry
}

/** Whether the app has the operation `name` but holds it back, because it runs app code and `console.invoke` is off. */
export function isHeldBackConsoleOperation(name: string): boolean {
  return scope[contributionKey]?.heldBack.has(name) === true
}

/** The installed operations. Without an install, the operations of `vite-hub`, built once. */
export function consoleOperationRegistry(): OperationRegistry {
  const installed = scope[contributionKey]
  if (installed) return installed.registry
  builtin ??= createOperationRegistry([{ operations: consoleOperations, plugin: "vite-hub" }])
  return builtin
}
