import { readEnv, trimmed } from "@vite-hub/internal/env"

import { isMaskedBlobRuntimeValue } from "../config.ts"
import { getActiveCloudflareEnv } from "../runtime/state.ts"

export function runtimeValue(value: string | undefined, ...envNames: string[]): string | undefined {
  const current = trimmed(value)
  const env = getActiveCloudflareEnv() as Record<string, string | undefined> | undefined
    || (typeof process === "undefined" ? {} : process.env)
  return isMaskedBlobRuntimeValue(current) ? readEnv(env, ...envNames) : current
}
