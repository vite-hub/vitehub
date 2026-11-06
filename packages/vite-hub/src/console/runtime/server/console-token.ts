import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { consoleDiagnosticBody, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { consoleBearerChallenge } from "./cors.ts"

/** The runtime secret of `console: { auth: "token" }`. */
export const consoleTokenVariable = "VITEHUB_CONSOLE_TOKEN"

/** A shorter secret is easy to guess, so the server refuses it as if it were not set. */
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

/** The secret from the host environment of this request: the Cloudflare `env` first, then `process.env`. */
export function readConsoleToken(event: unknown): string | undefined {
  const value: unknown = getCloudflareEnv(event)?.[consoleTokenVariable] ?? globalThis.process?.env?.[consoleTokenVariable]
  return String(value) === value && value.trim() ? value.trim() : undefined
}

/**
 * Whether two secrets are equal. Both sides are hashed with SHA-256 first, so the comparison always reads 32 bytes, and
 * its time does not depend on where the values differ or on their lengths.
 */
export async function consoleTokensMatch(expected: string, received: string): Promise<boolean> {
  const [left, right] = await Promise.all([expected, received].map(async value => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))))
  let difference = 0
  for (let index = 0; index < left!.length; index++) difference |= left![index]! ^ right![index]!
  return difference === 0
}

/**
 * Check the `Authorization: Bearer` token of a request against `VITEHUB_CONSOLE_TOKEN`. Returns `undefined` when the
 * token matches. Otherwise returns the rejection: `500` when the server has no usable secret, `401` with a Bearer
 * challenge when the token is missing or wrong. Cookies never count.
 */
export async function checkConsoleToken(request: Request, event: unknown): Promise<Response | undefined> {
  const expected = readConsoleToken(event)
  if (!expected || expected.length < minimumTokenLength) {
    return rejection(500, "CONSOLE_TOKEN_NOT_CONFIGURED", expected
      ? `${consoleTokenVariable} has fewer than ${minimumTokenLength} characters, so the server refuses every Console request.`
      : `console: { auth: "token" } needs ${consoleTokenVariable} in the server environment, and it is not set.`)
  }
  const received = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(request.headers.get("authorization") ?? "")?.[1]
  if (!received) return rejection(401, "CONSOLE_TOKEN_INVALID", "This request has no Console token.", consoleBearerChallenge())
  if (!await consoleTokensMatch(expected, received)) {
    return rejection(401, "CONSOLE_TOKEN_INVALID", "The Console token is not correct.", consoleBearerChallenge({ error: "invalid_token" }))
  }
}
