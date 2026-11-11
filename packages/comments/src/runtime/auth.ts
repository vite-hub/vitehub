import { getStandardContext } from "@vite-hub/runtime/h3"

import { createAuthUsers } from "../operations-core/server.ts"

import type { CommentsPeople, CommentsRequestEvent, CommentsUser } from "../types.ts"

// The generated Comments plugin imports this module at startup. Better Auth loads on the first request that needs a user.
const authServer = () => import("@vite-hub/auth/server")

/** The ViteHub Auth user of a request, or null. Generated Comments files pass it as `session` when the app has Auth. */
export async function commentsAuthSession(event: CommentsRequestEvent): Promise<CommentsUser | null> {
  const request = getStandardContext(event).req
  const auth = (await authServer()).useAuth(event)
  const session = await auth.api.getSession({ headers: request.headers })
  const user: unknown = session?.user
  if (!user || typeof user !== "object" || !("id" in user) || typeof user.id !== "string") return null
  return { ...user, id: user.id }
}

/** The users of ViteHub Auth, for `@` suggestions. Generated Comments files pass it as `users` when the app has Auth. */
export const commentsAuthUsers: CommentsPeople = createAuthUsers(async () => (await authServer()).getAuth())
