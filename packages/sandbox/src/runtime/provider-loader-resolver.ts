import type { SandboxRuntimeProvider } from './provider-loader'
import type { SandboxProvider } from '../sandbox/types'

type ProviderLoaderModule = {
  loadSandboxRuntimeProvider: (provider: SandboxProvider) => Promise<SandboxRuntimeProvider>
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>

export async function loadSandboxProviderRuntime(provider: SandboxProvider): Promise<SandboxRuntimeProvider> {
  const module = await dynamicImport<ProviderLoaderModule>('virtual:vitehub-sandbox-provider-loader').catch(() => {
    return dynamicImport<ProviderLoaderModule>('@vitehub/sandbox/runtime/provider-loader')
  }) as ProviderLoaderModule

  return await module.loadSandboxRuntimeProvider(provider)
}
