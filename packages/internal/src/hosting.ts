import { deploymentPresetFromNitro } from "./deployment.ts"

import type { DeploymentPreset } from "./deployment.ts"

export type HostingProvider = DeploymentPreset

export interface HostingDetectionTarget {
  options: {
    preset?: string | null
  }
}

export function normalizeHosting(hosting?: string | null): string {
  const normalized = hosting?.trim().toLowerCase().replaceAll('_', '-') || ''
  if (normalized === 'cloudflare') return 'cloudflare-module'
  return normalized
}

export function detectHosting(target: HostingDetectionTarget) {
  return normalizeHosting(target.options.preset || process.env.VITEHUB_HOSTING || '')
}

export function getHostingProvider(hosting?: string | null): HostingProvider | undefined {
  return deploymentPresetFromNitro(hosting)
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
