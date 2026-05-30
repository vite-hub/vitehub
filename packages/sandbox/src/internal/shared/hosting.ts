export type HostingProvider = 'cloudflare' | 'netlify' | 'vercel'

export interface HostingDetectionTarget {
  options: {
    nitro?: {
      preset?: string | null
    }
    preset?: string | null
  }
}

export function normalizeHosting(hosting?: string | null): string {
  const normalized = hosting?.trim().toLowerCase().replaceAll('_', '-') || ''
  if (normalized === 'cloudflare') return 'cloudflare-module'
  return normalized
}

export function detectHosting(target: HostingDetectionTarget) {
  return normalizeHosting(target.options.nitro?.preset || target.options.preset || detectPresetArg() || process.env.NITRO_PRESET || process.env.VITEHUB_HOSTING || '')
}

function detectPresetArg(): string {
  const argv = process.argv || []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--preset') return argv[index + 1] || ''
    if (arg?.startsWith('--preset=')) return arg.slice('--preset='.length)
  }
  return ''
}

export function getHostingProvider(hosting?: string | null): HostingProvider | undefined {
  const normalized = normalizeHosting(hosting)

  if (!normalized)
    return undefined

  if (normalized.startsWith('cloudflare'))
    return 'cloudflare'
  if (normalized.startsWith('vercel'))
    return 'vercel'
  if (normalized.startsWith('netlify'))
    return 'netlify'
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
