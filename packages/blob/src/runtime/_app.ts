type BlobAppHandler = (request: Request, context?: Record<string, unknown>) => Response | Promise<Response>

export type BlobApp =
  | BlobAppHandler
  | {
    fetch?: BlobAppHandler
    request?: (request: Request, options?: RequestInit, context?: Record<string, unknown>) => Response | Promise<Response>
  }

export function resolveBlobAppFetch(app: BlobApp | undefined): BlobAppHandler | undefined {
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

  throw new TypeError("Invalid blob app. Expected an h3 app or a fetch-compatible handler.")
}
