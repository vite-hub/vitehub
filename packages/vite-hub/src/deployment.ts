import { hostFromNitroPreset } from "@vite-hub/internal/deployment"

import type { ViteHubHost } from "@vite-hub/internal/deployment"

export type { ViteHubHost }

// The variables that std-env reads to detect the provider, the same detection that Nitro uses without a preset.
// Cloudflare Pages (`CF_PAGES`) is not here: ViteHub's Cloudflare host builds a Worker.
const providerHosts: ReadonlyArray<readonly [string, ViteHubHost]> = [
  ["WORKERS_CI", "cloudflare"],
  ["NETLIFY", "netlify"],
  ["NOW_BUILDER", "vercel"],
  ["VERCEL", "vercel"],
  ["VERCEL_ENV", "vercel"],
  ["DENO_DEPLOY", "deno"],
  ["DENO_DEPLOYMENT_ID", "deno"],
]

/**
 * Returns the ViteHub host that this process builds or runs on, or `undefined` when no variable names a host.
 * The order is `VITEHUB_HOST`, `NITRO_PRESET`, `SERVER_PRESET`, then the provider variables:
 * `WORKERS_CI` (Cloudflare Workers Builds), `NETLIFY`, `NOW_BUILDER`, `VERCEL` or `VERCEL_ENV`, then `DENO_DEPLOY` or `DENO_DEPLOYMENT_ID`.
 * `vitehub()` uses this result when `host` is omitted, and `"node"` when it is `undefined`.
 *
 * @example
 * ```ts
 * import { detectHost } from "vite-hub"
 *
 * const host = detectHost() ?? "node"
 * ```
 */
export function detectHost(env: Record<string, string | undefined> = process.env): ViteHubHost | undefined {
  for (const name of ["VITEHUB_HOST", "NITRO_PRESET", "SERVER_PRESET"]) {
    const host = hostFromNitroPreset(env[name])
    if (host) return host
  }
  return providerHosts.find(([name]) => env[name]?.trim())?.[1]
}

/**
 * Adds the `module` export condition to a Cloudflare build. Vite resolves server code with it, and Nitro does not.
 * Without it, a package that keeps its ESM build under `module`, such as `@opentelemetry/semantic-conventions` (which
 * Better Auth imports), ships its whole CommonJS build in the Worker instead of the few exports that the app uses.
 */
export function cloudflareExportConditions(conditions: unknown): string[] {
  const current = Array.isArray(conditions) ? conditions.filter((condition): condition is string => String(condition) === condition) : []
  return current.includes("module") || current.includes("!module") ? current : [...current, "module"]
}
