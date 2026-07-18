import type { CloudflareSandboxClient, CloudflareSandboxProviderOptions, CloudflareSandboxStub } from '../types'
import { CloudflareSandboxAdapter } from '../adapters/cloudflare'
import { SandboxError } from '../errors'

async function loadCloudflareSandbox() {
  try {
    return (await import('@cloudflare/sandbox')).getSandbox
  }
  catch (error) {
    throw new SandboxError('@cloudflare/sandbox load failed.', { cause: error, code: 'SANDBOX_RUNTIME_ERROR', provider: 'cloudflare' })
  }
}

export async function createCloudflareSandboxClient(provider: CloudflareSandboxProviderOptions): Promise<CloudflareSandboxClient> {
  if (!provider.namespace)
    throw new SandboxError('Cloudflare sandbox requires a Durable Objects binding namespace.', { code: 'SANDBOX_RUNTIME_ERROR', provider: 'cloudflare' })

  const id = provider.sandboxId ?? `cloudflare-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const cloudflareSandbox = provider.getSandbox ? undefined : await loadCloudflareSandbox()
  const getSandbox = provider.getSandbox ?? ((ns, sandboxId, opts) => cloudflareSandbox!(ns as never, sandboxId, opts) as unknown as CloudflareSandboxStub)
  const stub = getSandbox(provider.namespace, id, provider.cloudflare)
  return new CloudflareSandboxAdapter(id, stub)
}
