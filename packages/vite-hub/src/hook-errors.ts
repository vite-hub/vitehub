import { formatDiagnostic } from "nostics"

import type { Plugin, PluginOption } from "vite"

/** Vite prints a `config` or `configResolved` error with all its fields, so it shows the fix already. */
const printedByVite = new Set(["config", "configResolved"])
const printed = new WeakSet<object>()

/** A nostics diagnostic from any bundled copy of nostics: an error with a code and a fix or docs link. */
function isDiagnostic(error: unknown): error is Error & { code: string, docs?: string, fix?: string } {
  return error instanceof Error
    && typeof Reflect.get(error, "code") === "string"
    && (typeof Reflect.get(error, "fix") === "string" || typeof Reflect.get(error, "docs") === "string")
}

/**
 * Prints a diagnostic once, with its fix and docs link. Rolldown wraps a hook error in "Build failed with 1 error"
 * and keeps only its message and stack, so the fix of a ViteHub code would not reach the terminal.
 */
function report(error: unknown): never {
  if (isDiagnostic(error) && !printed.has(error)) {
    printed.add(error)
    process.stderr.write(`${formatDiagnostic(error)}\n`)
  }
  throw error
}

function wrap<T extends (...args: never[]) => unknown>(handler: T): T {
  return function (this: unknown, ...args: Parameters<T>) {
    let result: unknown
    try {
      result = handler.apply(this, args)
    }
    catch (error) {
      report(error)
    }
    return result instanceof Promise ? result.catch(report) : result
  } as T
}

function wrapPlugin(plugin: Plugin): void {
  for (const [name, hook] of Object.entries(plugin)) {
    if (printedByVite.has(name)) continue
    if (typeof hook === "function") Reflect.set(plugin, name, wrap(hook))
    else if (hook && typeof hook === "object" && "handler" in hook && typeof hook.handler === "function") hook.handler = wrap(hook.handler)
  }
}

/**
 * Makes the build and dev hooks of the ViteHub plugins print the fix and docs link of a ViteHub error before Vite or
 * Rolldown reports it. The error itself does not change. The plugins keep their identity, so other plugins still find them.
 */
export function withPrintedDiagnostics<T extends PluginOption>(option: T): T {
  if (option instanceof Promise) {
    // Vite awaits the same promise after this callback has wrapped the plugins. Vite reports a rejection itself.
    option.then(withPrintedDiagnostics, () => {})
    return option
  }
  if (Array.isArray(option)) {
    for (const item of option) withPrintedDiagnostics(item)
    return option
  }
  if (option && typeof option === "object" && "name" in option) wrapPlugin(option)
  return option
}
