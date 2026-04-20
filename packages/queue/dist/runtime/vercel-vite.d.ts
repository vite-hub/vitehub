import { b as ResolvedQueueModuleOptions, u as QueueDefinitionRegistry } from "../types-DHLfmgAh.js";

//#region src/runtime/vercel-vite.d.ts
type QueueNodeApp = {
  fetch?: (request: Request, context?: Record<string, unknown>) => Response | Promise<Response>;
  request?: (request: Request, options?: RequestInit, context?: Record<string, unknown>) => Response | Promise<Response>;
} | ((request: Request, context?: Record<string, unknown>) => Response | Promise<Response>);
interface QueueVercelServerOptions {
  app?: QueueNodeApp;
  queue?: false | ResolvedQueueModuleOptions;
  registry?: QueueDefinitionRegistry;
}
type QueueVercelServer = (req: unknown, res: unknown) => unknown;
declare function createQueueVercelServer(options?: QueueVercelServerOptions): QueueVercelServer;
//#endregion
export { QueueVercelServer, createQueueVercelServer };