import { getAuth, getAuthForRequest } from "@vite-hub/auth/server"

import { createAuthUsers } from "../operations-core/server.ts"

import { requestOf } from "./request.ts"

import type { H3Event } from "h3"
// Adds `~standard` to the H3Event type. The ViteHub Nitro plugin sets it at runtime.
import type {} from "@vite-hub/runtime/h3"
import type { CommentsPeople, CommentsUser } from "../types.ts"

/** The ViteHub Auth user of a request, or null. Generated Comments files pass it as `session` when the app has Auth. */
export async function commentsAuthSession(event: H3Event): Promise<CommentsUser | null> {
  const request = requestOf(event)
  const auth = getAuthForRequest(request, undefined, event)
  const session = await auth.api.getSession({ headers: request.headers })
  const user: unknown = session?.user
  if (!user || typeof user !== "object" || !("id" in user) || typeof user.id !== "string") return null
  return { ...user, id: user.id }
}

/** The users of ViteHub Auth, for `@` suggestions. Generated Comments files pass it as `users` when the app has Auth. */
export const commentsAuthUsers: CommentsPeople = createAuthUsers(() => getAuth())
