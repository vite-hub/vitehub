import { b as ResolvedQueueModuleOptions, i as CloudflareQueueMessageBatch, u as QueueDefinitionRegistry } from "../types-DHLfmgAh.js";

//#region src/runtime/cloudflare-vite.d.ts
type CloudflareWorkerEnv = Record<string, unknown>;
type CloudflareWorkerExecutionContext = {
  waitUntil?: (promise: Promise<unknown>) => void;
};
type CloudflareWorkerApp = {
  fetch?: (request: Request, context?: Record<string, unknown>) => Response | Promise<Response>;
  request?: (request: Request, options?: RequestInit, context?: Record<string, unknown>) => Response | Promise<Response>;
} | ((request: Request, context?: Record<string, unknown>) => Response | Promise<Response>);
interface QueueCloudflareWorkerOptions {
  app?: CloudflareWorkerApp;
  queue?: false | ResolvedQueueModuleOptions;
  registry?: QueueDefinitionRegistry;
}
interface QueueCloudflareWorker {
  fetch: (request: Request, env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext) => Promise<Response>;
  queue: (batch: CloudflareQueueMessageBatch, env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext) => Promise<void>;
}
declare function createQueueCloudflareWorker(options?: QueueCloudflareWorkerOptions): QueueCloudflareWorker;
//#endregion
export { CloudflareWorkerApp, CloudflareWorkerEnv, CloudflareWorkerExecutionContext, QueueCloudflareWorker, QueueCloudflareWorkerOptions, createQueueCloudflareWorker };