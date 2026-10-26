import { text } from "./identity.ts"

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
 * document; threads stay in the Database. Connections are read-only, and the server binds each person's presence to the
 * user that Comments resolves. ViteHub adds it as the `comments` definition when the host has a room authority.
 */
export function commentsRealtime(comments: Comments, options: { session?: (event: H3Event) => Promise<CommentsUser | null | undefined> } = {}): RealtimeDefinition {
  // Realtime keeps only the id, name, email, and image of a user. Decide access in `identify`, with the whole user that
  // `authorize` policies read, such as a role, and answer `authorize` for the same request.
  const readers = new WeakMap<H3Event, boolean>()
  return {
    async identify({ event }) {
      const user = comments.options.identify
        ? await comments.options.identify({ event })
        : await options.session?.(event).catch(() => null)
      readers.set(event, await comments.can({ user: user ?? null, action: "read" }))
      return user ? toRealtimeUser(user) : null
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
