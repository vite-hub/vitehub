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

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>

export async function loadSandboxRuntimeProvider(provider: SandboxProvider): Promise<SandboxRuntimeProvider> {
  if (provider === 'cloudflare') {
    const [{ resolveSandboxProvider }, { createCloudflareSandboxClient }] = await Promise.all([
      dynamicImport<typeof import('./providers/cloudflare')>('./providers/cloudflare'),
      dynamicImport<typeof import('../sandbox/providers/cloudflare')>('../sandbox/providers/cloudflare'),
    ])
    return { resolveSandboxProvider, createSandboxClient: createCloudflareSandboxClient }
  }

  if (provider === 'vercel') {
    const [{ resolveSandboxProvider }, { createVercelSandboxClient }] = await Promise.all([
      dynamicImport<typeof import('./providers/vercel')>('./providers/vercel'),
      dynamicImport<typeof import('../sandbox/providers/vercel')>('../sandbox/providers/vercel'),
    ])
    return { resolveSandboxProvider, createSandboxClient: createVercelSandboxClient }
  }

  throw new Error(`[vitehub] Unsupported sandbox provider: ${provider}`)
}
