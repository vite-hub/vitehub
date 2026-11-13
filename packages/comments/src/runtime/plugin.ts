import { installViteHubPageTools, registerViteHubPageTool } from "@vite-hub/internal/runtime/page-tools"
import { installRequestStandardContext } from "@vite-hub/runtime"

import { commentsRoleGrants } from "../operations-core/define.ts"
import { commentsErrorDiagnostics } from "../operations-core/errors.ts"
import { installCommentsRuntime } from "../operations-core/server.ts"
import { runtimeBuilds } from "../installed.ts"
import { resolveCommentsIdentity, resolveCommentsPage } from "./session.ts"

import type { Comments } from "../index.ts"
import type { InstallCommentsOptions } from "../install.ts"
import type { CommentsRuntime } from "../operations-core/service.ts"
import type { CommentsDatabase } from "../operations-core/store.ts"
import type { CommentsRequestEvent } from "../types.ts"
import type { CommentsGitHubLogin } from "./github-login.ts"
import type { CommentsSessionOptions } from "./session.ts"

export interface CommentsPluginOptions extends CommentsSessionOptions {
  comments: Comments
  /** Offers GitHub sign-in or account switching through the overlay, even before read access is granted. */
  githubLogin?: CommentsGitHubLogin
  /** The Database of `defineComments({ database })`, or undefined when the app has none. The first Comments call reads it. */
  database: () => CommentsDatabase | undefined | Promise<CommentsDatabase | undefined>
  /**
   * Path of the overlay script below the app base, such as `/api/_vitehub/comments/assets/overlay.js`. The page tools
   * loader imports it for people that may read comments.
   */
  overlay: string | false
  /** The app base, such as `/portal/`. The page tools use it for the loader tag of Nitro 3 pages. Default: the root. */
  base?: string
  /** Vite's serve/build identity, recorded by the generated plugin. Defaults to false. */
  development?: boolean
  /** What the server log says when `database()` returns nothing. */
  missingDatabase?: string
  /** The Auth users for `@` suggestions, when the app has Auth. */
  users?: InstallCommentsOptions["users"]
  /** The Blob store for attachments, when the app has Blob. */
  attachments?: InstallCommentsOptions["attachments"]
  /** Who keeps the tables up to date: `comments` for a Database that `comments()` opens itself. Default `app`. */
  schema?: InstallCommentsOptions["schema"]
  /** The tables of a Postgres Database. Default: the SQLite tables. */
  tables?: InstallCommentsOptions["tables"]
  dialect?: InstallCommentsOptions["dialect"]
}

const runtimeKey = Symbol.for("vitehub.comments.installed")

/** The Comments definition that the Nitro plugin installed, for the Console reader. */
export function installedComments(): Comments | undefined {
  const value: unknown = Reflect.get(globalThis, runtimeKey)
  // SAFETY: only defineCommentsPlugin() writes this process slot, with a Comments definition.
  return value === undefined ? undefined : value as Comments
}

/**
 * The Nitro plugin of Comments. It connects the definition to its Database, and registers the overlay as the
 * `comments` page tool: a visitor may load it when `authorize` allows `read` or GitHub sign-in is available.
 */
export function defineCommentsPlugin(options: CommentsPluginOptions): (nitroApp: unknown) => void {
  return (nitroApp) => {
    // The store, its migrations, and the app's Database load on the first Comments call, not at server startup.
    let warned = false
    let building: Promise<CommentsRuntime> | undefined
    const build = () => building ??= (async () => {
      const database = await options.database()
      if (!database) {
        if (!warned) console.warn(options.missingDatabase ?? "[vitehub] Comments has no Database. Enable one with `vitehub({ database: true })`, or set `defineComments({ database })` to a Database name.")
        warned = true
        throw Object.assign(commentsErrorDiagnostics.COMMENTS_R0010(), { status: 503 })
      }
      const { installComments } = await import("../install.ts")
      return installComments(options.comments, {
        database,
        development: options.development === true,
        ...(options.schema ? { schema: options.schema } : {}),
        ...(options.tables ? { tables: options.tables } : {}),
        ...(options.dialect ? { dialect: options.dialect } : {}),
        ...(options.users ? { users: options.users } : {}),
        ...(options.attachments ? { attachments: options.attachments } : {}),
      })
    })().catch((error: unknown) => {
      building = undefined
      throw error
    })
    runtimeBuilds.set(options.comments, build)
    installCommentsRuntime(build)
    Reflect.set(globalThis, runtimeKey, options.comments)

    // `overlay: false` leaves the page tool out; the API, the operations, and the Console stay.
    if (options.overlay === false) return
    const script = options.overlay
    registerViteHubPageTool(nitroApp, {
      id: "comments",
      label: "Comments",
      icon: "i-lucide-message-square-text",
      script,
      // Not lazy for readers: as in Drop, selected text gets the Comment bar and comments show on the page as soon as it
      // loads. `allowed` makes it lazy for people who may only sign in.
      // A link to a thread, `<page>?comment=<n>`, opens it.
      param: "comment",
      grants: commentsRoleGrants,
      async allowed({ request }) {
        // In a ViteHub app, the Request of the session route carries the Standard Context of the request.
        installRequestStandardContext(request)
        // SAFETY: the runtime adapter installed this Request's Standard Context before the identity check.
        const event = request as Request & CommentsRequestEvent
        const { user, gate } = await resolveCommentsIdentity(options.comments, event, { ...options, session: options.session ?? options.githubLogin?.user })
        const page = new URL(request.url).searchParams.get("page")
        const subject = page ? (await resolveCommentsPage(options.comments, event, request, page)).subject : undefined
        if (await options.comments.can({ user, action: "read", ...(subject ? { subject } : {}) }, gate)) return true
        // Someone who may only sign in, or switch accounts, gets the button. The overlay loads when they press it.
        return !options.comments.options.identify && options.githubLogin?.configured() && (!user || user.github) ? "lazy" : false
      },
    })
    installViteHubPageTools(nitroApp, { base: options.base })
  }
}
