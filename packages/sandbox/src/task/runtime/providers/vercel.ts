import type { SandboxTaskDefinitionOptions, VercelSandboxTaskProviderOptions } from '../../module-types'
import { loadVercelSandbox, resolveVercelSandbox } from '../../../internal/vercel.ts'
import type { VercelSandboxCreateOptions, VercelSandboxInstance } from '../../../vercel.ts'
import { readEnv } from '@vite-hub/internal/env'
import { sandboxTaskErrorDiagnostics } from '../../error-diagnostics.ts'
import { DEFAULT_SANDBOX_TASK_TIMEOUT_MS } from '../provider-resolution'

/**
 * The Vercel VM timeout starts at create, but the task timeout starts after the Sandbox opens.
 * The VM gets this extra time so that ViteHub, not the VM, ends a run at the task timeout.
 */
const VERCEL_TASK_SANDBOX_HEADROOM_MS = 30_000

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
    timeout: (options.local.timeout ?? DEFAULT_SANDBOX_TASK_TIMEOUT_MS) + VERCEL_TASK_SANDBOX_HEADROOM_MS,
    cpu: options.provider.cpu,
    ports: options.provider.ports,
    source: options.provider.source,
    networkPolicy: options.provider.networkPolicy,
    ...credentials,
  }
  return {
    provider: 'vercel' as const,
    resolveSandbox: async (requirements: readonly string[]) => await resolveVercelSandbox(
      { ...sandboxOptions, create: withPlanLimitError(await loadVercelSandbox()) },
      requirements,
    ),
  }
}

/** Reports a session timeout above the Vercel plan maximum with its own code and the limit from Vercel. */
function withPlanLimitError(create: (options: VercelSandboxCreateOptions) => Promise<VercelSandboxInstance>) {
  return async (createOptions: VercelSandboxCreateOptions) => {
    try {
      return await create(createOptions)
    }
    catch (error) {
      const limit = error instanceof Error ? vercelTimeoutLimit(error.message) : undefined
      if (limit && createOptions.timeout !== undefined)
        throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0077({ cause: error, limit, timeout: createOptions.timeout })
      throw error
    }
  }
}

function vercelTimeoutLimit(message: string) {
  // provider-message-match: the Vercel API answers a timeout above the plan maximum with a plain 400 and no error code.
  return /`timeout` restricted to [^\n]+/.exec(message)?.[0]
}
