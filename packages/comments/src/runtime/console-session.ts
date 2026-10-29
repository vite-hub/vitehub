import { text } from "../identity.ts"

import type { H3Event } from "h3"
import type { CommentsAction, CommentsUser } from "../types.ts"

/** The parts of `consoleRealtimeAccess()` from `vite-hub/console/sections` that Comments reads. */
export interface CommentsConsoleAccess {
  identify(context: { event: unknown }): Promise<{ id: string, name?: string, email?: string, image?: string } | null>
  authorize(context: { event: unknown, kind?: "read" | "write" }): Promise<boolean>
  user(context: { event: unknown }): Promise<Record<string, unknown> | null>
}

/**
 * The user of a request from the Console access rules: the person must be allowed to use the Console `comments`
 * section. People that the Console does not allow get `false`, which denies access before Comments guest policies.
 * A Console without accounts, such as `console: { auth: false }` or the dev server, stays anonymous to policies.
 * Guest authors name themselves in the overlay; their browser display data never becomes a policy user.
 */
export function commentsConsoleSession(access: CommentsConsoleAccess): (event: H3Event, action?: CommentsAction) => Promise<CommentsUser | null | false> {
  return async (event, action = "read") => {
    if (!await access.authorize({ event, kind: action === "read" ? "read" : "write" })) return false
    const user = await access.user({ event })
    const id = text(user?.id) ?? text(user?.email)
    if (user && id) return { ...user, id }
    const person = await access.identify({ event })
    // Cloudflare Access names the person by email. A Console without accounts makes a new guest id for each request.
    const openGuest = person && !person.email && /^guest-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(person.id)
    if (person && !openGuest) return { ...person }
    return null
  }
}
