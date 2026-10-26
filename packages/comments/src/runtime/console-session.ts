import type { H3Event } from "h3"
import type { CommentsUser } from "../types.ts"

/** The parts of `consoleRealtimeAccess()` from `vite-hub/console/sections` that Comments reads. */
export interface CommentsConsoleAccess {
  identify(context: { event: unknown }): Promise<{ id: string, name?: string, email?: string, image?: string } | null>
  authorize(context: { event: unknown }): Promise<boolean>
  user(context: { event: unknown }): Promise<Record<string, unknown> | null>
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** The guest name that the overlay sends after a person of a Console without accounts names itself. */
function namedGuest(request: Request): CommentsUser | undefined {
  const id = request.headers.get("x-vitehub-comments-guest-id")
  const name = request.headers.get("x-vitehub-comments-guest-name")
  if (!id || !name || id.length > 64) return
  try {
    const decoded = decodeURIComponent(name).trim().slice(0, 64)
    return decoded ? { id: `guest:${id}`, name: decoded, guest: true } : undefined
  }
  catch {
    return undefined
  }
}

/**
 * The user of a request from the Console access rules: the person must be allowed to use the Console `comments`
 * section. People that the Console does not allow get `null`, so they never see the overlay. A Console without
 * accounts, such as `console: { auth: false }` or the dev server, gives a guest, which names itself in the overlay.
 */
export function commentsConsoleSession(access: CommentsConsoleAccess): (event: H3Event) => Promise<CommentsUser | null> {
  return async (event) => {
    if (!await access.authorize({ event })) return null
    const user = await access.user({ event })
    const id = text(user?.id) ?? text(user?.email)
    if (user && id) return { ...user, id }
    const person = await access.identify({ event })
    // Cloudflare Access names the person by email. A Console without accounts makes a new guest id for each request.
    if (person && !person.id.startsWith("guest-")) return { ...person }
    return namedGuest(event.req) ?? { id: "guest:console", name: "Guest", guest: true }
  }
}
