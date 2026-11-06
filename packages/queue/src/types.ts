import type { Result } from "@vite-hub/runtime"

export type QueueProvider = "cloudflare" | "local" | "vercel"

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

export type CloudflareQueueBatchErrorAction =
  | "ack"
  | "retry"
  | { retry: CloudflareQueueRetryOptions }

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
  delaySeconds?: number
  idempotencyKey?: string
  retentionSeconds?: number
}

/** Options that apply to every job of a Vercel `sendBatch()` unless the job sets its own. */
export interface VercelQueueSendBatchOptions {
  delaySeconds?: number
  retentionSeconds?: number
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

export interface CloudflareQueueProviderOptions extends QueueSharedOptions {
  binding?: string | CloudflareQueueBinding
  provider: "cloudflare"
}

interface CloudflareQueueModuleProviderOptions extends QueueSharedOptions {
  binding?: string
  namePrefix?: string
  provider: "cloudflare"
}

export interface VercelQueueProviderOptions extends QueueSharedOptions {
  client?: VercelQueueSDK
  provider: "vercel"
  region?: string
  topic?: string
}

interface VercelQueueModuleProviderOptions extends QueueSharedOptions {
  provider: "vercel"
  region?: string
}

/**
 * The local provider keeps jobs in files under `base` and runs the Queue Definitions in this process.
 * The jobs survive a restart on the same host. They do not move to another host or container.
 */
export interface LocalQueueProviderOptions extends QueueSharedOptions {
  /** Directory of the stored jobs, relative to the working directory. Defaults to `.vitehub/data/queue`. */
  base?: string
  provider: "local"
  /** Queue Definition that receives the jobs. `getQueue()` sets it. */
  queue?: string
  /** The provider whose delivery rules the jobs follow. Defaults to `local`. `vite dev` sets the provider of the build. */
  rules?: LocalQueueRules
}

/**
 * The provider whose documented delivery rules the local provider follows: attempts, retry delay, the largest delay,
 * payload, and batch, and the enqueue options it accepts. In `vite dev`, a Cloudflare or Vercel app runs its jobs
 * with the local provider and the rules of its provider.
 */
export type LocalQueueRules = QueueProvider

interface LocalQueueModuleProviderOptions extends QueueSharedOptions {
  /** Directory of the stored jobs, relative to the working directory. Defaults to `.vitehub/data/queue`. */
  base?: string
  provider: "local"
}

export type QueueProviderOptions =
  | CloudflareQueueProviderOptions
  | LocalQueueProviderOptions
  | VercelQueueProviderOptions

export type QueueModuleProviderOptions =
  | CloudflareQueueModuleProviderOptions
  | LocalQueueModuleProviderOptions
  | VercelQueueModuleProviderOptions

export type QueueModuleOptions =
  | false
  | (QueueSharedOptions & { base?: string; namePrefix?: string; provider?: undefined })
  | QueueModuleProviderOptions

/** Local options after resolution. `vite dev` adds `rules` for a Cloudflare or Vercel app. */
export interface ResolvedLocalQueueOptions extends LocalQueueModuleProviderOptions {
  rules?: LocalQueueRules
}

export type ResolvedQueueOptions =
  | CloudflareQueueModuleProviderOptions
  | ResolvedLocalQueueOptions
  | VercelQueueModuleProviderOptions

export interface QueueJob<TPayload = unknown> {
  attempts: number
  id: string
  metadata?: unknown
  payload: TPayload
}

export type QueueHandler<TPayload = unknown, TResult = unknown> = (job: QueueJob<TPayload>) => TResult

export interface QueueDefinitionOptions {
  cache?: boolean
  callbackOptions?: VercelQueueCallbackOptions
  concurrency?: number
  onDispatchError?: (error: unknown, context: { name: string }) => unknown | Promise<unknown>
  onError?: CloudflareQueueBatchHandlerOptions["onError"]
}

export interface QueueDefinition<TPayload = unknown, TResult = unknown> {
  handler: QueueHandler<TPayload, TResult>
  options?: QueueDefinitionOptions
}

export interface QueueEnqueueOptions {
  id?: string
  contentType?: CloudflareQueueContentType
  delaySeconds?: number
  idempotencyKey?: string
  region?: string
  retentionSeconds?: number
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

/** Codes that `send()` and `sendBatch()` of a Cloudflare QueueClient return. */
export type CloudflareQueueErrorCode = "QUEUE_PROVIDER_FAILED" | "QUEUE_UNSUPPORTED_OPTION"

/** Codes that `send()` and `sendBatch()` of a local QueueClient return. */
export type LocalQueueErrorCode = "QUEUE_PROVIDER_FAILED" | "QUEUE_UNSUPPORTED_OPTION"

/** One job in `sendBatch()` of a local QueueClient. */
export interface LocalQueueSendBatchMessage<T = unknown> {
  body: T
  delaySeconds?: number
  idempotencyKey?: string
}

/** Codes that `send()` and `sendBatch()` of a Vercel QueueClient return. */
export type VercelQueueErrorCode = QueueErrorCode

interface QueueClientBase<P extends QueueProvider = QueueProvider> {
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
  sendBatch: (items: CloudflareQueueSendBatchMessage<TPayload>[], options?: Omit<QueueEnqueueOptions, "id">) => Promise<Result<QueueSendResult[], CloudflareQueueErrorCode>>
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
  sendBatch: (items: LocalQueueSendBatchMessage<TPayload>[], options?: { delaySeconds?: number }) => Promise<Result<QueueSendResult[], LocalQueueErrorCode>>
}

interface QueueClientMap<TPayload> {
  cloudflare: CloudflareQueueClient<TPayload>
  local: LocalQueueClient<TPayload>
  vercel: VercelQueueClient<TPayload>
}

export type QueueClient<P extends QueueProvider = QueueProvider, TPayload = unknown> = QueueClientMap<TPayload>[P]

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
  handler: string
  name: string
  source?: "server-queues" | "vite-suffix"
}
