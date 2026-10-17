import { defineDiagnostics, type Diagnostic } from "nostics"

const consoleGuide = "https://vitehub.dev/docs/development/console"

/** What the Console offers as the next step for a failure. */
export type ConsoleDiagnosticAction = "docs" | "reload" | "retry" | "sign-in"

/** Stable codes of Console and Console management failures. */
export type ConsoleDiagnosticCode =
  | "CONSOLE_ACCESS_DENIED"
  | "CONSOLE_ACCESS_NOT_CONFIGURED"
  | "CONSOLE_AUTH_NOT_CONFIGURED"
  | "CONSOLE_AUTHORIZE_REQUIRED"
  | "CONSOLE_CONFLICT"
  | "CONSOLE_CONNECTIONS_MANAGEMENT_UNAVAILABLE"
  | "CONSOLE_DEVELOPMENT_ONLY"
  | "CONSOLE_ENV_MANAGEMENT_UNAVAILABLE"
  | "CONSOLE_MANAGER_REQUIRED"
  | "CONSOLE_NOT_FOUND"
  | "CONSOLE_ORIGIN_REJECTED"
  | "CONSOLE_REQUEST_FAILED"
  | "CONSOLE_REQUEST_INVALID"
  | "CONSOLE_SIGN_IN_REQUIRED"
  | "CONSOLE_UNAVAILABLE"

export type ConsoleDiagnosticData = {
  readonly action: ConsoleDiagnosticAction
}

interface ConsoleDiagnosticParams {
  /** A more specific reason from the failure site. It replaces the default `why`. */
  message?: string
}

type ConsoleDiagnosticDefinition = {
  data: ConsoleDiagnosticData
  docs: string
  fix: string
  why: (params: ConsoleDiagnosticParams) => string
}

const code = (why: string, fix: string, docs: string, action: ConsoleDiagnosticAction): ConsoleDiagnosticDefinition => ({
  why: ({ message }: ConsoleDiagnosticParams) => message?.trim() || why,
  fix,
  docs,
  data: { action },
})

/**
 * Console and Console management failures. Each code has a stable name, a default why, a fix, and a docs link.
 * Server routes send these fields in their JSON error body. The Console client uses the same catalog when a
 * response has no body, such as a `401` from host middleware.
 */
const consoleDiagnostics = /*#__PURE__*/ defineDiagnostics({
  codes: {
    CONSOLE_SIGN_IN_REQUIRED: code(
      "You are not signed in, or your session ended.",
      "Sign in again.",
      `${consoleGuide}#how-each-mode-checks-a-request`,
      "sign-in",
    ),
    CONSOLE_ACCESS_DENIED: code(
      "The Console access policy rejected this account.",
      "Sign in with an account that the access policy allows, or ask the Console owner for access.",
      `${consoleGuide}#how-each-mode-checks-a-request`,
      "docs",
    ),
    CONSOLE_MANAGER_REQUIRED: code(
      "The Console accepted this request, but the session has no user id. Management actions record the user who made them.",
      "Sign out and sign in again. If this continues, make sure the Auth Definition that protects the Console returns a session user with an id.",
      "https://vitehub.dev/docs/connections/server-api#management-routes",
      "docs",
    ),
    CONSOLE_DEVELOPMENT_ONLY: code(
      "console: true is development-only. It works only on the development server.",
      "For production, set console: { auth: \"app\" } or console: { auth: { ... }, authorize }.",
      `${consoleGuide}#protect-the-console-route`,
      "docs",
    ),
    CONSOLE_ACCESS_NOT_CONFIGURED: code(
      "Console access is not configured. The server has no Console access policy.",
      "Build the app with the ViteHub plugin, so the generated Console output installs its access policy.",
      `${consoleGuide}#protect-the-console-route`,
      "docs",
    ),
    CONSOLE_AUTHORIZE_REQUIRED: code(
      "A host-managed Console requires console.authorize.",
      "Set console.authorize to a server file that default-exports defineConsoleAuthorize().",
      `${consoleGuide}#how-each-mode-checks-a-request`,
      "docs",
    ),
    CONSOLE_AUTH_NOT_CONFIGURED: code(
      "Console Auth is not configured.",
      "Add a ViteHub Auth Definition, or set the Cloudflare Access team domain and audience.",
      `${consoleGuide}#protect-the-console-route`,
      "docs",
    ),
    CONSOLE_ORIGIN_REJECTED: code(
      "The request did not come from the Console origin.",
      "Open the Console from its own URL. A proxy must forward the public Host and Origin headers.",
      `${consoleGuide}#protect-the-console-route`,
      "docs",
    ),
    CONSOLE_ENV_MANAGEMENT_UNAVAILABLE: code(
      "Env management is not available for this variable.",
      "Give the Env declaration a management bridge, then reload the Console.",
      "https://vitehub.dev/docs/env/bridge",
      "docs",
    ),
    CONSOLE_CONNECTIONS_MANAGEMENT_UNAVAILABLE: code(
      "The Connections management route is not mounted.",
      "Set connections: { management: true } for production, then build and deploy again.",
      `${consoleGuide}#manage-connections`,
      "docs",
    ),
    CONSOLE_REQUEST_INVALID: code(
      "The server cannot read this Console request.",
      "Reload the Console. If this continues, deploy the Console and the server from the same build.",
      `${consoleGuide}#fix-common-failures`,
      "reload",
    ),
    CONSOLE_NOT_FOUND: code(
      "The item does not exist, or the server removed it.",
      "Reload the Console to see the current data.",
      `${consoleGuide}#fix-common-failures`,
      "reload",
    ),
    CONSOLE_CONFLICT: code(
      "The data changed after the Console loaded it.",
      "Reload the Console, then try again.",
      `${consoleGuide}#fix-common-failures`,
      "reload",
    ),
    CONSOLE_UNAVAILABLE: code(
      "The server did not answer. It can be restarting, offline, or rate limited.",
      "Wait a moment, then try again.",
      `${consoleGuide}#fix-common-failures`,
      "retry",
    ),
    CONSOLE_REQUEST_FAILED: code(
      "The server could not complete the request.",
      "Try again. If this continues, read the server logs for this request.",
      `${consoleGuide}#fix-common-failures`,
      "retry",
    ),
  } satisfies Record<ConsoleDiagnosticCode, ConsoleDiagnosticDefinition>,
})

/** The JSON error fields that Console routes add to a failed response. `message` is the why. */
export interface ConsoleDiagnosticBody {
  code: string
  docs?: string
  fix?: string
  message: string
}

const consoleDiagnosticCodes = new Set<string>(Object.keys(consoleDiagnostics))

export function isConsoleDiagnosticCode(value: unknown): value is ConsoleDiagnosticCode {
  return typeof value === "string" && consoleDiagnosticCodes.has(value)
}

/** The Console code for an HTTP status when the failure site has no more specific code. */
export function consoleStatusDiagnosticCode(status: number): ConsoleDiagnosticCode {
  if (status === 401) return "CONSOLE_SIGN_IN_REQUIRED"
  if (status === 403) return "CONSOLE_ACCESS_DENIED"
  if (status === 404) return "CONSOLE_NOT_FOUND"
  if (status === 409) return "CONSOLE_CONFLICT"
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 504) return "CONSOLE_UNAVAILABLE"
  if (status >= 400 && status < 500) return "CONSOLE_REQUEST_INVALID"
  return "CONSOLE_REQUEST_FAILED"
}

/** Create the diagnostic of one Console code. `message` replaces the default why. */
export function consoleDiagnostic(code: ConsoleDiagnosticCode, message?: string): Diagnostic<ConsoleDiagnosticData> {
  return consoleDiagnostics[code]({ message })
}

/** Build the JSON error fields of one Console code. `message` replaces the default why. */
export function consoleDiagnosticBody(code: ConsoleDiagnosticCode, message?: string): ConsoleDiagnosticBody {
  const diagnostic = consoleDiagnostic(code, message)
  // Every catalog code has a fix and a docs link.
  return { code, docs: diagnostic.docs, fix: diagnostic.fix, message: diagnostic.message }
}

/** The next step that the Console offers for a code. */
export function consoleDiagnosticAction(code: ConsoleDiagnosticCode): ConsoleDiagnosticAction {
  return consoleDiagnostic(code).data.action
}
