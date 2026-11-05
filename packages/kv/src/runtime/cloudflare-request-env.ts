import { installCloudflareRequestEnv } from "@vite-hub/internal/runtime/cloudflare-env"

/**
 * Nitro middleware for Cloudflare KV. A Cloudflare KV store reads its binding from the active env, and only the request
 * carries that env in `vite dev`, so the middleware installs it before the route runs.
 */
export default function vitehubKVCloudflareRequestEnv(event: unknown): void {
  installCloudflareRequestEnv(event)
}
