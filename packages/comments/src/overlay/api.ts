import { commentsApiRoute } from "../page.ts"

import type { Comment, CommentAnchor, CommentAuthor, CommentContext, CommentMention, CommentThread } from "../types.ts"

export interface CommentsSession {
  user: CommentAuthor | null
  can: { read: boolean, comment: boolean, resolve: boolean }
  realtime: boolean
  content: boolean
}

/** Request-scoped permissions for an existing thread, evaluated with that thread's authorization context. */
export interface CommentsThread extends CommentThread {
  can?: { comment: boolean, resolve: boolean }
}

export interface CommentsField {
  field: string
  value: string | null
  editable: boolean
  digest: string
  collection: string
  id: string
}

/** The error part of an API answer: the code, `why`, and `fix` of a Comments error. */
export interface CommentsApiError {
  code: string
  why: string
  fix?: string
}

export type ApiResult<T> = [CommentsApiError, undefined] | [undefined, T]

const guestKey = "vitehub-comments-guest"
const route = commentsApiRoute(import.meta.url)

/** The guest name and id this browser chose, when the site lets guests comment. */
export function readGuest(): { id: string, name: string } | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(guestKey) ?? "null")
    if (value && typeof value === "object" && "id" in value && "name" in value && typeof value.id === "string" && typeof value.name === "string") return { id: value.id, name: value.name }
  }
  catch {}
}

export function saveGuest(name: string): { id: string, name: string } {
  const guest = { id: readGuest()?.id ?? crypto.randomUUID(), name }
  localStorage.setItem(guestKey, JSON.stringify(guest))
  return guest
}

async function call<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set("content-type", "application/json")
  const guest = readGuest()
  if (guest) {
    headers.set("x-vitehub-comments-guest-id", guest.id)
    headers.set("x-vitehub-comments-guest-name", encodeURIComponent(guest.name))
  }
  let response: Response
  try {
    response = await fetch(`${route}${path}`, { ...init, headers, credentials: "same-origin" })
  }
  catch {
    return [{ code: "COMMENTS_OFFLINE", why: "The server cannot be reached." }, undefined]
  }
  const value: unknown = await response.json().catch(() => undefined)
  if (value && typeof value === "object") {
    if ("error" in value && value.error && typeof value.error === "object") return [value.error as CommentsApiError, undefined]
    if ("data" in value) return [undefined, value.data as T]
  }
  return [{ code: "COMMENTS_FAILED", why: `The server answered ${response.status}.` }, undefined]
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) })

export const api = {
  session: () => call<CommentsSession>("/session"),
  threads: (page: string) => call<CommentsThread[]>(`/threads?page=${encodeURIComponent(page)}`),
  create: (input: { page: string, anchor: CommentAnchor, context: CommentContext, body: string, mentions: CommentMention[] }) => call<CommentsThread>("/threads", post(input)),
  reply: (thread: string, input: { body: string, mentions: CommentMention[] }) => call<Comment>(`/threads/${encodeURIComponent(thread)}/comments`, post(input)),
  resolve: (thread: string) => call<CommentsThread>(`/threads/${encodeURIComponent(thread)}/resolve`, { method: "POST" }),
  reopen: (thread: string) => call<CommentsThread>(`/threads/${encodeURIComponent(thread)}/reopen`, { method: "POST" }),
  remove: (thread: string) => call<null>(`/threads/${encodeURIComponent(thread)}`, { method: "DELETE" }),
  removeComment: (thread: string, comment: string) => call<null>(`/threads/${encodeURIComponent(thread)}/comments/${encodeURIComponent(comment)}`, { method: "DELETE" }),
  people: (query: string) => call<CommentMention[]>(`/people?q=${encodeURIComponent(query)}`),
  field: (field: string) => call<CommentsField>(`/fields?field=${encodeURIComponent(field)}`),
  saveField: (input: { field: string, value: string, ifDigest: string }) => call<{ field: string, value: string, digest: string }>("/fields", post(input)),
}
