import { hkdfSync } from "node:crypto"

import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { readViteHubSecret, viteHubSecretMinimumLength, viteHubSecretSalt } from "@vite-hub/internal/secret"

import { authErrorDiagnostics } from "./error-diagnostics.ts"

/** The `deriveSecret()` purpose of the Better Auth secret. `vitehub secret derive vitehub:auth` prints it. */
export const authSecretPurpose = "vitehub:auth"

// Better Auth reads these itself, so any of them keeps the app's own secret.
const betterAuthSecretNames = ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "AUTH_SECRET"] as const

let derived: { root: string, secret: string } | undefined

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * The Better Auth secret derived from the root app secret (`VITEHUB_SECRET`, or `NUXT_APP_SECRET`), equal to
 * `deriveSecret("vitehub:auth")`. Returns `undefined` when the environment sets a Better Auth secret or no root secret.
 * It is synchronous because Better Auth reads its options synchronously.
 */
export function deriveAuthSecret(event?: unknown): string | undefined {
  const env: Record<string, unknown> = { ...globalThis.process?.env, ...getCloudflareEnv(event) }
  if (betterAuthSecretNames.some(name => env[name])) return undefined
  const root = readViteHubSecret(env)
  if (!root) return undefined
  if (root.length < viteHubSecretMinimumLength) {
    throw authErrorDiagnostics.AUTH_R0016({ message: `[vitehub] VITEHUB_SECRET must be at least ${viteHubSecretMinimumLength} characters. Generate one with \`openssl rand -base64 32\`.` })
  }
  if (derived?.root !== root) derived = { root, secret: hex(hkdfSync("sha256", root, viteHubSecretSalt, authSecretPurpose, 32)) }
  return derived.secret
}
