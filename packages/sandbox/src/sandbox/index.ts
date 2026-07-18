import type { SandboxClient, SandboxProviderOptions } from './types'
import { SandboxError } from './errors'
import { detectSandbox, isSandboxAvailable } from './providers/shared'
import { validateSandboxConfig } from './validation'

type ProviderLoaderModule = typeof import('../runtime/provider-loader')

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>

export { NotSupportedError, SandboxError } from './errors'
export { validateSandboxConfig }
export { detectSandbox, isSandboxAvailable }
export type * from './types'

export const VercelSandboxStatic = {
  async list() {
    return (await import('./providers/vercel')).VercelSandboxStatic.list()
  },

  async get(id: string) {
    return (await import('./providers/vercel')).VercelSandboxStatic.get(id)
  },
}

export async function createSandboxClient(provider: SandboxProviderOptions): Promise<SandboxClient> {
  const validation = validateSandboxConfig(provider)
  if (!validation.ok) {
    const firstIssue =
      validation.issues.find((issue) => issue.severity === 'error') || validation.issues[0]
    throw new SandboxError({
      code: 'SANDBOX_VALIDATION_ERROR',
      details: { provider: provider.provider },
      message: firstIssue?.message || `[${provider.provider}] invalid sandbox config`,
    })
  }

  const { createSandboxClient } = await import('vitehub-sandbox-provider-loader').catch(() => {
    return dynamicImport<ProviderLoaderModule>('@vite-hub/sandbox/runtime/provider-loader')
  }).then(module => module.loadSandboxRuntimeProvider(provider.provider))
  return await createSandboxClient(provider)
}
