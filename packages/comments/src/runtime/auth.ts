import { getAuthForRequest } from "@vite-hub/auth/server"

import type { H3Event } from "h3"
import type { CommentsUser } from "../types.ts"

/** The ViteHub Auth user of a request, or null. Generated Comments files pass it as `session` when the app has Auth. */
export async function commentsAuthSession(event: H3Event): Promise<CommentsUser | null> {
  const auth = getAuthForRequest(event.req, undefined, event)
  const session = await auth.api.getSession({ headers: event.req.headers })
  const user: unknown = session?.user
  if (!user || typeof user !== "object" || !("id" in user) || typeof user.id !== "string") return null
  return { ...user, id: user.id }
}
