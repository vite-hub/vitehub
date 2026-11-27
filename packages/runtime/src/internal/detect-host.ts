import { detectHost as detectDeploymentHost } from "@vite-hub/internal/deployment"

import type { ViteHubHost } from "@vite-hub/internal/deployment"

/**
 * Returns the host that this code builds or runs on, or `undefined` when nothing names one.
 * It reads `VITEHUB_HOST`, `NITRO_PRESET`, `SERVER_PRESET`, then the build variables of Cloudflare Workers Builds
 * (`WORKERS_CI`), Netlify, Vercel, and Deno Deploy. Inside a Cloudflare Worker, it returns `"cloudflare"`.
 * `vitehub()` uses the same detection when `host` is omitted.
 *
 * @example
 * ```ts
 * import { detectHost } from "vite-hub/runtime"
 *
 * const host = detectHost() ?? "node"
 * ```
 */
export function detectHost(env: Record<string, string | undefined> = processEnv()): ViteHubHost | undefined {
  return detectDeploymentHost(env) ?? (globalThis.navigator?.userAgent === "Cloudflare-Workers" ? "cloudflare" : undefined)
}

function processEnv(): Record<string, string | undefined> {
  return globalThis.process?.env ?? {}
}
