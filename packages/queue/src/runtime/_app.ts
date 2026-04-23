import { resolveAppFetch, type VitehubApp } from "@vitehub/internal/runtime/app"

export type QueueApp = VitehubApp

export function resolveQueueAppFetch(app: QueueApp | undefined): ((request: Request, context?: Record<string, unknown>) => Response | Promise<Response>) | undefined {
  return resolveAppFetch("queue", app)
}
