import { commentsApiRoute } from "../page.ts"

import type {
  CommentAttachment,
  CommentContext,
  CommentCreateInput,
  CommentListQuery,
  CommentsGitHubAccess,
  CommentsTransport,
  CommentThread,
  CommentUploadInput,
  CommentUser,
} from "../types.ts"

export interface CommentsSession {
  user: CommentUser | null
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

/** A failed request of the transport. The comment parts show its message where the action failed. */
export class CommentsApiFailure extends Error {
  readonly code: string
  readonly fix?: string

  constructor(error: CommentsApiError) {
    super(error.fix ? `${error.why} ${error.fix}` : error.why)
    this.name = "CommentsApiFailure"
    this.code = error.code
    if (error.fix) this.fix = error.fix
  }
}

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

/** The headers that name this browser's guest. The server reads them only for a person without an account. */
export function guestHeaders(): Record<string, string> {
  const guest = readGuest()
  return guest ? { "x-vitehub-comments-guest-id": guest.id, "x-vitehub-comments-guest-name": encodeURIComponent(guest.name) } : {}
}

/** The answer of a route: the data, and the people that it names, by id. */
async function request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<{ data: T, people: CommentUser[] }>> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set("content-type", "application/json")
  for (const [name, value] of Object.entries(guestHeaders())) headers.set(name, value)
  let response: Response
  try {
    response = await fetch(`${route}${path}`, { ...init, headers, credentials: "same-origin" })
  }
  catch {
    return [{ code: "COMMENTS_OFFLINE", why: "The server cannot be reached." }, undefined]
  }
  const value: unknown = await response.json().catch(() => undefined)
  if (value && typeof value === "object") {
    // SAFETY: the Comments API answers errors with `{ code, why, fix }`.
    if ("error" in value && value.error && typeof value.error === "object") return [value.error as CommentsApiError, undefined]
    if ("data" in value) {
      // SAFETY: the route of `path` answers with `T`, and with the people it names as Comments users.
      const people = "people" in value && Array.isArray(value.people) ? value.people as CommentUser[] : []
      return [undefined, { data: value.data as T, people }]
    }
  }
  return [{ code: "COMMENTS_FAILED", why: `The server answered ${response.status}.` }, undefined]
}

async function call<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const [error, value] = await request<T>(path, init)
  return error ? [error, undefined] : [undefined, value.data]
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) })
const thread = (id: string) => `/threads/${encodeURIComponent(id)}`

/** The routes that are not comment threads: who the person is, and the Content fields of inline edits. */
export const api = {
  session: (page?: string) => call<CommentsSession>(`/session${page ? `?page=${encodeURIComponent(page)}` : ""}`),
  field: (field: string) => call<CommentsField>(`/fields?field=${encodeURIComponent(field)}`),
  saveField: (input: { field: string, value: string, ifDigest: string }) => call<{ field: string, value: string, digest: string }>("/fields", post(input)),
}

export interface OverlayTransportOptions {
  /** The page context of a new thread, which the overlay read when the draft started. */
  contextOf: (input: CommentCreateInput) => CommentContext | undefined
  /** The people that an answer named, so their mentions get names. */
  onPeople: (people: readonly CommentUser[]) => void
  /** After each change, so the other people on the page read the threads again. */
  onChange: () => void
}

/**
 * The comment parts' transport over the Comments API of the page: page threads only, with the guest headers of this
 * browser. `upload` runs the checks of `comments.upload` on the server.
 */
export function createOverlayTransport(options: OverlayTransportOptions): Required<Omit<CommentsTransport, "subscribe">> {
  async function data<T>(path: string, init?: RequestInit): Promise<T> {
    const [error, value] = await request<T>(path, init)
    if (error) throw new CommentsApiFailure(error)
    if (value.people.length) options.onPeople(value.people)
    return value.data
  }
  async function changed<T>(path: string, init: RequestInit): Promise<T> {
    const value = await data<T>(path, init)
    options.onChange()
    return value
  }
  /** The thread after a change that answers with a message or nothing. `null` when the change deleted it. */
  async function reread(id: string): Promise<CommentThread | null> {
    const [error, value] = await request<CommentThread>(thread(id))
    if (error?.code === "COMMENTS_NOT_FOUND") return null
    if (error) throw new CommentsApiFailure(error)
    if (value.people.length) options.onPeople(value.people)
    return value.data
  }
  const page = (query: CommentListQuery) => query.subject?.kind === "page" ? query.subject.id : query.page

  return {
    async list(query) {
      const current = page(query)
      const search = new URLSearchParams()
      if (current) search.set("page", current)
      if (query.status) search.set("status", query.status)
      const threads = await data<CommentThread[]>(`/threads${search.size ? `?${search}` : ""}`)
      // The API lists every page thread, newest activity first. The client pages with `before`.
      return threads.filter(entry => !query.before || entry.updatedAt < query.before.updatedAt || (entry.updatedAt === query.before.updatedAt && entry.id < query.before.id)).slice(0, query.limit)
    },
    async get(input) {
      if ("id" in input) return await reread(input.id)
      const threads = await this.list({})
      return threads.find(entry => entry.scope === input.scope && entry.n === input.n) ?? null
    },
    async create(input) {
      if (input.subject.kind !== "page") throw new CommentsApiFailure({ code: "COMMENTS_INVALID_INPUT", why: "The overlay comments on pages only." })
      const context = options.contextOf(input)
      return await changed<CommentThread>("/threads", post({
        page: input.subject.id,
        anchor: input.anchor,
        body: input.body,
        mentions: input.mentions ?? [],
        attachments: input.attachments ?? [],
        ...(context ? { context } : {}),
      }))
    },
    async reply(input) {
      await changed(`${thread(input.threadId)}/comments`, post({ body: input.body, mentions: input.mentions ?? [], attachments: input.attachments ?? [] }))
      const next = await reread(input.threadId)
      if (!next) throw new CommentsApiFailure({ code: "COMMENTS_NOT_FOUND", why: "The thread was deleted." })
      return next
    },
    edit: input => changed<CommentThread>(`${thread(input.threadId)}/comments/${encodeURIComponent(input.messageId)}`, { method: "PATCH", body: JSON.stringify({ body: input.body, mentions: input.mentions ?? [] }) }),
    async delete(input) {
      await changed(input.messageId ? `${thread(input.threadId)}/comments/${encodeURIComponent(input.messageId)}` : thread(input.threadId), { method: "DELETE" })
      return input.messageId ? await reread(input.threadId) : null
    },
    resolve: input => changed<CommentThread>(`${thread(input.threadId)}/resolve`, { method: "POST" }),
    reopen: input => changed<CommentThread>(`${thread(input.threadId)}/reopen`, { method: "POST" }),
    users(input) {
      const search = new URLSearchParams({ q: input.query })
      if (input.threadId) search.set("threadId", input.threadId)
      else if (input.subject?.kind === "page") search.set("page", input.subject.id)
      return data<CommentUser[]>(`/people?${search}`)
    },
    upload: (input: CommentUploadInput) => data<CommentAttachment>("/uploads", post({
      name: input.name,
      type: input.type,
      data: input.data,
      ...(input.subject?.kind === "page" ? { page: input.subject.id } : {}),
    })),
  }
}

/** The file as Base64, the form that `comments.upload` takes. */
export async function base64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
