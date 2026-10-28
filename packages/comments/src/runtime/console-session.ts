import { guestFromHeaders, text } from "../identity.ts"

import type { H3Event } from "h3"
import type { CommentsUser } from "../types.ts"

/** The parts of `consoleRealtimeAccess()` from `vite-hub/console/sections` that Comments reads. */
export interface CommentsConsoleAccess {
  identify(context: { event: unknown }): Promise<{ id: string, name?: string, email?: string, image?: string } | null>
  authorize(context: { event: unknown }): Promise<boolean>
  user(context: { event: unknown }): Promise<Record<string, unknown> | null>
}

/**
 * The user of a request from the Console access rules: the person must be allowed to use the Console `comments`
 * section. People that the Console does not allow get `false`, which denies access before Comments guest policies.
 * A Console without accounts, such as `console: { auth: false }` or the dev server, gives a guest, which names itself in the overlay.
 */
export function commentsConsoleSession(access: CommentsConsoleAccess): (event: H3Event) => Promise<CommentsUser | false> {
  return async (event) => {
    if (!await access.authorize({ event })) return false
    const user = await access.user({ event })
    const id = text(user?.id) ?? text(user?.email)
    if (user && id) return { ...user, id }
    const person = await access.identify({ event })
    // Cloudflare Access names the person by email. A Console without accounts makes a new guest id for each request.
    const openGuest = person && !person.email && /^guest-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(person.id)
    if (person && !openGuest) return { ...person }
    const guest = guestFromHeaders(event.req.headers)
    return guest ? { ...guest } : { id: "guest:console", name: "Guest", guest: true }
  }
}
