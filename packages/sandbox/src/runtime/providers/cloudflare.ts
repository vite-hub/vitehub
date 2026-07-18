import type { CloudflareSandboxDefinitionProviderOptions, SandboxDefinitionOptions } from '../../module-types'
import { getCloudflareEnv } from '../../internal/shared/provider-detection'
import { SandboxError } from '../../sandbox/errors'
import type { CloudflareSandboxOptions, CloudflareSandboxStub, DurableObjectNamespaceLike } from '../../sandbox/types'

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

async function loadCloudflareSandbox() {
  try {
    return (await import('@cloudflare/sandbox')).getSandbox
  }
  catch (error) {
    throw new SandboxError('@cloudflare/sandbox load failed.', { cause: error, code: 'SANDBOX_RUNTIME_ERROR', provider: 'cloudflare' })
  }
}

export async function resolveSandboxProvider(options: SandboxOptions, context: { event?: SandboxEvent } = {}) {
  const env = getCloudflareEnv(context.event)
  const bindingName = options.provider.binding || 'SANDBOX'
  const namespace = env?.[bindingName] as DurableObjectNamespaceLike | undefined

  if (!namespace) {
    throw new SandboxError(`Cloudflare sandbox requires the "${bindingName}" binding.`, { code: 'SANDBOX_RUNTIME_ERROR', provider: 'cloudflare' })
  }

  const getCloudflareSandbox = await loadCloudflareSandbox()

  return {
    provider: 'cloudflare' as const,
    namespace,
    sandboxId: options.provider.sandboxId,
    cloudflare: {
      sleepAfter: options.provider.sleepAfter,
      keepAlive: options.provider.keepAlive,
      normalizeId: options.provider.normalizeId,
    },
    getSandbox: (ns: DurableObjectNamespaceLike, sandboxId: string, opts?: CloudflareSandboxOptions) =>
      getCloudflareSandbox(ns as never, sandboxId, opts) as unknown as CloudflareSandboxStub,
  }
}
