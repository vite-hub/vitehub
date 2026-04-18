import type { SandboxDefinitionOptions, SandboxDefinitionProviderOptions } from '../module-types'
import type { SandboxClient, SandboxProvider, SandboxProviderOptions } from '../sandbox/types'

export interface SandboxRuntimeProvider {
  resolveSandboxProvider: (
    options: {
      local: SandboxDefinitionOptions
      provider: SandboxDefinitionProviderOptions & { provider: SandboxProvider }
    } | any,
    context?: any,
  ) => Promise<SandboxProviderOptions>
  createSandboxClient: (provider: SandboxProviderOptions | any) => Promise<SandboxClient>
}

export async function loadSandboxRuntimeProvider(provider: SandboxProvider): Promise<SandboxRuntimeProvider> {
  if (provider === 'cloudflare') {
    const [{ resolveSandboxProvider }, { createCloudflareSandboxClient }] = await Promise.all([
      import('./providers/cloudflare'),
      import('../sandbox/providers/cloudflare'),
    ])
    return { resolveSandboxProvider, createSandboxClient: createCloudflareSandboxClient }
  }

  if (provider === 'vercel') {
    const [{ resolveSandboxProvider }, { createVercelSandboxClient }] = await Promise.all([
      import('./providers/vercel'),
      import('../sandbox/providers/vercel'),
    ])
    return { resolveSandboxProvider, createSandboxClient: createVercelSandboxClient }
  }

  throw new Error(`[vitehub] Unsupported sandbox provider: ${provider}`)
}
