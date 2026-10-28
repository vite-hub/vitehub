import type { H3Event } from "h3"
import type { Comments } from "../index.ts"
import type { CommentsUser } from "../types.ts"

export interface CommentsSessionOptions {
  /** The same session reader configured for the Comments API. `false` denies access before identity policies. */
  session?: (event: H3Event) => Promise<CommentsUser | null | undefined | false>
}

/** The effective Comments user, shared by the overlay API and MCP tools. */
export async function resolveCommentsUser(comments: Comments, event: H3Event, session?: CommentsSessionOptions["session"]): Promise<CommentsUser | null | false> {
  const user = await session?.(event).catch(() => null)
  if (user === false) return false
  return comments.options.identify ? await comments.options.identify({ event }) ?? null : user ?? null
}
