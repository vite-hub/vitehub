import { deploymentPresetFromNitro } from "./deployment.ts"

export type HostingProvider = 'cloudflare' | 'netlify' | 'vercel'

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
