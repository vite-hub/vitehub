import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import { cleanProviderOutputConfig, writeProviderOutputConfig } from "./provider-output-config.ts"
import { toSafeAppName } from "./user-entry.ts"

import type { ProviderOutputConfigOwnership } from "./provider-output-config.ts"

export const defaultCloudflareCompatibilityDate = "2026-04-20"

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
