import type { H3Event } from "h3"
import type { Comments } from "../index.ts"
import type { CommentsAction, CommentsUser } from "../types.ts"

export interface CommentsSessionOptions {
  /** Reads the ViteHub Auth user only when no custom `identify` is configured. */
  session?: (event: H3Event) => Promise<CommentsUser | null | undefined>
  /**
   * Checks Console section access for the action before custom `identify` or Comments policies. `false` or a failed
   * check denies access; otherwise this is the user when no custom `identify` is configured.
   */
  consoleSession?: (event: H3Event, action?: CommentsAction) => Promise<CommentsUser | null | undefined | false>
}

/** The effective Comments user, shared by the overlay API and MCP tools. */
export async function resolveCommentsUser(comments: Comments, event: H3Event, options: CommentsSessionOptions = {}, action: CommentsAction = "read"): Promise<CommentsUser | null | false> {
  const consoleUser = await options.consoleSession?.(event, action).catch(() => false as const)
  if (consoleUser === false) return false
  if (comments.options.identify) return await comments.options.identify({ event }) ?? null
  if (options.consoleSession) return consoleUser ?? null
  return await options.session?.(event).catch(() => null) ?? null
}
