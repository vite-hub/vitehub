import type { SandboxNetworkPolicy, VercelSandboxNetworkPolicy, VercelSandboxSource } from '../index.ts'
import type { SandboxTaskProject } from './project'
import type { sandboxTaskRunErrors } from './runtime/result'
import type { SandboxTaskSizeOptions } from './size'

export type { SandboxTaskSizeOptions } from './size'

export type SandboxTaskDriver = 'cloudflare' | 'vercel'

export interface CloudflareSandboxTaskOptions {
  sleepAfter?: string | number
  keepAlive?: boolean
  normalizeId?: boolean
}

export interface VercelSandboxTaskDriverOptions extends SandboxTaskSizeOptions {
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

export interface CloudflareSandboxTaskDefinitionDriverOptions extends SandboxTaskSizeOptions {
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

export type AgentSandboxTaskConfig =
  | SandboxTaskDefinitionDriverOptions
  | ({ driver?: undefined, name?: string } & SandboxTaskSizeOptions)

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

export interface SandboxTaskDefinitionOptions {
  timeout?: number
  env?: Record<string, string>
}

export interface SandboxTaskProjectOptions {
  timeout?: number
}

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
