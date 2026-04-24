import type { SandboxDefinitionOptions, VercelSandboxProviderOptions } from '../../module-types'
import { readFrameworkEnv } from '../../internal/shared/env'
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
  const token = readFrameworkEnv(env, {
    nitro: ['NITRO_SANDBOX_TOKEN'],
    nuxt: ['NUXT_SANDBOX_TOKEN'],
    vite: ['VITE_SANDBOX_TOKEN'],
    plain: ['VERCEL_TOKEN'],
  })
  const teamId = readFrameworkEnv(env, {
    nitro: ['NITRO_SANDBOX_TEAM_ID'],
    nuxt: ['NUXT_SANDBOX_TEAM_ID'],
    vite: ['VITE_SANDBOX_TEAM_ID'],
    plain: ['VERCEL_TEAM_ID'],
  })
  const projectId = readFrameworkEnv(env, {
    nitro: ['NITRO_SANDBOX_PROJECT_ID'],
    nuxt: ['NUXT_SANDBOX_PROJECT_ID'],
    vite: ['VITE_SANDBOX_PROJECT_ID'],
    plain: ['VERCEL_PROJECT_ID'],
  })

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
