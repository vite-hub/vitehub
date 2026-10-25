import { defineDiagnostics } from "nostics"

import type { Diagnostic, DiagnosticCallParams, DiagnosticDefinition, Diagnostics } from "nostics"

/**
 * Error of a ViteHub operation. It is a Nostics diagnostic with a typed `code`.
 *
 * - `code` names the failure, for example `KV_INVALID_CURSOR`.
 * - `why` tells what went wrong. `message` has the same text.
 * - `fix` tells what to do next.
 * - `docs` links to the code on vitehub.dev.
 * - `cause` keeps the lower-level error, for example the provider error.
 */
export interface ResultError<TCode extends string = string> extends Diagnostic {
  readonly code: TCode
  readonly name: TCode
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
  [TCode in keyof TCodes & string]: (...args: Parameters<Diagnostics<TCodes, []>[TCode]>) => ResultError<TCode>
}

export interface DefineErrorsOptions<TCodes extends Record<string, DiagnosticDefinition>> {
  /** Each code with a `why` and a `fix`. */
  codes: TCodes
  /** Docs page that has one heading for each code. The `docs` URL of an error is `<page>#<code in lowercase>`. */
  docs: string
}

/**
 * Prepares a recognized diagnostic for a result without replacing it or its metadata.
 * Sets name to code to match the result contract, including diagnostics renamed by their owner.
 * The caller owns code allowlisting and the public text. JSON includes only the public fields.
 */
export function toResultError<TCode extends string>(
  error: (Diagnostic<unknown> | ResultError) & { readonly code: TCode },
): ResultError<TCode> {
  Object.defineProperty(error, "name", { configurable: true, value: error.code, writable: true })
  Object.defineProperty(error, "toJSON", {
    configurable: true,
    value: () => ({ code: error.code, docs: error.docs, fix: error.fix, name: error.name, why: error.why }),
  })
  // SAFETY: The name/code invariant and public serializer are established above.
  return error as ResultError<TCode>
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
  // doctor-disable-next-line typescript/evidence/no-widen-then-assert -- Nostics types `code` as `string`; this narrows it to the catalog key.
  return catalog as ErrorCatalog<TCodes>
}
