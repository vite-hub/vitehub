import type { Box } from '@vite-hub/box'
import type { SandboxDefinitionOptions, SandboxDefinitionProviderOptions } from '../module-types'
import type { SandboxProvider } from '../module-types'

export interface ResolvedSandboxBox {
  closeAfterRun?: boolean
  provider: SandboxProvider
  resolveBox: (requirements: readonly string[]) => Promise<Box>
  sandboxId?: string
}

export interface SandboxRuntimeProvider {
  resolveSandboxBox: (
    options: {
      local: SandboxDefinitionOptions
      provider: SandboxDefinitionProviderOptions & { provider: SandboxProvider }
    } | any,
    context?: any,
  ) => Promise<ResolvedSandboxBox>
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>

export async function loadSandboxRuntimeProvider(provider: SandboxProvider): Promise<SandboxRuntimeProvider> {
  if (provider === 'cloudflare') {
    const { resolveCloudflareSandboxBox } = await dynamicImport<typeof import('./providers/cloudflare')>('./providers/cloudflare.js')
    return { resolveSandboxBox: resolveCloudflareSandboxBox }
  }

  if (provider === 'vercel') {
    const { resolveVercelSandboxBox } = await dynamicImport<typeof import('./providers/vercel')>('./providers/vercel.js')
    return { resolveSandboxBox: resolveVercelSandboxBox }
  }

  throw new Error(`[vitehub] Unsupported sandbox provider: ${provider}`)
}
