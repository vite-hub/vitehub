import { hkdfSync } from "node:crypto"
import { BetterAuthError } from "better-auth"

import { readViteHubSecret, viteHubSecretMinimumLength, viteHubSecretSalt } from "@vite-hub/internal/secret"

import { authErrorDiagnostics } from "./error-diagnostics.ts"
import type { AuthRuntimeOptions } from "./types.ts"

/** The `deriveSecret()` purpose of the Better Auth secret. `vitehub secret derive vitehub:auth` prints it. */
export const authSecretPurpose = "vitehub:auth"

const publicDefaultSecret = "better-auth-secret-12345678901234567890"

function parseVersionedSecrets(value: string | undefined) {
  return value?.split(",").map((entry, index) => {
    const separator = entry.indexOf(":")
    const version = Number.parseInt(entry.slice(0, separator), 10)
    const secret = entry.slice(separator + 1).trim()
    if (separator === -1 || !Number.isInteger(version) || version < 0 || !secret) {
      throw new BetterAuthError(`Invalid BETTER_AUTH_SECRETS entry at position ${index + 1}. Expected a non-negative version and a non-empty secret: "<version>:<secret>".`)
    }
    return { version, value: secret }
  })
}

export function resolveAuthSecrets(
  options: Pick<AuthRuntimeOptions, "secret" | "secrets">,
  bindings: Record<string, unknown> | undefined,
  development: boolean,
) {
  const env = globalThis.process?.env
  const readEnvSecret = (name: "BETTER_AUTH_SECRET" | "BETTER_AUTH_SECRETS" | "AUTH_SECRET") => {
    const binding = bindings?.[name]
    return (typeof binding === "string" && binding) || env?.[name] || undefined
  }
  const secrets = options.secrets ?? parseVersionedSecrets(readEnvSecret("BETTER_AUTH_SECRETS"))
  const legacySecret = options.secret || readEnvSecret("BETTER_AUTH_SECRET") || readEnvSecret("AUTH_SECRET")
  const keepDevelopmentDefault = development && (Object.hasOwn(options, "secret") || Object.hasOwn(options, "secrets"))
  const secret = legacySecret ?? (secrets || keepDevelopmentDefault ? undefined : deriveAuthSecret({ ...env, ...bindings }))
  const secretMissing = !development && (
    (!secret && !secrets) || secret === publicDefaultSecret || secrets?.some(key => key.value === publicDefaultSecret) === true
  )
  return { secret, secrets, secretMissing }
}

let derived: { root: string, secret: string } | undefined

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function deriveAuthSecret(environment: Record<string, unknown>): string | undefined {
  const root = readViteHubSecret(environment)
  if (!root) return undefined
  if (root.length < viteHubSecretMinimumLength) {
    throw authErrorDiagnostics.AUTH_R0016({ message: `[vitehub] VITEHUB_SECRET must be at least ${viteHubSecretMinimumLength} characters. Generate one with \`openssl rand -base64 32\`.` })
  }
  if (derived?.root !== root) derived = { root, secret: hex(hkdfSync("sha256", root, viteHubSecretSalt, authSecretPurpose, 32)) }
  return derived.secret
}
