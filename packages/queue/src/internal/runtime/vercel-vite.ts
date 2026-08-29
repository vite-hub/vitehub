import { waitUntil as vercelWaitUntil } from "@vercel/functions"
import { createVercelHostedServer } from "@vite-hub/internal/runtime/vercel-hosted"

import type { QueueApp } from "../../runtime/_app.ts"
import { runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "./state.ts"

import type { QueueDefinitionRegistry, ResolvedQueueOptions } from "../../types.ts"
import type { QueueRuntimeClientFactory } from "./state.ts"

interface QueueVercelServerBaseOptions {
  app?: QueueApp
  registry?: QueueDefinitionRegistry
}

type QueueVercelServerOptions = QueueVercelServerBaseOptions & (
  | { createClient: QueueRuntimeClientFactory, queue?: ResolvedQueueOptions }
  | { createClient?: never, queue: false }
)

export type QueueVercelServer = (req: unknown, res: unknown) => unknown

export function createQueueVercelServer(options: QueueVercelServerOptions): QueueVercelServer {
  if (options.queue !== false && !options.createClient) {
    throw new TypeError("[vitehub] Enabled Vercel Queue output requires its generated client factory.")
  }

  return createVercelHostedServer({
    app: options.app,
    label: "queue",
    onRequest({ handle, req, res }) {
      setQueueRuntimeConfig(options.queue, options.createClient)
      setQueueRuntimeRegistry(options.registry)
      return runWithQueueRuntimeEvent({ req, res, waitUntil: vercelWaitUntil }, handle)
    },
  })
}
