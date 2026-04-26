import { resolve } from 'node:path'

import { getSupportedHostingProvider } from '../internal/shared/hosting'
import { getSandboxFeatureProvider } from '../module-types'

import type { AgentSandboxConfig, SandboxDefinitionOptions } from '../module-types'

export function resolveNitroSandboxScanDirs(rootDir: string, scanDirs: string[] | undefined) {
  return scanDirs?.length ? scanDirs : [resolve(rootDir, 'server')]
}

export function resolveSandboxConfig(config: AgentSandboxConfig, hosting?: string): AgentSandboxConfig {
  const provider = getSandboxFeatureProvider(config)
  if (provider?.provider)
    return { ...config }

  const inferred = getSupportedHostingProvider(hosting, ['cloudflare', 'vercel'])
  if (!inferred)
    return { ...config }

  return {
    ...config,
    provider: inferred,
  } as AgentSandboxConfig
}

export function assignSandboxRuntimeConfig(runtimeConfig: Record<string, unknown>, config: AgentSandboxConfig) {
  const provider = getSandboxFeatureProvider(config)
  if (provider?.provider === 'vercel') {
    runtimeConfig.sandbox = {
      ...config,
      token: provider.token ?? '',
      teamId: provider.teamId ?? '',
      projectId: provider.projectId ?? '',
    } as AgentSandboxConfig
    return
  }

  runtimeConfig.sandbox = config
}

export function normalizeSandboxDefinitionOptions(name: string, options: SandboxDefinitionOptions | undefined) {
  if (!options)
    return undefined

  try {
    return JSON.parse(JSON.stringify(options)) as SandboxDefinitionOptions
  }
  catch (error) {
    throw new Error(`[vitehub] Sandbox definition "${name}" options must be JSON-serializable.`, {
      cause: error,
    })
  }
}
