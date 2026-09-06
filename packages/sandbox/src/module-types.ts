import type { ViteHubError } from '@vite-hub/runtime'
import type { VercelBoxNetworkPolicy, VercelBoxSource } from '@vite-hub/box'
import type { SandboxProject } from './project'

export type SandboxProvider = 'cloudflare' | 'vercel'

export interface CloudflareSandboxOptions {
  sleepAfter?: string | number
  keepAlive?: boolean
  normalizeId?: boolean
}

export interface VercelSandboxProviderOptions {
  provider: 'vercel'
  runtime?: string
  timeout?: number
  cpu?: number
  ports?: number[]
  source?: VercelBoxSource
  networkPolicy?: VercelBoxNetworkPolicy
  token?: string
  teamId?: string
  projectId?: string
}

export interface CloudflareSandboxDefinitionProviderOptions {
  provider: 'cloudflare'
  binding?: string
  className?: string
  migrationTag?: string
  name?: string
  sandboxId?: string
  sleepAfter?: CloudflareSandboxOptions['sleepAfter']
  keepAlive?: CloudflareSandboxOptions['keepAlive']
  normalizeId?: CloudflareSandboxOptions['normalizeId']
}

export type SandboxDefinitionProviderOptions
  = VercelSandboxProviderOptions
    | CloudflareSandboxDefinitionProviderOptions

export type AgentSandboxConfig =
  | SandboxDefinitionProviderOptions
  | { provider?: undefined, name?: string }

export interface SandboxDefinitionBundle {
  entry: string
  execution?: 'definition' | 'module'
  modules: Record<string, string>
  project?: SandboxProject
}

export interface SandboxExecutionOptions {
  context?: Record<string, unknown>
  sandboxId?: string
}

export type SandboxDefinitionHandler<TPayload = unknown, TResult = unknown> = (
  payload?: TPayload,
  context?: Record<string, unknown>,
) => TResult | Promise<TResult>

type SandboxDefinitionPayload<THandler extends (...args: any[]) => any>
  = Parameters<THandler> extends [infer TPayload, ...unknown[]] ? TPayload : unknown

type SandboxDefinitionResult<THandler extends (...args: any[]) => any>
  = Awaited<ReturnType<THandler>>

export interface SandboxDefinitionOptions {
  timeout?: number
  env?: Record<string, string>
}

export interface SandboxProjectOptions {
  timeout?: number
}

export interface SandboxDefinitionInput<TPayload = unknown, TResult = unknown>
  extends SandboxDefinitionOptions {
  /** Force project packaging on or off. Omit to detect project use automatically. */
  project?: boolean
  run: SandboxDefinitionHandler<TPayload, TResult>
}

export interface SandboxDefinition<TPayload = unknown, TResult = unknown> {
  run: SandboxDefinitionHandler<TPayload, TResult>
  options?: SandboxDefinitionOptions
}

export type SandboxDefinitionFromHandler<THandler extends (...args: any[]) => any>
  = SandboxDefinition<SandboxDefinitionPayload<THandler>, SandboxDefinitionResult<THandler>> & {
    run: THandler
  }

export type SandboxRunResult<TResult = unknown> =
  | [error: null, value: TResult]
  | [error: ViteHubError<`SANDBOX_${string}`>, value: undefined]

export function getSandboxFeatureProvider(config?: AgentSandboxConfig | false): SandboxDefinitionProviderOptions | undefined {
  if (!config || typeof config !== 'object' || typeof config.provider !== 'string')
    return undefined

  return config as SandboxDefinitionProviderOptions
}
