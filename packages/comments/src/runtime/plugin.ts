import { registerViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"
import { installViteHubPageTools, registerViteHubPageTool } from "@vite-hub/internal/runtime/page-tools"

import { installComments } from "../index.ts"
import { commentsHintCookie, commentsHintQuery } from "../page.ts"
import { commentsMcpTools } from "./mcp.ts"

import type { Comments } from "../index.ts"
import type { CommentsDatabase } from "../store.ts"

export interface CommentsPluginOptions {
  comments: Comments
  /** The Database of `defineComments({ database })`, or undefined when the app has none. */
  database: () => CommentsDatabase | undefined
  /** URL of the overlay script that pages load in comment mode. */
  overlay: string
}

const runtimeKey = Symbol.for("vitehub.comments.runtime")

/** The Comments definition that the Nitro plugin installed, for the Console reader. */
export function installedComments(): Comments | undefined {
  const value: unknown = Reflect.get(globalThis, runtimeKey)
  // SAFETY: only defineCommentsPlugin() writes this process slot, with a Comments definition.
  return value === undefined ? undefined : value as Comments
}

/**
 * Whether a request asks for comment mode: the `?comments` query or the hint cookie that the session route sets. The
 * page tools skip paths under `/_vitehub` and `/api/` before they call it.
 */
export function wantsCommentMode(request: Request): boolean {
  if (new URL(request.url).searchParams.has(commentsHintQuery)) return true
  const cookie = request.headers.get("cookie")
  return Boolean(cookie && cookie.split(";").some(part => part.trim() === `${commentsHintCookie}=1`))
}

/**
 * The Nitro plugin of Comments. It connects the definition to its Database, and adds the overlay script to HTML pages
 * of requests in comment mode. Pages without the hint are returned unchanged.
 */
export function defineCommentsPlugin(options: CommentsPluginOptions): (nitroApp: unknown) => void {
  return (nitroApp) => {
    const database = options.database()
    if (database) installComments(options.comments, { database })
    else console.warn("[vitehub] Comments has no Database. Enable one with `vitehub({ database: true })`, or set `defineComments({ database })` to a Database name.")
    Reflect.set(globalThis, runtimeKey, options.comments)
    // The ViteHub MCP server at `/_vitehub/mcp` lists them for people with Console access to Comments.
    registerViteHubMcpTools("comments", commentsMcpTools(options.comments))

    // The page tools add the overlay script to HTML pages of requests in comment mode.
    registerViteHubPageTool({ id: "comments", script: options.overlay, wants: wantsCommentMode })
    installViteHubPageTools(nitroApp)
  }
}
