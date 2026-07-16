import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import { cleanProviderOutputConfig, writeProviderOutputConfig } from "./provider-output-config.ts"
import { toSafeAppName } from "./user-entry.ts"

export const defaultCloudflareCompatibilityDate = "2026-04-20"

interface CloudflareWranglerConfigOptions {
  wranglerArrayOwnedValues?: Record<string, unknown[]>
  outputRoot?: string
  rootDir: string
  wranglerArrayMergeKeys?: Record<string, string>
  wranglerConfig?: object
  wranglerConfigKeys?: string[]
}

export function createDefaultCloudflareOutputRoot(rootDir: string): string {
  return resolve(rootDir, "dist", toSafeAppName(rootDir))
}

function createConfigOwnership(options: CloudflareWranglerConfigOptions) {
  const arrays = Object.fromEntries(Object.entries(options.wranglerArrayMergeKeys ?? {}).map(([field, key]) => [field, {
    key,
    values: options.wranglerArrayOwnedValues?.[field],
  }]))
  return { arrays, keys: options.wranglerConfigKeys }
}

export async function writeCloudflareWranglerConfig(options: CloudflareWranglerConfigOptions): Promise<void> {
  const outputRoot = options.outputRoot ?? createDefaultCloudflareOutputRoot(options.rootDir)
  const configFile = resolve(outputRoot, "wrangler.json")
  if (!options.wranglerConfig) {
    await cleanProviderOutputConfig(configFile, createConfigOwnership(options))
    return
  }

  await mkdir(outputRoot, { recursive: true })
  await writeProviderOutputConfig(
    configFile,
    options.wranglerConfig,
    createConfigOwnership(options),
    { removeIfEmpty: true },
  )
}
