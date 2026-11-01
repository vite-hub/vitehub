import { deploymentPresetFromNitro } from "@vite-hub/internal/deployment"

import type { DeploymentPreset } from "@vite-hub/internal/deployment"

export type { DeploymentPreset }

// The variables that std-env reads to detect the provider, the same detection that Nitro uses without a preset.
// Cloudflare Pages (`CF_PAGES`) is not here: ViteHub's Cloudflare preset builds a Worker.
const providerPresets: ReadonlyArray<readonly [string, DeploymentPreset]> = [
  ["WORKERS_CI", "cloudflare"],
  ["NETLIFY", "netlify"],
  ["NOW_BUILDER", "vercel"],
  ["VERCEL", "vercel"],
  ["VERCEL_ENV", "vercel"],
  ["DENO_DEPLOY", "deno"],
  ["DENO_DEPLOYMENT_ID", "deno"],
]

/**
 * Returns the ViteHub preset of the host that this process builds or runs on, or `undefined` when no variable names a host.
 * The order is `VITEHUB_HOSTING`, `NITRO_PRESET`, `SERVER_PRESET`, then the provider variables:
 * `WORKERS_CI` (Cloudflare Workers Builds), `NETLIFY`, `NOW_BUILDER`, `VERCEL` or `VERCEL_ENV`, then `DENO_DEPLOY` or `DENO_DEPLOYMENT_ID`.
 * `vitehub()` uses this result when `preset` is omitted, and `"node"` when it is `undefined`.
 */
export function detectPreset(env: Record<string, string | undefined> = process.env): DeploymentPreset | undefined {
  for (const name of ["VITEHUB_HOSTING", "NITRO_PRESET", "SERVER_PRESET"]) {
    const preset = deploymentPresetFromNitro(env[name])
    if (preset) return preset
  }
  return providerPresets.find(([name]) => env[name]?.trim())?.[1]
}
