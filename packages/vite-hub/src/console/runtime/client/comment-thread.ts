import { requestConsoleOperation } from "./request"
import { isRecord } from "@vite-hub/internal/object"

import type { CommentsTransport, CommentSubject, CommentThread, CommentUser } from "@vite-hub/comments/client"

/**
 * A Comments transport over the Console RPC. Each call runs the `comments.*` operation with the Console user, so the
 * `authorize` policy of the app decides what the user may read and change.
 */
export function consoleCommentsTransport(threadId?: () => string | undefined): CommentsTransport {
  // SAFETY: The operation of the same name answers with the type of the transport method that called it.
  const call = <T>(operation: string, input: object) => requestConsoleOperation(`comments.${operation}`, { ...input }) as Promise<T>
  return {
    create: input => call("create", input),
    delete: input => call("delete", input),
    edit: input => call("edit", input),
    get: input => call("get", input),
    list: query => call("list", query),
    reopen: input => call("reopen", input),
    reply: input => call("reply", input),
    resolve: input => call("resolve", input),
    users: input => {
      const id = threadId?.()
      return call("users", { ...input, ...(id ? { threadId: id } : {}) })
    },
  }
}

/** Read an existing attachment through the operation, which checks access to its thread. */
export async function readConsoleCommentAttachment(key: string, signal?: AbortSignal): Promise<{ data: string, inline: boolean, name: string, type: string }> {
  // SAFETY: `comments.attachment` returns the stored file's metadata and Base64-encoded bytes.
  return await requestConsoleOperation("comments.attachment", { key }, signal ? { signal } : {}) as { data: string, inline: boolean, name: string, type: string }
}

/** The Console identity and capabilities for one thread. */
export interface ConsoleCommentSession {
  canWrite: boolean
  capabilities: { reply: boolean, resolve: boolean, deleteThread: boolean, edit: string[], delete: string[] }
  user: CommentUser | undefined
}

/** Ask `comments.session` for the Console identity and, with `threadId`, action-specific capabilities. */
export async function readConsoleCommentSession(subject: CommentSubject, signal?: AbortSignal, threadId?: string): Promise<ConsoleCommentSession> {
  const value = await requestConsoleOperation("comments.session", { subject, ...(threadId ? { threadId } : {}) }, signal ? { signal } : {})
  const user = isRecord(value) && isRecord(value.user) && typeof value.user.id === "string" ? value.user : undefined
  const capabilities = isRecord(value) && isRecord(value.capabilities) ? value.capabilities : {}
  const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []
  return {
    capabilities: {
      delete: ids(capabilities.delete),
      deleteThread: capabilities.deleteThread === true,
      edit: ids(capabilities.edit),
      reply: capabilities.reply === true,
      resolve: capabilities.resolve === true,
    },
    canWrite: isRecord(value) && value.canWrite === true,
    // SAFETY: `comments.session` answers with a `CommentUser`, and the check above keeps its string `id`.
    user: user as CommentUser | undefined,
  }
}

/** Whether an item of `comments.list` has the fields that the thread panel reads. */
export function isConsoleCommentThread(value: unknown): value is CommentThread {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.n === "number"
    && isRecord(value.subject)
    && isRecord(value.author)
    && Array.isArray(value.messages)
}

/** Where a thread is, for the panel heading: the page path, or `<kind> <id>` for another subject. */
export function consoleCommentSubjectLabel(subject: CommentSubject): string {
  return subject.kind === "page" ? subject.id : `${subject.kind} ${subject.id}`
}
