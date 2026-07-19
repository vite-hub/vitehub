import { resolveAppFetch } from "@vite-hub/internal/runtime/app"
import { createCloudflareRuntimeEvent, runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { H3, toWebHandler } from "h3"

type AppHandler = (request: Request, context?: Record<string, unknown>) => Response | Promise<Response>

export type DBApp =
  | AppHandler
  | {
    fetch?: AppHandler
    request?: (request: Request, options?: RequestInit, context?: Record<string, unknown>) => Response | Promise<Response>
  }

export interface DBCloudflareWorkerOptions {
  app?: DBApp
}

export interface DBCloudflareWorker {
  fetch: (request: Request, env: Record<string, unknown>, context: { waitUntil?: (promise: Promise<unknown>) => void }) => Promise<Response>
}

export function createDbCloudflareWorker(options: DBCloudflareWorkerOptions = {}): DBCloudflareWorker {
  const appHandler = resolveAppFetch("db", options.app)
  const defaultHandler = toWebHandler(new H3())

  return {
    async fetch(request, env, context) {
      const runtimeEvent = createCloudflareRuntimeEvent(env, context)
      return await runWithActiveCloudflareEnv(env, () => Promise.resolve(
        appHandler ? appHandler(request, runtimeEvent.context) : defaultHandler(request, runtimeEvent.context),
      ))
    },
  }
}
