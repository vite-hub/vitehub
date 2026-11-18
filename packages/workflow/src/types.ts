import type { Result } from "@vite-hub/runtime"

export type WorkflowDriver = "cloudflare" | "openworkflow" | "vercel"

export interface CloudflareWorkflowBinding<TPayload = unknown> {
  createBatch: (batch: Array<{ id: string, params?: TPayload }>) => Promise<CloudflareWorkflowInstance[]>
  get: (id: string) => Promise<CloudflareWorkflowInstance>
}

export interface CloudflareWorkflowInstance {
  id: string
  status: () => Promise<unknown>
  /** Stops the instance. Cloudflare rejects the call when the instance has already finished. */
  terminate: () => Promise<void>
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
  /** How many runs one worker executes at once. Defaults to 10. Each Agent turn uses two runs. */
  concurrency?: number
}

/**
 * The OpenWorkflow worker that the Nitro server starts. `false` keeps the server from starting it, for apps that run
 * a separate worker process with `startOpenWorkflowWorker()`.
 */
export type OpenWorkflowWorkerOption = false | OpenWorkflowWorkerOptions

export interface OpenWorkflowDriverOptions extends WorkflowSharedOptions {
  postgres?: OpenWorkflowPostgresOptions
  driver: "openworkflow"
  /**
   * `vite dev` keeps runs in the local SQLite file, even when `DATABASE_URL` or `OPENWORKFLOW_POSTGRES_URL` is set.
   * `true` lets it use that storage, so the dev server can run the runs of a shared database. Builds ignore it.
   */
  remote?: boolean
  sqlite?: OpenWorkflowSqliteOptions
  worker?: OpenWorkflowWorkerOption
}

export interface InferredWorkflowDriverOptions extends WorkflowSharedOptions {
  postgres?: OpenWorkflowPostgresOptions
  driver?: undefined
  /** See `OpenWorkflowProviderOptions.remote`. */
  remote?: boolean
  sqlite?: OpenWorkflowSqliteOptions
  worker?: OpenWorkflowWorkerOption
}

export type WorkflowDriverOptions =
  | CloudflareWorkflowDriverOptions
  | OpenWorkflowDriverOptions
  | VercelWorkflowDriverOptions

export type WorkflowModuleDriverOptions =
  | InferredWorkflowDriverOptions
  | WorkflowDriverOptions

export type WorkflowOptions =
  | false
  | WorkflowModuleDriverOptions

export type ResolvedWorkflowOptions = WorkflowDriverOptions

/** The failure of a failed Workflow Run. Every provider fills it, and it is safe to send as JSON. */
export interface WorkflowRunError {
  /** Code of the thrown error, when it has one. */
  code?: string
  message: string
  /** Name of the thrown error, when it is not `Error`. */
  name?: string
}

export interface WorkflowRun<TPayload = unknown, TResult = unknown> {
  completedAt?: Date
  createdAt?: Date
  /** Set when `status` is `failed`. */
  error?: WorkflowRunError
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
  /** The time a sleep step wakes. Only a `context.sleep()` step has it. */
  sleepUntil?: Date
  startedAt?: Date
  status: WorkflowRunStatus
}

/** How the wait between retries grows: `exponential` doubles it after each retry, `constant` keeps it. */
export type WorkflowStepBackoff = "constant" | "exponential"

/** When a step runs again after it throws. The defaults are `{ limit: 3, delay: '10 seconds', backoff: 'exponential' }`. */
export interface WorkflowStepRetries {
  backoff?: WorkflowStepBackoff
  /** How long to wait before the first retry. */
  delay?: WorkflowDuration
  /** How many times to run the step again after the first attempt fails. `0` runs it once. */
  limit?: number
}

/**
 * The options of one step. A step file exports them as `retries` and `timeout`. `timeout` is the time limit of one
 * attempt: when it passes, the step's `signal` aborts and the attempt fails with `WORKFLOW_STEP_TIMEOUT`.
 */
export interface WorkflowStepOptions {
  retries?: WorkflowStepRetries
  timeout?: WorkflowDuration
}

/** The second argument of a step function. */
export interface WorkflowStepContext {
  /** Aborts when the `timeout` of the step passes. Pass it to `fetch()` and other calls that take a signal. */
  signal: AbortSignal
}

export type WorkflowStepFunction<TInput = unknown, TResult = unknown> = (input: TInput, context: WorkflowStepContext) => TResult | Promise<TResult>

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
  provider: WorkflowDriver
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
  /** @internal Identifies the Agent Workflow handler that the Agent package creates for an Agent turn. */
  internalAgentWorkflow?: true
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
  /** @internal Identifies the inline Agent Workflow handler that the Agent package creates for an Agent turn. */
  internalAgentWorkflow?: true
  handler: WorkflowHandler<TPayload, TResult, TName>
  /** The discovered Workflow name. `defineWorkflow()` sets it; inline and generated definitions may leave it out. */
  name?: string
  options?: WorkflowDefinitionOptions<TPayload, TResult>
}

/** Omission is valid only when the handler accepts undefined. */
export type WorkflowStartArguments<TPayload> = undefined extends TPayload
  ? [payload?: TPayload, options?: WorkflowStartOptions]
  : [payload: TPayload, options?: WorkflowStartOptions]

/**
 * Codes that `startWorkflow()`, `getWorkflowRun()`, `cancelWorkflow()`, `resumeWorkflow()`, and the methods of a
 * WorkflowHandle return in the `[error, data]` tuple. Config errors throw instead.
 */
export type WorkflowResultErrorCode =
  | "WORKFLOW_CLOUDFLARE_RUN_ID_INVALID"
  | "WORKFLOW_OPERATION_UNSUPPORTED"
  | "WORKFLOW_PROVIDER_OPERATION_FAILED"
  | "WORKFLOW_R0014"
  | "WORKFLOW_RUN_ID_UNSUPPORTED"
  | "WORKFLOW_START_DELAY_INVALID"

/** `cancel()`, `getRun()`, and `start()` return `[error, data]`, as `cancelWorkflow()`, `getWorkflowRun()`, and `startWorkflow()` do. */
export interface WorkflowHandle<TPayload = unknown, TResult = unknown> {
  cancel: (id: string) => Promise<Result<WorkflowRun<unknown, unknown>, WorkflowResultErrorCode>>
  /** Starts a run after the response, through `waitUntil`. A failure goes to the log. */
  defer: (...args: WorkflowStartArguments<TPayload>) => void
  getRun: (id: string) => Promise<Result<WorkflowRun<unknown, unknown>, WorkflowResultErrorCode>>
  name: string
  start: (...args: WorkflowStartArguments<TPayload>) => Promise<Result<WorkflowRun<TPayload, TResult>, WorkflowResultErrorCode>>
}

/** Milliseconds, a duration such as `"30 minutes"` or `"3 days"`, or a `Date` that the run must not start before. */
export type WorkflowStartDelay = number | string | Date

export interface WorkflowStartOptions {
  /** Starts the run later. A `Date` in the past starts it now. */
  delay?: WorkflowStartDelay
  id?: string
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
