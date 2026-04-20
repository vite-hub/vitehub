//#region src/types.d.ts
type QueueProvider = "cloudflare" | "vercel";
type CloudflareQueueContentType = "bytes" | "json" | "text" | "v8";
interface CloudflareQueueSendOptions {
  contentType?: CloudflareQueueContentType;
  delaySeconds?: number;
}
interface CloudflareQueueSendBatchOptions {
  delaySeconds?: number;
}
interface CloudflareQueueSendBatchMessage<T = unknown> extends CloudflareQueueSendOptions {
  body: T;
}
interface CloudflareQueueRetryOptions {
  delaySeconds?: number;
}
interface CloudflareQueueBinding {
  send: <T = unknown>(body: T, options?: CloudflareQueueSendOptions) => Promise<unknown>;
  sendBatch: <T = unknown>(messages: Iterable<CloudflareQueueSendBatchMessage<T>>, options?: CloudflareQueueSendBatchOptions) => Promise<unknown>;
}
interface CloudflareQueueMessage<T = unknown> {
  ack: () => void;
  attempts: number;
  body: T;
  id: string;
  retry: (options?: CloudflareQueueRetryOptions) => void;
  timestamp?: Date;
}
interface CloudflareQueueMessageBatch<T = unknown> {
  ackAll: () => void;
  messages: CloudflareQueueMessage<T>[];
  queue: string;
  retryAll: (options?: CloudflareQueueRetryOptions) => void;
}
type CloudflareQueueBatchErrorAction = "ack" | "retry" | {
  retry: CloudflareQueueRetryOptions;
};
interface CloudflareQueueBatchHandlerOptions<T = unknown> {
  concurrency?: number;
  onError?: (error: unknown, message: CloudflareQueueMessage<T>, batch: CloudflareQueueMessageBatch<T>) => CloudflareQueueBatchErrorAction | void | Promise<CloudflareQueueBatchErrorAction | void>;
  onMessage: (message: CloudflareQueueMessage<T>, batch: CloudflareQueueMessageBatch<T>) => unknown | Promise<unknown>;
}
type VercelQueueRetryDirective = {
  acknowledge: true;
} | {
  afterSeconds: number;
};
type VercelQueueRetryHandler = (error: unknown, metadata: unknown) => VercelQueueRetryDirective | void;
interface VercelQueueCallbackOptions {
  retry?: VercelQueueRetryHandler;
  visibilityTimeoutSeconds?: number;
}
interface VercelQueueSendOptions {
  delaySeconds?: number;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  region?: string;
  retentionSeconds?: number;
}
interface VercelQueueSendResult {
  messageId?: string | null;
}
type VercelQueueMessageHandler<T = unknown> = (payload: T, metadata?: unknown) => unknown | Promise<unknown>;
type VercelQueueCallbackReturn = (request: Request) => Promise<unknown> | unknown;
type VercelQueueNodeCallbackReturn = (req: unknown, res: unknown) => Promise<unknown> | unknown;
interface VercelQueueSDK {
  handleCallback: <TPayload = unknown>(handler: VercelQueueMessageHandler<TPayload>, options?: VercelQueueCallbackOptions) => VercelQueueCallbackReturn;
  handleNodeCallback?: <TPayload = unknown>(handler: VercelQueueMessageHandler<TPayload>, options?: VercelQueueCallbackOptions) => VercelQueueNodeCallbackReturn;
  send: (topic: string, payload: unknown, options?: VercelQueueSendOptions) => Promise<VercelQueueSendResult>;
}
interface QueueSharedOptions {
  cache?: boolean;
}
interface CloudflareQueueProviderOptions extends QueueSharedOptions {
  binding?: string | CloudflareQueueBinding;
  provider: "cloudflare";
}
interface CloudflareQueueModuleProviderOptions extends QueueSharedOptions {
  binding?: string;
  provider: "cloudflare";
}
interface VercelQueueProviderOptions extends QueueSharedOptions {
  client?: VercelQueueSDK;
  provider: "vercel";
  region?: string;
  topic?: string;
}
interface VercelQueueModuleProviderOptions extends QueueSharedOptions {
  provider: "vercel";
  region?: string;
}
type QueueProviderOptions = CloudflareQueueProviderOptions | VercelQueueProviderOptions;
type QueueModuleProviderOptions = CloudflareQueueModuleProviderOptions | VercelQueueModuleProviderOptions;
type QueueModuleOptions = false | (QueueSharedOptions & {
  provider?: undefined;
}) | QueueModuleProviderOptions;
interface ResolvedCloudflareQueueModuleProviderOptions extends CloudflareQueueModuleProviderOptions {
  provider: "cloudflare";
}
interface ResolvedVercelQueueModuleProviderOptions extends VercelQueueModuleProviderOptions {
  provider: "vercel";
}
type ResolvedQueueModuleProviderOptions = ResolvedCloudflareQueueModuleProviderOptions | ResolvedVercelQueueModuleProviderOptions;
interface ResolvedQueueModuleOptions {
  provider: ResolvedQueueModuleProviderOptions;
}
interface QueueJob<TPayload = unknown> {
  attempts: number;
  id: string;
  metadata?: unknown;
  payload: TPayload;
}
type QueueHandler<TPayload = unknown, TResult = unknown> = (job: QueueJob<TPayload>) => TResult;
interface QueueDefinitionOptions {
  cache?: boolean;
  callbackOptions?: VercelQueueCallbackOptions;
  concurrency?: number;
  onDispatchError?: (error: unknown, context: {
    name: string;
  }) => unknown | Promise<unknown>;
  onError?: CloudflareQueueBatchHandlerOptions["onError"];
}
type CreateQueueDefinitionInput<TPayload = unknown, TResult = unknown> = {
  handler: QueueHandler<TPayload, TResult>;
} & QueueDefinitionOptions;
interface QueueDefinition<TPayload = unknown, TResult = unknown> {
  handler: QueueHandler<TPayload, TResult>;
  options?: QueueDefinitionOptions;
}
interface QueueEnqueueOptions {
  contentType?: CloudflareQueueContentType;
  delaySeconds?: number;
  idempotencyKey?: string;
  region?: string;
  retentionSeconds?: number;
}
type QueueEnqueueEnvelope<TPayload = unknown> = {
  payload: TPayload;
  contentType?: CloudflareQueueContentType;
  delaySeconds?: number;
  id?: string;
  idempotencyKey?: string;
  region?: string;
  retentionSeconds?: number;
};
type QueueEnqueueInput<TPayload = unknown> = TPayload | QueueEnqueueEnvelope<TPayload>;
type QueueSendResult = {
  messageId?: string;
  status: "queued";
};
interface QueueClientBase<P extends QueueProvider = QueueProvider> {
  readonly native: unknown;
  readonly provider: P;
  send: <TPayload = unknown>(input: QueueEnqueueInput<TPayload>) => Promise<QueueSendResult>;
}
interface CloudflareQueueClient extends QueueClientBase<"cloudflare"> {
  readonly binding: CloudflareQueueBinding;
  createBatchHandler: <TPayload = unknown>(options: CloudflareQueueBatchHandlerOptions<TPayload>) => (batch: CloudflareQueueMessageBatch<TPayload>) => Promise<void>;
  sendBatch: (items: CloudflareQueueSendBatchMessage[], options?: QueueEnqueueOptions) => Promise<QueueSendResult[]>;
}
interface VercelQueueClient extends QueueClientBase<"vercel"> {
  readonly topic: string;
  callback: <TPayload = unknown>(handler: VercelQueueMessageHandler<TPayload>, options?: VercelQueueCallbackOptions) => VercelQueueCallbackReturn;
  nodeCallback: <TPayload = unknown>(handler: VercelQueueMessageHandler<TPayload>, options?: VercelQueueCallbackOptions) => VercelQueueNodeCallbackReturn;
}
interface QueueClientMap {
  cloudflare: CloudflareQueueClient;
  vercel: VercelQueueClient;
}
type QueueClient<P extends QueueProvider = QueueProvider> = QueueClientMap[P];
interface QueueDefinitionRegistry {
  [name: string]: () => Promise<{
    default?: QueueDefinition;
  } | QueueDefinition>;
}
interface DiscoveredQueueDefinition {
  handler: string;
  name: string;
  source?: "vite-suffix";
}
//#endregion
export { VercelQueueNodeCallbackReturn as C, VercelQueueSendResult as E, VercelQueueClient as S, VercelQueueRetryHandler as T, QueueProvider as _, CreateQueueDefinitionInput as a, ResolvedQueueModuleOptions as b, QueueDefinition as c, QueueEnqueueInput as d, QueueEnqueueOptions as f, QueueModuleProviderOptions as g, QueueModuleOptions as h, CloudflareQueueMessageBatch as i, QueueDefinitionOptions as l, QueueJob as m, CloudflareQueueClient as n, DiscoveredQueueDefinition as o, QueueHandler as p, CloudflareQueueMessage as r, QueueClient as s, CloudflareQueueBatchHandlerOptions as t, QueueDefinitionRegistry as u, QueueProviderOptions as v, VercelQueueRetryDirective as w, VercelQueueCallbackOptions as x, QueueSendResult as y };