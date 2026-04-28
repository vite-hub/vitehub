import { resolveAppFetch } from "@vitehub/internal/runtime/app"

type AppHandler = (request: Request, context?: Record<string, unknown>) => Response | Promise<Response>

export type DBApp =
  | AppHandler
  | {
    fetch?: AppHandler
    request?: (request: Request, options?: RequestInit, context?: Record<string, unknown>) => Response | Promise<Response>
  }

export function resolveDbAppFetch(app: DBApp | undefined): ((request: Request, context?: Record<string, unknown>) => Response | Promise<Response>) | undefined {
  return resolveAppFetch("db", app)
}
