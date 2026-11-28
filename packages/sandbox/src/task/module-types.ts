import type { SandboxNetworkPolicy, VercelSandboxNetworkPolicy, VercelSandboxSource } from '../index.ts'
import type { SandboxTaskProject } from './project'
import type { sandboxTaskRunErrors } from './runtime/result'
import type { SandboxTaskSizeOptions } from './size'

export type { SandboxTaskSizeOptions } from './size'

export type SandboxTaskDriver = 'cloudflare' | 'container' | 'vercel'

export interface CloudflareSandboxTaskOptions {
  sleepAfter?: string | number
  keepAlive?: boolean
  normalizeId?: boolean
}

export interface SandboxTaskDevOptions {
  /**
   * `vite dev` runs each Sandbox Task in a local Docker container, with no provider account.
   * Set `true` to use the host's Sandbox in `vite dev` too.
   */
  remote?: boolean
  /**
   * Run Sandbox Tasks in `vite dev` as Node processes on this machine, with no isolation, instead of in a Docker container.
   * Use it only for trusted code when Docker is not available. It has no effect outside `vite dev`.
   */
  unsafeHostProcess?: boolean
}

export interface ContainerSandboxTaskDriverOptions extends SandboxTaskSizeOptions, SandboxTaskDevOptions {
  driver: 'container'
  /** The image of the Sandbox container. It must have `sh` and `node`. Defaults to `node:24-bookworm`. */
  image?: string
  /** `"allow-all"` (default), `"deny-all"`, or `{ allow: hostnames }`. A limit other than `"allow-all"` needs rootful Docker Engine on Linux. */
  networkPolicy?: SandboxNetworkPolicy
  /** The Docker CLI command. Defaults to `docker`. Set `DOCKER_HOST` to use a remote daemon. */
  docker?: string
}

export interface VercelSandboxTaskDriverOptions extends SandboxTaskSizeOptions, SandboxTaskDevOptions {
  driver: 'vercel'
  runtime?: string
  ports?: number[]
  source?: VercelSandboxSource
  /** `"allow-all"` (default), `"deny-all"`, or `{ allow: hostnames }`. Vercel also takes `subnets`. */
  networkPolicy?: VercelSandboxNetworkPolicy
  token?: string
  teamId?: string
  projectId?: string
}

export interface CloudflareSandboxTaskDefinitionDriverOptions extends SandboxTaskSizeOptions, SandboxTaskDevOptions {
  driver: 'cloudflare'
  /** Maximum number of Containers that run at once. Defaults to 12. */
  maxInstances?: number
  binding?: string
  className?: string
  migrationTag?: string
  name?: string
  sandboxId?: string
  sleepAfter?: CloudflareSandboxTaskOptions['sleepAfter']
  keepAlive?: CloudflareSandboxTaskOptions['keepAlive']
  normalizeId?: CloudflareSandboxTaskOptions['normalizeId']
  /** `"allow-all"` (default), `"deny-all"`, or `{ allow: hostnames }`. Applies when the Container starts. */
  networkPolicy?: SandboxNetworkPolicy
}

export type SandboxTaskDefinitionDriverOptions
  = VercelSandboxTaskDriverOptions
    | CloudflareSandboxTaskDefinitionDriverOptions
    | ContainerSandboxTaskDriverOptions

export type AgentSandboxTaskConfig =
  | SandboxTaskDefinitionDriverOptions
  | ({ driver?: undefined, name?: string } & SandboxTaskSizeOptions & SandboxTaskDevOptions)

export interface SandboxTaskDefinitionBundle {
  entry: string
  execution?: 'definition' | 'module'
  modules: Record<string, string>
  project?: SandboxTaskProject
}

export interface SandboxTaskExecutionOptions {
  /** Passed to the handler; defaults to an empty object. */
  context?: Record<string, unknown>
  /** Abort this invocation and propagate the caller's abort reason. */
  signal?: AbortSignal
  sandboxId?: string
}

export type SandboxTaskRunArguments<TPayload> = undefined extends TPayload
  ? [payload?: TPayload, options?: SandboxTaskExecutionOptions]
  : [payload: TPayload, options?: SandboxTaskExecutionOptions]

/** The handler of a Sandbox Task. The runtime calls it with the payload of the run and the run context. */
export type SandboxTaskDefinitionHandler<TPayload = unknown, TResult = unknown> = (
  payload: TPayload,
  context: Record<string, unknown>,
) => TResult | Promise<TResult>

type SandboxTaskDefinitionPayload<THandler extends (...args: any[]) => any>
  = Parameters<THandler> extends [infer TPayload, ...unknown[]] ? TPayload : unknown

type SandboxTaskDefinitionResult<THandler extends (...args: any[]) => any>
  = Awaited<ReturnType<THandler>>

/** The limits on the values that cross the Sandbox boundary. Each limit is a whole number from 1 to 1073741824. */
export interface SandboxTaskTransferOptions {
  /** The largest payload and context JSON, in UTF-8 bytes. Default: 4194304 (4 MiB). */
  maxInputBytes?: number
  /** The largest result JSON, in UTF-8 bytes. Default: 4194304 (4 MiB). */
  maxOutputBytes?: number
  /** The deepest nesting of arrays and objects in one direction. Default: 32. */
  maxDepth?: number
  /** The largest number of `Blob`, `Uint8Array`, and `Buffer` values in one direction. Default: 64. */
  maxSidecars?: number
  /** The largest total size of the binary values in one direction, in bytes. Default: 67108864 (64 MiB). */
  maxSidecarBytes?: number
}

export interface SandboxTaskDefinitionOptions {
  timeout?: number
  env?: Record<string, string>
  /** The limits on the payload, the context, and the result of a run. */
  transfer?: SandboxTaskTransferOptions
}

export type SandboxTaskProjectOptions = Pick<SandboxTaskDefinitionOptions, 'timeout' | 'transfer'>

export interface SandboxTaskDefinitionInput<TPayload = unknown, TResult = unknown>
  extends SandboxTaskDefinitionOptions {
  /** Force project packaging on or off. Omit to detect project use automatically. */
  project?: boolean
  handler: SandboxTaskDefinitionHandler<TPayload, TResult>
}

export interface SandboxTaskDefinition<TPayload = unknown, TResult = unknown> {
  handler: SandboxTaskDefinitionHandler<TPayload, TResult>
  options?: SandboxTaskDefinitionOptions
}

export type SandboxTaskDefinitionFromHandler<THandler extends (...args: any[]) => any>
  = SandboxTaskDefinition<SandboxTaskDefinitionPayload<THandler>, SandboxTaskDefinitionResult<THandler>> & {
    handler: THandler
  }

/**
 * What `runSandboxTask()` returns: `[error, data]`. `data` is the decoded handler result. A failed run returns
 * `SANDBOX_TASK_RUN_FAILED`, with the failure in `error.cause`.
 */
export type SandboxTaskRunResult<TResult = unknown> =
  | [error: ReturnType<typeof sandboxTaskRunErrors.SANDBOX_TASK_RUN_FAILED>, data: undefined]
  | [error: undefined, data: TResult]

export function getSandboxTaskFeatureDriver(config?: AgentSandboxTaskConfig | false): SandboxTaskDefinitionDriverOptions | undefined {
  if (!config || typeof config !== 'object' || typeof config.driver !== 'string')
    return undefined

  return config as SandboxTaskDefinitionDriverOptions
}
