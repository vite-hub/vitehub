import { waitUntil as vercelWaitUntil } from "@vercel/functions"
import { H3, fromWebHandler } from "h3"
import { toNodeHandler } from "h3/node"

import { resolveQueueAppFetch, type QueueApp } from "./_app.ts"
import { runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "./state.ts"

import type { QueueDefinitionRegistry, ResolvedQueueOptions } from "../types.ts"

interface QueueVercelServerOptions {
  app?: QueueApp
  queue?: false | ResolvedQueueOptions
  registry?: QueueDefinitionRegistry
}

export type QueueVercelServer = (req: unknown, res: unknown) => unknown

export function createQueueVercelServer(options: QueueVercelServerOptions = {}): QueueVercelServer {
  setQueueRuntimeConfig(options.queue)
  setQueueRuntimeRegistry(options.registry)

  const app = new H3()
  const fetchHandler = resolveQueueAppFetch(options.app)
  if (fetchHandler) {
    app.use(fromWebHandler(async (request, context) => await fetchHandler(request as never, context as never)))
  }

  const nodeHandler = toNodeHandler(app)
  return function vercelQueueServer(req, res) {
    return runWithQueueRuntimeEvent({ req, res, waitUntil: vercelWaitUntil }, () => nodeHandler(req as never, res as never))
  }
}
