import { defineDiagnostics, type Diagnostic } from "nostics"

const consoleGuide = "https://vitehub.dev/docs/development/console"

/** What the Console offers as the next step for a failure. */
export type ConsoleDiagnosticAction = "docs" | "reload" | "retry" | "sign-in"

/** Stable codes of Console and Console management failures. */
export type ConsoleDiagnosticCode =
  | "CONSOLE_ACCESS_DENIED"
  | "CONSOLE_ACCESS_NOT_CONFIGURED"
  | "CONSOLE_CONFLICT"
  | "CONSOLE_DEVELOPMENT_ONLY"
  | "CONSOLE_KEY_MALFORMED"
  | "CONSOLE_KEY_NOT_CONFIGURED"
  | "CONSOLE_KEY_UNKNOWN"
  | "CONSOLE_LOOPBACK_ONLY"
  | "CONSOLE_MCP_AUTHORIZATION_FAILED"
  | "CONSOLE_MCP_KEY_INVALID"
  | "CONSOLE_MCP_KV_REQUIRED"
  | "CONSOLE_MCP_SIGNED_OUT"
  | "CONSOLE_MCP_UNREACHABLE"
  | "CONSOLE_NOT_FOUND"
  | "CONSOLE_ORIGIN_REJECTED"
  | "CONSOLE_REQUEST_FAILED"
  | "CONSOLE_REQUEST_INVALID"
  | "CONSOLE_SIGN_IN_REQUIRED"
  | "CONSOLE_SIGNATURE_BODY"
  | "CONSOLE_SIGNATURE_INVALID"
  | "CONSOLE_SIGNATURE_MISSING"
  | "CONSOLE_SIGNATURE_ORIGIN"
  | "CONSOLE_SIGNATURE_STALE"
  | "CONSOLE_TICKET_INVALID"
  | "CONSOLE_TICKET_MISMATCH"
  | "CONSOLE_TICKET_STORE_MISSING"
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
    CONSOLE_DEVELOPMENT_ONLY: code(
      "The Console endpoint without Console options runs only on the development server.",
      "For production, set console: true, and set the VITEHUB_CONSOLE_KEY_<NAME> line that the ViteHub Console shows when you link the app.",
      `${consoleGuide}#protect-the-console-route`,
      "docs",
    ),
    CONSOLE_ACCESS_NOT_CONFIGURED: code(
      "Console access is not configured. The server has no Console access policy.",
      "Build the app with the ViteHub plugin, so the generated Console output installs its access policy.",
      `${consoleGuide}#protect-the-console-route`,
      "docs",
    ),
    CONSOLE_ORIGIN_REJECTED: code(
      "The request did not come from the Console origin.",
      "Open the Console from its own URL. A proxy must forward the public Host and Origin headers.",
      `${consoleGuide}#protect-the-console-route`,
      "docs",
    ),
    CONSOLE_SIGNATURE_MISSING: code(
      "This app takes only signed Console requests, and this request is not signed.",
      "Open the app from the ViteHub Console, or set `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` for the CLI. `vitehub secret console-key` prints a new key pair; set its public key on the app.",
      `${consoleGuide}#sign-console-requests`,
      "docs",
    ),
    CONSOLE_SIGNATURE_INVALID: code(
      "The signature does not match the request.",
      "Use the private key whose public key is in the `VITEHUB_CONSOLE_KEY_<NAME>` that the signature names. If the Console linked the app again, set the new line that its setup page shows.",
      `${consoleGuide}#sign-console-requests`,
      "docs",
    ),
    CONSOLE_SIGNATURE_STALE: code(
      "The request was signed more than 5 minutes before or after the app clock.",
      "Sync the clock of the machine that signs, then send the request again.",
      `${consoleGuide}#sign-console-requests`,
      "retry",
    ),
    CONSOLE_SIGNATURE_ORIGIN: code(
      "The request was signed for another origin, or the app has no trusted origin.",
      "Link the app with the URL that serves it. A Node.js server must set `vitehub({ publicUrl })` to its public URL for signed requests.",
      `${consoleGuide}#sign-console-requests`,
      "docs",
    ),
    CONSOLE_SIGNATURE_BODY: code(
      "The request body is not the body that was signed.",
      "Send the body bytes that the signature covers. A proxy must not change the body of `POST /_vitehub/rpc`.",
      `${consoleGuide}#sign-console-requests`,
      "docs",
    ),
    CONSOLE_KEY_UNKNOWN: code(
      "The app has no public key with the name that the signature names.",
      "Set the `VITEHUB_CONSOLE_KEY_<NAME>` line from the Console setup page, or from `vitehub secret console-key`, on the app. Then restart or deploy the server.",
      `${consoleGuide}#sign-console-requests`,
      "docs",
    ),
    CONSOLE_KEY_NOT_CONFIGURED: code(
      "`console: true` needs a `VITEHUB_CONSOLE_KEY_<NAME>` variable in the server environment.",
      "Link the app in the ViteHub Console and set the line that it shows, or run `vitehub secret console-key` and set its public key line. On Cloudflare, run `wrangler secret put VITEHUB_CONSOLE_KEY_<NAME>`. Then restart or deploy the server.",
      `${consoleGuide}#sign-console-requests`,
      "docs",
    ),
    CONSOLE_KEY_MALFORMED: code(
      "A `VITEHUB_CONSOLE_KEY_<NAME>` variable is not an Ed25519 public key.",
      "Set the value to the 43 base64url characters that the Console setup page or `vitehub secret console-key` prints, with no quotes or spaces. Then restart or deploy the server.",
      `${consoleGuide}#sign-console-requests`,
      "docs",
    ),
    CONSOLE_TICKET_INVALID: code(
      "This one-time link expired, was used, or was changed.",
      "Open the page again from the ViteHub Console. Each link works once, within 60 seconds.",
      `${consoleGuide}#one-time-links`,
      "docs",
    ),
    CONSOLE_TICKET_MISMATCH: code(
      "This one-time link was made for another person or another app.",
      "Open the page from the ViteHub Console in the browser where you are signed in to the app with the email of your Console account.",
      `${consoleGuide}#one-time-links`,
      "docs",
    ),
    CONSOLE_TICKET_STORE_MISSING: code(
      "One-time links need a store that every instance of the app shares, and the app has none.",
      "Add app Auth with a Database, such as `defineAuth({ database: authDatabase() })`, then run `vitehub database migrate`. Its verification table keeps each link until it is used.",
      `${consoleGuide}#one-time-links`,
      "docs",
    ),
    CONSOLE_LOOPBACK_ONLY: code(
      "The development Console without signed calls accepts only requests from this machine.",
      "Call it from this machine, such as with `vitehub` commands, or remove console.auth so the app takes calls that the ViteHub Console and the CLI sign.",
      `${consoleGuide}#protect-the-console-route`,
      "docs",
    ),
    CONSOLE_MCP_UNREACHABLE: code(
      "The MCP server did not answer, or it failed the MCP handshake.",
      "Check that the server runs and that the URL is its Streamable HTTP endpoint, such as /mcp.",
      `${consoleGuide}#connect-to-mcp-servers`,
      "retry",
    ),
    CONSOLE_MCP_SIGNED_OUT: code(
      "The MCP server rejects the credentials of this connection.",
      "Sign in again. For a token, connect again with a new one.",
      `${consoleGuide}#connect-to-mcp-servers`,
      "docs",
    ),
    CONSOLE_MCP_AUTHORIZATION_FAILED: code(
      "The OAuth sign-in with the MCP server failed.",
      "Start the sign-in again. The server must publish RFC 9728 metadata that names an authorization server with client registration.",
      `${consoleGuide}#connect-to-mcp-servers`,
      "docs",
    ),
    CONSOLE_MCP_KEY_INVALID: code(
      "VITEHUB_CONSOLE_MCP_KEY is not 32 random bytes, so the Console cannot seal MCP connections.",
      "Set VITEHUB_CONSOLE_MCP_KEY to 32 random bytes as base64 or hex, such as the output of openssl rand -base64 32.",
      `${consoleGuide}#what-the-mcp-client-keeps`,
      "docs",
    ),
    CONSOLE_MCP_KV_REQUIRED: code(
      "VITEHUB_CONSOLE_MCP_KEY is set, but the app has no configured default KV store for MCP connections.",
      "Set kv: true in vitehub(), or configure a default KV store, then rebuild the app.",
      `${consoleGuide}#what-the-mcp-client-keeps`,
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
