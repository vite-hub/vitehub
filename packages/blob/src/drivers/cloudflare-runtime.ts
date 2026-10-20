import { readEnv, trimmed } from "@vite-hub/internal/env"

import { isMaskedBlobRuntimeValue } from "../config.ts"
import { getActiveCloudflareEnv } from "../runtime/state.ts"

import type { CloudflareR2Jurisdiction } from "../types.ts"

export function runtimeValue(value: string | undefined, ...envNames: string[]): string | undefined {
  const current = trimmed(value)
  const env = getActiveCloudflareEnv() as Record<string, string | undefined> | undefined
    || (typeof process === "undefined" ? {} : process.env)
  return isMaskedBlobRuntimeValue(current) ? readEnv(env, ...envNames) : current
}

/** Jurisdictional R2 buckets answer only on their own S3 API host. */
export function r2S3Endpoint(accountId: string, jurisdiction: CloudflareR2Jurisdiction | undefined): string {
  return jurisdiction
    ? `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`
    : `https://${accountId}.r2.cloudflarestorage.com`
}
