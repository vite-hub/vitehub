import { commentsRoute } from "./page.ts"

import type {
  CommentAttachment,
  CommentCreateInput,
  CommentDeleteInput,
  CommentEditInput,
  CommentGetInput,
  CommentListQuery,
  CommentReplyInput,
  CommentsTransport,
  CommentStatusInput,
  CommentThread,
  CommentUploadInput,
  CommentUser,
  CommentUsersInput,
} from "./client-types.ts"

/** A guest that named itself in the browser. The server keeps the name as display data only. */
export interface CommentsGuest {
  id: string
  name: string
}

export interface RestTransportOptions {
  /**
   * The app origin and mount, such as `https://app.example.com` or `/portal`. The routes are
   * `<base>/api/_vitehub/comments/**`. Default: the page origin.
   */
  base?: string
  /**
   * Headers for each request, such as a share-link token that `identify` reads. A function runs before each request,
   * so it can read a token that changes.
   */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
  /** The guest that writes when nobody is signed in, and the policy lets guests write. A function runs before each request. */
  guest?: CommentsGuest | (() => CommentsGuest | undefined)
  /** Default `same-origin`, so the browser sends the session cookie to the app's own origin. */
  credentials?: RequestCredentials
  /** Replaces `fetch`, for tests or a server. */
  fetch?: typeof fetch
  /** Runs after each answer that has data, such as to learn the names of the people that it mentions. */
  onAnswer?: (answer: CommentsRestAnswer<unknown>) => void
}

/** A failed request of the Comments API: the code, `why`, and `fix` of the error object, and the HTTP status. */
export class CommentsRestError extends Error {
  readonly code: string
  readonly why: string
  readonly fix?: string
  readonly status: number

  constructor(failure: { code: string, why: string, fix?: string, status: number }) {
    super(failure.why)
    this.name = "CommentsRestError"
    this.code = failure.code
    this.why = failure.why
    this.status = failure.status
    if (failure.fix) this.fix = failure.fix
  }
}

/** A thread as the API answers it: with what the reader may do with it. */
export type RestCommentThread = CommentThread & { can?: { comment: boolean, resolve: boolean, delete?: boolean } }

/** The answer of a route: its data, and the people that its threads mention, so a UI shows their names. */
export interface CommentsRestAnswer<T> {
  data: T
  people: CommentUser[]
  /** The thread after a reply. */
  thread?: RestCommentThread
}

/** The request function of the Comments API that the overlay and `createRestTransport()` share. */
export type CommentsRestRequest = <T>(path: string, init?: RequestInit) => Promise<CommentsRestAnswer<T>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

/** The URL of an attachment key below the Comments API, such as `/api/_vitehub/comments/attachments/comments/<id>/shot.png`. */
export function commentAttachmentUrl(key: string, base = ""): string {
  return `${base.replace(/\/+$/, "")}${commentsRoute}/attachments/${key.split("/").map(part => encodeURIComponent(part)).join("/")}`
}

/**
 * Requests to the Comments API at `<base>/api/_vitehub/comments`, with the guest headers and the session cookie. A
 * failure throws `CommentsRestError` with the error object of the answer.
 */
export function createCommentsRestRequest(options: RestTransportOptions & { route?: string } = {}): CommentsRestRequest {
  const route = options.route ?? `${(options.base ?? "").replace(/\/+$/, "")}${commentsRoute}`
  return async <T>(path: string, init: RequestInit = {}): Promise<CommentsRestAnswer<T>> => {
    const send = options.fetch ?? globalThis.fetch
    const headers = new Headers(typeof options.headers === "function" ? await options.headers() : options.headers)
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value)
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
    const guest = typeof options.guest === "function" ? options.guest() : options.guest
    if (guest) {
      headers.set("x-vitehub-comments-guest-id", guest.id)
      headers.set("x-vitehub-comments-guest-name", encodeURIComponent(guest.name))
    }
    let response: Response
    try {
      response = await send(`${route}${path}`, { ...init, headers, credentials: options.credentials ?? "same-origin", cache: "no-store" })
    }
    catch (cause) {
      throw new CommentsRestError({ code: "COMMENTS_R0013", why: `The request failed: ${cause instanceof Error ? cause.message : String(cause)}`, fix: "Check the connection and the app URL, then try again.", status: 0 })
    }
    const value: unknown = await response.json().catch(() => undefined)
    if (isRecord(value) && isRecord(value.error)) {
      const { code, why, fix } = value.error
      throw new CommentsRestError({ code: typeof code === "string" ? code : "COMMENTS_R0013", why: typeof why === "string" ? why : `The server answered ${response.status}.`, ...(typeof fix === "string" ? { fix } : {}), status: response.status })
    }
    if (isRecord(value) && "data" in value) {
      const answer: CommentsRestAnswer<T> = {
        // SAFETY: each route answers with the data type that its caller names.
        data: value.data as T,
        people: Array.isArray(value.people) ? value.people as CommentUser[] : [],
        // SAFETY: a reply answers with the thread that it changed.
        ...(isRecord(value.thread) ? { thread: value.thread as unknown as RestCommentThread } : {}),
      }
      options.onAnswer?.(answer)
      return answer
    }
    throw new CommentsRestError({ code: "COMMENTS_R0013", why: `The server answered ${response.status} without data.`, status: response.status })
  }
}

function listSearch(query: CommentListQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.page !== undefined) params.set("page", query.page)
  if (query.subject) {
    params.set("subjectKind", query.subject.kind)
    params.set("subjectId", query.subject.id)
  }
  else if (query.subjectKind) params.set("subjectKind", query.subjectKind)
  if (query.status) params.set("status", query.status)
  if (query.mine !== undefined) params.set("mine", String(query.mine))
  if (query.mentions !== undefined) params.set("mentions", String(query.mentions))
  if (query.revision) params.set("revision", String(query.revision.lte))
  if (query.limit !== undefined) params.set("limit", String(query.limit))
  if (query.before) {
    params.set("beforeId", query.before.id)
    params.set("beforeUpdatedAt", String(query.before.updatedAt))
  }
  return params
}

/** A `CommentsTransport` over the Comments API, with `upload` and the URL of each attachment. */
export interface RestTransport extends CommentsTransport {
  upload: (input: CommentUploadInput) => Promise<CommentAttachment>
  /** The URL that serves the file of an attachment key to people who may read its thread, such as for a thumbnail. */
  attachmentUrl: (key: string) => string
}

const thread = (id: string) => `/threads/${encodeURIComponent(id)}`
const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

/**
 * A transport over the Comments API at `<base>/api/_vitehub/comments`: the routes that the overlay uses. The server
 * runs the `authorize` policy of `server/comments.ts` for the user of the request: the app session, the Console, or a
 * guest that `guest` names. It needs no Console access, so guests and share-link readers can use it. It has no
 * `subscribe`: the client refreshes when the window gets focus.
 */
export function createRestTransport(options: RestTransportOptions = {}): RestTransport {
  const request = createCommentsRestRequest(options)
  const base = (options.base ?? "").replace(/\/+$/, "")
  return {
    async list(query: CommentListQuery) {
      return (await request<RestCommentThread[]>(`/threads?${listSearch(query)}`)).data
    },
    async get(input: CommentGetInput) {
      const path = "id" in input ? thread(input.id) : `/scopes/${encodeURIComponent(input.scope)}/threads/${input.n}`
      return (await request<RestCommentThread | null>(path)).data
    },
    async create(input: CommentCreateInput) {
      return (await request<RestCommentThread>("/threads", post(input))).data
    },
    async reply({ threadId, ...input }: CommentReplyInput) {
      const answer = await request<unknown>(`${thread(threadId)}/comments`, post(input))
      if (!answer.thread) throw new CommentsRestError({ code: "COMMENTS_R0013", why: "The server answered the reply without its thread.", status: 200 })
      return answer.thread
    },
    async edit({ threadId, messageId, ...input }: CommentEditInput) {
      return (await request<RestCommentThread>(`${thread(threadId)}/comments/${encodeURIComponent(messageId)}`, { method: "PATCH", body: JSON.stringify(input) })).data
    },
    async delete({ threadId, messageId }: CommentDeleteInput) {
      const path = messageId === undefined ? thread(threadId) : `${thread(threadId)}/comments/${encodeURIComponent(messageId)}`
      return (await request<RestCommentThread | null>(path, { method: "DELETE" })).data
    },
    async resolve({ threadId }: CommentStatusInput) {
      return (await request<RestCommentThread>(`${thread(threadId)}/resolve`, post())).data
    },
    async reopen({ threadId }: CommentStatusInput) {
      return (await request<RestCommentThread>(`${thread(threadId)}/reopen`, post())).data
    },
    async users({ query, limit, threadId, subject }: CommentUsersInput) {
      const params = new URLSearchParams({ q: query })
      if (limit !== undefined) params.set("limit", String(limit))
      if (threadId !== undefined) params.set("thread", threadId)
      else if (subject) {
        params.set("subjectKind", subject.kind)
        params.set("subjectId", subject.id)
      }
      return (await request<CommentUser[]>(`/people?${params}`)).data
    },
    async upload(input: CommentUploadInput) {
      return (await request<CommentAttachment>("/attachments", post(input))).data
    },
    attachmentUrl: key => commentAttachmentUrl(key, base),
  }
}
