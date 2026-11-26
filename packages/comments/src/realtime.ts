import { text } from "./identity.ts"
import { commentNoticeRoom, commentRoom, commentsNoticeDefinition, normalizeCommentPage } from "./page.ts"
import { resolveCommentsIdentity, resolveCommentsPage } from "./runtime/session.ts"

import type { RealtimeDefinition, RealtimeUser } from "@vite-hub/realtime"
import type { Comments } from "./index.ts"
import type { CommentsIdentity, CommentsSessionOptions } from "./runtime/session.ts"
import type { CommentThread, CommentsUser } from "./types.ts"

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
 * document; threads stay in the Database. The server binds account presence to the user that Comments resolves.
 * Guests name themselves in the browser. ViteHub adds it as the `comments` definition when the host has a room
 * authority.
 */
export function commentsRealtime(comments: Comments, options: CommentsSessionOptions = {}, purpose: "presence" | "notices" = "presence"): RealtimeDefinition {
  // Realtime drops policy fields such as role. Keep the whole identity for this request's page-aware check.
  const readers = new WeakMap<object, CommentsIdentity>()
  return {
    async identify({ event }) {
      const identity = await resolveCommentsIdentity(comments, event, options)
      readers.set(event, identity)
      if (!identity.user) return null
      // Browser WebSockets carry no guest headers. Keep guests' browser identities in awareness instead of
      // binding them to the shared session fallback. Custom identify results, including guests, remain server-bound.
      return comments.options.identify || identity.user.guest !== true ? toRealtimeUser(identity.user) : null
    },
    async authorize({ event, mode, documentId, request }) {
      const identity = readers.get(event)
      if (mode !== "read" || identity === undefined) return false
      const page = new URL(request.url).searchParams.get("page")
      if (!page) return false
      // Rooms stay one per page path. Comments hints travel in page awareness. The definition-wide events room exposes
      // other pages' activity.
      if (purpose === "presence" && documentId !== commentRoom(normalizeCommentPage(page))) return false
      const { subject } = await resolveCommentsPage(comments, event, request, page)
      if (purpose === "notices" && documentId !== commentNoticeRoom(subject)) return false
      return await comments.can({ user: identity.user, action: "read", subject }, identity.gate)
    },
    document: false,
    ...(purpose === "notices" ? { awareness: false } : {}),
  }
}

/** The notice that tells the open pages of a thread to load their threads again. */
export const commentsChangeNotice = { type: "comments" } as const

/** Tells the browsers on the page of a thread that it changed, so they load their threads again. It never throws. */
export async function notifyCommentsChange(thread: Pick<CommentThread, "subject">): Promise<void> {
  const realtime = await import("@vite-hub/realtime/server").catch(() => undefined)
  await realtime?.notifyRealtimeRoom(commentsNoticeDefinition, commentNoticeRoom(thread.subject), commentsChangeNotice)
}
