import { createDatabaseEnvStore, listDatabaseEnvNamespaces } from "vite-hub/env/database"

import type { DatabaseEnvStore, EnvDatabase } from "vite-hub/env/database"

/**
 * Env values in a self-hosted Console. Whoever runs a Console can read the values that it stores, so it stores none
 * until its operator turns them on. The hosted Console at console.vitehub.dev never turns them on.
 */
export const envValuesVariable = "VITEHUB_CONSOLE_ENV_VALUES"

/** The 32-byte AES-GCM key of the stored values: 64 hex digits, or base64. It is not `VITEHUB_CONSOLE_SECRET`. */
export const envKeyVariable = "VITEHUB_CONSOLE_ENV_KEY"

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
  | { state: "on", key: Uint8Array }
  | { state: "misconfigured", problem: string }

export const envValuesOffMessage = `This Console does not store env values. Keep them in .env.<stage> files and on the host. A self-hosted Console stores them when its operator sets ${envValuesVariable}=1 and ${envKeyVariable}. The hosted Console at console.vitehub.dev never stores values.`

/** A key as 64 hex digits, or as base64 or base64url of 32 bytes, such as `openssl rand -base64 32`. */
export function parseEnvKey(text: string): Uint8Array | undefined {
  const value = text.trim()
  if (/^[\da-f]{64}$/i.test(value)) return Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16))
  if (!/^[\w+/-]{43}=?$/.test(value)) return undefined
  const binary = atob(value.replace(/=$/, "").replace(/-/g, "+").replace(/_/g, "/"))
  return binary.length === 32 ? Uint8Array.from(binary, character => character.charCodeAt(0)) : undefined
}

/** Read the switch and the key. Values stay off unless the switch is exactly `1` or `true`. */
export function readConsoleEnvConfig(env: Record<string, string | undefined>): ConsoleEnvConfig {
  const flag = env[envValuesVariable]?.trim()
  if (flag !== "1" && flag !== "true") return { state: "off" }
  const text = env[envKeyVariable]
  if (!text?.trim()) return { problem: `${envValuesVariable} is on, but ${envKeyVariable} is not set. Create a key with \`openssl rand -base64 32\` and keep a copy outside the database.`, state: "misconfigured" }
  const key = parseEnvKey(text)
  if (!key) return { problem: `${envKeyVariable} must be 32 bytes as 64 hex digits or base64. Create one with \`openssl rand -base64 32\`.`, state: "misconfigured" }
  return { key, state: "on" }
}

/** The values of one project: one Env database namespace for each stage, `<project>:<stage>`. */
export interface ConsoleEnvValues {
  /** The default stages and every stage that holds a value, sorted. */
  stages(): Promise<string[]>
  stage(stage: string): DatabaseEnvStore
}

export function consoleEnvValues(db: EnvDatabase, key: Uint8Array, projectId: string): ConsoleEnvValues {
  const prefix = `${projectId}:`
  return {
    async stages() {
      const stored = (await listDatabaseEnvNamespaces(db, prefix)).map(namespace => namespace.slice(prefix.length))
      return [...new Set([...defaultEnvStages, ...stored])].sort((a, b) => stageRank(a) - stageRank(b) || a.localeCompare(b))
    },
    stage: stage => createDatabaseEnvStore({ db, encryptionKey: key, namespace: `${prefix}${stage}` }),
  }
}

function stageRank(stage: string): number {
  const index = defaultEnvStages.indexOf(stage)
  return index === -1 ? defaultEnvStages.length : index
}

