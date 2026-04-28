import type {
  SandboxDetectionResult,
  SandboxProvider,
} from '../types'
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

function canResolvePackageSync(specifier: string): boolean {
  const runtimeRequire = (globalThis as { require?: { resolve?: (id: string) => string } }).require
  if (typeof runtimeRequire?.resolve === 'function') {
    try {
      runtimeRequire.resolve(specifier)
      return true
    }
    catch {
    }
  }

  const metaResolve = (import.meta as ImportMeta & { resolve?: (id: string) => string }).resolve
  if (typeof metaResolve === 'function') {
    try {
      return typeof metaResolve(specifier) === 'string'
    }
    catch {
    }
  }

  return false
}

export function isSandboxAvailable(provider?: SandboxProvider): boolean {
  if (provider === 'vercel')
    return isVercel() || canResolvePackageSync('@vercel/sandbox')
  if (provider === 'cloudflare')
    return isCloudflare() || canResolvePackageSync('@cloudflare/sandbox')

  const detected = detectSandbox()
  if (detected.type === 'cloudflare' || detected.type === 'vercel')
    return isSandboxAvailable(detected.type)
  return false
}
