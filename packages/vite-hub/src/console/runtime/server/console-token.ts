import { getStandardContext } from "@vite-hub/runtime/h3"

import { consoleDiagnosticBody, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { consoleBearerChallenge } from "./cors.ts"

import type { ConsoleRequestEvent } from "./request.ts"

/**
 * The runtime secret of `console: { auth: "token" }`: the SHA-256 of each accepted token as 64 hex characters, with commas
 * between them. The server never stores a token, so reading the host env, or a pulled `.env` file, does not give a
 * working bearer. Each caller, such as a Console or the CLI in CI, can have its own token, and removing its hash revokes
 * only that caller.
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
function readVariable(event: ConsoleRequestEvent, name: string): string | undefined {
  const value: unknown = getStandardContext(event).runtime?.cloudflare?.env?.[name] ?? globalThis.process?.env?.[name]
  return String(value) === value && value.trim() ? value.trim() : undefined
}

function hexBytes(value: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{64}$/i.test(value)) return undefined
  return Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16))
}

/** The digests of a stored list, or the 1-based position of the first entry that is not 64 hex characters. */
function parseHashList(value: string): { digests: Uint8Array[] } | { invalid: number } {
  const entries = value.split(",").map(entry => entry.trim())
  const digests: Uint8Array[] = []
  for (const [index, entry] of entries.entries()) {
    const digest = hexBytes(entry)
    if (!digest) return { invalid: index + 1 }
    digests.push(digest)
  }
  return { digests }
}

/**
 * Whether a bearer token has one of the stored SHA-256 digests. The token is hashed once, and the comparison always
 * reads all 32 bytes of every digest, so its time does not depend on where the digests differ or which one matches.
 */
export async function consoleTokenMatchesHash(expected: readonly Uint8Array[], received: string): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(received)))
  let matched = 0
  for (const stored of expected) {
    let difference = stored.length ^ digest.length
    for (let index = 0; index < digest.length; index++) difference |= (stored[index] ?? 0) ^ digest[index]!
    matched |= Number(difference === 0)
  }
  return matched === 1
}

/** The outcome of `checkConsoleToken()`. Only `withConsoleAccess()` turns `ok: true` into a Console access grant. */
export type ConsoleTokenCheck = { ok: true } | { ok: false, response: Response }

/**
 * Check the `Authorization: Bearer` token of a request against the hashes in `VITEHUB_CONSOLE_TOKEN_SHA256`. A rejection
 * is `500` when the server has no usable list, and `401` with a Bearer challenge when the token is missing, too short,
 * or matches no hash. Cookies never count.
 */
export async function checkConsoleToken(request: Request, event: ConsoleRequestEvent): Promise<ConsoleTokenCheck> {
  const stored = readVariable(event, consoleTokenHashVariable)
  const list = stored ? parseHashList(stored) : undefined
  if (!list || "invalid" in list) {
    const message = list
      ? `Entry ${list.invalid} of \`${consoleTokenHashVariable}\` is not 64 hex characters, so the server refuses every Console request. Separate several hashes with commas.`
      : readVariable(event, rawTokenVariable)
        ? `\`${rawTokenVariable}\` is set, but the server reads only \`${consoleTokenHashVariable}\`, the SHA-256 of the token. Store the hash and remove \`${rawTokenVariable}\`.`
        : `\`console: { auth: "token" }\` needs \`${consoleTokenHashVariable}\` in the server environment, and it is not set.`
    return { ok: false, response: rejection(500, "CONSOLE_TOKEN_NOT_CONFIGURED", message) }
  }
  const received = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(request.headers.get("authorization") ?? "")?.[1]
  if (!received) return { ok: false, response: rejection(401, "CONSOLE_TOKEN_INVALID", "This request has no Console token.", consoleBearerChallenge()) }
  if (received.length < minimumTokenLength || !await consoleTokenMatchesHash(list.digests, received)) {
    return { ok: false, response: rejection(401, "CONSOLE_TOKEN_INVALID", "The Console token is not correct.", consoleBearerChallenge({ error: "invalid_token" })) }
  }
  return { ok: true }
}
