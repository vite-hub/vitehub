import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import { cleanProviderOutputConfig, writeProviderOutputConfig } from "./provider-output-config.ts"
import { toSafeAppName } from "./user-entry.ts"

import type { ProviderOutputConfigOwnership } from "./provider-output-config.ts"

// Node compatibility must also be enabled by date when Nitro emits nodejs_compat_v2 alone.
export const defaultCloudflareCompatibilityDate = "2026-10-01"
export const cloudflareRuntimeExternal = "cloudflare:*"

interface CloudflareWranglerConfigOptions {
  outputRoot?: string
  rootDir: string
  wranglerConfig?: object
  wranglerConfigDefaults?: object
  wranglerConfigOwnership?: ProviderOutputConfigOwnership
}

export function createDefaultCloudflareOutputRoot(rootDir: string): string {
  return resolve(rootDir, "dist", toSafeAppName(rootDir))
}

export async function writeCloudflareWranglerConfig(options: CloudflareWranglerConfigOptions): Promise<void> {
  const outputRoot = options.outputRoot ?? createDefaultCloudflareOutputRoot(options.rootDir)
  const configFile = resolve(outputRoot, "wrangler.json")
  if (!options.wranglerConfig) {
    await cleanProviderOutputConfig(configFile, options.wranglerConfigOwnership ?? {})
    return
  }

  await mkdir(outputRoot, { recursive: true })
  await writeProviderOutputConfig(
    configFile,
    options.wranglerConfig,
    options.wranglerConfigOwnership,
    { defaults: options.wranglerConfigDefaults, removeIfEmpty: true },
  )
}
