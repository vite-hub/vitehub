import { createHash, randomUUID } from 'node:crypto'
import { loadSandboxRuntimeProvider } from 'virtual:vitehub-sandbox-provider-loader'

import { getCloudflareEnv } from '../internal/shared/provider-detection'
import { SandboxError } from '../sandbox/errors'
import { detectSandbox } from '../sandbox/providers/shared'

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

  const hash = createHash('sha256')
    .update(`${name}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 24)

  return `vitehub-${name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-${hash}`
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
  const runtimeProvider = await loadSandboxRuntimeProvider(provider)
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
