import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { glob } from "tinyglobby"

/** A Redis URL that NuxtHub's KV read on its own, and where the codemod found it. */
export interface RedisKVSource {
  variable: "REDIS_URL" | "KV_URL"
  file: string
}

const upstashPairs = [["KV_REST_API_URL", "KV_REST_API_TOKEN"], ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]] as const

/**
 * NuxtHub selects Redis for `hub.kv: true` when the build has `REDIS_URL`, or a `KV_URL` that starts with `rediss://`,
 * and Upstash REST variables come first. ViteHub never selects Redis on its own, so the codemod looks for the same
 * variables in the app's env files and Nuxt config. It keeps no values.
 */
export async function findRedisKVSource(cwd: string, configFile: string, configCode: string): Promise<RedisKVSource | undefined> {
  const values = new Map<string, { file: string, value: string }>()
  for (const file of (await glob([".env", ".env.*"], { cwd, dot: true })).sort()) {
    const code = await readFile(join(cwd, file), "utf8")
    for (const match of code.matchAll(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*["']?(.*)$/gm)) {
      if (!values.has(match[1]!)) values.set(match[1]!, { file, value: match[2]! })
    }
  }
  if (upstashPairs.some(names => names.every(name => values.has(name)))) return
  const redisUrl = values.get("REDIS_URL")
  if (redisUrl) return { variable: "REDIS_URL", file: redisUrl.file }
  const kvUrl = values.get("KV_URL")
  if (kvUrl?.value.startsWith("rediss://")) return { variable: "KV_URL", file: kvUrl.file }
  if (/\bREDIS_URL\b/.test(configCode)) return { variable: "REDIS_URL", file: configFile }
}
