import { normalizeBlobOptions } from "./config.ts"
import { readEnv, trimmed } from "./internal/env.ts"

import type { BlobResolutionInput } from "./config.ts"
import type { BlobModuleOptions, ResolvedBlobModuleOptions } from "./types.ts"

export const BLOB_VITE_PLUGIN_NAME = "@vitehub/blob/vite"
export const BLOB_VIRTUAL_CONFIG_ID = "virtual:@vitehub/blob/config"

export interface BlobViteRuntimeConfig {
  blob: false | ResolvedBlobModuleOptions
  hosting?: string
}

function resolveHosting(input: BlobResolutionInput): string | undefined {
  const env = input.env || process.env
  return trimmed(input.hosting) ?? readEnv(env, "NITRO_PRESET", "VITEHUB_HOSTING")
}

export function resolveBlobViteConfig(
  blob: BlobModuleOptions | undefined,
  input: BlobResolutionInput = {},
): BlobViteRuntimeConfig {
  const env = input.env || process.env
  const hosting = resolveHosting(input)
  const resolved = normalizeBlobOptions(blob, { env, hosting })
  return { blob: resolved ?? false, hosting }
}
