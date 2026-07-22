import { getCloudflareEnv } from '@vite-hub/internal/runtime/cloudflare-env'
import { createProviderDetector, isCloudflare, isVercel } from '../internal/shared/provider-detection'
import { sandboxError } from '../sandbox/errors'
import { loadSandboxProviderRuntime } from './provider-loader-resolver'

import type {
  SandboxDefinitionOptions,
  SandboxDefinitionProviderOptions,
} from '../module-types'
import type { SandboxProvider } from '../module-types'

type SandboxEvent = {
  context?: {
    cloudflare?: { env?: Record<string, unknown> }
    _platform?: { cloudflare?: { env?: Record<string, unknown> } }
  }
}

const allowedDefinitionKeys = new Set(['timeout', 'env'])
const detectProvider = createProviderDetector<'cloudflare' | 'vercel'>([
  { provider: 'cloudflare', when: isCloudflare },
  { provider: 'vercel', when: isVercel },
])

export function detectSandbox() {
  const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>
  const type = detectProvider() || 'none'
  if (type === 'cloudflare')
    return { type, details: { runtime: typeof process === 'undefined' ? 'workerd' : 'node' } }
  if (type === 'vercel')
    return { type, details: { env: env.VERCEL_ENV } }
  return { type }
}

function canResolvePackageSync(specifier: string) {
  const runtimeRequire = (globalThis as { require?: { resolve?: (id: string) => string } }).require
  if (typeof runtimeRequire?.resolve === 'function') {
    try {
      runtimeRequire.resolve(specifier)
      return true
    }
    catch {
      return false
    }
  }

  try {
    return typeof (import.meta as ImportMeta & { resolve?: (id: string) => string }).resolve?.(specifier) === 'string'
  }
  catch {
    return false
  }
}

export function isSandboxAvailable(provider?: SandboxProvider): boolean {
  if (provider === 'cloudflare')
    return canResolvePackageSync('@cloudflare/sandbox')
  if (provider === 'vercel')
    return canResolvePackageSync('@vercel/sandbox')
  const detected = detectSandbox()
  return detected.type === 'cloudflare' || detected.type === 'vercel'
    ? isSandboxAvailable(detected.type)
    : false
}

function hashCloudflareSandboxName(name: string) {
  let hash = 2166136261
  for (let index = 0; index < name.length; index++)
    hash = Math.imul(hash ^ name.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(36)
}

export function createCloudflareExecutionSandboxId(name: string, sandboxId?: string) {
  if (sandboxId)
    return sandboxId

  const prefix = 'vitehub-'
  const suffix = `-${hashCloudflareSandboxName(name)}-definition`
  const slug = encodeURIComponent(name).slice(0, 256 - prefix.length - suffix.length)
  return `${prefix}${slug}${suffix}`
}

export function resolveRuntimeProvider(provider?: SandboxDefinitionProviderOptions, event?: SandboxEvent) {
  if (provider?.provider)
    return provider.provider

  const envProvider = typeof process !== 'undefined' ? process.env?.SANDBOX_PROVIDER : undefined
  if (envProvider === 'cloudflare' || envProvider === 'vercel')
    return envProvider

  if (getCloudflareEnv(event))
    return 'cloudflare'

  const detected = detectSandbox()
  if (detected.type === 'cloudflare' || detected.type === 'vercel')
    return detected.type

  throw sandboxError('Sandbox provider could not be inferred. Configure `sandbox.provider` as `cloudflare` or `vercel`.', {
    code: 'SANDBOX_PROVIDER_REQUIRED',
  })
}

export function assertSandboxDefinitionOptions(local: SandboxDefinitionOptions) {
  const invalidKeys = Object.keys(local).filter(key => !allowedDefinitionKeys.has(key))
  if (invalidKeys.length > 0)
    throw new TypeError(`[vitehub] Sandbox definition options only support timeout and env. Unsupported: ${invalidKeys.join(', ')}`)
}

export async function resolveSandboxBox(
  provider: SandboxProvider,
  providerOptions: SandboxDefinitionProviderOptions & { provider: SandboxProvider },
  local: SandboxDefinitionOptions,
  context: { event?: SandboxEvent },
) {
  const runtimeProvider = await loadSandboxProviderRuntime(provider)
  return await runtimeProvider.resolveSandboxBox({
    local,
    provider: providerOptions,
  }, context)
}

export function withSandboxProvider(
  provider: SandboxProvider,
  options?: SandboxDefinitionProviderOptions,
) {
  return {
    ...options,
    provider,
  } as SandboxDefinitionProviderOptions & { provider: SandboxProvider }
}

export type { SandboxEvent }
