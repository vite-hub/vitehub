import type { H3Event } from "h3"
import type { Comments } from "../index.ts"
import type { CommentsUser } from "../types.ts"

export interface CommentsSessionOptions {
  /** The same session reader configured for the Comments API. */
  session?: (event: H3Event) => Promise<CommentsUser | null | undefined>
}

/** The effective Comments user, shared by the overlay API and MCP tools. */
export async function resolveCommentsUser(comments: Comments, event: H3Event, session?: CommentsSessionOptions["session"]): Promise<CommentsUser | null> {
  if (comments.options.identify) return await comments.options.identify({ event }) ?? null
  if (!session) return null
  try {
    return await session(event) ?? null
  }
  catch {
    return null
  }
}
