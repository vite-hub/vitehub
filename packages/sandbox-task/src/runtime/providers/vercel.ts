import type { SandboxTaskDefinitionOptions, VercelSandboxTaskProviderOptions } from '../../module-types'
import { resolveVercelSandbox } from '@vite-hub/sandbox/_internal/vercel'
import { readEnv } from '@vite-hub/internal/env'

type SandboxTaskOptions = {
  local: SandboxTaskDefinitionOptions
  provider: VercelSandboxTaskProviderOptions
}

function readConfigCredential(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function resolveEnvCredentials() {
  const env = typeof process !== 'undefined' ? process.env : {}
  const token = readEnv(env, 'VITE_SANDBOX_TOKEN', 'VERCEL_TOKEN')
  const teamId = readEnv(env, 'VITE_SANDBOX_TEAM_ID', 'VERCEL_TEAM_ID')
  const projectId = readEnv(env, 'VITE_SANDBOX_PROJECT_ID', 'VERCEL_PROJECT_ID')

  return {
    token,
    teamId,
    projectId,
  }
}

function resolveCredentials(provider: VercelSandboxTaskProviderOptions) {
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

export async function resolveVercelTaskSandbox(options: SandboxTaskOptions) {
  const credentials = resolveCredentials(options.provider)
  const sandboxOptions = {
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
    resolveSandbox: async (requirements: readonly string[]) => await resolveVercelSandbox(
      sandboxOptions,
      requirements,
    ),
  }
}
