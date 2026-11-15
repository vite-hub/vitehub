import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import { installCommentsRuntime } from "./operations-core/server.ts"
import { createCommentsStore } from "./operations-core/store.ts"
import { commentsSchemaGate } from "./migrate.ts"
import { commentsSchema } from "./operations-core/database.ts"
import { createForgeSync } from "./forge/sync.ts"
import { pendingKey, runtimes } from "./installed.ts"

import type { Comments } from "./index.ts"
import type { CommentsPeople } from "./operations-core/define.ts"
import type { CommentsAttachmentStore, CommentsRuntime } from "./operations-core/service.ts"
import type { CommentsDatabase, CommentsStore, CommentsTables } from "./operations-core/store.ts"
import type { CommentsSchemaOwner } from "./migrate.ts"
import type { CommentsRequestEvent } from "./types.ts"
import type { Installed } from "./installed.ts"

export interface InstallCommentsOptions {
  database: CommentsDatabase
  /** The tables of the Database schema, so a Postgres Database uses its own. Default: the SQLite tables. */
  tables?: CommentsTables & { commentForge?: typeof commentsSchema.vitehubCommentForge }
  /** The Auth adapter for `@` suggestions, when the app has Auth and no `people`. */
  users?: CommentsPeople
  /** The Blob store for attachments, when the app has one and no `storeAttachment`. */
  attachments?: CommentsAttachmentStore
  /** Only the Vite dev server enables it, for the default guest policy. Without it, the operation context decides, else `false`. */
  development?: boolean
  /**
   * Who keeps the tables up to date. `"comments"`: Comments opened the Database itself, so it migrates and creates
   * the tables before the first query. Default `"app"`: the app's migrations do, and Comments fails with
   * `COMMENTS_R0019` until the tables match this version. See `CommentsSchemaOwner`.
   */
  schema?: CommentsSchemaOwner
  /** The SQL dialect of `database`. Default `sqlite`: SQLite, libSQL, and D1. */
  dialect?: "sqlite" | "postgresql"
}

/** The store, after the tables are ready: each method waits for `ready` first. */
function gated(store: CommentsStore, ready: () => Promise<void>): CommentsStore {
  const wrapped: Partial<Record<keyof CommentsStore, unknown>> = {}
  for (const key of Object.keys(store) as Array<keyof CommentsStore>) {
    const method = store[key] as (...args: unknown[]) => Promise<unknown>
    wrapped[key] = async (...args: unknown[]) => {
      await ready()
      return method(...args)
    }
  }
  // SAFETY: every key of the store maps to a wrapper with the same parameters and result.
  return wrapped as CommentsStore
}

/**
 * Connects a Comments definition to its Database, for the server API, the overlay API, and the comment operations.
 * The generated Nitro plugin calls it on the first Comments call; call it yourself only in tests or outside ViteHub.
 */
export function installComments(comments: Comments, install: InstallCommentsOptions): CommentsRuntime {
  const tables = install.tables ?? { commentCounters: commentsSchema.vitehubCommentCounters, commentMessages: commentsSchema.vitehubCommentMessages, commentThreads: commentsSchema.vitehubCommentThreads }
  const store = gated(createCommentsStore(install.database, tables), commentsSchemaGate(install.database, install.schema ?? "app", { dialect: install.dialect ?? "sqlite" }))
  // SAFETY: defineComments() sets this slot to the set of pending tasks before it freezes the object.
  const pending = Reflect.get(comments, pendingKey) as Set<Promise<unknown>> | undefined
  const track = (task: Promise<unknown>) => {
    if (!pending) return
    const tracked = task.catch(() => undefined).finally(() => pending.delete(tracked))
    pending.add(tracked)
  }
  const { identify } = comments.options
  const runtime: CommentsRuntime = {
    background: track,
    definition: comments.options,
    ...(identify
      ? {
          identify: async (event: unknown) => {
            // SAFETY: The operation surfaces pass the request of the call: a Request, an H3 event, or an event with Standard Context.
            const requestEvent = event as CommentsRequestEvent
            // `identify` reads `event["~standard"]`. Set it when Nitro did not, such as for a Request from a test.
            getStandardContext(requestEvent)
            return await identify({ event: requestEvent }) ?? null
          },
        }
      : {}),
    ...(install.development === undefined ? {} : { development: install.development }),
    store,
    ...(install.users ? { users: install.users } : {}),
    ...(install.attachments ? { attachments: install.attachments } : {}),
  }
  let sync: Installed["sync"]
  if (comments.options.forge) {
    const forge = createForgeSync(comments.options.forge, { database: install.database, store, ...(install.tables?.commentForge ? { table: install.tables.commentForge } : {}) })
    sync = forge.sync
    runtime.forge = {
      attach: forge.attach,
      changed(threadId) {
        track(forge.sync(threadId).catch(error => console.error(`[vitehub] Comments could not sync thread ${threadId} to its pull request:`, error)))
      },
    }
  }
  runtimes.set(comments, { runtime, ...(sync ? { sync } : {}) })
  // The comment operations of the Console, the CLI, and MCP share the runtime.
  installCommentsRuntime(runtime)
  return runtime
}
