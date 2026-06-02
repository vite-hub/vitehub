export type WorkflowProvider = "cloudflare" | "openworkflow" | "vercel"

export interface CloudflareWorkflowBinding<TPayload = unknown> {
  create: (options?: { id?: string, params?: TPayload }) => Promise<CloudflareWorkflowInstance>
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

export interface CloudflareWorkflowProviderOptions extends WorkflowSharedOptions {
  provider: "cloudflare"
}

export interface VercelWorkflowProviderOptions extends WorkflowSharedOptions {
  provider: "vercel"
}

export interface OpenWorkflowPostgresOptions {
  namespaceId?: string
  runMigrations?: boolean
  schema?: string
  url?: string
}

export interface OpenWorkflowWorkerOptions {
  concurrency?: number
}

export interface OpenWorkflowProviderOptions extends WorkflowSharedOptions {
  postgres?: OpenWorkflowPostgresOptions
  provider: "openworkflow"
  worker?: OpenWorkflowWorkerOptions
}

export interface InferredWorkflowProviderOptions extends WorkflowSharedOptions {
  postgres?: OpenWorkflowPostgresOptions
  provider?: undefined
  worker?: OpenWorkflowWorkerOptions
}

export type WorkflowProviderOptions =
  | CloudflareWorkflowProviderOptions
  | OpenWorkflowProviderOptions
  | VercelWorkflowProviderOptions

export type WorkflowModuleProviderOptions =
  | InferredWorkflowProviderOptions
  | WorkflowProviderOptions

export type WorkflowModuleOptions =
  | false
  | WorkflowModuleProviderOptions

export type ResolvedWorkflowOptions = WorkflowProviderOptions

export interface WorkflowRun<TPayload = unknown, TResult = unknown> {
  id: string
  provider: WorkflowProvider
  result?: TResult
  status: WorkflowRunStatus
  metadata?: unknown
  payload?: TPayload
}

export type WorkflowRunStatus = "queued" | "running" | "completed" | "failed" | "unknown"

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
}

export type WorkflowStepRunner<TSteps extends Record<string, WorkflowStepFunction> = Record<string, WorkflowStepFunction>> = {
  [TName in keyof TSteps]: TSteps[TName]
}

export interface WorkflowExecutionContext<TPayload = unknown> {
  id?: string
  name: string
  payload: TPayload
  provider: WorkflowProvider
  step?: WorkflowProviderStep
  steps?: WorkflowStepRunner
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
}

export interface WorkflowDefinitionOptions {
  id?: string
  rootStep?: boolean
}

export interface WorkflowDefinition<TPayload = unknown, TResult = unknown> {
  handler: WorkflowHandler<TPayload, TResult>
  options?: WorkflowDefinitionOptions
}

export interface WorkflowHandle<TPayload = unknown, TResult = unknown> {
  defer: (payload?: TPayload, options?: WorkflowStartOptions) => Promise<WorkflowRun<TPayload>>
  getRun: (id: string) => Promise<WorkflowRun<TPayload, TResult>>
  name: string
  run: (payload?: TPayload, options?: WorkflowStartOptions) => Promise<WorkflowRun<TPayload, TResult>>
}

export interface WorkflowStartOptions {
  id?: string
}

export interface WorkflowDeferOptions extends WorkflowStartOptions {
  deferred?: boolean
}

export interface WorkflowDefinitionRegistry {
  [name: string]: () => Promise<{ default?: WorkflowDefinition, [exportName: string]: unknown } | WorkflowDefinition>
}

export interface DiscoveredWorkflowDefinition {
  handler: string
  name: string
  source?: "inline" | "server-workflows" | "vite-suffix"
  steps?: string[]
}
