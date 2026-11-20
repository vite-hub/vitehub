import { resolveRemoteSandboxRuntime } from '../../../internal/remote.ts'
import { createTrustedHostRuntime } from '../../../internal/trusted-host.ts'

import type { ResolvedTaskSandbox } from '../provider-loader'

/**
 * `vite dev` runs each Sandbox Task as a Node process on this machine, in a temporary directory that the run removes.
 * The process is not isolated: the Sandbox `executionAuthority` says `isolation: "none"`.
 */
export function resolveLocalTaskSandbox(): ResolvedTaskSandbox {
  return {
    provider: 'local',
    resolveSandbox: async requirements => await resolveRemoteSandboxRuntime(createTrustedHostRuntime(), requirements),
  }
}
