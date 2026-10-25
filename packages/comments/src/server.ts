import { commentsErrorDiagnostics } from "./errors.ts"
import type { CommentsDefinition } from "./define.ts"
import type { CommentsStore } from "./store.ts"
import type { CommentUser } from "./types.ts"

/** Where mentions find people. */
export interface CommentsUsers {
  /** People whose name contains `query`. `users()` returns only their `id`, `name`, and `image`. */
  search: (query: string, limit: number) => Promise<CommentUser[]>
  /** The people with these ids. An id that is not a person is left out. */
  byIds: (ids: readonly string[]) => Promise<CommentUser[]>
}

export interface CommentsRuntime {
  definition: CommentsDefinition
  store: CommentsStore
  /** The Auth adapter. Without it, `users()` finds the authors that the store knows. */
  users?: CommentsUsers
}

const key: unique symbol = Symbol.for("vitehub.comments.runtime")
const scope = globalThis as typeof globalThis & { [key]?: CommentsRuntime | (() => CommentsRuntime | Promise<CommentsRuntime>) }

/** Install the runtime of the app. The generated Nitro plugin calls this. The runtime may be a function that builds it on first use. */
export function installComments(runtime: CommentsRuntime | (() => CommentsRuntime | Promise<CommentsRuntime>)): void {
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

/** People from a Better Auth instance, through its internal adapter. */
export function createAuthUsers(getAuth: () => BetterAuthUsers): CommentsUsers {
  const adapter = async () => (await getAuth().$context).internalAdapter
  return {
    async byIds(ids) {
      if (!ids.length) return []
      const found = await (await adapter()).listUsers(ids.length, 0, undefined, [{ field: "id", operator: "in", value: [...ids] }])
      return found.map(toUser).filter((person): person is CommentUser => person !== undefined)
    },
    async search(query, limit) {
      const found = await (await adapter()).listUsers(limit, 0, undefined, [{ field: "name", operator: "contains", value: query }])
      return found.map(toUser).filter((person): person is CommentUser => person !== undefined)
    },
  }
}
export { createCommentsStore } from "./store.ts"
export type { CommentsDatabase, CommentsStore, CommentsTables } from "./store.ts"
