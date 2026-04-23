import type { SandboxClient, SandboxProviderOptions } from './types'
import { SandboxError } from './errors'
import { detectSandbox, isSandboxAvailable } from './providers/shared'
import { validateSandboxConfig } from './validation'
import { loadSandboxRuntimeProvider } from '#vitehub-sandbox-provider-loader'

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
    const firstIssue = validation.issues.find(issue => issue.severity === 'error') || validation.issues[0]
    throw new SandboxError(firstIssue?.message || `[${provider.provider}] invalid sandbox config`)
  }

  const { createSandboxClient } = await loadSandboxRuntimeProvider(provider.provider)
  return await createSandboxClient(provider)
}
