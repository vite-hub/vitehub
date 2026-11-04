import { commentsErrorDiagnostics } from "./errors.ts"
import type { CommentsPeople } from "./define.ts"
import type { CommentsRuntime } from "./service.ts"
import type { CommentUser } from "./types.ts"

export type { CommentsAttachmentStore, CommentsForgeHooks, CommentsRuntime } from "./service.ts"
/** Where mentions find people. The same shape as `defineComments({ people })`. */
export type CommentsUsers = CommentsPeople

const key: unique symbol = Symbol.for("vitehub.comments.runtime")
const scope = globalThis as typeof globalThis & { [key]?: CommentsRuntime | (() => CommentsRuntime | Promise<CommentsRuntime>) }

/**
 * Install the runtime that the comment operations use. `installComments()` calls this; the generated Nitro plugin
 * passes a function that builds the runtime on first use.
 */
export function installCommentsRuntime(runtime: CommentsRuntime | (() => CommentsRuntime | Promise<CommentsRuntime>)): void {
  scope[key] = runtime
}

/** The installed runtime, or `COMMENTS_R0010` with status 503. */
export async function commentsRuntime(): Promise<CommentsRuntime> {
  const installed = scope[key]
  if (!installed) throw Object.assign(commentsErrorDiagnostics.COMMENTS_R0010(), { status: 503 })
  if (installed instanceof Function) {
    const built = await installed()
    scope[key] = built
    return built
  }
  return installed
}

export function hasCommentsRuntime(): boolean {
  return scope[key] !== undefined
}

interface BetterAuthUsers {
  $context: Promise<{ internalAdapter: { listUsers: (limit?: number, offset?: number, sortBy?: unknown, where?: unknown[]) => Promise<Array<Record<string, unknown>>> } }>
}

function toUser(record: Record<string, unknown>): CommentUser | undefined {
  const id = typeof record.id === "string" ? record.id : undefined
  if (!id) return undefined
  const name = typeof record.name === "string" && record.name ? record.name : undefined
  const image = typeof record.image === "string" && record.image ? record.image : undefined
  return { id, ...(name ? { name } : {}), ...(image ? { image } : {}) }
}

/** People from a Better Auth instance, through its internal adapter. The generated Nitro plugin passes it when the app has Auth. */
export function createAuthUsers(getAuth: () => object): CommentsPeople {
  // SAFETY: Better Auth instances, and the Auth of ViteHub, have `$context` with this internal adapter.
  const adapter = async () => (await (getAuth() as BetterAuthUsers).$context).internalAdapter
  return {
    async byIds(ids) {
      if (!ids.length) return []
      const found = await (await adapter()).listUsers(ids.length, 0, undefined, [{ field: "id", operator: "in", value: [...ids] }])
      return found.flatMap(record => {
        const person = toUser(record)
        return person ? [{ ...record, ...person }] : []
      })
    },
    async search(query, limit) {
      const found = await (await adapter()).listUsers(limit, 0, undefined, [{ field: "name", operator: "contains", value: query, mode: "insensitive" }])
      // The full records, so `canMention` and `authorize` read fields such as `role`. Suggestions keep only public ones.
      return found.flatMap(record => {
        const person = toUser(record)
        return person ? [{ ...record, ...person }] : []
      })
    },
  }
}
export { createCommentsStore } from "./store.ts"
export { validateCommentsDefinition } from "./define.ts"
export type { CommentsDatabase, CommentsStore, CommentsTables } from "./store.ts"
