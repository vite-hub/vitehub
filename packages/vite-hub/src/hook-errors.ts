import { inspect } from "node:util"

import { createConsoleReporter } from "nostics"

import type { Diagnostic } from "nostics"

import type { Plugin, PluginOption } from "vite"

/** Vite prints a `config` or `configResolved` error with `util.inspect`, as an error of the config file itself. */
const inspectedByVite = new Set(["config", "configResolved"])
const printed = new WeakSet<object>()

/** A nostics diagnostic from any bundled copy of nostics: an error with a code and a fix or docs link. */
function isDiagnostic(error: unknown): error is Diagnostic {
  return error instanceof Error
    && typeof Reflect.get(error, "code") === "string"
    && (typeof Reflect.get(error, "fix") === "string" || typeof Reflect.get(error, "docs") === "string")
}

/**
 * `[CODE] message`, then the sources, the cause, the docs link and the fix, so the last line says what to do. nostics
 * prints the fix before the docs link.
 */
function formatViteHubDiagnostic(diagnostic: Diagnostic, cause?: string): string {
  const details = [
    ...(diagnostic.sources?.length ? [`sources: ${diagnostic.sources.join(", ")}`] : []),
    ...(cause ? [`cause: ${cause}`] : []),
    ...(diagnostic.docs ? [`see: ${diagnostic.docs}`] : []),
    ...(diagnostic.fix ? [`fix: ${diagnostic.fix}`] : []),
  ]
  return [`[${diagnostic.name}] ${diagnostic.message}`, ...details.map((detail, index) => `${index < details.length - 1 ? "├▶" : "╰▶"} ${detail}`)].join("\n")
}

/** Prints to stderr, with the original error of a diagnostic after it when the diagnostic has a `cause`. */
const printDiagnostic = createConsoleReporter({ method: "error", formatter: diagnostic => formatViteHubDiagnostic(diagnostic) })

/**
 * Makes `util.inspect` show a diagnostic as its short text, with the fix on the last line. Vite prints an error of the
 * config file, such as one that `vitehub()` throws, and of a `config` or `configResolved` hook with `util.inspect`.
 * Without this, the terminal shows the stack and then every field, and the fix is in the middle of that dump.
 * The error keeps its message, stack and fields.
 */
export function withShortInspect(error: unknown): unknown {
  if (isDiagnostic(error) && !Object.hasOwn(error, inspect.custom)) {
    const cause = error.cause === undefined ? undefined : error.cause instanceof Error ? error.cause.message : String(error.cause)
    Object.defineProperty(error, inspect.custom, { value: () => formatViteHubDiagnostic(error, cause) })
  }
  return error
}

function throwShort(error: unknown): never {
  throw withShortInspect(error)
}

/**
 * Prints a diagnostic once, with its fix, docs link and cause. Rolldown wraps a hook error in "Build failed with 1 error".
 * It keeps `fix`, `docs` and `cause` on `errors[0]` and prints `cause`, but no bundler prints `fix`, so the fix of a
 * ViteHub code would not reach the terminal. Rolldown also drops `url` (https://github.com/rolldown/rolldown/issues/11739).
 * `vite dev` prints neither `cause` nor `url`; not reported to Vite yet (repro:
 * https://github.com/onmax/repros/tree/repro/vite-dev-error-cause/vite-dev-error-cause).
 */
function report(error: unknown): never {
  if (isDiagnostic(error) && !printed.has(error)) {
    printed.add(error)
    // nostics 1.4.0 types the options argument as required, but the reporter defaults it.
    printDiagnostic(error, {})
  }
  throw error
}

function wrap<T extends (...args: never[]) => unknown>(handler: T, onError: (error: unknown) => never): T {
  return function (this: unknown, ...args: Parameters<T>) {
    let result: unknown
    try {
      result = handler.apply(this, args)
    }
    catch (error) {
      onError(error)
    }
    return result instanceof Promise ? result.catch(onError) : result
  } as T
}

function wrapPlugin(plugin: Plugin): void {
  for (const [name, hook] of Object.entries(plugin)) {
    const onError = inspectedByVite.has(name) ? throwShort : report
    if (typeof hook === "function") Reflect.set(plugin, name, wrap(hook, onError))
    else if (hook && typeof hook === "object" && "handler" in hook && typeof hook.handler === "function") hook.handler = wrap(hook.handler, onError)
  }
}

/**
 * Makes the build and dev hooks of the ViteHub plugins print the fix and docs link of a ViteHub error before Vite or
 * Rolldown reports it, and makes Vite print an error of a `config` or `configResolved` hook short. The error itself does
 * not change. The plugins keep their identity, so other plugins still find them.
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
