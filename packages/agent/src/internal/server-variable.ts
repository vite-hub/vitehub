import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

/**
 * The value of a server variable: Node's `process.env`, the Cloudflare bindings, and the values of `setEnv()` in app
 * tests. A webhook `secret` string names one, as in Webhooks.
 */
export function serverVariable(name: string): string | undefined {
  const env: Record<string, unknown> = {
    ...(typeof process === "object" && process?.env ? process.env : {}),
    ...getActiveCloudflareEnv(),
    ...getViteHubTestMode()?.env,
  }
  const value = env[name]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
