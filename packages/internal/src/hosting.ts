import { deploymentPresetFromNitro } from "./deployment.ts"

import type { DeploymentPreset } from "./deployment.ts"

export type HostingProvider = 'cloudflare' | 'netlify' | 'vercel'

export interface HostInput {
  /** Nitro config or resolved Nitro options. Its `preset` wins over every other source. */
  nitro?: unknown
  /** A preset or hosting name from plugin options, such as the `hosting` that `vitehub()` passes. */
  hosting?: unknown
  /** Defaults to `process.env`. Reads `NITRO_PRESET`, `SERVER_PRESET`, then `VITEHUB_HOSTING`. */
  env?: Record<string, string | undefined>
}

/**
 * Returns the Nitro preset name that this build targets, as the developer wrote it.
 * The order is `nitro.preset`, `hosting`, `NITRO_PRESET`, `SERVER_PRESET`, then `VITEHUB_HOSTING`.
 * Empty values are skipped.
 */
export function resolveHostPreset(input: HostInput = {}): string | undefined {
  const env = input.env ?? (typeof process === "undefined" ? {} : process.env)
  const nitroPreset = input.nitro && typeof input.nitro === "object" ? Reflect.get(input.nitro, "preset") : undefined
  for (const value of [nitroPreset, input.hosting, env.NITRO_PRESET, env.SERVER_PRESET, env.VITEHUB_HOSTING]) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

/** Returns the host that this build targets: `cloudflare`, `deno`, `netlify`, `node`, or `vercel`. */
export function resolveHost(input: HostInput = {}): DeploymentPreset | undefined {
  return deploymentPresetFromNitro(resolveHostPreset(input))
}

export function normalizeHosting(hosting?: string | null): string {
  const normalized = hosting?.trim().toLowerCase().replaceAll('_', '-') || ''
  if (normalized === 'cloudflare') return 'cloudflare-module'
  return normalized
}

/** Narrows a preset or host name to the hosts that have a native provider: Cloudflare, Netlify, or Vercel. */
export function getHostingProvider(hosting?: string | null): HostingProvider | undefined {
  const preset = deploymentPresetFromNitro(hosting)
  if (preset === 'cloudflare' || preset === 'netlify' || preset === 'vercel')
    return preset

  return undefined
}

export function getSupportedHostingProvider<TProvider extends HostingProvider>(
  hosting: string | undefined,
  supportedProviders: readonly TProvider[],
) {
  const provider = getHostingProvider(hosting)
  if (!provider || !supportedProviders.includes(provider as TProvider))
    return undefined

  return provider as TProvider
}
