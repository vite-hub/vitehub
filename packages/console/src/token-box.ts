/**
 * The Console keeps the private signing key of each project link, so it can sign calls to the project's Operations
 * endpoint. It stores the key encrypted with AES-GCM. The encryption key comes from `VITEHUB_CONSOLE_SECRET`, and the
 * project id is the associated data, so a sealed key copied to another project row does not open.
 */

export const consoleSecretVariable = "VITEHUB_CONSOLE_SECRET"

/** A shorter secret is easy to guess. `openssl rand -hex 32` makes one of 64 characters. */
const minimumSecretLength = 32
const sealedPrefix = "v1."
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64url(value: string): Uint8Array | undefined {
  if (!/^[\w-]*$/.test(value)) return undefined
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

/** Check the secret of a Console server. Returns the message to show when it cannot be used. */
export function consoleSecretProblem(secret: string | undefined): string | undefined {
  if (!secret?.trim()) return `Set ${consoleSecretVariable} on the Console server. Create one with \`openssl rand -hex 32\`.`
  if (secret.trim().length < minimumSecretLength) return `${consoleSecretVariable} has fewer than ${minimumSecretLength} characters. Create one with \`openssl rand -hex 32\`.`
  return undefined
}

async function boxKey(secret: string) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret.trim()), "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", info: encoder.encode("vitehub-console project key v1"), salt: new Uint8Array(32) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

/** Encrypt the private key of one project. The result is `v1.<iv>.<ciphertext>`, both in base64url. */
export async function sealProjectKey(secret: string, projectId: string, privateKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(projectId) }, await boxKey(secret), encoder.encode(privateKey))
  return `${sealedPrefix}${base64url(iv)}.${base64url(new Uint8Array(sealed))}`
}

/**
 * Decrypt the private key of one project. Returns `undefined` when the value was sealed with another secret, for another
 * project, or was changed.
 */
export async function openProjectKey(secret: string, projectId: string, sealed: string): Promise<string | undefined> {
  if (!sealed.startsWith(sealedPrefix)) return undefined
  const [ivText, dataText, extra] = sealed.slice(sealedPrefix.length).split(".")
  const iv = ivText === undefined ? undefined : fromBase64url(ivText)
  const data = dataText === undefined ? undefined : fromBase64url(dataText)
  if (extra !== undefined || iv?.length !== 12 || !data) return undefined
  try {
    const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(projectId) }, await boxKey(secret), data)
    return decoder.decode(opened)
  }
  catch {
    return undefined
  }
}
