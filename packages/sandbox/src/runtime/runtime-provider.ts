import { getCloudflareEnv } from '../internal/shared/provider-detection'
import type {
  AgentSandboxConfig,
  SandboxDefinitionOptions,
  SandboxDefinitionProviderOptions,
} from '../module-types'
import { getSandboxFeatureProvider } from '../module-types'
import { SandboxError } from '../sandbox/errors'
import { detectSandbox } from '../sandbox/providers/shared'
import type { SandboxClient, SandboxProvider, SandboxProviderOptions } from '../sandbox/types'
import { validateSandboxConfig } from '../sandbox/validation'
import { loadSandboxRuntimeProvider } from 'virtual:vitehub-sandbox-provider-loader'

export type SandboxEvent = {
  context?: {
    cloudflare?: { env?: Record<string, unknown> }
    _platform?: { cloudflare?: { env?: Record<string, unknown> } }
  }
}

const allowedDefinitionKeys = new Set(['timeout', 'env', 'runtime'])

export function assertSandboxDefinitionOptions(local: SandboxDefinitionOptions) {
  const invalidKeys = Object.keys(local).filter(key => !allowedDefinitionKeys.has(key))
  if (invalidKeys.length > 0)
    throw new TypeError(`[vitehub] Sandbox definition options only support timeout, env, runtime. Unsupported: ${invalidKeys.join(', ')}`)
}

export function resolveRuntimeProvider(provider?: SandboxDefinitionProviderOptions, event?: SandboxEvent) {
  if (provider?.provider)
    return provider.provider

  const envProvider = process.env.SANDBOX_PROVIDER
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

export async function resolveSandboxProviderConfig(
  provider: SandboxProvider,
  providerOptions: SandboxDefinitionProviderOptions & { provider: SandboxProvider },
  local: SandboxDefinitionOptions,
  context: { event?: SandboxEvent },
): Promise<{
  createSandboxClient: (provider: SandboxProviderOptions) => Promise<SandboxClient>
  resolvedProvider: SandboxProviderOptions
}> {
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

export async function loadSandboxClientFactory(provider: SandboxProvider) {
  return (await loadSandboxRuntimeProvider(provider)).createSandboxClient
}

export async function createSandboxWithConfig(
  config: AgentSandboxConfig,
  local: SandboxDefinitionOptions = {},
  context: { event?: SandboxEvent } = {},
) {
  assertSandboxDefinitionOptions(local)
  const resolvedProviderConfig = getSandboxFeatureProvider(config)
  const provider = resolveRuntimeProvider(resolvedProviderConfig, context.event)
  const { createSandboxClient, resolvedProvider } = await resolveSandboxProviderConfig(provider, {
    ...(resolvedProviderConfig || {}),
    provider,
  } as SandboxDefinitionProviderOptions & { provider: SandboxProvider }, local, context)

  const validation = validateSandboxConfig(resolvedProvider)
  if (!validation.ok) {
    const firstIssue = validation.issues.find(issue => issue.severity === 'error') || validation.issues[0]
    throw new SandboxError(firstIssue?.message || `[${provider}] invalid sandbox config`)
  }

  return await createSandboxClient(resolvedProvider)
}
