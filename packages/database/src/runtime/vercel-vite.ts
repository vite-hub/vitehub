import { createVercelHostedServer } from "@vite-hub/internal/runtime/vercel-hosted"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { VitehubApp } from "@vite-hub/internal/runtime/app"

export interface DatabaseVercelServerOptions {
  app?: VitehubApp
}

export function createDbVercelServer(options: DatabaseVercelServerOptions = {}): (req: IncomingMessage, res: ServerResponse) => unknown {
  return createVercelHostedServer({ app: options.app, label: "database" })
}
