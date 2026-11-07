export type WorkflowDriver = "cloudflare" | "openworkflow" | "vercel"

export interface CloudflareWorkflowBinding<TPayload = unknown> {
  createBatch: (batch: Array<{ id: string, params?: TPayload }>) => Promise<CloudflareWorkflowInstance[]>
  get: (id: string) => Promise<CloudflareWorkflowInstance>
}

export interface CloudflareWorkflowInstance {
  id: string
  status: () => Promise<unknown>
}

export interface WorkflowSharedOptions {
  binding?: string
  name?: string
}

export interface CloudflareWorkflowDriverOptions extends WorkflowSharedOptions {
  driver: "cloudflare"
}

export interface VercelWorkflowDriverOptions extends WorkflowSharedOptions {
  driver: "vercel"
}

export interface OpenWorkflowPostgresOptions {
  namespaceId?: string
  runMigrations?: boolean
  schema?: string
  url?: WorkflowRuntimeConfigValue
}

export interface WorkflowRuntimeEnvDeclarationLike {
  default?: unknown
  kind: "env-variable"
  source?: {
    kind: "env"
    name: string
    names?: string[]
  }
}

export type WorkflowRuntimeConfigValue = string | WorkflowRuntimeEnvDeclarationLike

export interface OpenWorkflowSqliteOptions {
  namespaceId?: string
  path?: WorkflowRuntimeConfigValue
  runMigrations?: boolean
}

export interface OpenWorkflowWorkerOptions {
  concurrency?: number
}

export interface OpenWorkflowDriverOptions extends WorkflowSharedOptions {
  postgres?: OpenWorkflowPostgresOptions
  driver: "openworkflow"
  sqlite?: OpenWorkflowSqliteOptions
  worker?: OpenWorkflowWorkerOptions
}

export interface InferredWorkflowDriverOptions extends WorkflowSharedOptions {
  postgres?: OpenWorkflowPostgresOptions
  driver?: undefined
  sqlite?: OpenWorkflowSqliteOptions
  worker?: OpenWorkflowWorkerOptions
}

export type WorkflowDriverOptions =
  | CloudflareWorkflowDriverOptions
  | OpenWorkflowDriverOptions
  | VercelWorkflowDriverOptions

export type WorkflowModuleDriverOptions =
  | InferredWorkflowDriverOptions
  | WorkflowDriverOptions

export type WorkflowModuleOptions =
  | false
  | WorkflowModuleDriverOptions

export type ResolvedWorkflowOptions = WorkflowDriverOptions

export interface WorkflowRun<TPayload = unknown, TResult = unknown> {
  completedAt?: Date
  createdAt?: Date
  id: string
  provider: WorkflowDriver
  result?: TResult
  startedAt?: Date
  status: WorkflowRunStatus
  steps?: WorkflowRunStep[]
  metadata?: unknown
  payload?: TPayload
}

export type WorkflowRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown"

export interface WorkflowRunStep {
  attempt: number
  completedAt?: Date
  error?: { code?: string; message: string }
  id: string
  name: string
  startedAt?: Date
  status: WorkflowRunStatus
}

export interface WorkflowStepOptions {
  retries?: {
    backoff?: string
    delay?: string
    limit?: number
  }
}

export type WorkflowStepFunction<TInput = unknown, TResult = unknown> = (input: TInput) => TResult | Promise<TResult>

export interface WorkflowProviderStep {
  do?: <TResult>(
    name: string,
    options: WorkflowStepOptions,
    run: () => TResult | Promise<TResult>,
  ) => Promise<TResult>
  sleep?: (name: string, duration: string) => Promise<void>
}

export type WorkflowStepRunner<TSteps extends Record<string, WorkflowStepFunction> = Record<string, WorkflowStepFunction>> = {
  [TName in keyof TSteps]: TSteps[TName]
}

/** Run data that a provider gives to ViteHub before ViteHub adds the step runner. */
export interface WorkflowProviderContext<TPayload = unknown> {
  id?: string
  name: string
  payload: TPayload
  provider: WorkflowDriver
  step?: WorkflowProviderStep
}

export interface WorkflowExecutionContext<TPayload = unknown> extends WorkflowProviderContext<TPayload> {
  /** Step functions from the numbered files in the Workflow folder. Empty when the Workflow has no step files. */
  steps: WorkflowStepRunner
}

export type WorkflowHandler<TPayload = unknown, TResult = unknown> = (context: WorkflowExecutionContext<TPayload>) => TResult | Promise<TResult>

export type WorkflowRunIdValue =
  | boolean
  | null
  | number
  | string
  | undefined
  | { readonly [key: string]: WorkflowRunIdValue }
  | readonly WorkflowRunIdValue[]

export interface WorkflowCreateOptions<TPayload = unknown, TResult = unknown> {
  handler?: WorkflowHandler<TPayload, TResult>
  id?: (context: { name: string, payload?: TPayload }) => Promise<WorkflowRunIdValue> | WorkflowRunIdValue
  name?: string
  rootStep?: boolean
}

export interface WorkflowDefinitionOptions<TPayload = unknown, TResult = unknown> {
  id?: string
  /** Vercel native entry. Vercel calls it with the provider context only, so it gets no step runner. */
  native?: (context: WorkflowProviderContext<TPayload>) => TResult | Promise<TResult>
  rootStep?: boolean
}

export interface WorkflowDefinition<TPayload = unknown, TResult = unknown> {
  /** @internal Identifies provider-generated Agent invocation recovery definitions. */
  internalAgentInvocationRecovery?: true
  handler: WorkflowHandler<TPayload, TResult>
  options?: WorkflowDefinitionOptions<TPayload, TResult>
}

/** Omission is valid only when the handler accepts undefined. */
export type WorkflowStartArguments<TPayload> = undefined extends TPayload
  ? [payload?: TPayload, options?: WorkflowStartOptions]
  : [payload: TPayload, options?: WorkflowStartOptions]

export interface WorkflowHandle<TPayload = unknown, TResult = unknown> {
  cancel: (id: string) => Promise<WorkflowRun<unknown, unknown>>
  defer: (...args: WorkflowStartArguments<TPayload>) => Promise<WorkflowRun<TPayload>>
  getRun: (id: string) => Promise<WorkflowRun<unknown, unknown>>
  name: string
  run: (...args: WorkflowStartArguments<TPayload>) => Promise<WorkflowRun<TPayload, TResult>>
}

export interface WorkflowStartOptions {
  id?: string
}

export interface WorkflowDeferOptions extends WorkflowStartOptions {
  deferred?: boolean
}

export interface WorkflowSignalResult {
  id: string
  provider: WorkflowDriver
}

/**
 * Maps Workflow names to module loaders. The registry does not know each
 * payload type, so it uses `never` as the payload. A definition with any
 * payload type fits without a cast.
 */
export interface WorkflowDefinitionRegistry {
  [name: string]: (() => Promise<{ default?: WorkflowDefinition<never>, [exportName: string]: unknown } | WorkflowDefinition<never>>) & {
    /** @internal Identifies provider-generated Agent invocation recovery definitions without evaluating their modules. */
    internalAgentInvocationRecovery?: true
  }
}

export interface DiscoveredWorkflowDefinition {
  agentIdentity?: string
  handler: string
  name: string
  source?: "agent-workflow" | "agent-workflow-recovery" | "inline" | "server-workflows" | "vite-suffix"
  steps?: string[]
}
