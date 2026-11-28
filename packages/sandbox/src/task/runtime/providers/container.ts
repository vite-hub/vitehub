import type { Sandbox, SandboxNetworkPolicy, SandboxOpenOptions, VercelSandboxNetworkPolicy } from '../../../index.ts'
import type { ContainerSandboxEgress } from '../../../internal/container.ts'
import { createContainerRuntime } from '../../../internal/container.ts'
import { resolveRemoteSandboxRuntime } from '../../../internal/remote.ts'
import { sandboxTaskErrorDiagnostics } from '../../error-diagnostics.ts'
import { readSandboxTaskErrorMetadata } from '../error-normalization.ts'
import type { SandboxTaskDefinitionDriverOptions } from '../../module-types'
import { readSandboxTaskSize } from '../../size.ts'
import type { ResolvedTaskSandbox } from '../provider-loader'

/** The image of a Sandbox Task container when the config sets no `image`. It has Node, npm, Corepack, and git. */
export const defaultContainerSandboxTaskImage = 'node:24-bookworm'

type ContainerTaskOptions = Partial<SandboxTaskDefinitionDriverOptions> & {
  docker?: string
  image?: string
  networkPolicy?: SandboxNetworkPolicy | VercelSandboxNetworkPolicy
}

/**
 * Runs each Sandbox Task in a new Docker container that the run removes. The Docker CLI must reach a daemon:
 * the local daemon, a mounted `/var/run/docker.sock`, or `DOCKER_HOST`.
 */
export async function resolveContainerTaskSandbox(options: { provider?: ContainerTaskOptions }): Promise<ResolvedTaskSandbox> {
  const provider = options.provider ?? {}
  const size = readSandboxTaskSize(provider)
  const runtime = createContainerRuntime({
    image: provider.driver === 'container' && provider.image ? provider.image : defaultContainerSandboxTaskImage,
    egress: containerEgress(provider.networkPolicy),
    ...(provider.driver === 'container' && provider.docker ? { docker: provider.docker } : {}),
    ...(size.cpu === undefined ? {} : { cpus: size.cpu }),
    ...(size.memory === undefined ? {} : { memoryBytes: Math.round(size.memory * 1024 * 1024) }),
  })
  return {
    provider: 'container',
    resolveSandbox: async (requirements) => {
      const sandbox = await resolveRemoteSandboxRuntime(runtime, requirements)
      return Object.freeze<Sandbox>({
        ...sandbox,
        async open(openOptions?: SandboxOpenOptions) {
          try {
            return await sandbox.open(openOptions)
          }
          catch (error) {
            if (readSandboxTaskErrorMetadata(error)?.code === 'SANDBOX_DOCKER_UNAVAILABLE')
              throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_DOCKER_UNAVAILABLE({ cause: error, detail: (error as Error).message.replace(/^.*?cannot reach a Docker daemon: /, '') })
            throw error
          }
        },
      })
    },
  }
}

function containerEgress(policy: SandboxNetworkPolicy | VercelSandboxNetworkPolicy | undefined): ContainerSandboxEgress {
  if (policy === undefined || policy === 'allow-all')
    return 'open'
  if (policy === 'deny-all')
    return 'none'
  if (typeof policy === 'object' && policy && !('subnets' in policy) && Array.isArray(policy.allow))
    return policy.allow.includes('*') ? 'open' : policy.allow.length ? { allow: policy.allow } : 'none'
  throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_CONTAINER_NETWORK_POLICY()
}
