import { text } from "./identity.ts"
import { resolveCommentsIdentity } from "./runtime/session.ts"

import type { RealtimeDefinition, RealtimeUser } from "@vite-hub/realtime"
import type { H3Event } from "h3"
import type { Comments } from "./index.ts"
import type { CommentsSessionOptions } from "./runtime/session.ts"
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
export function commentsRealtime(comments: Comments, options: CommentsSessionOptions = {}): RealtimeDefinition {
  // Realtime keeps only the id, name, email, and image of a user. Decide access in `identify`, with the whole user that
  // `authorize` policies read, such as a role, and answer `authorize` for the same request.
  const readers = new WeakMap<H3Event, boolean>()
  return {
    async identify({ event }) {
      const identity = await resolveCommentsIdentity(comments, event, options)
      readers.set(event, identity !== false && await comments.can({ user: identity.user, action: "read" }, identity.gate))
      if (identity === false || !identity.user) return null
      // Browser WebSockets carry no guest headers. Keep Console guests' browser identities in awareness instead of
      // binding them to the shared session fallback. Custom identify results, including guests, remain server-bound.
      return comments.options.identify || identity.user.guest !== true ? toRealtimeUser(identity.user) : null
    },
    authorize: ({ event, mode }) => mode === "read" && readers.get(event) === true,
    document: {
      kind: "comments",
      load: async () => ({ body: "", digest: null }),
      // Read-only connections never change the room, so there is nothing to store.
      save: async () => ({ digest: "comments" }),
    },
    persistence: false,
  }
}
