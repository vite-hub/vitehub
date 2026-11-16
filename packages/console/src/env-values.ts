import { createDatabaseEnvStore, listDatabaseEnvNamespaces } from "vite-hub/env/database"

import type { DatabaseEnvStore, EnvDatabase } from "vite-hub/env/database"

/**
 * Env values in a self-hosted Console. Whoever runs a Console can read the values that it stores, so it stores none
 * until its operator turns them on. The hosted Console at console.vitehub.dev never turns them on.
 */
export const envValuesVariable = "VITEHUB_CONSOLE_ENV_VALUES"

/** The 32-byte AES-GCM key of the stored values: 64 hex digits, or base64. It is not `VITEHUB_CONSOLE_SECRET`. */
export const envKeyVariable = "VITEHUB_CONSOLE_ENV_KEY"

/**
 * The keyring for a rotation, in place of `VITEHUB_CONSOLE_ENV_KEY`: comma-separated keys, the current key first, then
 * the previous keys. New writes use the first key. A value that a previous key sealed still reads.
 */
export const envKeysVariable = "VITEHUB_CONSOLE_ENV_KEYS"

/** Every project has these stages. Other stages appear when they hold a value. */
export const defaultEnvStages: readonly string[] = ["production", "preview"]

/** A stage is also the suffix of a `.env.<stage>` file, so it stays a plain file name. */
export const envStagePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/

/** The names that a shell and a `.env` file accept. */
export const envNamePattern = /^[A-Z_a-z]\w{0,255}$/

/** 64 KiB, larger than any real env value. */
export const maxEnvValueLength = 65_536

export type ConsoleEnvConfig =
  | { state: "off" }
  | { state: "on", keys: Uint8Array[] }
  | { state: "misconfigured", problem: string }

export const envValuesOffMessage = `This Console does not store env values. Keep them in .env.<stage> files and on the host. A self-hosted Console stores them when its operator sets ${envValuesVariable}=1 and ${envKeyVariable} or ${envKeysVariable}. The hosted Console at console.vitehub.dev never stores values.`

/** A key as 64 hex digits, or as base64 or base64url of 32 bytes, such as `openssl rand -base64 32`. */
export function parseEnvKey(text: string): Uint8Array | undefined {
  const value = text.trim()
  if (/^[\da-f]{64}$/i.test(value)) return Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16))
  if (!/^[\w+/-]{43}=?$/.test(value)) return undefined
  const binary = atob(value.replace(/=$/, "").replace(/-/g, "+").replace(/_/g, "/"))
  return binary.length === 32 ? Uint8Array.from(binary, character => character.charCodeAt(0)) : undefined
}

/**
 * Read the switch and the keyring. Values stay off unless the switch is exactly `1` or `true`. The keyring is
 * `VITEHUB_CONSOLE_ENV_KEYS`, or the one key of `VITEHUB_CONSOLE_ENV_KEY`. Both at once is a mistake: the Console
 * would have to guess which one is current.
 */
export function readConsoleEnvConfig(env: Record<string, string | undefined>): ConsoleEnvConfig {
  const flag = env[envValuesVariable]?.trim()
  if (flag !== "1" && flag !== "true") return { state: "off" }
  const one = env[envKeyVariable]?.trim()
  const list = env[envKeysVariable]?.trim()
  if (one && list) return { problem: `Set ${envKeysVariable} or ${envKeyVariable}, not both. During a rotation, ${envKeysVariable} holds the new key first, then the old key.`, state: "misconfigured" }
  if (!one && !list) return { problem: `${envValuesVariable} is on, but ${envKeyVariable} is not set. Create a key with \`openssl rand -base64 32\` and keep a copy outside the database.`, state: "misconfigured" }
  const variable = list ? envKeysVariable : envKeyVariable
  const texts = list ? list.split(",") : [one!]
  const keys: Uint8Array[] = []
  for (const [index, text] of texts.entries()) {
    const key = parseEnvKey(text)
    if (!key) return { problem: `${variable} must hold 32-byte keys as 64 hex digits or base64${list ? `, separated by commas. Key ${index + 1} is not one` : ""}. Create one with \`openssl rand -base64 32\`.`, state: "misconfigured" }
    keys.push(key)
  }
  return { keys, state: "on" }
}

/** The values of one project: one Env database namespace for each stage, `<project>:<stage>`. */
export interface ConsoleEnvValues {
  /** The default stages and every stage that holds a value, sorted. */
  stages(): Promise<string[]>
  stage(stage: string): DatabaseEnvStore
}

export function consoleEnvValues(db: EnvDatabase, keys: Uint8Array[], projectId: string): ConsoleEnvValues {
  const prefix = `${projectId}:`
  return {
    async stages() {
      const stored = (await listDatabaseEnvNamespaces(db, prefix)).map(namespace => namespace.slice(prefix.length))
      return [...new Set([...defaultEnvStages, ...stored])].sort((a, b) => stageRank(a) - stageRank(b) || a.localeCompare(b))
    },
    stage: stage => createDatabaseEnvStore({ db, encryptionKeys: keys, namespace: `${prefix}${stage}` }),
  }
}

/** The result of `rotateConsoleEnvValues()`: the stages of every project, and the values that it sealed again. */
export interface ConsoleEnvRotation {
  namespaces: number
  rotated: number
  skipped: number
}

/**
 * Seal each stored value of every project and stage with the current key, the first of `keys`. A value that the current
 * key sealed stays as it is. Revisions stay the same, and a value that a write replaces during the rotation keeps the
 * write. When it is done, no value needs the previous keys.
 */
export async function rotateConsoleEnvValues(db: EnvDatabase, keys: Uint8Array[]): Promise<ConsoleEnvRotation> {
  const result: ConsoleEnvRotation = { namespaces: 0, rotated: 0, skipped: 0 }
  for (const namespace of await listDatabaseEnvNamespaces(db, "")) {
    const { rotated, skipped } = await createDatabaseEnvStore({ db, encryptionKeys: keys, namespace }).rotate()
    result.namespaces++
    result.rotated += rotated
    result.skipped += skipped
  }
  return result
}

function stageRank(stage: string): number {
  const index = defaultEnvStages.indexOf(stage)
  return index === -1 ? defaultEnvStages.length : index
}

