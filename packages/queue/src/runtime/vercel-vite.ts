import { createApp, fromWebHandler } from "h3"
import { toNodeHandler } from "h3/node"

import { runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "./state.ts"

import type { QueueDefinitionRegistry, ResolvedQueueModuleOptions } from "../types.ts"

type QueueNodeApp =
  | {
    fetch?: (request: Request, context?: Record<string, unknown>) => Response | Promise<Response>
    request?: (request: Request, options?: RequestInit, context?: Record<string, unknown>) => Response | Promise<Response>
  }
  | ((request: Request, context?: Record<string, unknown>) => Response | Promise<Response>)

interface QueueVercelServerOptions {
  app?: QueueNodeApp
  queue?: false | ResolvedQueueModuleOptions
  registry?: QueueDefinitionRegistry
}

export type QueueVercelServer = (req: unknown, res: unknown) => unknown

function resolveQueueAppFetch(queueApp: QueueNodeApp | undefined) {
  if (!queueApp) {
    return undefined
  }

  if (typeof queueApp === "function") {
    return queueApp
  }

  if (typeof queueApp.request === "function") {
    return (request: Request, context?: Record<string, unknown>) => queueApp.request!(request, undefined, context)
  }

  if (typeof queueApp.fetch === "function") {
    return queueApp.fetch.bind(queueApp)
  }

  throw new TypeError("Invalid Vite queue server app. Expected an h3 app or a fetch-compatible handler.")
}

export function createQueueVercelServer(options: QueueVercelServerOptions = {}): QueueVercelServer {
  setQueueRuntimeConfig(options.queue)
  setQueueRuntimeRegistry(options.registry)

  const app = createApp()
  const fetchHandler = resolveQueueAppFetch(options.app)
  if (fetchHandler) {
    app.use(fromWebHandler(async (request, context) => await fetchHandler(request as never, context as never)))
  }

  const nodeHandler = toNodeHandler(app)
  return function vercelQueueServer(req: unknown, res: unknown) {
    return runWithQueueRuntimeEvent({ req, res }, () => nodeHandler(req as never, res as never))
  }
}
