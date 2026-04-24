import { getSandbox as getCloudflareSandbox } from '@cloudflare/sandbox'
import type { CloudflareSandboxClient, CloudflareSandboxProviderOptions, CloudflareSandboxStub } from '../types'
import { CloudflareSandboxAdapter } from '../adapters'
import { SandboxError } from '../errors'

export async function createCloudflareSandboxClient(provider: CloudflareSandboxProviderOptions): Promise<CloudflareSandboxClient> {
  if (!provider.namespace)
    throw new SandboxError('Cloudflare sandbox requires a Durable Objects binding namespace.')

  const id = provider.sandboxId ?? `cloudflare-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const getSandbox = provider.getSandbox ?? ((ns, sandboxId, opts) => getCloudflareSandbox(ns, sandboxId, opts) as unknown as CloudflareSandboxStub)
  const stub = getSandbox(provider.namespace, id, provider.cloudflare)
  return new CloudflareSandboxAdapter(id, stub)
}
