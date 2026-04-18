import { getSandbox as getCloudflareSandbox } from '@cloudflare/sandbox'
import type { CloudflareSandboxDefinitionProviderOptions, SandboxDefinitionOptions } from '../../module-types'
import { getCloudflareEnv } from '../../internal/shared/provider-detection'
import type { DurableObjectNamespaceLike } from '../../sandbox/types'

type SandboxOptions = {
  local: SandboxDefinitionOptions
  provider: CloudflareSandboxDefinitionProviderOptions
}

type SandboxEvent = {
  context?: {
    cloudflare?: { env?: Record<string, unknown> }
    _platform?: { cloudflare?: { env?: Record<string, unknown> } }
  }
}

export async function resolveSandboxProvider(options: SandboxOptions, context: { event?: SandboxEvent } = {}) {
  const env = getCloudflareEnv(context.event)
  const bindingName = options.provider.binding || 'SANDBOX'
  const namespace = env?.[bindingName] as DurableObjectNamespaceLike | undefined

  if (!namespace) {
    throw new Error(`Cloudflare sandbox requires the "${bindingName}" binding. Set sandbox.binding or run inside Cloudflare.`)
  }

  return {
    provider: 'cloudflare' as const,
    namespace,
    sandboxId: options.provider.sandboxId,
    cloudflare: {
      sleepAfter: options.provider.sleepAfter,
      keepAlive: options.provider.keepAlive,
      normalizeId: options.provider.normalizeId,
    },
    getSandbox: getCloudflareSandbox,
  }
}
