/**
 * The Console keeps the private signing key of each project link, so it can sign calls to the project's Operations
 * endpoint. It stores the key encrypted with AES-GCM. The encryption key comes from `VITEHUB_CONSOLE_SECRET`, and the
 * project id is the associated data, so a sealed key copied to another project row does not open.
 */

export const consoleSecretVariable = "VITEHUB_CONSOLE_SECRET"

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

/** What a sealed value holds. Each purpose derives its own key from the secret, so a value of one purpose never opens as another. */
export type ConsoleSealPurpose = "project key" | "mcp records"

async function boxKey(secret: string, purpose: ConsoleSealPurpose) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret.trim()), "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", info: encoder.encode(`vitehub-console ${purpose} v1`), salt: new Uint8Array(32) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

/**
 * Encrypt a value with a key that comes from `VITEHUB_CONSOLE_SECRET`. `context` is the associated data: the value opens
 * only with the same context, such as the row that holds it. The result is `v1.<iv>.<ciphertext>`, both in base64url.
 */
export async function sealConsoleValue(secret: string, purpose: ConsoleSealPurpose, context: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, await boxKey(secret, purpose), encoder.encode(value))
  return `${sealedPrefix}${base64url(iv)}.${base64url(new Uint8Array(sealed))}`
}

/** Decrypt a value of `sealConsoleValue()`. Returns `undefined` for another secret, purpose, or context, or a changed value. */
export async function openConsoleValue(secret: string, purpose: ConsoleSealPurpose, context: string, sealed: string): Promise<string | undefined> {
  if (!sealed.startsWith(sealedPrefix)) return undefined
  const [ivText, dataText, extra] = sealed.slice(sealedPrefix.length).split(".")
  const iv = ivText === undefined ? undefined : fromBase64url(ivText)
  const data = dataText === undefined ? undefined : fromBase64url(dataText)
  if (extra !== undefined || iv?.length !== 12 || !data) return undefined
  try {
    const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, await boxKey(secret, purpose), data)
    return decoder.decode(opened)
  }
  catch {
    return undefined
  }
}

/** Encrypt the private key of one project. The project id is the context. */
export function sealProjectKey(secret: string, projectId: string, privateKey: string): Promise<string> {
  return sealConsoleValue(secret, "project key", projectId, privateKey)
}

/**
 * Decrypt the private key of one project. Returns `undefined` when the value was sealed with another secret, for another
 * project, or was changed.
 */
export function openProjectKey(secret: string, projectId: string, sealed: string): Promise<string | undefined> {
  return openConsoleValue(secret, "project key", projectId, sealed)
}
