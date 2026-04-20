import { C as VercelQueueNodeCallbackReturn, E as VercelQueueSendResult, S as VercelQueueClient, T as VercelQueueRetryHandler, _ as QueueProvider, a as CreateQueueDefinitionInput, b as ResolvedQueueModuleOptions, c as QueueDefinition, d as QueueEnqueueInput, f as QueueEnqueueOptions, g as QueueModuleProviderOptions, h as QueueModuleOptions, i as CloudflareQueueMessageBatch, l as QueueDefinitionOptions, m as QueueJob, n as CloudflareQueueClient, o as DiscoveredQueueDefinition, p as QueueHandler, r as CloudflareQueueMessage, s as QueueClient, t as CloudflareQueueBatchHandlerOptions, v as QueueProviderOptions, w as VercelQueueRetryDirective, x as VercelQueueCallbackOptions, y as QueueSendResult } from "./types-DHLfmgAh.js";
import { handleHostedVercelQueueCallback } from "./runtime/hosted.js";
import { createQueueCloudflareWorker } from "./runtime/cloudflare-vite.js";

//#region src/config.d.ts
interface QueueResolutionInput {
  hosting?: string;
}
declare function normalizeQueueOptions(options: QueueModuleOptions | undefined, input?: QueueResolutionInput): ResolvedQueueModuleOptions | undefined;
//#endregion
//#region src/definition.d.ts
declare function defineQueue<TPayload = unknown, TResult = unknown>(handler: QueueHandler<TPayload, TResult>, options?: QueueDefinitionOptions): QueueDefinition<TPayload, TResult>;
declare function createQueue<TPayload = unknown, TResult = unknown>(input: CreateQueueDefinitionInput<TPayload, TResult>): QueueDefinition<TPayload, TResult>;
//#endregion
//#region src/enqueue.d.ts
declare function createQueueMessageId(prefix?: string): string;
//#endregion
//#region src/errors.d.ts
interface QueueErrorMetadata {
  cause?: unknown;
  code?: string;
  details?: Record<string, unknown>;
  httpStatus?: number;
  method?: string;
  provider?: string;
}
declare class QueueError extends Error {
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly httpStatus?: number;
  readonly method?: string;
  readonly provider?: string;
  override readonly cause?: unknown;
  constructor(message: string, metadata?: QueueErrorMetadata);
}
//#endregion
//#region src/providers/cloudflare.d.ts
declare function createCloudflareQueueBatchHandler<TPayload = unknown>(options: CloudflareQueueBatchHandlerOptions<TPayload>): (batch: CloudflareQueueMessageBatch<TPayload>) => Promise<void>;
//#endregion
//#region src/integrations/cloudflare.d.ts
declare function getCloudflareQueueName(name: string): string;
declare function getCloudflareQueueBindingName(name: string): string;
declare function getCloudflareQueueDefinitionName(name: string): string;
//#endregion
//#region src/integrations/vercel.d.ts
declare function getVercelQueueTopicName(name: string): string;
//#endregion
//#region src/runtime/client.d.ts
declare function createQueueClient(options: QueueProviderOptions): Promise<QueueClient>;
declare function getQueue(name: string): Promise<QueueClient>;
declare function runQueue<TPayload = unknown>(name: string, input: QueueEnqueueInput<TPayload>): Promise<QueueSendResult>;
declare function deferQueue<TPayload = unknown>(name: string, input: QueueEnqueueInput<TPayload>): void;
//#endregion
export { type CloudflareQueueBatchHandlerOptions, type CloudflareQueueClient, type CloudflareQueueMessage, type CloudflareQueueMessageBatch, type CreateQueueDefinitionInput, type DiscoveredQueueDefinition, type QueueClient, type QueueDefinition, type QueueDefinitionOptions, type QueueEnqueueInput, type QueueEnqueueOptions, QueueError, type QueueHandler, type QueueJob, type QueueModuleOptions, type QueueModuleProviderOptions, type QueueProvider, type QueueProviderOptions, type QueueSendResult, type VercelQueueCallbackOptions, type VercelQueueClient, type VercelQueueNodeCallbackReturn, type VercelQueueRetryDirective, type VercelQueueRetryHandler, type VercelQueueSendResult, createCloudflareQueueBatchHandler, createQueue, createQueueClient, createQueueCloudflareWorker, createQueueMessageId, deferQueue, defineQueue, getCloudflareQueueBindingName, getCloudflareQueueDefinitionName, getCloudflareQueueName, getQueue, getVercelQueueTopicName, handleHostedVercelQueueCallback, normalizeQueueOptions, runQueue };