import type { DeploymentEnvContext, DeploymentEnvEntry } from '@vite-hub/internal/build/deployment-plan-output'

import type { AgentSandboxTaskConfig } from './module-types'
import { vercelCredentialEnv } from './vercel-credentials.ts'

const owners = ['sandbox']

/**
 * The variables that Sandbox Tasks read on the deployed host. Off Vercel, a Vercel Sandbox needs its token, team, and
 * project from env when the config leaves them out. On Vercel it names none: the Sandbox SDK uses the OIDC token of the
 * deployment, and a declared name would make deploy copy a shell `VERCEL_TOKEN` to the host. A Cloudflare Sandbox uses
 * its binding and reads none.
 */
export function sandboxDeploymentEnv(
  config: AgentSandboxTaskConfig | false | undefined,
  driver: 'cloudflare' | 'vercel' | undefined,
  context: DeploymentEnvContext,
): DeploymentEnvEntry[] {
  if (config === false || driver !== 'vercel' || context.host === 'vercel') return []
  const configured = config?.driver === 'vercel' ? config : undefined
  return (['token', 'teamId', 'projectId'] as const).flatMap(option => configured?.[option]?.trim()
    ? []
    : [{ names: vercelCredentialEnv[option].names, required: true, secret: vercelCredentialEnv[option].secret, hasDefault: false, owners }])
}
