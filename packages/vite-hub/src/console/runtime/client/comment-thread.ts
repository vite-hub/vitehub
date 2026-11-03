import { requestConsoleOperation } from "./request"

import type { CommentsTransport, CommentSubject, CommentThread, CommentUser } from "@vite-hub/comments/client"

/**
 * A Comments transport over the Console RPC. Each call runs the `comments.*` operation with the Console user, so the
 * `authorize` policy of the app decides what the user may read and change. `path` is any Console API path of the app,
 * and only locates the application mount.
 */
export function consoleCommentsTransport(path: string): CommentsTransport {
  // SAFETY: The operation of the same name answers with the type of the transport method that called it.
  const call = <T>(operation: string, input: object) => requestConsoleOperation(path, `comments.${operation}`, { ...input }) as Promise<T>
  return {
    create: input => call("create", input),
    delete: input => call("delete", input),
    edit: input => call("edit", input),
    get: input => call("get", input),
    list: query => call("list", query),
    reopen: input => call("reopen", input),
    reply: input => call("reply", input),
    resolve: input => call("resolve", input),
    users: input => call("users", input),
  }
}

/** What the Console user may do with the threads of one subject. */
export interface ConsoleCommentSession {
  canWrite: boolean
  user: CommentUser | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Ask `comments.session` who the Console user is and whether they may write on `subject`. */
export async function readConsoleCommentSession(path: string, subject: CommentSubject, signal?: AbortSignal): Promise<ConsoleCommentSession> {
  const value = await requestConsoleOperation(path, "comments.session", { subject }, signal ? { signal } : {})
  const user = isRecord(value) && isRecord(value.user) && typeof value.user.id === "string" ? value.user : undefined
  return {
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
