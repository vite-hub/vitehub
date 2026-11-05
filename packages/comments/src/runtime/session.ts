import type { H3Event } from "h3"
import type { Comments } from "../index.ts"
import type { CommentsPolicyGate } from "../operations-core/define.ts"
import type { CommentAction, CommentsUser } from "../types.ts"

export interface CommentsSessionOptions {
  /** Reads the ViteHub Auth user only when no custom `identify` is configured. */
  session?: (event: H3Event) => Promise<CommentsUser | null | undefined>
  /**
   * Console section access for the action, used only when no custom `identify` is configured. `false` or a failed
   * check denies access; otherwise this is the user.
   */
  consoleSession?: (event: H3Event, action?: CommentAction) => Promise<CommentsUser | null | undefined | false>
}

/** The user of a request, and what the server checked before the policy runs. */
export interface CommentsIdentity {
  user: CommentsUser | null
  /** `console` is set only when the Console admitted the person, so the default policy may trust them. */
  gate: CommentsPolicyGate
}

/**
 * The user of a request, shared by the overlay API, Realtime presence, the MCP tools, and the comment operations.
 * With `identify`, the app decides: `identify` names the user and `authorize` decides what they may do, so members,
 * guests, and share-link readers get in without Console access. Without `identify`, the Console's section access for
 * `action` decides when the app has the Console, and `false` means it refused. Otherwise it is the Auth session.
 */
export async function resolveCommentsIdentity(comments: Comments, event: H3Event, options: CommentsSessionOptions = {}, action: CommentAction = "read"): Promise<CommentsIdentity | false> {
  if (comments.options.identify) return { user: await comments.options.identify({ event }) ?? null, gate: {} }
  if (options.consoleSession) {
    const user = await options.consoleSession(event, action).catch(() => false as const)
    return user === false ? false : { user: user ?? null, gate: { console: true } }
  }
  return { user: await options.session?.(event).catch(() => null) ?? null, gate: {} }
}
