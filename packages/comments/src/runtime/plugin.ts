import { registerViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"
import { installViteHubPageTools, registerViteHubPageTool } from "@vite-hub/internal/runtime/page-tools"

import { installComments } from "../index.ts"
import { commentsApiRoute, commentsHintCookie, commentsHintQuery, commentsRoute } from "../page.ts"
import { commentsMcpTools } from "./mcp.ts"

import type { Comments } from "../index.ts"
import type { CommentsDatabase } from "../store.ts"
import type { CommentsSessionOptions } from "./session.ts"

export interface CommentsPluginOptions extends CommentsSessionOptions {
  comments: Comments
  /** The Database of `defineComments({ database })`, or undefined when the app has none. */
  database: () => CommentsDatabase | undefined
  /** URL of the overlay script that pages load in comment mode. */
  overlay: string
  /** Vite's serve/build identity, recorded by the generated plugin. Defaults to false. */
  development?: boolean
  /** What the server log says when `database()` returns nothing. */
  missingDatabase?: string
}

const runtimeKey = Symbol.for("vitehub.comments.runtime")

/** The Comments definition that the Nitro plugin installed, for the Console reader. */
export function installedComments(): Comments | undefined {
  const value: unknown = Reflect.get(globalThis, runtimeKey)
  // SAFETY: only defineCommentsPlugin() writes this process slot, with a Comments definition.
  return value === undefined ? undefined : value as Comments
}

/** Whether a request asks for comment mode: the `?comments` query or the hint cookie that the session route sets. */
export function wantsCommentMode(request: Request, base = ""): boolean {
  const url = new URL(request.url)
  if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false
  const path = url.pathname.slice(base.length)
  if (path.startsWith("/_vitehub") || path.startsWith("/api/")) return false
  if (url.searchParams.has(commentsHintQuery)) return true
  const cookie = request.headers.get("cookie")
  return Boolean(cookie && cookie.split(";").some(part => part.trim() === `${commentsHintCookie}=1`))
}

/**
 * The Nitro plugin of Comments. It connects the definition to its Database, and adds the overlay script to HTML pages
 * of requests in comment mode. Pages without the hint are returned unchanged.
 */
export function defineCommentsPlugin(options: CommentsPluginOptions): (nitroApp: unknown) => void {
  const base = commentsApiRoute(new URL(options.overlay, "http://localhost").href).slice(0, -commentsRoute.length)
  return (nitroApp) => {
    const database = options.database()
    if (database) installComments(options.comments, { database, development: options.development })
    else console.warn(options.missingDatabase ?? "[vitehub] Comments has no Database. Enable one with `vitehub({ database: true })`, or set `defineComments({ database })` to a Database name.")
    Reflect.set(globalThis, runtimeKey, options.comments)
    // The ViteHub MCP server at `/_vitehub/mcp` lists them for people with Console access to Comments.
    registerViteHubMcpTools("comments", commentsMcpTools(options.comments, { session: options.session, consoleSession: options.consoleSession }))

    // The page tools add the overlay script to HTML pages of requests in comment mode.
    registerViteHubPageTool(nitroApp, { id: "comments", script: options.overlay, wants: request => wantsCommentMode(request, base) })
    installViteHubPageTools(nitroApp)
  }
}
