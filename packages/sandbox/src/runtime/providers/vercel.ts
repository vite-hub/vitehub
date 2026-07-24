import type { SandboxDefinitionOptions, VercelSandboxProviderOptions } from '../../module-types'
import { resolveVercelBox } from '@vite-hub/box/_internal/vercel'
import { readNonEmptyEnv } from '../../internal/shared/env'

type SandboxOptions = {
  local: SandboxDefinitionOptions
  provider: VercelSandboxProviderOptions
}

function readConfigCredential(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function resolveEnvCredentials() {
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

function resolveCredentials(provider: VercelSandboxProviderOptions) {
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

export async function resolveSandboxBox(options: SandboxOptions) {
  const credentials = resolveCredentials(options.provider)
  const boxOptions = {
    runtime: options.provider.runtime || 'node24',
    timeout: typeof options.local.timeout === 'number'
      ? options.local.timeout
      : options.provider.timeout,
    cpu: options.provider.cpu,
    ports: options.provider.ports,
    source: options.provider.source,
    networkPolicy: options.provider.networkPolicy,
    ...credentials,
  }
  return {
    provider: 'vercel' as const,
    resolveBox: async (requirements: readonly string[]) => await resolveVercelBox(
      boxOptions,
      requirements,
    ),
  }
}
