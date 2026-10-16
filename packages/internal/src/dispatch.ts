import { deriveViteHubSecret, isViteHubSecretEqual, readViteHubSecret } from "./secret.ts"

/**
 * Dispatch lets a CLI run one server operation, such as a manual Schedule run, without a browser session.
 * The client signs the request with the dispatch key. The server derives the same key from its root secret.
 * It uses no Node API, so it also runs in Worker runtimes.
 */

/** The `deriveSecret()` purpose of the dispatch key. `vitehub secret derive vitehub:dispatch` prints the key. */
export const viteHubDispatchKeyPurpose = "vitehub:dispatch"

export const viteHubDispatchHeaders = {
  actor: "x-vitehub-dispatch-actor",
  nonce: "x-vitehub-dispatch-nonce",
  signature: "x-vitehub-dispatch-signature",
  timestamp: "x-vitehub-dispatch-timestamp",
} as const

/** A request older or newer than this many seconds fails. Nonces are kept for the same window. */
export const viteHubDispatchWindowSeconds = 300

export type ViteHubDispatchVerification =
  | { actor?: string, ok: true }
  | { message: string, ok: false, status: 401 }

interface DispatchFields {
  actor: string
  bodyHash: string
  nonce: string
  operation: string
  timestamp: string
}

const encoder = new TextEncoder()
const keyPattern = /^[0-9a-f]{64}$/
const noncePattern = /^[0-9a-f]{32}$/
const timestampPattern = /^\d{1,12}$/
const signaturePattern = /^v1=([0-9a-f]{64})$/
// eslint-disable-next-line no-control-regex -- The actor is one header line, so control characters are rejected.
const controlCharacters = /[\u0000-\u001F\u007F]/
const maximumActorLength = 200
const nonceKey = Symbol.for("vitehub.dispatch.nonces")
// SAFETY: This module owns the process slot, so separately bundled copies share one replay cache.
const scope = globalThis as typeof globalThis & { [nonceKey]?: Map<string, number> }

function hex(buffer: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

async function sha256(text: string): Promise<string> {
  return hex(await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(text)))
}

async function hmac(key: string, message: string): Promise<string> {
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", encoder.encode(key), { hash: "SHA-256", name: "HMAC" }, false, ["sign"])
  return hex(await globalThis.crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)))
}

function canonical(fields: DispatchFields): string {
  return ["vitehub-dispatch-v1", fields.operation, fields.timestamp, fields.nonce, fields.actor, fields.bodyHash].join("\n")
}

function failure(message: string): ViteHubDispatchVerification {
  return { message, ok: false, status: 401 }
}

/**
 * Resolves the dispatch key of a client: `VITEHUB_DISPATCH_KEY`, or the key derived from `VITEHUB_SECRET` or
 * `NUXT_APP_SECRET`. Returns `undefined` when none is set. Throws a `TypeError` for a malformed `VITEHUB_DISPATCH_KEY`.
 */
export async function resolveViteHubDispatchKey(env: Readonly<Record<string, unknown>>): Promise<string | undefined> {
  const key = env.VITEHUB_DISPATCH_KEY
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Host env records are untrusted values.
  if (typeof key === "string" && key) {
    if (!keyPattern.test(key)) throw new TypeError("[vitehub] VITEHUB_DISPATCH_KEY must be the 64-character hex key that `vitehub secret derive vitehub:dispatch` prints.")
    return key
  }
  const root = readViteHubSecret(env)
  return root ? await deriveViteHubSecret(root, viteHubDispatchKeyPurpose) : undefined
}

/**
 * Signs one dispatch request and returns its headers. The signature covers the operation, the time, a one-time nonce,
 * the actor claim, and the exact body. The actor claim is self-asserted: anyone with the key can choose it.
 */
export async function signViteHubDispatch(options: { actor?: string, body: string, key: string, now?: number, operation: string }): Promise<Record<string, string>> {
  const actor = options.actor ?? ""
  const timestamp = String(Math.floor((options.now ?? Date.now()) / 1_000))
  const nonce = hex(globalThis.crypto.getRandomValues(new Uint8Array(16)))
  const signature = await hmac(options.key, canonical({ actor, bodyHash: await sha256(options.body), nonce, operation: options.operation, timestamp }))
  return {
    ...(actor ? { [viteHubDispatchHeaders.actor]: actor } : {}),
    [viteHubDispatchHeaders.nonce]: nonce,
    [viteHubDispatchHeaders.signature]: `v1=${signature}`,
    [viteHubDispatchHeaders.timestamp]: timestamp,
  }
}

/** Whether a request carries a dispatch signature. Verify such a request as dispatch only, never as a Console session. */
export function hasViteHubDispatch(headers: Headers): boolean {
  return headers.has(viteHubDispatchHeaders.signature)
}

/**
 * Verifies one dispatch request against the root secret in `env`. The signature must match the operation and the
 * exact body, the timestamp must be inside the five-minute window, and each nonce is accepted once. The replay cache
 * belongs to one server process: deployments with several instances accept a replay on another instance inside the window.
 */
export async function verifyViteHubDispatch(options: { body: string, env: Readonly<Record<string, unknown>>, headers: Headers, now?: number, operation: string }): Promise<ViteHubDispatchVerification> {
  const root = readViteHubSecret(options.env)
  if (!root) return failure("Dispatch is not configured on this deployment. Set VITEHUB_SECRET.")
  const { headers } = options
  const timestamp = headers.get(viteHubDispatchHeaders.timestamp) ?? ""
  const nonce = headers.get(viteHubDispatchHeaders.nonce) ?? ""
  const actor = headers.get(viteHubDispatchHeaders.actor) ?? ""
  const signature = signaturePattern.exec(headers.get(viteHubDispatchHeaders.signature) ?? "")?.[1]
  if (!signature || !noncePattern.test(nonce) || !timestampPattern.test(timestamp) || actor.length > maximumActorLength || controlCharacters.test(actor)) {
    return failure("Malformed dispatch signature.")
  }
  const now = Math.floor((options.now ?? Date.now()) / 1_000)
  const seconds = Number(timestamp)
  if (Math.abs(now - seconds) > viteHubDispatchWindowSeconds) return failure("Dispatch signature expired. Check the client clock.")
  let key: string
  try {
    key = await deriveViteHubSecret(root, viteHubDispatchKeyPurpose)
  }
  catch (error) {
    return failure(error instanceof Error ? error.message : "Dispatch is not configured on this deployment.")
  }
  const expected = await hmac(key, canonical({ actor, bodyHash: await sha256(options.body), nonce, operation: options.operation, timestamp }))
  if (!isViteHubSecretEqual(signature, expected)) return failure("Dispatch signature does not match. Use the dispatch key of this deployment.")
  const nonces = (scope[nonceKey] ??= new Map())
  for (const [seen, expiresAt] of nonces) {
    if (expiresAt < now) nonces.delete(seen)
  }
  if (nonces.has(nonce)) return failure("Dispatch nonce was already used.")
  nonces.set(nonce, seconds + viteHubDispatchWindowSeconds)
  return actor ? { actor, ok: true } : { ok: true }
}
