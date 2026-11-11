import { isWebContainer } from "@vite-hub/web-container/env"

import type { BetterAuthOptions } from "better-auth"

type PasswordOptions = NonNullable<NonNullable<BetterAuthOptions["emailAndPassword"]>["password"]>

// Better Auth's default scrypt parameters and `salt:key` hex format, so hashes move between hosts.
const scryptOptions = { N: 16384, r: 16, p: 1, dkLen: 64, maxmem: 128 * 16384 * 16 * 2 }

let reported = false

async function scryptKey(password: string, salt: string): Promise<string> {
  const { scryptAsync } = await import("@noble/hashes/scrypt.js")
  const { bytesToHex } = await import("@noble/hashes/utils.js")
  return bytesToHex(await scryptAsync(password.normalize("NFKC"), salt, scryptOptions))
}

/** Hashes a password like Better Auth's default hasher, with the pure JavaScript scrypt of `@noble/hashes`. */
export async function hashPasswordWithNoble(password: string): Promise<string> {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")
  return `${salt}:${await scryptKey(password, salt)}`
}

/** Verifies a hash that Better Auth's default hasher or `hashPasswordWithNoble()` made. */
export async function verifyPasswordWithNoble({ hash, password }: { hash: string, password: string }): Promise<boolean> {
  const [salt, key] = hash.split(":")
  // Internal invariant: same error as the default verifier of `@better-auth/utils`, which this one replaces.
  if (!salt || !key) throw new Error("Invalid password hash")
  const derived = await scryptKey(password, salt)
  return derived === key
}

/**
 * A WebContainer has `node:crypto` `scrypt`, but every call throws `TypeError: run is not a function`.
 * There, Auth gives Better Auth a pure JavaScript scrypt with the same output. Other hosts keep Better Auth's default.
 * A `hash` or `verify` that the Auth Definition sets always wins.
 */
export function withPasswordHasher<TOptions extends Pick<BetterAuthOptions, "emailAndPassword">>(options: TOptions): TOptions {
  if (!isWebContainer()) return options
  const emailAndPassword = options.emailAndPassword
  const password: PasswordOptions = emailAndPassword?.password ?? {}
  if (password.hash && password.verify) return options
  if (!reported) {
    reported = true
    console.info("[vitehub] Auth hashes passwords with the scrypt of @noble/hashes, because node:crypto scrypt does not work in a WebContainer. Hashes stay compatible with other hosts.")
  }
  return {
    ...options,
    emailAndPassword: {
      enabled: false,
      ...emailAndPassword,
      password: { ...password, hash: password.hash ?? hashPasswordWithNoble, verify: password.verify ?? verifyPasswordWithNoble },
    },
  }
}
