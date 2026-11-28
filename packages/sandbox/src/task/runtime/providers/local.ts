import { resolveRemoteSandboxRuntime } from '../../../internal/remote.ts'
import { createTrustedHostRuntime } from '../../../internal/trusted-host.ts'
import { sandboxTaskErrorDiagnostics } from '../../error-diagnostics.ts'
import type { AgentSandboxTaskConfig } from '../../module-types'

import type { ResolvedTaskSandbox } from '../provider-loader'
import { resolveContainerTaskSandbox } from './container.ts'

/**
 * `vite dev` runs each Sandbox Task in a local Docker container that the run removes.
 * With `unsafeHostProcess: true`, it runs the task as a Node process on this machine instead, with no isolation:
 * the Sandbox `executionAuthority` says `isolation: "none"`.
 */
export async function resolveLocalTaskSandbox(config?: false | AgentSandboxTaskConfig): Promise<ResolvedTaskSandbox> {
  const options = config || {}
  if (!options.unsafeHostProcess)
    return await resolveContainerTaskSandbox({ provider: options })
  const policy = 'networkPolicy' in options ? options.networkPolicy : undefined
  if (policy !== undefined && policy !== 'allow-all')
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_LOCAL_NETWORK_POLICY()
  if (process.platform === 'win32')
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_LOCAL_WINDOWS()
  return {
    provider: 'local',
    resolveSandbox: async requirements => await resolveRemoteSandboxRuntime(createTrustedHostRuntime(), requirements),
  }
}
