export type WorkflowProvider = "cloudflare" | "openworkflow" | "vercel"

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

/**
 * The OpenWorkflow worker that the Nitro server starts. `false` keeps the server from starting it, for apps that run
 * a separate worker process with `startOpenWorkflowWorker()`.
 */
export type OpenWorkflowWorkerOption = false | OpenWorkflowWorkerOptions

export interface OpenWorkflowProviderOptions extends WorkflowSharedOptions {
  postgres?: OpenWorkflowPostgresOptions
  provider: "openworkflow"
  /**
   * `vite dev` keeps runs in the local SQLite file, even when `DATABASE_URL` or `OPENWORKFLOW_POSTGRES_URL` is set.
   * `true` lets it use that storage, so the dev server can run the runs of a shared database. Builds ignore it.
   */
  remote?: boolean
  sqlite?: OpenWorkflowSqliteOptions
  worker?: OpenWorkflowWorkerOption
}

export interface InferredWorkflowProviderOptions extends WorkflowSharedOptions {
  postgres?: OpenWorkflowPostgresOptions
  provider?: undefined
  /** See `OpenWorkflowProviderOptions.remote`. */
  remote?: boolean
  sqlite?: OpenWorkflowSqliteOptions
  worker?: OpenWorkflowWorkerOption
}

export type WorkflowProviderOptions =
  | CloudflareWorkflowProviderOptions
  | OpenWorkflowProviderOptions
  | VercelWorkflowProviderOptions

export type WorkflowModuleProviderOptions =
  | InferredWorkflowProviderOptions
  | WorkflowProviderOptions

export type WorkflowOptions =
  | false
  | WorkflowModuleProviderOptions

export type ResolvedWorkflowOptions = WorkflowProviderOptions

export interface WorkflowRun<TPayload = unknown, TResult = unknown> {
  completedAt?: Date
  createdAt?: Date
  id: string
  provider: WorkflowProvider
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
  /** The time a sleep step wakes. Only a `context.sleep()` step has it. */
  sleepUntil?: Date
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
  /** Sleeps for a number of milliseconds. ViteHub names each sleep by call order. */
  sleep?: (name: string, milliseconds: number) => Promise<void>
  /** Sleeps until a date. Without it, ViteHub sleeps for the time that is left until the date. */
  sleepUntil?: (name: string, date: Date) => Promise<void>
}

export type WorkflowDurationUnit = "second" | "minute" | "hour" | "day" | "week" | "month" | "year"

/**
 * A sleep duration: milliseconds, or a string such as `'30 seconds'` or `'1 day'`. Cloudflare and OpenWorkflow read
 * this form the same way. A month is 30 days and a year is 365.25 days.
 */
export type WorkflowDuration = number | `${number} ${WorkflowDurationUnit}` | `${number} ${WorkflowDurationUnit}s`

/**
 * The step files of each folder Workflow, by Workflow name and step name. ViteHub writes it to
 * `.vitehub/workflow.d.ts` from the numbered files in `server/workflows/<name>/`.
 */
export interface WorkflowStepRegistry {}

/** A step runs one input through its step file, inside a durable provider step. */
export type WorkflowStep<TStep> = TStep extends (...args: infer TArguments) => infer TResult
  ? (...input: TArguments extends [] ? [] : TArguments extends [unknown, ...unknown[]] ? [input: TArguments[0]] : [input?: TArguments[0]]) => Promise<Awaited<TResult>>
  : never

/** The step functions of the Workflow `TName`. Empty for a Workflow without step files. */
export type WorkflowSteps<TName extends string = string> = TName extends keyof WorkflowStepRegistry
  ? { readonly [TStep in keyof WorkflowStepRegistry[TName]]: WorkflowStep<WorkflowStepRegistry[TName][TStep]> }
  : { readonly [TStep in never]: never }

/** Run data that a provider gives to ViteHub before ViteHub adds the step runner. */
export interface WorkflowProviderContext<TPayload = unknown> {
  id?: string
  name: string
  payload: TPayload
  provider: WorkflowProvider
  step?: WorkflowProviderStep
}

export interface WorkflowExecutionContext<TPayload = unknown, TName extends string = string> extends Omit<WorkflowProviderContext<TPayload>, "step"> {
  name: TName
  /** The provider step runner. Use `context.sleep()` to sleep. */
  step?: Omit<WorkflowProviderStep, "sleep" | "sleepUntil">
  /**
   * Sleeps for a duration such as `'1 day'` or a number of milliseconds, or until a `Date`. Only a folder Workflow's
   * `index.ts` can sleep. In a single-file Workflow it throws `WORKFLOW_ROOT_STEP_SLEEP`. The sleep is durable on
   * Cloudflare and OpenWorkflow. Inline runs (`vite dev` and Vercel handlers) wait with a timer, which is not durable.
   */
  sleep: (until: WorkflowDuration | Date) => Promise<void>
  /** Step functions from the numbered files in the Workflow folder. Empty when the Workflow has no step files. */
  steps: WorkflowSteps<TName>
}

export type WorkflowHandler<TPayload = unknown, TResult = unknown, TName extends string = string> = (
  payload: TPayload,
  context: WorkflowExecutionContext<TPayload, TName>,
) => TResult | Promise<TResult>

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

export interface WorkflowDefinition<TPayload = unknown, TResult = unknown, TName extends string = string> {
  /** @internal Identifies provider-generated Agent invocation recovery definitions. */
  internalAgentInvocationRecovery?: true
  handler: WorkflowHandler<TPayload, TResult, TName>
  /** The discovered Workflow name. `defineWorkflow()` sets it; inline and generated definitions may leave it out. */
  name?: string
  options?: WorkflowDefinitionOptions<TPayload, TResult>
}

/** Omission is valid only when the handler accepts undefined. */
export type WorkflowStartArguments<TPayload> = undefined extends TPayload
  ? [payload?: TPayload, options?: WorkflowStartOptions]
  : [payload: TPayload, options?: WorkflowStartOptions]

export interface WorkflowHandle<TPayload = unknown, TResult = unknown> {
  cancel: (id: string) => Promise<WorkflowRun<unknown, unknown>>
  /** Starts a run after the response, through `waitUntil`. A failure goes to the log. */
  defer: (...args: WorkflowStartArguments<TPayload>) => void
  getRun: (id: string) => Promise<WorkflowRun<unknown, unknown>>
  name: string
  start: (...args: WorkflowStartArguments<TPayload>) => Promise<WorkflowRun<TPayload, TResult>>
}

export interface WorkflowStartOptions {
  id?: string
}

export interface WorkflowSignalResult {
  id: string
  provider: WorkflowProvider
}

/**
 * Maps Workflow names to module loaders. The registry does not know each
 * payload type, so it uses `never` as the payload. A definition with any
 * payload type fits without a cast.
 */
export interface WorkflowDefinitionRegistry {
  [name: string]: (() => Promise<{ default?: WorkflowDefinition<never, unknown, never>, [exportName: string]: unknown } | WorkflowDefinition<never, unknown, never>>) & {
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
