import { text } from "./identity.ts"
import { commentRoom, normalizeCommentPage } from "./page.ts"

import type { RealtimeDefinition, RealtimeUser } from "@vite-hub/realtime"
import type { H3Event } from "h3"
import type { Comments } from "./index.ts"
import type { CommentsUser } from "./types.ts"

function toRealtimeUser(user: CommentsUser): RealtimeUser {
  const result: RealtimeUser = { id: user.id }
  const name = text(user.name) ?? text(user.email)
  const email = text(user.email)
  const image = text(user.image)
  if (name) result.name = name
  if (email) result.email = email
  if (image) result.image = image
  return result
}

/**
 * The Realtime Definition of the page presence rooms: who is on a page and where their cursor is. Rooms hold no
 * document; threads stay in the Database. Connections are read-only, and the server binds account presence to the user
 * that Comments resolves. Guests name themselves in the browser. ViteHub adds it as the `comments` definition when the
 * host has a room authority.
 */
export function commentsRealtime(comments: Comments, options: {
  /** Auth fallback, skipped when custom `identify` is configured. */
  session?: (event: H3Event) => Promise<CommentsUser | null | undefined>
  /** Console section access, checked before custom `identify` or Comments policies. */
  consoleSession?: (event: H3Event) => Promise<CommentsUser | null | undefined | false>
} = {}): RealtimeDefinition {
  // Realtime drops policy fields such as role. Keep the whole identity for this request's page-aware check.
  const readers = new WeakMap<H3Event, CommentsUser | null | false>()
  return {
    async identify({ event }) {
      const consoleUser = await options.consoleSession?.(event).catch(() => false as const)
      if (consoleUser === false) {
        readers.set(event, false)
        return null
      }
      const user = comments.options.identify
        ? await comments.options.identify({ event })
        : options.consoleSession
          ? consoleUser
          : await options.session?.(event).catch(() => null)
      readers.set(event, user ?? null)
      // Browser WebSockets carry no guest headers. Keep Console guests' browser identities in awareness instead of
      // binding them to the shared session fallback. Custom identify results, including guests, remain server-bound.
      return user && (comments.options.identify || user.guest !== true) ? toRealtimeUser(user) : null
    },
    async authorize({ event, mode, documentId, request }) {
      const user = readers.get(event)
      if (mode !== "read" || user === undefined || user === false) return false
      const page = new URL(request.url).searchParams.get("page")
      if (!page) return false
      const subject = { kind: "page", id: normalizeCommentPage(page) }
      // Comments hints travel in page awareness. The definition-wide events room exposes other pages' activity.
      if (documentId !== commentRoom(subject.id)) return false
      return await comments.can({ user, action: "read", subject }, { console: Boolean(options.consoleSession) })
    },
    document: {
      kind: "comments",
      load: async () => ({ body: "", digest: null }),
      // Read-only connections never change the room, so there is nothing to store.
      save: async () => ({ digest: "comments" }),
    },
    persistence: false,
  }
}
