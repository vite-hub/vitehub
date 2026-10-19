import type { VercelSandboxNetworkPolicy, VercelSandboxSource } from '@vite-hub/sandbox'
import type { SandboxTaskProject } from './project'

export type SandboxTaskProvider = 'cloudflare' | 'vercel'

export interface CloudflareSandboxTaskOptions {
  sleepAfter?: string | number
  keepAlive?: boolean
  normalizeId?: boolean
}

export interface VercelSandboxTaskProviderOptions {
  provider: 'vercel'
  runtime?: string
  timeout?: number
  cpu?: number
  ports?: number[]
  source?: VercelSandboxSource
  networkPolicy?: VercelSandboxNetworkPolicy
  token?: string
  teamId?: string
  projectId?: string
}

export interface CloudflareSandboxTaskDefinitionProviderOptions {
  provider: 'cloudflare'
  binding?: string
  className?: string
  migrationTag?: string
  name?: string
  sandboxId?: string
  sleepAfter?: CloudflareSandboxTaskOptions['sleepAfter']
  keepAlive?: CloudflareSandboxTaskOptions['keepAlive']
  normalizeId?: CloudflareSandboxTaskOptions['normalizeId']
}

export type SandboxTaskDefinitionProviderOptions
  = VercelSandboxTaskProviderOptions
    | CloudflareSandboxTaskDefinitionProviderOptions

export type AgentSandboxTaskConfig =
  | SandboxTaskDefinitionProviderOptions
  | { provider?: undefined, name?: string }

export interface SandboxTaskDefinitionBundle {
  entry: string
  execution?: 'definition' | 'module'
  modules: Record<string, string>
  project?: SandboxTaskProject
}

export interface SandboxTaskExecutionOptions {
  context?: Record<string, unknown>
  /** Abort this invocation and propagate the caller's abort reason. */
  signal?: AbortSignal
  sandboxId?: string
}

export type SandboxTaskDefinitionHandler<TPayload = unknown, TResult = unknown> = (
  payload?: TPayload,
  context?: Record<string, unknown>,
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
  run: SandboxTaskDefinitionHandler<TPayload, TResult>
}

export interface SandboxTaskDefinition<TPayload = unknown, TResult = unknown> {
  run: SandboxTaskDefinitionHandler<TPayload, TResult>
  options?: SandboxTaskDefinitionOptions
}

export type SandboxTaskDefinitionFromHandler<THandler extends (...args: any[]) => any>
  = SandboxTaskDefinition<SandboxTaskDefinitionPayload<THandler>, SandboxTaskDefinitionResult<THandler>> & {
    run: THandler
  }

/** The result of a sandbox invocation. HTTP semantics are used for both
 * successful values and failures. */
export type SandboxTaskRunResult = Response

export function getSandboxTaskFeatureProvider(config?: AgentSandboxTaskConfig | false): SandboxTaskDefinitionProviderOptions | undefined {
  if (!config || typeof config !== 'object' || typeof config.provider !== 'string')
    return undefined

  return config as SandboxTaskDefinitionProviderOptions
}
