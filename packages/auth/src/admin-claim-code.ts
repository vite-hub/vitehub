// No Better Auth import here: `vitehub auth claim` loads this module.

/** The variable with the SHA-256 of a one-time claim code, written by `vitehub auth claim`. */
export const adminClaimVariable = "VITEHUB_ADMIN_CLAIM"

/** Crockford Base32 without I, L, O, and U, so a person can read the code aloud without mistakes. */
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** A random code of 16 characters (80 bits), in groups of four. */
export function createAdminClaimCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  // 256 is a multiple of 32, so each character is equally likely.
  const characters = [...bytes].map(byte => alphabet[byte % alphabet.length]).join("")
  return [0, 4, 8, 12].map(start => characters.slice(start, start + 4)).join("-")
}

/** The `VITEHUB_ADMIN_CLAIM` value of a code. Case, spaces, and dashes do not change it. */
export async function adminClaimHash(code: string): Promise<string> {
  const normalized = code.toUpperCase().replace(/[^0-9A-Z]/g, "")
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized)))
  return `sha256:${[...digest].map(byte => byte.toString(16).padStart(2, "0")).join("")}`
}
