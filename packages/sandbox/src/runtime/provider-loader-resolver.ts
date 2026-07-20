import type { SandboxRuntimeProvider } from './provider-loader'
import type { SandboxProvider } from '../module-types'

type ProviderLoaderModule = {
  loadSandboxRuntimeProvider: (provider: SandboxProvider) => Promise<SandboxRuntimeProvider>
}

export async function loadSandboxProviderRuntime(provider: SandboxProvider): Promise<SandboxRuntimeProvider> {
  const module = await import('vitehub-sandbox-provider-loader').catch(() => {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>
    return dynamicImport<ProviderLoaderModule>('@vite-hub/sandbox/runtime/provider-loader')
  }) as ProviderLoaderModule

  return await module.loadSandboxRuntimeProvider(provider)
}
