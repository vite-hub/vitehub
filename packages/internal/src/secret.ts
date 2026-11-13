const secretEncoder = new TextEncoder()

/**
 * Compares a request value with an expected secret in constant time for the length of `expected`. Returns `false`
 * when either value is missing or empty. It uses no Node API, so it also runs in Worker runtimes.
 */
export function isViteHubSecretEqual(actual: string | null | undefined, expected: string | null | undefined): boolean {
  if (!actual || !expected) return false
  const left = secretEncoder.encode(actual)
  const right = secretEncoder.encode(expected)
  let difference = left.length ^ right.length
  for (let index = 0; index < right.length; index += 1) difference |= (left[index] ?? 0) ^ right[index]!
  return difference === 0
}

/**
 * Compares the token of a `Bearer` `Authorization` header with an expected secret in constant time. The scheme is
 * case-insensitive. Returns `false` for another scheme or a missing value.
 */
export function isViteHubBearerSecretEqual(authorization: string | null | undefined, expected: string | null | undefined): boolean {
  return isViteHubSecretEqual(/^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1], expected)
}

/** The shortest root secret that `deriveViteHubSecret()` accepts. `openssl rand -base64 32` prints 44 characters. */
export const viteHubSecretMinimumLength = 32

/** HKDF salt for every ViteHub-derived secret. A different salt than Nuxt's keeps both derivations apart for one shared root. */
export const viteHubSecretSalt = "vitehub"

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Reads the root app secret from an env record: `VITEHUB_SECRET`, then `NUXT_APP_SECRET`, so a Nuxt app needs only one
 * secret. Returns `undefined` when neither is a non-empty string.
 */
export function readViteHubSecret(env: Readonly<Record<string, unknown>>): string | undefined {
  for (const name of ["VITEHUB_SECRET", "NUXT_APP_SECRET"]) {
    const value = env[name]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

/**
 * Derives a 32-byte secret for one purpose from the root secret, hex-encoded. It uses HKDF-SHA256 with the salt
 * `vitehub` and the purpose as `info`. The result is stable while the root is unchanged and distinct for every purpose.
 * Throws a `TypeError` when the root is shorter than 32 characters or the purpose is empty. It uses no Node API.
 */
export async function deriveViteHubSecret(root: string, purpose: string): Promise<string> {
  if (root.length < viteHubSecretMinimumLength) {
    throw new TypeError(`[vitehub] VITEHUB_SECRET must be at least ${viteHubSecretMinimumLength} characters. Generate one with \`openssl rand -base64 32\`.`)
  }
  if (!purpose) throw new TypeError("[vitehub] A derived secret requires a purpose.")
  const key = await globalThis.crypto.subtle.importKey("raw", secretEncoder.encode(root), "HKDF", false, ["deriveBits"])
  return hex(await globalThis.crypto.subtle.deriveBits({
    hash: "SHA-256",
    info: secretEncoder.encode(purpose),
    name: "HKDF",
    salt: secretEncoder.encode(viteHubSecretSalt),
  }, key, 256))
}

/** How a webhook signs its body with HMAC-SHA256. GitHub is `{ prefix: "sha256=" }`. */
export interface ViteHubHmacSignatureFormat {
  /** The text before the digest in the header, such as `sha256=`. Default: none. */
  prefix?: string
  /** The digest encoding. Default: `hex`, compared without case. */
  encoding?: "hex" | "base64"
  /** How the secret becomes the key. `base64` decodes it, and a secret that does not decode fails. Default: `utf8`. */
  secretEncoding?: "utf8" | "base64"
}

/** The format of GitHub's `X-Hub-Signature-256` header. */
export const githubHmacSignatureFormat: ViteHubHmacSignatureFormat = Object.freeze({ prefix: "sha256=" })

/** Decodes a canonical base64 key. Returns `undefined` for malformed or empty input, so verification fails closed. */
export function decodeViteHubBase64Key(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) return undefined
  let binary: string
  try {
    binary = atob(value)
  }
  catch {
    return undefined
  }
  if (!binary.length || btoa(binary).replace(/=+$/, "") !== value.replace(/=+$/, "")) return undefined
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

/** The HMAC-SHA256 of `value`. It uses Web Crypto, so it also runs in Worker runtimes. */
export async function viteHubHmacSha256(key: string | Uint8Array<ArrayBuffer>, value: string | ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const raw = typeof key === "string" ? secretEncoder.encode(key) : key
  const data = typeof value === "string" ? secretEncoder.encode(value) : value
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", raw, { hash: "SHA-256", name: "HMAC" }, false, ["sign"])
  return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", cryptoKey, data))
}

/**
 * Checks a webhook signature header of the form `<prefix><digest>`, where the digest is the HMAC-SHA256 of the raw
 * body. It compares in constant time. Returns `false` for a missing header, an empty secret, or a key that does not
 * decode. Pass `githubHmacSignatureFormat` for GitHub's `X-Hub-Signature-256`. It uses no Node API.
 */
export async function verifyViteHubHmacSignature(
  secret: string | null | undefined,
  header: string | null | undefined,
  body: string | ArrayBuffer | Uint8Array<ArrayBuffer>,
  format: ViteHubHmacSignatureFormat = {},
): Promise<boolean> {
  const prefix = format.prefix ?? ""
  if (!secret || !header || !header.startsWith(prefix)) return false
  const key = format.secretEncoding === "base64" ? decodeViteHubBase64Key(secret) : secretEncoder.encode(secret)
  if (!key) return false
  const digest = await viteHubHmacSha256(key, body)
  const received = header.slice(prefix.length)
  if (format.encoding === "base64") return isViteHubSecretEqual(received, btoa(String.fromCharCode(...digest)))
  return isViteHubSecretEqual(received.toLowerCase(), hex(digest.buffer))
}
