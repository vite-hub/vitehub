import type { SandboxRuntimeProvider } from './provider-loader'
import type { SandboxProvider } from '../sandbox/types'

type ProviderLoaderModule = {
  loadSandboxRuntimeProvider: (provider: SandboxProvider) => Promise<SandboxRuntimeProvider>
}

export async function loadSandboxProviderRuntime(provider: SandboxProvider): Promise<SandboxRuntimeProvider> {
  const module = await import(
    /* @vite-ignore */
    'virtual:vitehub-sandbox-provider-loader'
  ).catch(() => import(
    /* @vite-ignore */
    './provider-loader'
  )) as ProviderLoaderModule

  return await module.loadSandboxRuntimeProvider(provider)
}
