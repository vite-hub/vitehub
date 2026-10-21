import { getCloudflareEnv } from '@vite-hub/internal/runtime/cloudflare-env'
import { createProviderDetector, isCloudflare, isVercel } from '../internal/shared/provider-detection'
import { sandboxTaskError } from '../sandbox-task/errors'

import type {
  SandboxTaskDefinitionOptions,
  SandboxTaskDefinitionProviderOptions,
} from '../module-types'
import type { SandboxTaskProvider } from '../module-types'
import type { SandboxTaskRuntimeProvider } from './provider-loader'
import { sandboxTaskErrorDiagnostics } from "../error-diagnostics.ts"

type SandboxTaskEvent = {
  context?: {
    cloudflare?: { env?: Record<string, unknown> }
    _platform?: { cloudflare?: { env?: Record<string, unknown> } }
  }
}

type ProviderLoaderModule = {
  loadSandboxTaskRuntimeProvider: (provider: SandboxTaskProvider) => Promise<SandboxTaskRuntimeProvider>
}

const allowedDefinitionKeys = new Set(['timeout', 'env'])
const maxTimeout = 2_147_483_647
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

export function isSandboxAvailable(provider?: SandboxTaskProvider): boolean {
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
  const suffix = `-${hashCloudflareSandboxName(name)}-${crypto.randomUUID()}`
  const slug = encodeURIComponent(name).slice(0, 63 - prefix.length - suffix.length)
  return `${prefix}${slug}${suffix}`
}

export function resolveRuntimeProvider(provider?: SandboxTaskDefinitionProviderOptions, event?: SandboxTaskEvent) {
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

  throw sandboxTaskError('Sandbox provider could not be inferred. Configure `sandbox.provider` as `cloudflare` or `vercel`.', {
    code: 'SANDBOX_TASK_PROVIDER_REQUIRED',
  })
}

export function assertSandboxTaskDefinitionOptions(local: SandboxTaskDefinitionOptions) {
  const invalidKeys = Object.keys(local).filter(key => !allowedDefinitionKeys.has(key))
  if (invalidKeys.length > 0)
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0069({ message: `[vitehub] Sandbox Task Definition options only support timeout and env. Unsupported: ${invalidKeys.join(', ')}` })
  if (local.timeout !== undefined
    && (!Number.isInteger(local.timeout) || local.timeout <= 0 || local.timeout > maxTimeout)) {
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0070({ message: `[vitehub] Sandbox Task Definition timeout must be a positive integer no greater than ${maxTimeout}.` })
  }
}

export async function resolveTaskSandbox(
  provider: SandboxTaskProvider,
  providerOptions: SandboxTaskDefinitionProviderOptions & { provider: SandboxTaskProvider },
  local: SandboxTaskDefinitionOptions,
  context: { event?: SandboxTaskEvent },
) {
  // SAFETY: Both import paths resolve the provider-loader module contract.
  const providerLoader = await import('vitehub-sandbox-task-provider-loader').catch(() => {
    // SAFETY: The generated provider-loader alias is unavailable only outside the generated runtime; dynamic import returns the requested module shape.
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<ProviderLoaderModule>
    return dynamicImport('@vite-hub/sandbox-task/runtime/provider-loader')
  }) as ProviderLoaderModule
  const runtimeProvider = await providerLoader.loadSandboxTaskRuntimeProvider(provider)
  return await runtimeProvider.resolveTaskSandbox({
    local,
    provider: providerOptions,
  }, context)
}

export function withSandboxTaskProvider(
  provider: SandboxTaskProvider,
  options?: SandboxTaskDefinitionProviderOptions,
) {
  return {
    ...options,
    provider,
  } as SandboxTaskDefinitionProviderOptions & { provider: SandboxTaskProvider }
}

export type { SandboxTaskEvent }
