import { consoleDiagnostic, consoleDiagnosticAction, isConsoleDiagnosticCode, type ConsoleDiagnosticAction, type ConsoleDiagnosticCode } from "../diagnostics"
import { ConsoleNetworkError, ConsoleRequestError } from "./request"

/** A failure as the Console shows it: what happened, how to repair it, and the next step. */
export interface ConsoleProblem {
  /** The next step. `retry` appears only when a retry can succeed. */
  action: ConsoleDiagnosticAction
  code: string
  docs?: string
  fix?: string
  status?: number
  why: string
}

// Codes from owner packages that a retry cannot repair, even with a 5xx status.
const configurationCodes = new Set(["CONNECTION_AUTH_REQUIRED", "ENV_BRIDGE_UNTRUSTED"])

const text = (value: unknown): string | undefined =>
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Diagnostic fields cross module boundaries as unknown values.
  typeof value === "string" && value.trim() ? value : undefined

function fromCode(code: ConsoleDiagnosticCode, message?: string): ConsoleProblem {
  const diagnostic = consoleDiagnostic(code, message)
  return { action: consoleDiagnosticAction(code), code, docs: diagnostic.docs, fix: diagnostic.fix, why: diagnostic.message }
}

function statusAction(status: number, code: string, docs: string | undefined): ConsoleDiagnosticAction {
  if (status === 401) return "sign-in"
  if ((status === 408 || status === 429 || status === 500 || (status >= 502 && status <= 504)) && !configurationCodes.has(code)) return "retry"
  return docs ? "docs" : "reload"
}

/**
 * Turns a thrown value into the problem that a Console state shows. Returns `undefined` for no error.
 * A Console code uses its catalog action. Another code uses its status: `401` asks to sign in, a transient status
 * offers a retry, and other failures link the docs.
 */
export function consoleProblem(error: unknown): ConsoleProblem | undefined {
  if (error === undefined || error === null || error === false) return undefined
  if (error instanceof ConsoleRequestError) {
    if (isConsoleDiagnosticCode(error.code)) return { ...fromCode(error.code, error.message), status: error.status }
    return {
      action: statusAction(error.status, error.code, error.docs),
      code: error.code,
      docs: error.docs,
      fix: error.fix,
      status: error.status,
      why: error.message,
    }
  }
  // Only failures wrapped at the fetch boundary are transient network errors.
  if (error instanceof ConsoleNetworkError) return fromCode("CONSOLE_UNAVAILABLE")
  if (error instanceof Error) {
    const code = text(Reflect.get(error, "code"))
    if (code && isConsoleDiagnosticCode(code)) return fromCode(code, error.message)
    const docs = text(Reflect.get(error, "docs"))
    const fallback = fromCode("CONSOLE_REQUEST_FAILED")
    return {
      action: "docs",
      code: code ?? fallback.code,
      docs: docs ?? fallback.docs,
      fix: text(Reflect.get(error, "fix")) ?? fallback.fix,
      why: error.message || fallback.why,
    }
  }
  return fromCode("CONSOLE_REQUEST_FAILED")
}
