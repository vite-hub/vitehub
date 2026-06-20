import { normalizeBlobOptions } from "./config.ts"
import { readEnv, trimmed } from "@vite-hub/internal/env"

import type { BlobResolutionInput } from "./config.ts"
import type { BlobModuleOptions, ResolvedBlobModuleOptions } from "./types.ts"

export const BLOB_VITE_PLUGIN_NAME = "@vite-hub/blob/vite"
export const BLOB_VIRTUAL_CONFIG_ID = "#vitehub/blob/config"

export interface BlobViteRuntimeConfig {
  blob: false | ResolvedBlobModuleOptions
  hosting?: string
}

function resolveHosting(input: BlobResolutionInput): string | undefined {
  const env = input.env || process.env
  const explicit = trimmed(input.hosting)
  if (explicit) return explicit
  const vitehubHosting = readEnv(env, "VITEHUB_HOSTING")
  if (vitehubHosting) return vitehubHosting
  if (readEnv(env, "NETLIFY") || readEnv(env, "NETLIFY_DEV") || readEnv(env, "NETLIFY_LOCAL")) return "netlify"
  return undefined
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
