import type { Duration, Result } from "@vite-hub/runtime"

export type QueueDriver = "cloudflare" | "local" | "postgres" | "vercel"

/** The Queue drivers that run jobs in a Node server process. */
export type NodeQueueDriver = "local" | "postgres"

type CloudflareQueueContentType = "bytes" | "json" | "text" | "v8"

interface CloudflareQueueSendOptions {
  contentType?: CloudflareQueueContentType
  delaySeconds?: number
}

interface CloudflareQueueSendBatchOptions {
  delaySeconds?: number
}

interface CloudflareQueueSendBatchMessage<T = unknown> extends CloudflareQueueSendOptions {
  body: T
}

/** One job in `sendBatch()` of a Cloudflare QueueClient. */
export interface CloudflareQueueSendBatchItem<T = unknown> {
  body: T
  contentType?: CloudflareQueueContentType
  /** Time before delivery, such as `"1m"`. */
  delay?: Duration
}

interface CloudflareQueueRetryOptions {
  delaySeconds?: number
}

export interface CloudflareQueueBinding {
  send: <T = unknown>(body: T, options?: CloudflareQueueSendOptions) => Promise<unknown>
  sendBatch: <T = unknown>(messages: Iterable<CloudflareQueueSendBatchMessage<T>>, options?: CloudflareQueueSendBatchOptions) => Promise<unknown>
}

export interface CloudflareQueueMessage<T = unknown> {
  ack: () => void
  attempts: number
  body: T
  id: string
  retry: (options?: CloudflareQueueRetryOptions) => void
  timestamp?: Date
}

export interface CloudflareQueueMessageBatch<T = unknown> {
  ackAll: () => void
  messages: CloudflareQueueMessage<T>[]
  queue: string
  retryAll: (options?: CloudflareQueueRetryOptions) => void
}

/** What `onError` returns: `"ack"`, `"retry"`, or `{ retry: { delay: "30s" } }` to retry after a time. */
export type CloudflareQueueBatchErrorAction =
  | "ack"
  | "retry"
  | { retry: { delay?: Duration } }

export interface CloudflareQueueBatchHandlerOptions<T = unknown> {
  concurrency?: number
  onError?: (error: unknown, message: CloudflareQueueMessage<T>, batch: CloudflareQueueMessageBatch<T>) => CloudflareQueueBatchErrorAction | void | Promise<CloudflareQueueBatchErrorAction | void>
  onMessage: (message: CloudflareQueueMessage<T>, batch: CloudflareQueueMessageBatch<T>) => unknown | Promise<unknown>
}

export type VercelQueueRetryDirective =
  | { acknowledge: true }
  | { afterSeconds: number }

export type VercelQueueRetryHandler = (error: unknown, metadata: unknown) => VercelQueueRetryDirective | void

export interface VercelQueueCallbackOptions {
  retry?: VercelQueueRetryHandler
  visibilityTimeoutSeconds?: number
}

interface VercelQueueSendOptions {
  delaySeconds?: number
  headers?: Record<string, string>
  idempotencyKey?: string
  region?: string
  retentionSeconds?: number
}

export interface VercelQueueSendResult {
  messageId?: string | null
}

interface VercelQueueBatchSendMessage extends Omit<VercelQueueSendOptions, "headers" | "region"> {
  payload: unknown
}

/** Result of one message in a `@vercel/queue` `sendBatch()` request, in input order. */
export type VercelQueueBatchSendResult =
  | { messageId: string, status: "sent" }
  | { messageId: null, status: "deferred" }
  | { error: string, retryable: boolean, status: "failed", statusCode: number }

/**
 * One job in `sendBatch()` of a Vercel QueueClient. Omitted `idempotencyKey` values are generated anew on each call.
 * Supply a stable key from the first attempt to deduplicate retries.
 */
export interface VercelQueueSendBatchMessage<T = unknown> {
  body: T
  /** Time before delivery, such as `"1m"`. */
  delay?: Duration
  idempotencyKey?: string
  /** How long Vercel keeps the job: a duration such as `"1h"`, or a number of seconds. */
  retention?: Duration | number
}

/** Options that apply to every job of a Vercel `sendBatch()` unless the job sets its own. */
export interface VercelQueueSendBatchOptions {
  delay?: Duration
  retention?: Duration | number
}

type VercelQueueMessageHandler<T = unknown> = (payload: T, metadata?: unknown) => unknown | Promise<unknown>

type VercelQueueCallbackReturn = (request: Request) => Promise<unknown> | unknown

export interface VercelQueueSDK {
  handleCallback: <TPayload = unknown>(handler: VercelQueueMessageHandler<TPayload>, options?: VercelQueueCallbackOptions) => VercelQueueCallbackReturn
  send: (topic: string, payload: unknown, options?: VercelQueueSendOptions) => Promise<VercelQueueSendResult>
  /** `@vercel/queue` 0.10 and later. A custom client without it makes `sendBatch()` fail with `QUEUE_PROVIDER_FAILED`. */
  sendBatch?: (topic: string, messages: readonly VercelQueueBatchSendMessage[]) => Promise<readonly VercelQueueBatchSendResult[]>
}

export interface QueueSharedOptions {
  cache?: boolean
}

export interface CloudflareQueueDriverOptions extends QueueSharedOptions {
  binding?: string | CloudflareQueueBinding
  driver: "cloudflare"
}

interface CloudflareQueueModuleDriverOptions extends QueueSharedOptions {
  binding?: string
  namePrefix?: string
  driver: "cloudflare"
}

export interface VercelQueueDriverOptions extends QueueSharedOptions {
  client?: VercelQueueSDK
  driver: "vercel"
  region?: string
  topic?: string
}

interface VercelQueueModuleDriverOptions extends QueueSharedOptions {
  driver: "vercel"
  region?: string
}

/**
 * The local driver keeps jobs in files under `base` and runs the Queue Definitions in this process.
 * The jobs survive a restart on the same host. They do not move to another host or container.
 */
export interface LocalQueueDriverOptions extends QueueSharedOptions {
  /** Directory of the stored jobs, relative to the working directory. Defaults to `.vitehub/data/queue`. */
  base?: string
  driver: "local"
  /** Queue Definition that receives the jobs. `useQueue()` sets it. */
  queue?: string
  /** The driver whose delivery rules the jobs follow. Defaults to `local`. `vite dev` sets the driver of the build. */
  rules?: LocalQueueRules
}

/**
 * The driver whose documented delivery rules the local driver follows: attempts, retry delay, the largest delay,
 * payload, and batch, and the enqueue options it accepts. In `vite dev`, a Cloudflare or Vercel app runs its jobs
 * with the local driver and the rules of its hosted driver.
 */
export type LocalQueueRules = QueueDriver

interface LocalQueueModuleDriverOptions extends QueueSharedOptions {
  /** Directory of the stored jobs, relative to the working directory. Defaults to `.vitehub/data/queue`. */
  base?: string
  driver: "local"
}

/**
 * The postgres driver keeps jobs in the `vitehub_queue_jobs` table of a Postgres database. Every server process
 * that runs the app takes jobs from the table, so the jobs survive a restart and spread over all instances.
 * It uses the connection of the Default Database. `QUEUE_POSTGRES_URL` overrides it at runtime.
 */
export interface PostgresQueueDriverOptions extends QueueSharedOptions {
  /** The Database whose Postgres connection Queue uses. The build sets `default` when the Default Database is on Postgres. */
  database?: string
  driver: "postgres"
  /** Queue Definition that receives the jobs. `getQueue()` sets it. */
  queue?: string
}

interface PostgresQueueModuleDriverOptions extends QueueSharedOptions {
  driver: "postgres"
}

/** Postgres options after resolution. The build adds `database` when the Default Database is on Postgres. */
export interface ResolvedPostgresQueueOptions extends PostgresQueueModuleDriverOptions {
  database?: string
}

export type QueueDriverOptions =
  | CloudflareQueueDriverOptions
  | LocalQueueDriverOptions
  | PostgresQueueDriverOptions
  | VercelQueueDriverOptions

export type QueueModuleDriverOptions =
  | CloudflareQueueModuleDriverOptions
  | LocalQueueModuleDriverOptions
  | PostgresQueueModuleDriverOptions
  | VercelQueueModuleDriverOptions

export type QueueOptions =
  | false
  | (QueueSharedOptions & { base?: string; namePrefix?: string; driver?: undefined })
  | QueueModuleDriverOptions

/** Local options after resolution. `vite dev` adds `rules` for a Cloudflare or Vercel app. */
export interface ResolvedLocalQueueOptions extends LocalQueueModuleDriverOptions {
  rules?: LocalQueueRules
}

export type ResolvedQueueOptions =
  | CloudflareQueueModuleDriverOptions
  | ResolvedLocalQueueOptions
  | ResolvedPostgresQueueOptions
  | VercelQueueModuleDriverOptions

/** The one object that a Queue handler receives: the `payload` that was sent, and the delivery details. */
export interface QueueJob<TPayload = unknown> {
  /** Delivery count of this job, from 1. */
  attempts: number
  /** Message ID of this job. */
  id: string
  /** Delivery metadata of the provider, when it gives some. */
  metadata?: unknown
  payload: TPayload
}

export type QueueHandler<TPayload = unknown, TResult = unknown> = (job: QueueJob<TPayload>) => TResult

/** Options of `defineQueue()`, next to `handler`. */
export interface QueueDefinitionOptions {
  cache?: boolean
  callbackOptions?: VercelQueueCallbackOptions
  concurrency?: number
  onDispatchError?: (error: unknown, context: { name: string }) => unknown | Promise<unknown>
  onError?: CloudflareQueueBatchHandlerOptions["onError"]
}

/** A Queue Definition: `defineQueue({ handler, ...options })`. */
export interface QueueDefinition<TPayload = unknown, TResult = unknown> extends QueueDefinitionOptions {
  handler: QueueHandler<TPayload, TResult>
}

/**
 * Options of `sendQueue()` and `send()`. ViteHub generates the message ID. To deduplicate sends, pass `idempotencyKey`
 * on a provider that supports it.
 */
export interface QueueEnqueueOptions {
  contentType?: CloudflareQueueContentType
  /** Time before delivery, such as `"30s"`, `"5m"`, or `"1 day"`. A number fails with `RUNTIME_DURATION_INVALID`. */
  delay?: Duration
  idempotencyKey?: string
  region?: string
  /** How long the provider keeps the job: a duration such as `"1h"`, or a number of seconds. */
  retention?: Duration | number
}

export type QueueSendResult = {
  messageId?: string
  status: "queued"
}

export interface NormalizedQueueEnqueueInput<TPayload = unknown> {
  id: string
  options: QueueEnqueueOptions
  payload: TPayload
}

/** Codes that Queue operations return in the `[error, data]` tuple. Config errors throw instead. */
export type QueueErrorCode =
  | "QUEUE_PROVIDER_FAILED"
  | "QUEUE_PROVIDER_INVALID_RESPONSE"
  | "QUEUE_UNSUPPORTED_OPTION"
  | "RUNTIME_DURATION_INVALID"

/** Codes that `send()` and `sendBatch()` of a Cloudflare QueueClient return. */
export type CloudflareQueueErrorCode = "QUEUE_PROVIDER_FAILED" | "QUEUE_UNSUPPORTED_OPTION" | "RUNTIME_DURATION_INVALID"

/** Codes that `send()` and `sendBatch()` of a local QueueClient return. */
export type LocalQueueErrorCode = "QUEUE_PROVIDER_FAILED" | "QUEUE_UNSUPPORTED_OPTION" | "RUNTIME_DURATION_INVALID"

/** Codes that `send()` and `sendBatch()` of a postgres QueueClient return. */
export type PostgresQueueErrorCode = "QUEUE_PROVIDER_FAILED" | "QUEUE_UNSUPPORTED_OPTION" | "RUNTIME_DURATION_INVALID"

/** One job in `sendBatch()` of a local or postgres QueueClient. */
export interface LocalQueueSendBatchMessage<T = unknown> {
  body: T
  /** Time before delivery, such as `"1m"`. */
  delay?: Duration
  idempotencyKey?: string
}

/** Codes that `send()` and `sendBatch()` of a Vercel QueueClient return. */
export type VercelQueueErrorCode = QueueErrorCode

interface QueueClientBase<P extends QueueDriver = QueueDriver> {
  readonly native: unknown
  readonly provider: P
}

/**
 * `send()` and `sendBatch()` return `[error, data]`. `error.code` is one of the codes in the method type.
 */
export interface CloudflareQueueClient<TPayload = unknown> extends QueueClientBase<"cloudflare"> {
  readonly binding: CloudflareQueueBinding
  createBatchHandler: <TMessage = unknown>(options: CloudflareQueueBatchHandlerOptions<TMessage>) => (batch: CloudflareQueueMessageBatch<TMessage>) => Promise<void>
  send: (payload: TPayload, options?: QueueEnqueueOptions) => Promise<Result<QueueSendResult, CloudflareQueueErrorCode>>
  sendBatch: (items: CloudflareQueueSendBatchItem<TPayload>[], options?: QueueEnqueueOptions) => Promise<Result<QueueSendResult[], CloudflareQueueErrorCode>>
}

/**
 * `send()` and `sendBatch()` return `[error, data]`. `error.code` is one of the codes in the method type.
 */
export interface VercelQueueClient<TPayload = unknown> extends QueueClientBase<"vercel"> {
  readonly topic: string
  send: (payload: TPayload, options?: QueueEnqueueOptions) => Promise<Result<QueueSendResult, VercelQueueErrorCode>>
  /**
   * Sends 1 to 100 jobs in one `@vercel/queue` request. When any job fails, it returns `QUEUE_PROVIDER_FAILED`
   * with the per-job results in `error.cause.results`. Request-level failures can occur after jobs are accepted.
   * To retry safely, supply the same caller-provided `idempotencyKey` on every job from the first attempt.
   * Generated keys change on each call and do not deduplicate retries.
   */
  sendBatch: (items: VercelQueueSendBatchMessage<TPayload>[], options?: VercelQueueSendBatchOptions) => Promise<Result<QueueSendResult[], VercelQueueErrorCode>>
  callback: <TMessage = unknown>(handler: VercelQueueMessageHandler<TMessage>, options?: VercelQueueCallbackOptions) => VercelQueueCallbackReturn
}

/**
 * `send()` stores the job under `base` and returns when the file is written. This process then runs the
 * Queue Definition. `send()` and `sendBatch()` return `[error, data]`.
 */
export interface LocalQueueClient<TPayload = unknown> extends QueueClientBase<"local"> {
  readonly queue: string
  send: (payload: TPayload, options?: QueueEnqueueOptions) => Promise<Result<QueueSendResult, LocalQueueErrorCode>>
  sendBatch: (items: LocalQueueSendBatchMessage<TPayload>[], options?: { delay?: Duration }) => Promise<Result<QueueSendResult[], LocalQueueErrorCode>>
}

/**
 * `send()` inserts the job in the Postgres table and returns when the insert commits. Any server process of the app
 * then runs the Queue Definition. `send()` and `sendBatch()` return `[error, data]`.
 */
export interface PostgresQueueClient<TPayload = unknown> extends QueueClientBase<"postgres"> {
  readonly queue: string
  send: (payload: TPayload, options?: QueueEnqueueOptions) => Promise<Result<QueueSendResult, PostgresQueueErrorCode>>
  /** Inserts all jobs in one transaction. When one insert fails, no job of the batch is stored. */
  sendBatch: (items: LocalQueueSendBatchMessage<TPayload>[], options?: { delay?: Duration }) => Promise<Result<QueueSendResult[], PostgresQueueErrorCode>>
}

interface QueueClientMap<TPayload> {
  cloudflare: CloudflareQueueClient<TPayload>
  local: LocalQueueClient<TPayload>
  postgres: PostgresQueueClient<TPayload>
  vercel: VercelQueueClient<TPayload>
}

export type QueueClient<P extends QueueDriver = QueueDriver, TPayload = unknown> = QueueClientMap<TPayload>[P]

/** Discovered Queue Definitions. Generated declarations extend this interface. */
export interface QueueRegistry {}

export type QueueName = Extract<keyof QueueRegistry, string>
export type QueuePayload<TName extends QueueName> = QueueRegistry[TName] extends { handler: (job: infer TJob) => unknown }
  ? TJob extends QueueJob<infer TPayload> ? TPayload : never
  : never

export interface QueueDefinitionRegistry {
  [name: string]: () => Promise<{ default?: QueueDefinition } | QueueDefinition>
}

export interface DiscoveredQueueDefinition {
  /** Plugin that contributed this Definition through `vitehub.queues`, when it was not found in the app. */
  contributor?: string
  handler: string
  name: string
  /** Why the contributing plugin adds this Definition. */
  reason?: string
  source?: "server-queues" | "vite-plugin-contribution" | "vite-suffix"
}

/** The last delivery error of a stored job, as `vitehub queue jobs` shows it. */
export interface QueueDeliveryErrorDetails {
  code?: string
  details?: Readonly<Record<string, unknown>>
  docs?: string
  fix?: string
  message: string
  name: string
  stack?: string
}

/** The delivery rules that the local engine applies. */
export interface LocalQueueDeliveryRules {
  /** Deliveries before a failing job becomes a dead job. `Infinity` retries until the job expires. */
  maxAttempts: number
  /** Largest `delay`, in seconds, that a send accepts. */
  maxDelaySeconds?: number
  /** Largest number of jobs in one `sendBatch()`. */
  maxBatchJobs?: number
  /** Largest JSON size in bytes of all payloads of one `sendBatch()`. */
  maxBatchBytes?: number
  /** Largest JSON size in bytes of one payload. */
  maxPayloadBytes?: number
  /** Accepted `retention`, in seconds. A job expires at the end of its retention, whether it ran or not. */
  retention?: { defaultSeconds: number, maxSeconds: number, minSeconds: number }
  /** Milliseconds before the next delivery after `attempts` failed deliveries. */
  retryDelayMs: (attempts: number) => number
  /** The provider whose documented rules these are. */
  rules: LocalQueueRules
  /** Enqueue options that fail with `QUEUE_UNSUPPORTED_OPTION`. */
  unsupportedOptions: readonly ("contentType" | "idempotencyKey" | "region" | "retention")[]
}

export interface LocalQueueStatus {
  /** Absolute directory of the local provider, or the Postgres table and database, without the password. */
  base: string
  /** Dead jobs kept per Queue Definition. Older dead jobs are deleted. */
  deadLimit: number
  /**
   * `single-host`: the jobs survive a restart of this host. Another host or a new container does not see them.
   * `shared`: the postgres provider keeps the jobs in Postgres, and every instance of the app takes jobs from it.
   */
  durability: "shared" | "single-host"
  queues: Record<string, { dead: number, pending: number, running: number }>
}

/** One stored job, as `vitehub queue jobs list` shows it. Times are ISO strings. */
export interface LocalQueueJob {
  attempts: number
  /** When a pending job runs next. */
  availableAt: string
  enqueuedAt: string
  /** The last delivery error. A pending job has one after a failed attempt. */
  error?: QueueDeliveryErrorDetails
  /** When the job expires, for Vercel rules. */
  expiresAt?: string
  /** When the job became dead. */
  failedAt?: string
  /** The message ID that `runQueue()` returned. */
  id: string
  queue: string
  state: "dead" | "pending" | "running"
}

/** One stored job with its payload, as `vitehub queue jobs get` shows it. */
export interface LocalQueueJobDetail extends LocalQueueJob {
  /** The local provider only: the file of the job. */
  file?: string
  idempotencyKey?: string
  payload?: unknown
}

/** Which jobs `jobs()` lists. */
export interface QueueJobsFilter {
  queue?: string
  state?: LocalQueueJob["state"]
}

/** Which jobs `clear()` removes. Running jobs always stay. */
export interface LocalQueueClearFilter {
  queue?: string
  state?: "dead" | "pending"
}

/**
 * The stored jobs of a provider that ViteHub can read: the local and the postgres provider. The Queue operations,
 * so `vitehub queue jobs` and the Console, read jobs through it.
 */
export interface QueueJobStore {
  /** The directory of the local provider, or the Postgres table and database, without the password. */
  readonly base: string
  /** Removes the stored jobs that match, except running jobs. Returns how many it removed. */
  clear: (filter?: LocalQueueClearFilter) => Promise<number>
  /** The newest stored job with this message ID, with its payload. */
  job: (id: string) => Promise<LocalQueueJobDetail | undefined>
  /** The stored jobs, newest first. The postgres provider applies `filter` and returns at most 1,000 jobs. */
  jobs: (filter?: QueueJobsFilter) => Promise<LocalQueueJob[]>
  readonly provider: "local" | "postgres"
  /**
   * Runs the newest stored job with this message ID now. A dead job gets a new set of attempts. A pending job keeps
   * its attempts and does not wait for its delay or retry delay. A running job is not changed. `duplicate`: a newer
   * live job holds the `idempotencyKey` of the dead job.
   */
  retry: (id: string) => Promise<LocalQueueJob | "duplicate" | "missing" | "running">
  readonly rules: LocalQueueDeliveryRules
  status: () => Promise<LocalQueueStatus>
}
