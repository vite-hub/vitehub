import { commentsErrorDiagnostics } from "./errors.ts"

import type { CommentsStore } from "./store.ts"
import type { CommentThread } from "./types.ts"

/** Options of `tenantCommentsStore()`. */
export interface TenantCommentsStoreOptions {
  /** The stored scope of every thread of the tenant, such as a project id. */
  tenant: string
  /** The scope that Comments uses for the threads of the tenant. Default: `site`, the scope of pages and Content. */
  scope?: string
}

/**
 * A store that keeps the threads of one tenant in tables that several tenants share. It stores `scope` as the tenant
 * and gives the threads back with the scope of Comments, so thread numbers count per tenant. Each call by id first reads
 * the stored scope of the thread: ids are unique and a scope never changes, so a thread of another tenant is not found.
 */
export function tenantCommentsStore(store: CommentsStore, options: TenantCommentsStoreOptions): CommentsStore {
  const { tenant } = options
  const tenantScope = options.scope ?? "site"
  const owned = (thread: CommentThread | null) => thread?.scope === tenant
  const shown = (thread: CommentThread): CommentThread => ({ ...thread, scope: tenantScope })
  const visible = (thread: CommentThread | null) => thread && owned(thread) ? shown(thread) : null
  async function own(threadId: string): Promise<void> {
    if (!owned(await store.getById(threadId))) throw commentsErrorDiagnostics.COMMENTS_R0002({ id: threadId })
  }
  const canReadOwned = (canRead: (thread: CommentThread) => Promise<boolean>) => async (thread: CommentThread) => owned(thread) && await canRead(shown(thread))
  return {
    async list(query) {
      if (query.scope !== undefined && query.scope !== tenantScope) return []
      return (await store.list({ ...query, scope: tenant })).map(shown)
    },
    async getById(id) {
      return visible(await store.getById(id))
    },
    async getByNumber(scope, n) {
      return scope === tenantScope ? visible(await store.getByNumber(tenant, n)) : null
    },
    async getByRequestId(scope, requestId) {
      return scope === tenantScope ? visible(await store.getByRequestId(tenant, requestId)) : null
    },
    async getByMessage(messageId) {
      return visible(await store.getByMessage(messageId))
    },
    async getByAttachment(key, cursor) {
      const found = await store.getByAttachment(key, cursor)
      return { ...found, threads: found.threads.filter(owned).map(shown) }
    },
    async createThread(input) {
      if (input.scope !== tenantScope) throw commentsErrorDiagnostics.COMMENTS_TENANT_SCOPE_INVALID({ scope: input.scope, tenantScope })
      return shown(await store.createThread({ ...input, scope: tenant }))
    },
    async addMessage(threadId, input, addOptions) {
      await own(threadId)
      return shown(await store.addMessage(threadId, input, addOptions))
    },
    async editMessage(threadId, messageId, input) {
      await own(threadId)
      return shown(await store.editMessage(threadId, messageId, input))
    },
    async deleteMessage(threadId, messageId, now) {
      await own(threadId)
      return shown(await store.deleteMessage(threadId, messageId, now))
    },
    async deleteThread(threadId, ownerId) {
      const thread = await store.getById(threadId)
      if (!thread) return true
      if (!owned(thread)) return false
      return store.deleteThread(threadId, ownerId)
    },
    async setStatus(threadId, status, by, now, actor) {
      await own(threadId)
      return shown(await store.setStatus(threadId, status, by, now, actor))
    },
    async deleteScope(scope) {
      return scope === tenantScope ? store.deleteScope(tenant) : []
    },
    async deleteUser() {
      throw commentsErrorDiagnostics.COMMENTS_TENANT_DELETE_USER()
    },
    async knownUsers(query, limit, canRead) {
      return store.knownUsers(query, limit, canReadOwned(canRead))
    },
    async knownUsersByIds(ids, canRead) {
      return store.knownUsersByIds(ids, canReadOwned(canRead))
    },
  }
}
