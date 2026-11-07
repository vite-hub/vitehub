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

/** One input that the command needs. `choices` lists the accepted values when there are few. */
export interface SetupMissing {
  field: string
  choices?: readonly string[]
}

export interface SetupFailure {
  exitCode: number
  missing?: readonly SetupMissing[]
  /** A command that succeeds as it is. */
  rerun?: string
  /** More fields of the JSON document, such as the plan. */
  data?: object
}

/**
 * Reports `error` as one JSON document on stdout with `--json`, else on stderr, and returns `failure.exitCode`.
 * The document has `error`, and `missing` and `rerun` when the failure has them.
 */
export function writeSetupError(context: Pick<ViteHubCliContext, "stderr" | "stdout">, json: boolean, error: unknown, failure: SetupFailure = { exitCode: setupExitCodes.error }): number {
  const { data, exitCode, missing, rerun } = failure
  if (json) {
    writeSetupJson(context, { ...data, error: toSetupError(error), ...(missing ? { missing } : {}), ...(rerun ? { rerun } : {}) })
    return exitCode
  }
  context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
  if (missing?.length) context.stderr.write(`Missing: ${missing.map(item => item.choices ? `${item.field} (${item.choices.join(", ")})` : item.field).join(", ")}\n`)
  if (rerun) context.stderr.write(`Run: ${rerun}\n`)
  return exitCode
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
