import type { DeploymentEnvContext, DeploymentEnvEntry } from '@vite-hub/internal/build/deployment-plan-output'

import type { AgentSandboxTaskConfig } from './module-types'
import { vercelCredentialEnv } from './vercel-credentials.ts'

const owners = ['sandbox']

/**
 * The variables that Sandbox Tasks read on the deployed host. A Vercel Sandbox reads its token, team, and project from
 * env when the config leaves them out. On Vercel they are optional, since the Sandbox SDK then uses the OIDC token of
 * the deployment. A Cloudflare Sandbox uses its binding and reads none. A container Sandbox runs the `docker` CLI, which
 * reads the optional `DOCKER_HOST` and otherwise uses the local daemon socket.
 */
export function sandboxDeploymentEnv(
  config: AgentSandboxTaskConfig | false | undefined,
  driver: 'cloudflare' | 'container' | 'vercel' | undefined,
  context: DeploymentEnvContext,
): DeploymentEnvEntry[] {
  if (config === false) return []
  if (driver === 'container')
    return [{ names: ['DOCKER_HOST'], required: false, secret: false, hasDefault: true, owners }]
  if (driver !== 'vercel') return []
  const configured = config?.driver === 'vercel' ? config : undefined
  const required = context.host !== 'vercel'
  return (['token', 'teamId', 'projectId'] as const).flatMap(option => configured?.[option]?.trim()
    ? []
    : [{ names: vercelCredentialEnv[option].names, required, secret: vercelCredentialEnv[option].secret, hasDefault: false, owners }])
}
