import { formatRuntimeDiagnosticError } from "@vite-hub/runtime"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"

/** Exit codes of the setup commands. */
export const setupExitCodes = {
  done: 0,
  error: 1,
  inputNeeded: 2,
  conflict: 3,
  stalePlan: 4,
} as const

export interface SetupError {
  code: string
  message: string
  why: string
  fix?: string
  docs?: string
}

interface DiagnosticLike {
  code: string
  message: string
  why: string
  fix?: string
  docs?: string
}

function isDiagnostic(error: unknown): error is DiagnosticLike {
  return error instanceof Error && typeof Reflect.get(error, "code") === "string" && typeof Reflect.get(error, "why") === "string"
}

function toSetupError(error: unknown): SetupError {
  const diagnostic = isDiagnostic(error) ? error : cliErrorDiagnostics.CLI_R0001({ message: error instanceof Error ? error.message : String(error) })
  const why = diagnostic.why.replace(/^\[vitehub\] /u, "")
  return {
    code: diagnostic.code,
    // The first sentence, for a one-line summary. `why` keeps the whole reason.
    message: /^.*?[.!?](?=\s|$)/u.exec(why)?.[0] ?? why,
    why,
    ...(diagnostic.fix ? { fix: diagnostic.fix } : {}),
    ...(diagnostic.docs ? { docs: diagnostic.docs } : {}),
  }
}

/** Prints one JSON document with `schemaVersion: 1` on stdout. */
export function writeSetupJson(context: Pick<ViteHubCliContext, "stdout">, data: object): void {
  context.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...data })}\n`)
}

/** One accepted value of a missing input. Accounts carry an id and a name; plain values are strings. */
export type SetupChoice = string | { id: string, name?: string }

/** An input that a setup command needs, such as an account id, with the values it accepts when there are few. */
export interface SetupMissing {
  field: string
  choices?: readonly SetupChoice[]
}

export interface SetupFailureDetails {
  missing?: readonly SetupMissing[]
  /** A command that would succeed, with `<placeholders>` for values that the caller must choose. */
  rerun?: string
  /** More fields of the JSON document, such as the plan. */
  data?: object
}

/** A setup diagnostic with its exit code and the input that is missing. `writeSetupError` reports it. */
export class SetupFailure extends Error {
  override readonly cause: Error
  readonly exitCode: number
  readonly details: SetupFailureDetails

  constructor(cause: Error, exitCode: number, details: SetupFailureDetails = {}) {
    super(cause.message)
    this.name = "SetupFailure"
    this.cause = cause
    this.exitCode = exitCode
    this.details = details
  }
}

function formatMissing(missing: readonly SetupMissing[]): string {
  return missing.map((item) => {
    const choices = item.choices ?? []
    if (choices.every(choice => typeof choice === "string")) return `Missing: ${item.field}${choices.length ? ` (${choices.join(", ")})` : ""}\n`
    return `Missing: ${item.field}\n${choices.map(choice => typeof choice === "string" ? `  ${choice}\n` : `  ${choice.id}${choice.name ? `  ${choice.name}` : ""}\n`).join("")}`
  }).join("")
}

/**
 * Reports `error` as one JSON document on stdout with `--json`, else on stderr, and returns its exit code.
 * A `SetupFailure` adds `missing`, `rerun`, and its `data` to the document. Any other error exits with 1.
 */
export function writeSetupError(context: Pick<ViteHubCliContext, "stderr" | "stdout">, json: boolean, error: unknown): number {
  if (error instanceof SetupFailure) {
    const { data, missing, rerun } = error.details
    if (json) writeSetupJson(context, { ...data, error: toSetupError(error.cause), ...(missing ? { missing } : {}), ...(rerun ? { rerun } : {}) })
    else context.stderr.write(`${formatRuntimeDiagnosticError(error.cause)}\n${formatMissing(missing ?? [])}${rerun ? `Run: ${rerun}\n` : ""}`)
    return error.exitCode
  }
  if (json) writeSetupJson(context, { error: toSetupError(error) })
  else context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
  return setupExitCodes.error
}

export interface SetupArgs {
  json: boolean
  help: boolean
}

/** Reads `--json` and `--help`. Throws `CLI_R0003` for any other argument. */
export function readSetupArgs(args: readonly string[], usage: string): SetupArgs {
  const unknown = args.find(arg => arg !== "--json" && arg !== "-h" && arg !== "--help")
  if (unknown !== undefined) throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] Unknown argument ${JSON.stringify(unknown)}. Usage: ${usage}` })
  return { help: args.includes("-h") || args.includes("--help"), json: args.includes("--json") }
}

/** Rows as plain text columns, two spaces apart. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n")
}
