import { getCloudflareEnv } from '@vite-hub/internal/runtime/cloudflare-env'
import { SandboxError } from '../sandbox/errors'
import { detectSandbox } from '../sandbox/providers/shared'
import { loadSandboxProviderRuntime } from './provider-loader-resolver'

import type {
  SandboxDefinitionOptions,
  SandboxDefinitionProviderOptions,
} from '../module-types'
import type { SandboxProvider, SandboxProviderOptions } from '../sandbox/types'

type SandboxEvent = {
  context?: {
    cloudflare?: { env?: Record<string, unknown> }
    _platform?: { cloudflare?: { env?: Record<string, unknown> } }
  }
}

const allowedDefinitionKeys = new Set(['timeout', 'env', 'runtime'])

export function createCloudflareExecutionSandboxId(name: string, sandboxId?: string) {
  if (sandboxId)
    return sandboxId

  return encodeURIComponent(name)
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

  throw new SandboxError('Sandbox provider could not be inferred. Configure `sandbox.provider` as `cloudflare` or `vercel`.', {
    code: 'SANDBOX_PROVIDER_REQUIRED',
  })
}

export function assertSandboxDefinitionOptions(local: SandboxDefinitionOptions) {
  const invalidKeys = Object.keys(local).filter(key => !allowedDefinitionKeys.has(key))
  if (invalidKeys.length > 0)
    throw new TypeError(`[vitehub] Sandbox definition options only support timeout, env, runtime. Unsupported: ${invalidKeys.join(', ')}`)
}

export async function resolveSandboxProvider(
  provider: SandboxProvider,
  providerOptions: SandboxDefinitionProviderOptions & { provider: SandboxProvider },
  local: SandboxDefinitionOptions,
  context: { event?: SandboxEvent },
) {
  const runtimeProvider = await loadSandboxProviderRuntime(provider)
  const resolvedProvider = await runtimeProvider.resolveSandboxProvider({
    local,
    provider: providerOptions,
  }, context) as SandboxProviderOptions

  return {
    createSandboxClient: runtimeProvider.createSandboxClient,
    resolvedProvider,
  }
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
