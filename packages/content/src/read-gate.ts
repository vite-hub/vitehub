import type { ContentUser } from "./index.ts"

/**
 * The part of a Content runtime that decides who reads published Content through a generated reader:
 * `/api/content/**`, the sitemap, RSS, `llms.txt`, Markdown copies, `/mcp`, and preview URLs.
 */
export interface ContentReadAccess {
  /** `defineContent({ route })`. `"public"` serves every reader to everyone without `authorize`. */
  readonly route?: boolean | "public"
  /** Whether `defineContent()` has an `authorize` policy. */
  readonly hasPolicy?: boolean
  can?(context: { user: ContentUser | null, action: "read" }): Promise<boolean>
}

/** Options of the Content readers, such as `defineContentHandler()` and `defineContentLlmsHandler()`. */
export interface ContentHandlerOptions {
  /**
   * The signed-in user of a request, which `authorize` gets as `user`. The generated readers read the ViteHub Auth
   * session when the app has Auth. Without this option, `user` is null.
   */
  user?: (request: Request) => ContentUser | null | undefined | Promise<ContentUser | null | undefined>
}

/** Whether a reader asks `authorize`: the runtime has a policy, and `route` is not `"public"`. */
export function contentReadGated(content: ContentReadAccess): boolean {
  return content.route !== "public" && content.hasPolicy === true
}

/**
 * Ask `authorize` with `action: "read"` for a request. Returns the answer to send when it denies: 401 without a user,
 * 403 with one, both `Cache-Control: private, no-store`. Returns undefined when the reader may serve the request.
 */
export async function contentReadDenied(content: ContentReadAccess, request: Request, options: ContentHandlerOptions = {}): Promise<Response | undefined> {
  if (!contentReadGated(content)) return
  const user = await options.user?.(request) ?? null
  // A runtime that claims a policy but cannot check it denies.
  if (content.can && await content.can({ user, action: "read" })) return
  return new Response(user ? "Forbidden" : "Unauthorized", { status: user ? 403 : 401, headers: { "cache-control": "private, no-store" } })
}

/** A gated answer depends on the user, so no shared cache keeps it. Other answers stay as they are. */
export function contentReadResponse(content: ContentReadAccess, response: Response): Response {
  if (!contentReadGated(content)) return response
  try {
    response.headers.set("cache-control", "private, no-store")
    return response
  }
  catch {
    // A response from `fetch()` has immutable headers.
    const copy = new Response(response.body, response)
    copy.headers.set("cache-control", "private, no-store")
    return copy
  }
}
