import type { SandboxDefinitionOptions, VercelSandboxProviderOptions } from '../../module-types'
import { readFrameworkEnv } from '../../internal/shared/env'
import { normalizeVercelSandboxRuntime } from '../../sandbox/providers/vercel-runtime'

type SandboxOptions = {
  local: SandboxDefinitionOptions
  provider: VercelSandboxProviderOptions
}

function resolveEnvCredentials() {
  const token = readFrameworkEnv(process.env, {
    nitro: ['NITRO_SANDBOX_TOKEN'],
    nuxt: ['NUXT_SANDBOX_TOKEN'],
    vite: ['VITE_SANDBOX_TOKEN'],
    plain: ['VERCEL_TOKEN'],
  })
  const teamId = readFrameworkEnv(process.env, {
    nitro: ['NITRO_SANDBOX_TEAM_ID'],
    nuxt: ['NUXT_SANDBOX_TEAM_ID'],
    vite: ['VITE_SANDBOX_TEAM_ID'],
    plain: ['VERCEL_TEAM_ID'],
  })
  const projectId = readFrameworkEnv(process.env, {
    nitro: ['NITRO_SANDBOX_PROJECT_ID'],
    nuxt: ['NUXT_SANDBOX_PROJECT_ID'],
    vite: ['VITE_SANDBOX_PROJECT_ID'],
    plain: ['VERCEL_PROJECT_ID'],
  })

  if (!token || !teamId || !projectId)
    return undefined

  return {
    token,
    teamId,
    projectId,
  }
}

export async function resolveSandboxProvider(options: SandboxOptions) {
  const credentials = options.provider.token && options.provider.teamId && options.provider.projectId
    ? {
        token: options.provider.token,
        teamId: options.provider.teamId,
        projectId: options.provider.projectId,
      }
    : resolveEnvCredentials()

  return {
    provider: 'vercel' as const,
    runtime: normalizeVercelSandboxRuntime(options.provider.runtime),
    timeout: typeof options.local.timeout === 'number'
      ? options.local.timeout
      : (typeof options.provider.timeout === 'number' ? options.provider.timeout : undefined),
    cpu: options.provider.cpu,
    ports: options.provider.ports,
    credentials,
    source: options.provider.source,
    networkPolicy: options.provider.networkPolicy,
  }
}
