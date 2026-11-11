/**
 * Signed requests to the Console endpoint of an app, `POST /_vitehub/rpc`. Each caller, such as one Console link or one
 * CI job, has an Ed25519 key pair. The app keeps only the public keys, in `VITEHUB_CONSOLE_KEY_<NAME>`, so a copy of
 * its env cannot sign a request. The module uses only Web Crypto, so it runs in Node, Workers, Deno, and browsers.
 *
 * The signature covers this text, one field per line:
 *
 * ```txt
 * vitehub-signature-v1
 * POST
 * /_vitehub/rpc
 * https://app.example.com
 * 1794400000
 * CONSOLE_3F9A12BC
 * <SHA-256 of the body bytes, base64url>
 * <the x-vitehub-caller header>
 * ```
 */

import { isRecord } from "./object.ts"

/** The signature header: `key=<NAME>, t=<seconds>, origin=<app origin>, body=<SHA-256>, v1=<signature>`. */
export const consoleSignatureHeader = "x-vitehub-signature"
/** Who calls, as base64url JSON. The signature covers it. See {@link ConsoleCaller}. */
export const consoleCallerHeader = "x-vitehub-caller"
/** The first line of the signed text. A new format gets a new tag. */
export const consoleSignatureVersion = "vitehub-signature-v1"
/** The app refuses a signature that is older or newer than this many seconds. */
export const consoleSignatureWindowSeconds = 300
/** The app reads the public key of the caller `<NAME>` from `VITEHUB_CONSOLE_KEY_<NAME>`. */
export const consolePublicKeyPrefix = "VITEHUB_CONSOLE_KEY_"
/** The CLI reads its private key from `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`. `<NAME>` is the key name that it signs with. */
export const consolePrivateKeyPrefix = "VITEHUB_CONSOLE_PRIVATE_KEY_"

const keyNamePattern = /^[A-Z0-9_]{1,64}$/
const timestampPattern = /^\d{1,12}$/
const maximumCallerLength = 4_096
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const ed25519 = { name: "Ed25519" } as const
// The fixed DER prefix of an Ed25519 private key in PKCS #8 (RFC 8410). The 32-byte seed follows it.
const pkcs8Prefix = Uint8Array.of(0x30, 0x2E, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2B, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20)

/** The person that the Console signs for. The app gives it to `console.authorize` and to operations as the user. */
export interface ConsoleCallerUser {
  id: string
  name?: string
  email?: string
}

/**
 * Who sent a signed request. The key holder asserts it, so an app trusts it as much as it trusts the key.
 * - `via: "console"`: the ViteHub Console, for the signed-in `user`, in the `team` that linked the app. With
 *   `surface: "mcp"`, the ViteHub MCP of the Console called for the user: the app applies its MCP rules, and
 *   `confirmed: true` says that the person agreed to a destructive call.
 * - `via: "cli"`: the `vitehub` CLI, or another tool with a private key. It has no user.
 */
export type ConsoleCaller =
  | { via: "console", user: ConsoleCallerUser, team?: { id: string, role?: string }, surface?: "mcp", confirmed?: true }
  | { via: "cli" }

/** A private key and the name that the app knows its public key by. */
export interface ConsoleSigningKey {
  /** The `<NAME>` of `VITEHUB_CONSOLE_KEY_<NAME>`, such as `CONSOLE_3F9A12BC` or `CI`. */
  name: string
  /** The 32-byte Ed25519 seed, base64url. */
  privateKey: string
}

/** The codes of a refused signature. `500` codes are setup errors of the app, `401` codes are errors of the request. */
export type ConsoleSignatureCode =
  | "CONSOLE_KEY_MALFORMED"
  | "CONSOLE_KEY_NOT_CONFIGURED"
  | "CONSOLE_KEY_UNKNOWN"
  | "CONSOLE_SIGNATURE_BODY"
  | "CONSOLE_SIGNATURE_INVALID"
  | "CONSOLE_SIGNATURE_MISSING"
  | "CONSOLE_SIGNATURE_ORIGIN"
  | "CONSOLE_SIGNATURE_STALE"

export interface ConsoleSignatureFailure {
  ok: false
  code: ConsoleSignatureCode
  message: string
  status: 401 | 500
}

/** A signature that matched. `bodySha256` is the digest that it covers: the reader of the body must compare it. */
export interface ConsoleSignatureMatch {
  ok: true
  caller: ConsoleCaller
  key: string
  bodySha256: string
}

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** The bytes of a base64url value, or `undefined` when it is not canonical base64url without padding. */
function fromBase64url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[\w-]*$/.test(value) || value.length % 4 === 1) return undefined
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0))
  // A value with unused bits set decodes too. Only the canonical form counts, so one key has one spelling.
  return base64url(bytes) === value ? bytes : undefined
}

function bytesOf(body: string | ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  if (typeof body === "string") return encoder.encode(body)
  return body instanceof Uint8Array ? Uint8Array.from(body) : new Uint8Array(body)
}

/** The SHA-256 of the exact body bytes, base64url. A request without a body hashes zero bytes. */
export async function consoleBodySha256(body: string | ArrayBuffer | Uint8Array = ""): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytesOf(body))))
}

/** The text that the signature covers. Fields are joined with `\n`. */
export function consoleSignedText(fields: { method: string, target: string, origin: string, timestamp: string, key: string, bodySha256: string, caller: string }): string {
  return [consoleSignatureVersion, fields.method.toUpperCase(), fields.target, fields.origin, fields.timestamp, fields.key, fields.bodySha256, fields.caller].join("\n")
}

/** The path and query of a URL, the part of the request target that the signature covers. */
function requestTarget(url: URL): string {
  return `${url.pathname}${url.search}`
}

/** Whether a name can be the `<NAME>` of `VITEHUB_CONSOLE_KEY_<NAME>`: up to 64 of `A-Z`, `0-9`, and `_`. */
export function isConsoleKeyName(name: string): boolean {
  return keyNamePattern.test(name)
}

/** The 32 bytes of a public key, or `undefined` when the value is not a base64url raw Ed25519 public key. */
export function readConsolePublicKey(value: string): Uint8Array<ArrayBuffer> | undefined {
  const bytes = fromBase64url(value.trim())
  return bytes?.length === 32 ? bytes : undefined
}

async function importPrivateKey(seed: string) {
  const bytes = fromBase64url(seed.trim())
  if (bytes?.length !== 32) throw new TypeError("[vitehub] A Console private key is the 32-byte Ed25519 seed as base64url (43 characters). `vitehub secret console-key` makes one.")
  const der = new Uint8Array(pkcs8Prefix.length + 32)
  der.set(pkcs8Prefix)
  der.set(bytes, pkcs8Prefix.length)
  return await crypto.subtle.importKey("pkcs8", der, ed25519, false, ["sign"])
}

/** A new key pair: the public key for the app, the private key (the seed) for the caller. Both are base64url. */
export async function createConsoleKeyPair(): Promise<{ publicKey: string, privateKey: string }> {
  const pair = await crypto.subtle.generateKey(ed25519, true, ["sign", "verify"])
  // Internal invariant: Ed25519 generateKey() always returns a key pair; the check narrows the CryptoKey union.
  if (!("privateKey" in pair)) throw new TypeError("Ed25519 key generation did not return a key pair.")
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  return { privateKey: base64url(pkcs8.slice(-32)), publicKey: base64url(publicKey) }
}

/** The `x-vitehub-caller` value of a caller: its JSON as base64url. */
export function encodeConsoleCaller(caller: ConsoleCaller): string {
  return base64url(encoder.encode(JSON.stringify(caller)))
}

function optionalText(value: unknown, maximum = 512): string | undefined | false {
  if (value === undefined) return undefined
  return String(value) === value && value.length > 0 && value.length <= maximum ? value : false
}

const consoleCallerKeys = new Set(["via", "user", "team", "surface", "confirmed"])

/** Read an `x-vitehub-caller` value. Returns `undefined` for anything that is not one of the {@link ConsoleCaller} forms. */
export function decodeConsoleCaller(value: string): ConsoleCaller | undefined {
  if (value.length > maximumCallerLength) return undefined
  const bytes = fromBase64url(value)
  if (!bytes) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(bytes))
  }
  catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (parsed.via === "cli") return Object.keys(parsed).length === 1 ? { via: "cli" } : undefined
  if (parsed.via !== "console" || !isRecord(parsed.user) || Object.keys(parsed).some(key => !consoleCallerKeys.has(key))) return undefined
  // `confirmed` belongs to an MCP call only, so a Console page call cannot carry it.
  if ((parsed.surface !== undefined && parsed.surface !== "mcp") || (parsed.confirmed !== undefined && (parsed.confirmed !== true || parsed.surface !== "mcp"))) return undefined
  const mcp = parsed.surface === "mcp" ? { surface: "mcp" as const, ...(parsed.confirmed === true ? { confirmed: true as const } : {}) } : {}
  const id = optionalText(parsed.user.id)
  const name = optionalText(parsed.user.name)
  const email = optionalText(parsed.user.email)
  if (!id || name === false || email === false || Object.keys(parsed.user).some(key => key !== "id" && key !== "name" && key !== "email")) return undefined
  const user: ConsoleCallerUser = { id, ...(name ? { name } : {}), ...(email ? { email } : {}) }
  if (parsed.team === undefined) return { via: "console", user, ...mcp }
  if (!isRecord(parsed.team)) return undefined
  const teamId = optionalText(parsed.team.id)
  const role = optionalText(parsed.team.role)
  if (!teamId || role === false || Object.keys(parsed.team).some(key => key !== "id" && key !== "role")) return undefined
  return { via: "console", user, team: { id: teamId, ...(role ? { role } : {}) }, ...mcp }
}

/**
 * Sign one request. `url` is the full URL that the request goes to, and `body` is the exact body that it sends. Returns
 * the two headers to add: `x-vitehub-signature` and `x-vitehub-caller`.
 */
export async function signConsoleRequest(options: { body?: string | ArrayBuffer | Uint8Array, caller: ConsoleCaller, key: ConsoleSigningKey, method: string, now?: number, url: string | URL }): Promise<Record<string, string>> {
  if (!isConsoleKeyName(options.key.name)) throw new TypeError(`[vitehub] The Console key name ${JSON.stringify(options.key.name)} must be 1 to 64 of A-Z, 0-9, and _.`)
  const url = new URL(options.url)
  const timestamp = String(Math.floor((options.now ?? Date.now()) / 1_000))
  const bodySha256 = await consoleBodySha256(options.body)
  const caller = encodeConsoleCaller(options.caller)
  const text = consoleSignedText({ bodySha256, caller, key: options.key.name, method: options.method, origin: url.origin, target: requestTarget(url), timestamp })
  const signature = new Uint8Array(await crypto.subtle.sign(ed25519, await importPrivateKey(options.key.privateKey), encoder.encode(text)))
  return {
    [consoleCallerHeader]: caller,
    [consoleSignatureHeader]: `key=${options.key.name}, t=${timestamp}, origin=${url.origin}, body=${bodySha256}, v1=${base64url(signature)}`,
  }
}

/** Whether a request carries a Console signature. */
export function hasConsoleSignature(headers: Headers): boolean {
  return headers.has(consoleSignatureHeader)
}

function failure(code: ConsoleSignatureCode, message: string, status: 401 | 500 = 401): ConsoleSignatureFailure {
  return { code, message, ok: false, status }
}

/** The public keys of an env, by name, or the failure for an env without any, or with one that is not a key. */
export function readConsolePublicKeys(env: Readonly<Record<string, unknown>>): Map<string, Uint8Array<ArrayBuffer>> | ConsoleSignatureFailure {
  const keys = new Map<string, Uint8Array<ArrayBuffer>>()
  for (const variable of Object.keys(env).sort()) {
    if (!variable.startsWith(consolePublicKeyPrefix)) continue
    const name = variable.slice(consolePublicKeyPrefix.length)
    const value = env[variable]
    if (String(value) !== value || !value.trim()) continue
    const key = isConsoleKeyName(name) ? readConsolePublicKey(value) : undefined
    if (!key) {
      return failure("CONSOLE_KEY_MALFORMED", `\`${variable}\` is not an Ed25519 public key: the value must be 43 base64url characters (32 raw bytes) and the name 1 to 64 of A-Z, 0-9, and _. The app refuses every Console request until it is fixed.`, 500)
    }
    keys.set(name, key)
  }
  if (!keys.size) return failure("CONSOLE_KEY_NOT_CONFIGURED", `\`console: true\` needs at least one \`${consolePublicKeyPrefix}<NAME>\` variable in the server environment, and none is set.`, 500)
  return keys
}

function signatureFields(header: string): Record<"key" | "t" | "origin" | "body" | "v1", string> | undefined {
  const fields: Record<string, string> = {}
  for (const part of header.split(",")) {
    const separator = part.indexOf("=")
    if (separator === -1) return undefined
    const name = part.slice(0, separator).trim()
    if (!["key", "t", "origin", "body", "v1"].includes(name) || Object.hasOwn(fields, name)) return undefined
    fields[name] = part.slice(separator + 1).trim()
  }
  const { body, key, origin, t, v1 } = fields
  return body && key && origin && t && v1 ? { body, key, origin, t, v1 } : undefined
}

/**
 * Check the signature of a request before its body is read. `origin` is the origin that the app serves, such as its
 * configured public URL. `keys` comes from {@link readConsolePublicKeys}. A match returns the signed body digest: the
 * reader of the body compares it with {@link consoleBodySha256} of the bytes it reads, before it acts on them.
 */
export async function verifyConsoleSignature(options: { headers: Headers, keys: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, method: string, now?: number, origin: string, url: string | URL }): Promise<ConsoleSignatureMatch | ConsoleSignatureFailure> {
  const header = options.headers.get(consoleSignatureHeader)
  if (header === null) return failure("CONSOLE_SIGNATURE_MISSING", "This request is not signed.")
  const fields = signatureFields(header)
  const callerValue = options.headers.get(consoleCallerHeader) ?? ""
  const caller = decodeConsoleCaller(callerValue)
  const bodyDigest = fields ? fromBase64url(fields.body) : undefined
  const signature = fields ? fromBase64url(fields.v1) : undefined
  if (!fields || !isConsoleKeyName(fields.key) || !timestampPattern.test(fields.t) || bodyDigest?.length !== 32 || signature?.length !== 64 || !caller) {
    return failure("CONSOLE_SIGNATURE_INVALID", `The \`${consoleSignatureHeader}\` or \`${consoleCallerHeader}\` header is malformed.`)
  }
  const now = Math.floor((options.now ?? Date.now()) / 1_000)
  const skew = now - Number(fields.t)
  if (Math.abs(skew) > consoleSignatureWindowSeconds) {
    const minutes = Math.round(Math.abs(skew) / 60)
    return failure("CONSOLE_SIGNATURE_STALE", `The request was signed ${skew > 0 ? `${minutes} minutes ago` : `${minutes} minutes in the future`}. The app accepts ${consoleSignatureWindowSeconds / 60} minutes either way.`)
  }
  const origin = new URL(options.origin).origin
  if (fields.origin !== origin) return failure("CONSOLE_SIGNATURE_ORIGIN", `The request was signed for ${fields.origin}, and this app is ${origin}.`)
  const publicKey = options.keys.get(fields.key)
  if (!publicKey) return failure("CONSOLE_KEY_UNKNOWN", `The request was signed with the key \`${fields.key}\`, and this app has no \`${consolePublicKeyPrefix}${fields.key}\`.`)
  const text = consoleSignedText({ bodySha256: fields.body, caller: callerValue, key: fields.key, method: options.method, origin, target: requestTarget(new URL(options.url)), timestamp: fields.t })
  let matched = false
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, ed25519, false, ["verify"])
    matched = await crypto.subtle.verify(ed25519, key, signature, encoder.encode(text))
  }
  catch {
    matched = false
  }
  if (!matched) return failure("CONSOLE_SIGNATURE_INVALID", `The signature does not match the request, or it was made with another key than \`${consolePublicKeyPrefix}${fields.key}\`.`)
  return { bodySha256: fields.body, caller, key: fields.key, ok: true }
}

/**
 * The signing key of a CLI from its env: the one `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` variable. Returns `undefined`
 * without one. Throws a `TypeError` when there are several, or when the value is not a 32-byte seed.
 */
export function readConsoleSigningKey(env: Readonly<Record<string, string | undefined>>): ConsoleSigningKey | undefined {
  const variables = Object.keys(env).filter(name => name.startsWith(consolePrivateKeyPrefix) && env[name]?.trim()).sort()
  if (!variables.length) return undefined
  if (variables.length > 1) throw new TypeError(`[vitehub] Set one ${consolePrivateKeyPrefix}<NAME> variable. This environment has ${variables.join(", ")}.`)
  const variable = variables[0]!
  const name = variable.slice(consolePrivateKeyPrefix.length)
  const privateKey = env[variable]!.trim()
  if (!isConsoleKeyName(name) || fromBase64url(privateKey)?.length !== 32) {
    throw new TypeError(`[vitehub] ${variable} must be the 43-character private key that \`vitehub secret console-key\` prints, and its name 1 to 64 of A-Z, 0-9, and _.`)
  }
  return { name, privateKey }
}
