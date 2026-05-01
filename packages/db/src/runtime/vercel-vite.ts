import { createVercelHostedServer } from "@vitehub/internal/runtime/hosted"

import type { DBApp } from "./cloudflare-vite.ts"

export type { DBApp }

interface DBVercelServerOptions {
  app?: DBApp
}

export type DBVercelServer = (req: unknown, res: unknown) => unknown

export function createDbVercelServer(options: DBVercelServerOptions = {}): DBVercelServer {
  return createVercelHostedServer({
    app: options.app,
    label: "db",
  })
}
