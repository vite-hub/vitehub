import { resolveBox, type CloudflareBoxOptions } from '@vite-hub/box'
import { getCloudflareEnv } from '@vite-hub/internal/runtime/cloudflare-env'
import type { CloudflareSandboxDefinitionProviderOptions, SandboxDefinitionOptions } from '../../module-types'

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

export async function resolveSandboxBox(options: SandboxOptions, context: { event?: SandboxEvent } = {}) {
  const env = getCloudflareEnv(context.event)
  const bindingName = options.provider.binding || 'SANDBOX'
  const namespace = env?.[bindingName]

  if (!namespace) {
    throw new Error(`Cloudflare sandbox requires the "${bindingName}" binding. Set sandbox.binding or run inside Cloudflare.`)
  }

  return {
    closeAfterRun: options.provider.keepAlive === true,
    provider: 'cloudflare' as const,
    sandboxId: options.provider.sandboxId,
    resolveBox: async (requirements: readonly string[]) => await resolveBox({
      runtime: {
        kind: 'cloudflare',
        namespace: namespace as CloudflareBoxOptions['namespace'],
        sandboxId: options.provider.sandboxId,
        cloudflare: {
          sleepAfter: options.provider.sleepAfter ?? '5m',
          keepAlive: options.provider.keepAlive,
          normalizeId: options.provider.normalizeId,
        },
      },
    }, {}, { requires: requirements }),
  }
}
