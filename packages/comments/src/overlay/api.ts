import { commentsApiRoute } from "../page.ts"
import { CommentsRestError, createCommentsRestRequest } from "../rest-transport.ts"

import type { PinAnchor } from "../anchor.ts"
import type { CommentContext, CommentMessage, CommentsGitHubAccess, CommentThread, CommentUser } from "../types.ts"

/** A person as the overlay shows them: always with a name. */
export interface OverlayPerson {
  id: string
  name: string
  image?: string
  guest?: boolean
}

/** A person that a message mentions, with the name that its text shows after `@`. */
export interface OverlayMention {
  id: string
  name: string
}

/** A message as the overlay shows it. */
export interface OverlayComment {
  id: string
  threadId: string
  body: string
  mentions: OverlayMention[]
  author: OverlayPerson
  /** ISO time. */
  createdAt: string
}

export interface CommentsSession {
  user: OverlayPerson | null
  /** For a person signed in with GitHub: their login, and whether they can push to the repository. */
  github?: CommentsGitHubAccess
  can: { read: boolean, comment: boolean, resolve: boolean, delete?: boolean }
  /** The GitHub sign-in, when the person may not read yet and the site offers it. */
  signIn?: { provider: "github", url: string }
  /** Signs out of the GitHub sign-in of Comments. */
  signOut?: string
  realtime: boolean
  content: boolean
}

/** Request-scoped permissions for an existing thread, evaluated with that thread's authorization context. */
type ThreadPermissions = { comment: boolean, resolve: boolean, delete?: boolean }

/** A pin of a page: a page thread with an element anchor, as the overlay draws it. */
export interface PageThread {
  id: string
  page: string
  anchor: PinAnchor
  status: CommentThread["status"]
  createdBy: OverlayPerson
  resolvedBy: OverlayPerson | null
  /** Oldest first. The first comment opened the thread. */
  comments: OverlayComment[]
  /** ISO time. */
  updatedAt: string
  can?: ThreadPermissions
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

function person(user: CommentUser): OverlayPerson {
  return { id: user.id, name: user.name ?? user.id, ...(user.image ? { image: user.image } : {}), ...(user.guest ? { guest: true } : {}) }
}

function commentOf(message: CommentMessage, people: ReadonlyMap<string, CommentUser>): OverlayComment {
  return {
    id: message.id,
    threadId: message.threadId,
    body: message.body,
    author: person(message.author),
    createdAt: new Date(message.createdAt).toISOString(),
    mentions: message.mentions.flatMap((id) => {
      const found = people.get(id)
      return found ? [{ id, name: found.name ?? id }] : []
    }),
  }
}

/** A page thread of the API as a pin, or undefined for a thread whose anchor is not on an element. */
function pinOf(thread: CommentThread & { can?: ThreadPermissions }, people: ReadonlyMap<string, CommentUser>): PageThread | undefined {
  if (thread.subject.kind !== "page" || thread.anchor.kind !== "element") return
  return {
    id: thread.id,
    page: thread.subject.id,
    anchor: { label: "", page: { x: 0, y: 0 }, viewport: { width: 0 }, ...thread.anchor },
    status: thread.status,
    createdBy: person(thread.author),
    resolvedBy: thread.resolvedBy ? person(thread.resolvedBy) : null,
    comments: thread.messages.map(message => commentOf(message, people)),
    updatedAt: new Date(thread.updatedAt).toISOString(),
    ...(thread.can ? { can: thread.can } : {}),
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const [error, value] = await request<T>(path, init)
  return error ? [error, undefined] : [undefined, value.data]
}

/** The overlay talks to the Comments API through the same requests as `createRestTransport()`. */
const send = createCommentsRestRequest({ route, guest: readGuest })

/** The answer of a route that names people: the data, and the mentioned people by id. */
async function request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<{ data: T, people: Map<string, CommentUser> }>> {
  try {
    const answer = await send<T>(path, init)
    return [undefined, { data: answer.data, people: new Map(answer.people.map(entry => [entry.id, entry])) }]
  }
  catch (error) {
    if (error instanceof CommentsRestError) return [{ code: error.code, why: error.why, ...(error.fix ? { fix: error.fix } : {}) }, undefined]
    throw error
  }
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) })

type ApiThread = CommentThread & { can?: ThreadPermissions }

/** One page thread as a pin. A thread that the overlay cannot place is not found. */
async function pin(path: string, init: RequestInit): Promise<ApiResult<PageThread>> {
  const [error, value] = await request<ApiThread>(path, init)
  if (error) return [error, undefined]
  const found = pinOf(value.data, value.people)
  return found ? [undefined, found] : [{ code: "COMMENTS_NOT_FOUND", why: "The thread is not on an element of the page." }, undefined]
}

/** Mentions go to the server as ids. It checks each one, and that the text names it with `@`. */
function mentionIds(mentions: readonly OverlayMention[]): string[] {
  return [...new Set(mentions.map(mention => mention.id))]
}

export const api = {
  session: (page: string) => call<CommentsSession>(`/session?page=${encodeURIComponent(page)}`),
  async threads(page: string): Promise<ApiResult<PageThread[]>> {
    const [error, value] = await request<ApiThread[]>(`/threads?page=${encodeURIComponent(page)}`)
    if (error) return [error, undefined]
    return [undefined, value.data.flatMap(thread => pinOf(thread, value.people) ?? [])]
  },
  create: (input: { page: string, anchor: PinAnchor, context: CommentContext, body: string, mentions: OverlayMention[] }) => pin("/threads", post({ ...input, mentions: mentionIds(input.mentions) })),
  async reply(thread: string, input: { body: string, mentions: OverlayMention[] }): Promise<ApiResult<OverlayComment>> {
    const [error, value] = await request<CommentMessage>(`/threads/${encodeURIComponent(thread)}/comments`, post({ body: input.body, mentions: mentionIds(input.mentions) }))
    return error ? [error, undefined] : [undefined, commentOf(value.data, value.people)]
  },
  resolve: (thread: string) => pin(`/threads/${encodeURIComponent(thread)}/resolve`, { method: "POST" }),
  reopen: (thread: string) => pin(`/threads/${encodeURIComponent(thread)}/reopen`, { method: "POST" }),
  remove: (thread: string) => call<null>(`/threads/${encodeURIComponent(thread)}`, { method: "DELETE" }),
  removeComment: (thread: string, comment: string) => call<null>(`/threads/${encodeURIComponent(thread)}/comments/${encodeURIComponent(comment)}`, { method: "DELETE" }),
  async people(query: string, target: { page: string } | { thread: string }): Promise<ApiResult<OverlayMention[]>> {
    const params = new URLSearchParams({ q: query, ...target })
    const [error, found] = await call<CommentUser[]>(`/people?${params}`)
    return error ? [error, undefined] : [undefined, found.map(entry => ({ id: entry.id, name: entry.name ?? entry.id }))]
  },
  field: (field: string) => call<CommentsField>(`/fields?field=${encodeURIComponent(field)}`),
  saveField: (input: { field: string, value: string, ifDigest: string }) => call<{ field: string, value: string, digest: string }>("/fields", post(input)),
}
