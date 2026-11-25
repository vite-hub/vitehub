import { commentsApiRoute, commentsRoute } from "../page.ts"
import { Diagnostic } from "nostics"

import { createCommentsRestRequest, createRestTransport } from "../rest-transport.ts"
import { createCommentSendTransport } from "../send-transport.ts"

import type { CommentSendTransport } from "../client-send.ts"

import type { CommentsRestAnswer, RestTransport } from "../rest-transport.ts"
import type { CommentContext, CommentCreateInput, CommentsGitHubAccess, CommentSubject, CommentUser } from "../types.ts"

export interface CommentsSession {
  user: CommentUser | null
  /** For a person signed in with GitHub: their login, and whether they can push to the repository. */
  github?: CommentsGitHubAccess
  /** `change: false` keeps every message as it was sent: no one edits or deletes one, not even their own. */
  can: { read: boolean, comment: boolean, resolve: boolean, delete?: boolean, change?: false }
  /**
   * The GitHub sign-in, when the person may not read yet and the site offers it. With `newTab`, `url` is complete and
   * opens in a new tab, and the page stays.
   */
  signIn?: { provider: "github" | "console", url: string }
  /** Signs out of the GitHub sign-in of Comments. */
  signOut?: string
  realtime: boolean
  attachments?: false
  /** `false` when the app shows its own presence, so the overlay shows no faces and no cursors. */
  presence?: false
  content: boolean
  /** Send is on, and this person may hand the waiting comments to their agent. */
  send?: true
  /** The person is a member of the Console team: **Copy prompt** gives their agent the ViteHub MCP at `mcp`. */
  agent?: { mcp: string }
  /** The subject of the page, which `page` of `defineComments()` decides on the server. */
  subject?: CommentSubject
  /** The version of the subject that new threads start on. */
  revision?: number
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

const send = createCommentsRestRequest({ route, guest: readGuest })

/** The error part of an API answer, from the diagnostic that a failed request throws. */
export function apiError(error: unknown): CommentsApiError {
  if (error instanceof Diagnostic) return { code: error.code, why: error.message, ...(error.fix ? { fix: error.fix } : {}) }
  throw error
}

async function call<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  try {
    return [undefined, (await send<T>(path, init)).data]
  }
  catch (error) {
    return [apiError(error), undefined]
  }
}

/**
 * Where the overlay reads its session and threads when they do not come from the Comments API of the page, such as
 * the hosted embed, whose Console frame makes every request.
 */
export interface CommentsOverlayBackend {
  session: (page: string) => Promise<ApiResult<CommentsSession>>
  transport: (onAnswer: (answer: CommentsRestAnswer<unknown>) => void) => RestTransport
}

let backend: CommentsOverlayBackend | undefined

/** Sends the session and thread requests of the overlay to `next`. Call it before the overlay starts. */
export function useCommentsOverlayBackend(next: CommentsOverlayBackend): void {
  backend = next
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) })

/** The routes that are not comment threads: who the person is on a page, and the Content fields of inline edits. */
export const api = {
  session: (page: string) => backend ? backend.session(page) : call<CommentsSession>(`/session?page=${encodeURIComponent(page)}`),
  field: (field: string, page: string) => call<CommentsField>(`/fields?page=${encodeURIComponent(page)}&field=${encodeURIComponent(field)}`),
  saveField: (input: { field: string, value: string, ifDigest: string }, page: string) => call<{ field: string, value: string, digest: string }>(`/fields?page=${encodeURIComponent(page)}`, post(input)),
}

export interface OverlayTransportOptions {
  /** The page context of a new thread, which the overlay read when the draft started. */
  contextOf: (input: CommentCreateInput) => CommentContext | undefined
  /** The version of the subject that `/session` gave for the page. A new thread starts on it. */
  revisionOf?: () => number | undefined
  /** The people that an answer named, so their mentions get names. */
  onPeople: (people: readonly CommentUser[]) => void
  /** After each change, so the other people on the page read the threads again. */
  onChange: () => void
}

/**
 * The comment parts' transport: `createRestTransport()` over the Comments API of the page, with the guest of this
 * browser. A new thread also sends the page context that the overlay read, and each change tells the other people on
 * the page.
 */
export function createOverlayTransport(options: OverlayTransportOptions): RestTransport {
  const onAnswer = (answer: CommentsRestAnswer<unknown>) => answer.people.length && options.onPeople(answer.people)
  const rest = backend ? backend.transport(onAnswer) : createRestTransport({ base: route.slice(0, -commentsRoute.length), guest: readGuest, onAnswer })
  const changed = <A extends unknown[], T>(run: (...input: A) => Promise<T>) => async (...input: A): Promise<T> => {
    const value = await run(...input)
    options.onChange()
    return value
  }
  return {
    ...rest,
    create: changed((input: CommentCreateInput) => {
      const context = options.contextOf(input)
      const revision = input.revision ?? options.revisionOf?.()
      // SAFETY: `POST /threads` takes the page context of the overlay next to the input of `comments.create`.
      return rest.create({ ...input, ...(context ? { context } : {}), ...(revision === undefined ? {} : { revision }) } as CommentCreateInput)
    }),
    reply: changed(rest.reply),
    edit: changed(rest.edit),
    delete: changed(rest.delete),
    resolve: changed(rest.resolve),
    reopen: changed(rest.reopen),
  }
}

/** The transport of Send in the pill, over the Send routes of the page's Comments API. */
export function createOverlaySendTransport(page: () => string): CommentSendTransport {
  return createCommentSendTransport({ base: route.slice(0, -commentsRoute.length), page })
}
