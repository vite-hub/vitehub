import { readEnv, trimmed } from "@vite-hub/internal/env"

import { isMaskedBlobRuntimeValue, readBlobSecretEnv } from "../config.ts"
import { blobRuntimeEnv, getActiveCloudflareEnv } from "../runtime/state.ts"

import type { CloudflareR2Jurisdiction, ResolvedCloudflareR2BlobStoreConfig } from "../types.ts"

export function runtimeValue(value: string | undefined, ...envNames: string[]): string | undefined {
  const current = trimmed(value)
  const env = getActiveCloudflareEnv() as Record<string, string | undefined> | undefined
    || (typeof process === "undefined" ? {} : process.env)
  return isMaskedBlobRuntimeValue(current) ? readEnv(env, ...envNames) : current
}

const R2_CREDENTIAL_ENV = {
  accessKeyId: ["R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID"],
  secretAccessKey: ["R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_SECRET_ACCESS_KEY"],
} as const

/**
 * An R2 HTTP credential. The binding does not use it, so the driver reads it only for HTTP access and signed URLs.
 * When the config read it from an env variable, only that variable is read, and a missing variable fails with `BLOB_R0044`.
 */
export function r2Credential(options: ResolvedCloudflareR2BlobStoreConfig, option: keyof typeof R2_CREDENTIAL_ENV): string | undefined {
  const name = options.secretEnv?.[option]
  return name ? readBlobSecretEnv(blobRuntimeEnv(), name, option, options.driver) : runtimeValue(options[option], ...R2_CREDENTIAL_ENV[option])
}

/** Jurisdictional R2 buckets answer only on their own S3 API host. */
export function r2S3Endpoint(accountId: string, jurisdiction: CloudflareR2Jurisdiction | undefined): string {
  return jurisdiction
    ? `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`
    : `https://${accountId}.r2.cloudflarestorage.com`
}
