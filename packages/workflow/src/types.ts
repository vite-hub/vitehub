export type WorkflowProvider = "cloudflare" | "vercel"

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

export type WorkflowProviderOptions =
  | CloudflareWorkflowProviderOptions
  | VercelWorkflowProviderOptions

export type WorkflowModuleOptions =
  | false
  | (WorkflowSharedOptions & { provider?: undefined })
  | WorkflowProviderOptions

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

export interface WorkflowExecutionContext<TPayload = unknown> {
  id?: string
  name: string
  payload: TPayload
  provider: WorkflowProvider
  step?: unknown
}

export type WorkflowHandler<TPayload = unknown, TResult = unknown> = (context: WorkflowExecutionContext<TPayload>) => TResult | Promise<TResult>

export interface WorkflowDefinitionOptions {
  id?: string
}

export interface WorkflowDefinition<TPayload = unknown, TResult = unknown> {
  handler: WorkflowHandler<TPayload, TResult>
  options?: WorkflowDefinitionOptions
}

export interface WorkflowStartOptions {
  id?: string
}

export interface WorkflowStartInput<TPayload = unknown> {
  id?: string
  payload?: TPayload
}

export interface WorkflowDefinitionRegistry {
  [name: string]: () => Promise<{ default?: WorkflowDefinition } | WorkflowDefinition>
}

export interface DiscoveredWorkflowDefinition {
  handler: string
  name: string
  source?: "nitro-server-workflows" | "vite-suffix"
}
