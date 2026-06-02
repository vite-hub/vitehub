import type { SandboxDefinitionOptions, VercelSandboxProviderOptions } from '../../module-types'
import { readNonEmptyEnv } from '../../internal/shared/env'
import { normalizeVercelSandboxRuntime } from '../../sandbox/providers/vercel-runtime'
import type { ResolvedVercelSandboxCredentials } from '../../sandbox/providers/shared'

type SandboxOptions = {
  local: SandboxDefinitionOptions
  provider: VercelSandboxProviderOptions
}

function readConfigCredential(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function resolveEnvCredentials(): Partial<ResolvedVercelSandboxCredentials> {
  const env = typeof process !== 'undefined' ? process.env : {}
  const token = readNonEmptyEnv(env, 'VITE_SANDBOX_TOKEN', 'VERCEL_TOKEN')
  const teamId = readNonEmptyEnv(env, 'VITE_SANDBOX_TEAM_ID', 'VERCEL_TEAM_ID')
  const projectId = readNonEmptyEnv(env, 'VITE_SANDBOX_PROJECT_ID', 'VERCEL_PROJECT_ID')

  return {
    token,
    teamId,
    projectId,
  }
}

function resolveCredentials(provider: VercelSandboxProviderOptions): ResolvedVercelSandboxCredentials | undefined {
  const env = resolveEnvCredentials()
  const token = readConfigCredential(provider.token) || env.token
  const teamId = readConfigCredential(provider.teamId) || env.teamId
  const projectId = readConfigCredential(provider.projectId) || env.projectId

  if (!token || !teamId || !projectId)
    return undefined

  return {
    token,
    teamId,
    projectId,
  }
}

export async function resolveSandboxProvider(options: SandboxOptions) {
  return {
    provider: 'vercel' as const,
    runtime: normalizeVercelSandboxRuntime(options.provider.runtime),
    timeout: typeof options.local.timeout === 'number'
      ? options.local.timeout
      : (typeof options.provider.timeout === 'number' ? options.provider.timeout : undefined),
    cpu: options.provider.cpu,
    ports: options.provider.ports,
    credentials: resolveCredentials(options.provider),
    source: options.provider.source,
    networkPolicy: options.provider.networkPolicy,
  }
}
