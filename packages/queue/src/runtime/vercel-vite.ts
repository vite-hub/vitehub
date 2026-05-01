import { waitUntil as vercelWaitUntil } from "@vercel/functions"
import { createVercelHostedServer } from "@vitehub/internal/runtime/vercel-hosted"

import type { QueueApp } from "./_app.ts"
import { runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "./state.ts"

import type { QueueDefinitionRegistry, ResolvedQueueOptions } from "../types.ts"

interface QueueVercelServerOptions {
  app?: QueueApp
  queue?: false | ResolvedQueueOptions
  registry?: QueueDefinitionRegistry
}

export type QueueVercelServer = (req: unknown, res: unknown) => unknown

export function createQueueVercelServer(options: QueueVercelServerOptions = {}): QueueVercelServer {
  return createVercelHostedServer({
    app: options.app,
    label: "queue",
    onRequest({ handle, req, res }) {
      setQueueRuntimeConfig(options.queue)
      setQueueRuntimeRegistry(options.registry)
      return runWithQueueRuntimeEvent({ req, res, waitUntil: vercelWaitUntil }, handle)
    },
  })
}
