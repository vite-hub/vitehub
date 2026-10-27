import { registerViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"
import { installViteHubPageTools, registerViteHubPageTool } from "@vite-hub/internal/runtime/page-tools"

import { installComments } from "../index.ts"
import { resolveCommentsUser } from "./handler.ts"
import { commentsMcpTools } from "./mcp.ts"

import type { H3Event } from "h3"
import type { Comments } from "../index.ts"
import type { CommentsDatabase } from "../store.ts"
import type { CommentsHandlerOptions } from "./handler.ts"

export interface CommentsPluginOptions {
  comments: Comments
  /** The Database of `defineComments({ database })`, or undefined when the app has none. */
  database: () => CommentsDatabase | undefined
  /** URL of the overlay script. The page tools loader imports it for people that may read comments. */
  overlay: string
  /** Reads the user of a request, as in `createCommentsHandler()`. Omitted when the app has no Console and no Auth. */
  session?: CommentsHandlerOptions["session"]
}

const runtimeKey = Symbol.for("vitehub.comments.runtime")

/** The Comments definition that the Nitro plugin installed, for the Console reader. */
export function installedComments(): Comments | undefined {
  const value: unknown = Reflect.get(globalThis, runtimeKey)
  // SAFETY: only defineCommentsPlugin() writes this process slot, with a Comments definition.
  return value === undefined ? undefined : value as Comments
}

/**
 * The Nitro plugin of Comments. It connects the definition to its Database, and registers the overlay as the
 * `comments` page tool: the page tools session lets a visitor load it when `authorize` allows `read`.
 */
export function defineCommentsPlugin(options: CommentsPluginOptions): (nitroApp: unknown) => void {
  return (nitroApp) => {
    const database = options.database()
    if (database) installComments(options.comments, { database })
    else console.warn("[vitehub] Comments has no Database. Enable one with `vitehub({ database: true })`, or set `defineComments({ database })` to a Database name.")
    Reflect.set(globalThis, runtimeKey, options.comments)
    // The ViteHub MCP server at `/_vitehub/mcp` lists them for people with Console access to Comments.
    registerViteHubMcpTools("comments", commentsMcpTools(options.comments))

    registerViteHubPageTool(nitroApp, {
      id: "comments",
      label: "Comments",
      icon: "i-lucide-message-square-text",
      script: options.overlay,
      async allowed({ event }) {
        // SAFETY: the page tools session passes the H3 event of its Nitro route, which the session readers accept.
        const user = await resolveCommentsUser(options.comments, options.session, event as H3Event)
        return await options.comments.can({ user, action: "read" })
      },
    })
    installViteHubPageTools(nitroApp)
  }
}
