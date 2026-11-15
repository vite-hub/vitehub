import type { DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"

import { upstashTokenEnvNames, upstashUrlEnvNames } from "./integrations/upstash.ts"

import type { ResolvedKVModuleOptions, ResolvedKVStoreConfig } from "./types.ts"

const owners = ["kv"]
const maskedRuntimeValue = "********"

function entry(names: readonly string[]): DeploymentEnvEntry {
  return { names, required: true, secret: true, hasDefault: false, owners }
}

function storeEntries(store: ResolvedKVStoreConfig): DeploymentEnvEntry[] {
  if (store.driver === "upstash") {
    // A masked value is read at runtime from the Vercel or Upstash names. A literal value reads no variable.
    return [
      ...store.url === maskedRuntimeValue ? [entry(upstashUrlEnvNames)] : [],
      ...store.token === maskedRuntimeValue ? [entry(upstashTokenEnvNames)] : [],
    ]
  }
  // `env:NAME` reads that variable when the store starts. A literal URL reads none.
  if (store.driver === "redis" && store.url.startsWith("env:")) return [entry([store.url.slice("env:".length)])]
  return []
}

/**
 * The variables that the KV stores read on the deployed host: the Upstash REST URL and token, and the Redis URL
 * variable. Cloudflare KV, Database, Deno KV, and `fs-lite` stores read none.
 */
export function kvDeploymentEnv(config: false | ResolvedKVModuleOptions): DeploymentEnvEntry[] {
  if (!config) return []
  return Object.values(config.stores ?? { default: config.store }).flatMap(storeEntries)
}
