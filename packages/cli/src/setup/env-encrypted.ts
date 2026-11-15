import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { parseEnv } from "node:util"

import { join } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "./envelope.ts"

/** dotenvx marks an encrypted value with this prefix. */
const prefix = "encrypted:"

/** The file where dotenvx writes private keys. It must never be in git. */
export const envKeysFile = ".env.keys"

export function isEncryptedEnvValue(value: string): boolean {
  return value.startsWith(prefix)
}

/**
 * The name of the private key for `file`, as dotenvx names it: the `DOTENV_PUBLIC_KEY*` name in the file wins,
 * then `.env` takes `DOTENV_PRIVATE_KEY` and `.env.<a>[.<b>]` takes `DOTENV_PRIVATE_KEY_<A>[_<B>]`.
 */
export function envPrivateKeyName(file: string, source: string): string {
  const declared = Object.keys(parseEnv(source)).find(name => name.startsWith("DOTENV_PUBLIC_KEY"))
  if (declared) return declared.replace("DOTENV_PUBLIC_KEY", "DOTENV_PRIVATE_KEY")
  const parts = basename(file).toLowerCase().split(".").slice(2)
  return parts.length ? `DOTENV_PRIVATE_KEY_${parts.slice(0, 2).join("_").toUpperCase()}` : "DOTENV_PRIVATE_KEY"
}

export interface EncryptedEnvValue {
  name: string
  /** The env file that the value came from. */
  file: string
  value: string
}

/**
 * Decrypts dotenvx values with the private key of each file, from `env` first and then from `.env.keys`.
 * A key may list several private keys separated by commas, as dotenvx allows during a rotation.
 * Returns the plaintext by name, and the private keys it used so that output can redact them.
 */
export async function decryptEnvValues(root: string, items: readonly EncryptedEnvValue[], env: NodeJS.ProcessEnv): Promise<{ values: Map<string, string>, keys: string[] }> {
  const values = new Map<string, string>()
  const keys = new Set<string>()
  if (!items.length) return { keys: [], values }
  const keysPath = join(root, envKeysFile)
  const keysFile = existsSync(keysPath) ? parseEnv(await readFile(keysPath, "utf8")) : {}
  const { decrypt } = await import("@dotenvx/primitives")
  const byFile = new Map<string, EncryptedEnvValue[]>()
  for (const item of items) byFile.set(item.file, [...byFile.get(item.file) ?? [], item])
  for (const [file, group] of byFile) {
    const keyName = envPrivateKeyName(file, await readFile(join(root, file), "utf8"))
    const names = group.map(item => item.name).join(", ")
    const candidates = (env[keyName] || keysFile[keyName] || "").split(",").map(key => key.trim()).filter(Boolean)
    if (!candidates.length) {
      throw new SetupFailure(cliErrorDiagnostics.SETUP_ENV_PRIVATE_KEY_MISSING({ file, key: keyName, names }), setupExitCodes.inputNeeded, { missing: [{ field: keyName }] })
    }
    for (const key of candidates) keys.add(key)
    for (const item of group) {
      const errors: string[] = []
      for (const key of candidates) {
        try {
          values.set(item.name, decrypt(key, item.value))
          break
        }
        catch (error: unknown) {
          const code = error instanceof Error ? Reflect.get(error, "code") : undefined
          errors.push(typeof code === "string" ? code : "DECRYPTION_FAILED")
        }
      }
      if (!values.has(item.name)) throw new SetupFailure(cliErrorDiagnostics.SETUP_ENV_DECRYPT_FAILED({ file, key: keyName, name: item.name, reason: errors.at(-1) }), setupExitCodes.error)
    }
  }
  return { keys: [...keys], values }
}
