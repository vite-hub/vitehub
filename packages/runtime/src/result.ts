import { defineDiagnostics, Diagnostic } from "nostics"

import type { DiagnosticCallParams, DiagnosticDefinition, DiagnosticJSON, Diagnostics } from "nostics"

/**
 * Error of a ViteHub operation. It is a Nostics diagnostic with a typed `code`.
 *
 * - `code` names the failure, for example `KV_INVALID_CURSOR`.
 * - `why` tells what went wrong. `message` has the same text.
 * - `fix` tells what to do next.
 * - `docs` links to the code on vitehub.dev.
 * - `cause` keeps the lower-level error, for example the provider error.
 * - `data` keeps catalog metadata in memory. Its type is inferred by `defineErrors()`.
 */
export interface ResultError<TCode extends string = string, TData = unknown> extends Diagnostic<TData> {
  readonly code: TCode
  readonly name: TCode
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

/** Error catalog of one package. Each code creates a `ResultError` with that code. */
export type ErrorCatalog<TCodes extends Record<string, DiagnosticDefinition>> = {
  [TCode in keyof TCodes & string]: (...args: Parameters<Diagnostics<TCodes, []>[TCode]>) => ResultError<TCode, ReturnType<Diagnostics<TCodes, []>[TCode]>["data"]>
}

export interface DefineErrorsOptions<TCodes extends Record<string, DiagnosticDefinition>> {
  /** Each code with a `why` and a `fix`. */
  codes: TCodes
  /** Docs page that has one heading for each code. The `docs` URL of an error is `<page>#<code in lowercase>`. */
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
  const result = canReplace("name") && canReplace("toJSON")
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
  if (result !== error) result.stack = error.stack
  Object.defineProperty(result, "name", { configurable: true, value: result.code, writable: true })
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
export function defineErrors<const TCodes extends Record<string, DiagnosticDefinition>>(
  options: DefineErrorsOptions<TCodes>,
): ErrorCatalog<TCodes> {
  type Create = (params?: DiagnosticCallParams) => Diagnostic<unknown>
  // SAFETY: Each Nostics handle takes one optional params object and returns a Diagnostic.
  const diagnostics = defineDiagnostics({
    codes: options.codes,
    docsBase: code => `${options.docs}#${String(code).toLowerCase()}`,
  }) as Record<string, Create>
  const catalog: Record<string, unknown> = {}
  for (const [code, create] of Object.entries(diagnostics)) {
    catalog[code] = (params?: DiagnosticCallParams) => toResultError(create(params))
  }
  // SAFETY: Nostics sets the `code` and `name` of each diagnostic to its catalog key.
  // It preserves per-code data, and toResultError establishes the name and public serializer.
  // doctor-disable-next-line typescript/evidence/no-widen-then-assert -- Nostics types `code` as `string`; this narrows it to the catalog key.
  return catalog as ErrorCatalog<TCodes>
}
