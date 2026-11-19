import { defineDiagnostics, Diagnostic } from "nostics"

import type { DiagnosticCallParams, DiagnosticDefinition, DiagnosticJSON, Diagnostics } from "nostics"

import { isRuntimeDiagnostic } from "./diagnostics.ts"

const resultErrorBrand = Symbol.for("vitehub.runtime.resultError")

export function isPreparedResultError(value: unknown): value is ResultError {
  return isRuntimeDiagnostic(value) && Object.getOwnPropertyDescriptor(value, resultErrorBrand)?.value === true
}

/**
 * Error of a ViteHub operation. It is a Nostics diagnostic with a typed `code`.
 *
 * - `code` names the failure, for example `KV_INVALID_CURSOR`. `name` has the same code.
 * - `why` tells what went wrong. `message` has the same text.
 * - `fix` tells what to do next.
 * - `docs` links to the code on vitehub.dev.
 * - `cause` keeps the lower-level error, for example the provider error.
 * - `data` keeps catalog metadata in memory. Its type is inferred by `defineErrors()`.
 * - `status` is the HTTP status that `toResponse(error)` answers, when the catalog code sets one. Without it, 500.
 */
export interface ResultError<TCode extends string = string, TData = unknown> extends Diagnostic<TData, TCode> {
  /** HTTP status of the code, for example 409 for a conflict. `toResponse(error)` answers 500 without it. */
  readonly status?: number
  /** Retains the Nostics serializer type for compatibility; runtime JSON is redacted. */
  toJSON(): DiagnosticJSON<TData> & {
    code: TCode
    name: TCode
    why: string
    fix: string | undefined
    docs: string | undefined
  }
}

/**
 * `[error, data]` tuple that each ViteHub runtime operation returns.
 * Check `error` first. When `error` is `undefined`, `data` has the value.
 */
export type Result<TData, TCode extends string = string> =
  | [error: ResultError<TCode>, data: undefined]
  | [error: undefined, data: TData]

/**
 * Code map that `defineErrors()` accepts. `is` is reserved for `ErrorCatalog.is`.
 * `status` is the HTTP status that `toResponse(error)` answers for the code, such as 409 for a conflict. Without it, 500.
 */
export type ErrorCodes = Record<string, DiagnosticDefinition & { status?: number }> & { is?: never }

type CatalogCode<TCodes> = Exclude<keyof TCodes, "is"> & string

type CatalogHandles<TCodes extends Record<string, DiagnosticDefinition>> = Diagnostics<TCodes, []>

type CatalogData<TCodes extends Record<string, DiagnosticDefinition>, TCode extends CatalogCode<TCodes>> =
  ReturnType<CatalogHandles<TCodes>[TCode]>["data"]

/** One code of an error catalog. Call it to create the error, or use `is` to check an error. */
export interface ErrorHandle<TArgs extends unknown[], TCode extends string, TData> {
  (...args: TArgs): ResultError<TCode, TData>
  /**
   * Checks if `error` is a live Nostics error with this code, and narrows its `data`.
   * It reads `code`, so it also accepts an error from another copy of the package or another realm.
   * Safe to pass unbound, for example `errors.filter(catalog.CODE.is)`.
   */
  is: (error: unknown) => error is ResultError<TCode, TData>
}

/**
 * Error catalog of one package. Each code creates a `ResultError` with that code.
 * `is` checks if an error has a code of this catalog. `is` is not enumerable, so `Object.keys()` gives only the codes.
 * Use `InferDiagnosticCodes<typeof catalog>` from `nostics` for the union of the codes.
 */
export type ErrorCatalog<TCodes extends Record<string, DiagnosticDefinition>> = {
  /**
   * Checks if `error` is a live Nostics error with a code of this catalog, and narrows its `code` and `data`.
   * It reads `code`, so it also accepts an error from another copy of the package or another realm.
   */
  is: (error: unknown) => error is { [TCode in CatalogCode<TCodes>]: ResultError<TCode, CatalogData<TCodes, TCode>> }[CatalogCode<TCodes>]
} & {
  [TCode in CatalogCode<TCodes>]: ErrorHandle<Parameters<CatalogHandles<TCodes>[TCode]>, TCode, CatalogData<TCodes, TCode>>
}

export interface DefineErrorsOptions<TCodes extends Record<string, DiagnosticDefinition>> {
  /** Each code with a `why` and a `fix`, and an optional HTTP `status`. */
  codes: TCodes
  /** Base URL of the diagnostics pages, which have one page for each code. The `docs` URL of an error is `<docs>/<code in lowercase>`. */
  docs: string
}

/**
 * Prepares a recognized diagnostic for a result, keeping its metadata in memory.
 * Reuses mutable diagnostics; copies diagnostics whose name or serializer cannot be replaced.
 * Sets name to code to match the result contract, including diagnostics renamed by their owner.
 * The caller owns code allowlisting and the public text. JSON includes only the public fields.
 */
export function toResultError<TCode extends string, TData>(
  error: (Diagnostic<TData> | ResultError<string, TData>) & { readonly code: TCode },
): ResultError<TCode, TData> {
  const canReplace = (key: "name" | "toJSON") => {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    return descriptor ? descriptor.configurable === true : Object.isExtensible(error)
  }
  const result = canReplace("name") && canReplace("toJSON") && (Object.hasOwn(error, resultErrorBrand) || Object.isExtensible(error))
    ? error
    : new Diagnostic<unknown>({
      code: error.code,
      why: error.why,
      fix: error.fix,
      docs: error.docs,
      cause: error.cause,
      data: error.data,
      sources: error.sources,
    })
  if (result !== error) {
    result.stack = error.stack
    const status: unknown = Reflect.get(error, "status")
    if (typeof status === "number") Object.defineProperty(result, "status", { configurable: true, value: status })
  }
  Object.defineProperty(result, "name", { configurable: true, value: result.code, writable: true })
  Object.defineProperty(result, resultErrorBrand, { value: true })
  Object.defineProperty(result, "toJSON", {
    configurable: true,
    value: () => ({ code: result.code, docs: result.docs, fix: result.fix, name: result.name, why: result.why }),
  })
  // SAFETY: The diagnostic retains its code and data; name and public JSON are established above.
  return result as ResultError<TCode, TData>
}

/**
 * Defines the error catalog of a package with Nostics.
 * Return runtime errors as `[error, undefined]`. Throw definition and config errors.
 */
export function defineErrors<const TCodes extends ErrorCodes>(options: DefineErrorsOptions<TCodes>): ErrorCatalog<TCodes>
// The loop cannot build the mapped catalog type, so the overload above states it.
// Each code gets the Nostics handle for that code wrapped by `toResultError`, plus `is`.
export function defineErrors(options: DefineErrorsOptions<ErrorCodes>): object {
  const diagnostics = defineDiagnostics({ codes: options.codes, docsBase: options.docs })
  const codes = new Set(Object.keys(options.codes))
  const catalog: Record<string, unknown> = Object.defineProperty({}, "is", {
    value: (error: unknown) => isRuntimeDiagnostic(error) && codes.has(error.code),
  })
  for (const code of codes) {
    const create = diagnostics[code]
    const status = options.codes[code]?.status
    catalog[code] = Object.assign((params?: DiagnosticCallParams) => {
      const error = toResultError(create(params))
      if (status !== undefined) Object.defineProperty(error, "status", { configurable: true, enumerable: false, value: status })
      return error
    }, {
      is: (error: unknown) => isRuntimeDiagnostic(error) && error.code === code,
    })
  }
  return catalog
}
