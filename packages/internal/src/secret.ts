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
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Host env records are untrusted values.
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
