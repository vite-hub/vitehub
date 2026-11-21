import type { DeploymentEnvContext, DeploymentEnvEntry } from '@vite-hub/internal/build/deployment-plan-output'

import type { AgentSandboxTaskConfig } from './module-types'

const owners = ['sandbox']

// The names that `providers/vercel.ts` reads when the config leaves a credential out.
const vercelCredentialNames = {
  token: { names: ['VITE_SANDBOX_TOKEN', 'VERCEL_TOKEN'], secret: true },
  teamId: { names: ['VITE_SANDBOX_TEAM_ID', 'VERCEL_TEAM_ID'], secret: false },
  projectId: { names: ['VITE_SANDBOX_PROJECT_ID', 'VERCEL_PROJECT_ID'], secret: false },
} as const

/**
 * The variables that Sandbox Tasks read on the deployed host. A Vercel Sandbox reads its token, team, and project from
 * env when the config leaves them out. On Vercel they are optional, since the Sandbox SDK then uses the OIDC token of
 * the deployment. A Cloudflare Sandbox uses its binding and reads none.
 */
export function sandboxDeploymentEnv(
  config: AgentSandboxTaskConfig | false | undefined,
  driver: 'cloudflare' | 'vercel' | undefined,
  context: DeploymentEnvContext,
): DeploymentEnvEntry[] {
  if (config === false || driver !== 'vercel') return []
  const configured = config?.driver === 'vercel' ? config : undefined
  const required = context.host !== 'vercel'
  return (['token', 'teamId', 'projectId'] as const).flatMap(option => configured?.[option]?.trim()
    ? []
    : [{ names: vercelCredentialNames[option].names, required, secret: vercelCredentialNames[option].secret, hasDefault: false, owners }])
}
