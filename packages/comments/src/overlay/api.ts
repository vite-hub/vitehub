import { commentsApiRoute, commentsRoute } from "../page.ts"
import { CommentsRestError, createCommentsRestRequest, createRestTransport } from "../rest-transport.ts"

import type { RestTransport } from "../rest-transport.ts"
import type { CommentContext, CommentCreateInput, CommentsGitHubAccess, CommentUser } from "../types.ts"

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

async function call<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  try {
    return [undefined, (await send<T>(path, init)).data]
  }
  catch (error) {
    if (error instanceof CommentsRestError) return [{ code: error.code, why: error.why, ...(error.fix ? { fix: error.fix } : {}) }, undefined]
    throw error
  }
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) })

/** The routes that are not comment threads: who the person is on a page, and the Content fields of inline edits. */
export const api = {
  session: (page: string) => call<CommentsSession>(`/session?page=${encodeURIComponent(page)}`),
  field: (field: string, page: string) => call<CommentsField>(`/fields?page=${encodeURIComponent(page)}&field=${encodeURIComponent(field)}`),
  saveField: (input: { field: string, value: string, ifDigest: string }, page: string) => call<{ field: string, value: string, digest: string }>(`/fields?page=${encodeURIComponent(page)}`, post(input)),
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
 * The comment parts' transport: `createRestTransport()` over the Comments API of the page, with the guest of this
 * browser. A new thread also sends the page context that the overlay read, and each change tells the other people on
 * the page.
 */
export function createOverlayTransport(options: OverlayTransportOptions): RestTransport {
  const rest = createRestTransport({
    base: route.slice(0, -commentsRoute.length),
    guest: readGuest,
    onAnswer: answer => answer.people.length && options.onPeople(answer.people),
  })
  const changed = <A extends unknown[], T>(run: (...input: A) => Promise<T>) => async (...input: A): Promise<T> => {
    const value = await run(...input)
    options.onChange()
    return value
  }
  return {
    ...rest,
    create: changed((input: CommentCreateInput) => {
      const context = options.contextOf(input)
      // SAFETY: `POST /threads` takes the page context of the overlay next to the input of `comments.create`.
      return rest.create((context ? { ...input, context } : input) as CommentCreateInput)
    }),
    reply: changed(rest.reply),
    edit: changed(rest.edit),
    delete: changed(rest.delete),
    resolve: changed(rest.resolve),
    reopen: changed(rest.reopen),
  }
}

/** The file as Base64, the form that `comments.upload` takes. */
export async function base64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
