import { internalErrorDiagnostics } from "../error-diagnostics.ts"
type AppHandler = (request: Request, context?: Record<string, unknown>) => Response | Promise<Response>

export type VitehubApp =
  | AppHandler
  | {
    fetch?: AppHandler
    request?: (request: Request, options?: RequestInit, context?: Record<string, unknown>) => Response | Promise<Response>
  }

export function resolveAppFetch(label: string, app: VitehubApp | undefined): AppHandler | undefined {
  if (!app) {
    return undefined
  }

  if (typeof app === "function") {
    return app
  }

  if (typeof app.request === "function") {
    return (request, context) => app.request!(request, undefined, context)
  }

  if (typeof app.fetch === "function") {
    return app.fetch.bind(app)
  }

  throw internalErrorDiagnostics.INTERNAL_R0011({ message: `Invalid ${label} app. Expected an h3 app or a fetch-compatible handler.` })
}
