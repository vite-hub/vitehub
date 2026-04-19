import type {
  SandboxDetectionResult,
  SandboxProvider,
} from '../types'
import { canResolveModule } from '../../internal/shared/module-resolve'
import { createProviderDetector, isCloudflare, isVercel } from '../../internal/shared/provider-detection'

export interface ResolvedVercelSandboxCredentials {
  token: string
  teamId: string
  projectId: string
}

const detect = createProviderDetector<'cloudflare' | 'vercel'>([
  { provider: 'cloudflare', when: isCloudflare },
  { provider: 'vercel', when: isVercel },
])

export function detectSandbox(): SandboxDetectionResult {
  const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>
  const type = detect() || 'none'
  if (type === 'cloudflare')
    return { type, details: { runtime: typeof process === 'undefined' ? 'workerd' : 'node' } }
  if (type === 'vercel')
    return { type, details: { env: env.VERCEL_ENV } }
  return { type }
}

export function isSandboxAvailable(provider?: SandboxProvider): boolean {
  if (provider === 'vercel')
    return canResolveModule('@vercel/sandbox')
  if (provider === 'cloudflare')
    return canResolveModule('@cloudflare/sandbox')

  const detected = detectSandbox()
  if (detected.type === 'cloudflare' || detected.type === 'vercel')
    return isSandboxAvailable(detected.type)
  return false
}
