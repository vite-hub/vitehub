import { h as QueueModuleOptions } from "./types-DHLfmgAh.js";
import { Plugin } from "vite";

//#region src/internal/vite-build.d.ts
interface CloudflareQueueConfigOptions {
  compatibilityDate?: string;
  rootDir?: string;
}
interface CloudflareQueueConfig {
  assets?: {
    directory?: string;
    run_worker_first: string[];
  };
  compatibility_date: string;
  compatibility_flags: string[];
  main: string;
  name?: string;
  observability: {
    enabled: true;
  };
  queues?: {
    consumers: Array<{
      queue: string;
    }>;
    producers: Array<{
      binding: string;
      queue: string;
    }>;
  };
}
declare function createCloudflareQueueConfig(options?: CloudflareQueueConfigOptions): Promise<CloudflareQueueConfig>;
//#endregion
//#region src/vite.d.ts
type QueueVitePlugin = Plugin;
declare function hubQueue(): QueueVitePlugin;
declare module "vite" {
  interface UserConfig {
    queue?: QueueModuleOptions;
  }
}
//#endregion
export { type CloudflareQueueConfig, type CloudflareQueueConfigOptions, QueueVitePlugin, createCloudflareQueueConfig, hubQueue };