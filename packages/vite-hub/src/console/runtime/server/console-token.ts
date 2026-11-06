import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { consoleDiagnosticBody, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { consoleBearerChallenge } from "./cors.ts"

/**
 * The runtime secret of `console: { auth: "token" }`: the SHA-256 of the token as 64 hex characters. The server never
 * stores the token, so reading the host env, or a pulled `.env` file, does not give a working bearer.
 */
export const consoleTokenHashVariable = "VITEHUB_CONSOLE_TOKEN_SHA256"

/** The raw token. The server refuses it, so a token in the host env never becomes the secret. */
const rawTokenVariable = "VITEHUB_CONSOLE_TOKEN"

/** A shorter bearer is easy to guess, so the server rejects it before it hashes it. */
const minimumTokenLength = 32

const encoder = new TextEncoder()

function rejection(status: 401 | 500, code: ConsoleDiagnosticCode, message: string, challenge?: string): Response {
  return Response.json({ ...consoleDiagnosticBody(code, message), ok: false, status }, {
    headers: {
      "cache-control": "no-store",
      ...(challenge ? { "www-authenticate": challenge } : {}),
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
    status,
  })
}

/** A variable from the host environment of this request: the Cloudflare `env` first, then `process.env`. */
function readVariable(event: unknown, name: string): string | undefined {
  const value: unknown = getCloudflareEnv(event)?.[name] ?? globalThis.process?.env?.[name]
  return String(value) === value && value.trim() ? value.trim() : undefined
}

function hexBytes(value: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{64}$/i.test(value)) return undefined
  return Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16))
}

/**
 * Whether a bearer token has the stored SHA-256 digest. The comparison always reads all 32 bytes, so its time does not
 * depend on where the digests differ.
 */
export async function consoleTokenMatchesHash(expected: Uint8Array, received: string): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(received)))
  let difference = expected.length ^ digest.length
  for (let index = 0; index < digest.length; index++) difference |= (expected[index] ?? 0) ^ digest[index]!
  return difference === 0
}

/** The outcome of `checkConsoleToken()`. Only `withConsoleAccess()` turns `ok: true` into a Console access grant. */
export type ConsoleTokenCheck = { ok: true } | { ok: false, response: Response }

/**
 * Check the `Authorization: Bearer` token of a request against `VITEHUB_CONSOLE_TOKEN_SHA256`. A rejection is `500`
 * when the server has no usable hash, and `401` with a Bearer challenge when the token is missing, too short, or wrong.
 * Cookies never count.
 */
export async function checkConsoleToken(request: Request, event: unknown): Promise<ConsoleTokenCheck> {
  const stored = readVariable(event, consoleTokenHashVariable)
  const expected = stored ? hexBytes(stored) : undefined
  if (!expected) {
    const message = stored
      ? `${consoleTokenHashVariable} is not 64 hex characters, so the server refuses every Console request.`
      : readVariable(event, rawTokenVariable)
        ? `${rawTokenVariable} is set, but the server reads only ${consoleTokenHashVariable}, the SHA-256 of the token. Store the hash and remove ${rawTokenVariable}.`
        : `console: { auth: "token" } needs ${consoleTokenHashVariable} in the server environment, and it is not set.`
    return { ok: false, response: rejection(500, "CONSOLE_TOKEN_NOT_CONFIGURED", message) }
  }
  const received = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(request.headers.get("authorization") ?? "")?.[1]
  if (!received) return { ok: false, response: rejection(401, "CONSOLE_TOKEN_INVALID", "This request has no Console token.", consoleBearerChallenge()) }
  if (received.length < minimumTokenLength || !await consoleTokenMatchesHash(expected, received)) {
    return { ok: false, response: rejection(401, "CONSOLE_TOKEN_INVALID", "The Console token is not correct.", consoleBearerChallenge({ error: "invalid_token" })) }
  }
  return { ok: true }
}
