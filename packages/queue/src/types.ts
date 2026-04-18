export type QueueProvider = "cloudflare" | "vercel"
export type InternalQueueProvider = QueueProvider | "memory"

export type CloudflareQueueContentType = "bytes" | "json" | "text" | "v8"

export interface CloudflareQueueSendOptions {
  contentType?: CloudflareQueueContentType
  delaySeconds?: number
}

export interface CloudflareQueueSendBatchOptions {
  delaySeconds?: number
}

export interface CloudflareQueueSendBatchMessage<T = unknown> extends CloudflareQueueSendOptions {
  body: T
}

export interface CloudflareQueueRetryOptions {
  delaySeconds?: number
}

export interface CloudflareQueueBinding {
  send: <T = unknown>(body: T, options?: CloudflareQueueSendOptions) => Promise<unknown>
  sendBatch: <T = unknown>(
    messages: Iterable<CloudflareQueueSendBatchMessage<T>>,
    options?: CloudflareQueueSendBatchOptions,
  ) => Promise<unknown>
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
export type CloudflareQueueBatchErrorAction = "ack" | "retry" | { retry: CloudflareQueueRetryOptions }

export interface CloudflareQueueBatchHandlerOptions<T = unknown> {
  concurrency?: number
  onError?: (
    error: unknown,
    message: CloudflareQueueMessage<T>,
    batch: CloudflareQueueMessageBatch<T>,
  ) => CloudflareQueueBatchErrorAction | void | Promise<CloudflareQueueBatchErrorAction | void>
  onMessage: (message: CloudflareQueueMessage<T>, batch: CloudflareQueueMessageBatch<T>) => unknown | Promise<unknown>
}

export type VercelQueueRetryDirective = { acknowledge: true } | { afterSeconds: number }
export type VercelQueueRetryHandler = (error: unknown, metadata: unknown) => VercelQueueRetryDirective | void

export interface VercelQueueCallbackOptions {
  retry?: VercelQueueRetryHandler
  visibilityTimeoutSeconds?: number
}

export interface VercelQueueSendOptions {
  delaySeconds?: number
  headers?: Record<string, string>
  idempotencyKey?: string
  region?: string
  retentionSeconds?: number
}

export interface VercelQueueSendResult {
  messageId?: string | null
}

export type VercelQueueMessageHandler<T = unknown> =
  (payload: T, metadata?: unknown) => unknown | Promise<unknown>

export type VercelQueueCallbackReturn = (request: Request) => Promise<unknown> | unknown
export type VercelQueueNodeCallbackReturn = (req: unknown, res: unknown) => Promise<unknown> | unknown

export interface VercelQueueSDK {
  handleCallback: <TPayload = unknown>(
    handler: VercelQueueMessageHandler<TPayload>,
    options?: VercelQueueCallbackOptions,
  ) => VercelQueueCallbackReturn
  handleNodeCallback?: <TPayload = unknown>(
    handler: VercelQueueMessageHandler<TPayload>,
    options?: VercelQueueCallbackOptions,
  ) => VercelQueueNodeCallbackReturn
  send: (topic: string, payload: unknown, options?: VercelQueueSendOptions) => Promise<VercelQueueSendResult>
}

export interface MemoryQueueStoreItem<T = unknown> {
  enqueuedAt: Date
  messageId: string
  payload: T
}

export interface MemoryQueueStore {
  messages: MemoryQueueStoreItem[]
}

export interface MemoryQueueProviderOptions {
  cache?: boolean
  provider: "memory"
  store?: MemoryQueueStore
}

export interface CloudflareQueueProviderOptions {
  binding?: string | CloudflareQueueBinding
  cache?: boolean
  provider: "cloudflare"
}

export interface VercelQueueProviderOptions {
  cache?: boolean
  client?: VercelQueueSDK
  provider: "vercel"
  region?: string
  topic?: string
}

export type QueueProviderOptions =
  | CloudflareQueueProviderOptions
  | VercelQueueProviderOptions

export type InternalQueueProviderOptions =
  | QueueProviderOptions
  | MemoryQueueProviderOptions

export type QueueModuleOptions =
  | false
  | { cache?: boolean, provider?: undefined }
  | QueueProviderOptions

export interface ResolvedQueueModuleOptions {
  provider: InternalQueueProviderOptions
}

export interface QueueJob<TPayload = unknown> {
  attempts: number
  id: string
  metadata?: unknown
  payload: TPayload
  signal: AbortSignal
}

export type QueueHandler<TPayload = unknown, TResult = unknown> =
  (job: QueueJob<TPayload>) => TResult | Promise<TResult>

export interface QueueDefinitionOptions {
  cache?: boolean
  callbackOptions?: VercelQueueCallbackOptions
  concurrency?: number
  onError?: CloudflareQueueBatchHandlerOptions["onError"]
}

export interface QueueDefinition<TPayload = unknown, TResult = unknown> {
  handler: QueueHandler<TPayload, TResult>
  options?: QueueDefinitionOptions
}

export interface CreateQueueDefinitionInput<TPayload = unknown, TResult = unknown>
  extends QueueDefinitionOptions {
  handler: QueueHandler<TPayload, TResult>
}

export interface QueueEnqueueOptions {
  contentType?: CloudflareQueueContentType
  delaySeconds?: number
  idempotencyKey?: string
  region?: string
  retentionSeconds?: number
}

export type QueueEnqueueInput<TPayload = unknown> =
  | TPayload
  | (QueueEnqueueOptions & {
    id?: string
    payload: TPayload
  })

export type QueueSendResult = { messageId?: string, status: "queued" }

export interface QueueClientBase<P extends string = QueueProvider> {
  readonly native: unknown
  readonly provider: P
  send: <TPayload = unknown>(input: QueueEnqueueInput<TPayload>) => Promise<QueueSendResult>
}

export interface MemoryQueueClient extends QueueClientBase<"memory"> {
  drain: (handler: (payload: unknown, meta: { enqueuedAt: Date, messageId: string }) => unknown | Promise<unknown>) => Promise<number>
  peek: (limit?: number) => MemoryQueueStoreItem[]
  sendBatch: (items: Array<{ id?: string, payload: unknown }>) => Promise<QueueSendResult[]>
  size: () => number
}

export interface CloudflareQueueClient extends QueueClientBase<"cloudflare"> {
  readonly binding: CloudflareQueueBinding
  createBatchHandler: <TPayload = unknown>(
    options: CloudflareQueueBatchHandlerOptions<TPayload>,
  ) => (batch: CloudflareQueueMessageBatch<TPayload>) => Promise<void>
  sendBatch: (
    items: CloudflareQueueSendBatchMessage[],
    options?: QueueEnqueueOptions,
  ) => Promise<QueueSendResult[]>
}

export interface VercelQueueClient extends QueueClientBase<"vercel"> {
  readonly topic: string
  callback: <TPayload = unknown>(
    handler: VercelQueueMessageHandler<TPayload>,
    options?: VercelQueueCallbackOptions,
  ) => VercelQueueCallbackReturn
  nodeCallback: <TPayload = unknown>(
    handler: VercelQueueMessageHandler<TPayload>,
    options?: VercelQueueCallbackOptions,
  ) => VercelQueueNodeCallbackReturn
}

export type QueueClient = CloudflareQueueClient | VercelQueueClient
export type InternalQueueClient = QueueClient | MemoryQueueClient

export interface QueueDefinitionRegistry {
  [name: string]: () => Promise<{ default?: QueueDefinition } | QueueDefinition>
}

export interface DiscoveredQueueDefinition {
  handler: string
  name: string
}
