import type { Result } from "@vite-hub/runtime"

export type QueueProvider = "cloudflare" | "vercel"

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

type VercelQueueMessageHandler<T = unknown> = (payload: T, metadata?: unknown) => unknown | Promise<unknown>

type VercelQueueCallbackReturn = (request: Request) => Promise<unknown> | unknown

export interface VercelQueueSDK {
  handleCallback: <TPayload = unknown>(handler: VercelQueueMessageHandler<TPayload>, options?: VercelQueueCallbackOptions) => VercelQueueCallbackReturn
  send: (topic: string, payload: unknown, options?: VercelQueueSendOptions) => Promise<VercelQueueSendResult>
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

export type QueueProviderOptions =
  | CloudflareQueueProviderOptions
  | VercelQueueProviderOptions

export type QueueModuleProviderOptions =
  | CloudflareQueueModuleProviderOptions
  | VercelQueueModuleProviderOptions

export type QueueModuleOptions =
  | false
  | (QueueSharedOptions & { namePrefix?: string; provider?: undefined })
  | QueueModuleProviderOptions

export type ResolvedQueueOptions = QueueModuleProviderOptions

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

/** Codes that `send()` of a Vercel QueueClient returns. */
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
 * `send()` returns `[error, data]`. `error.code` is one of the codes in the method type.
 */
export interface VercelQueueClient<TPayload = unknown> extends QueueClientBase<"vercel"> {
  readonly topic: string
  send: (payload: TPayload, options?: QueueEnqueueOptions) => Promise<Result<QueueSendResult, VercelQueueErrorCode>>
  callback: <TMessage = unknown>(handler: VercelQueueMessageHandler<TMessage>, options?: VercelQueueCallbackOptions) => VercelQueueCallbackReturn
}

interface QueueClientMap<TPayload> {
  cloudflare: CloudflareQueueClient<TPayload>
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
