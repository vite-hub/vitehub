import { installStandardContext } from "@vite-hub/runtime/h3"

import type { Comments } from "../index.ts"
import type { CommentsPolicyGate } from "../operations-core/define.ts"
import type { CommentAction, CommentsRequestEvent, CommentsUser } from "../types.ts"

export interface CommentsSessionOptions {
  /** Reads the ViteHub Auth user only when no custom `identify` is configured. */
  session?: (event: CommentsRequestEvent) => Promise<CommentsUser | null | undefined>
  /**
   * Console section access for the action, used only when no custom `identify` is configured. `false` or a failed
   * check denies access; otherwise this is the user.
   */
  consoleSession?: (event: CommentsRequestEvent, action?: CommentAction) => Promise<CommentsUser | null | undefined | false>
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
export async function resolveCommentsIdentity(comments: Comments, event: CommentsRequestEvent, options: CommentsSessionOptions = {}, action: CommentAction = "read"): Promise<CommentsIdentity | false> {
  if (comments.options.identify) {
    // `identify` reads `event["~standard"]`. Set it when Nitro did not, such as for an H3 app without the ViteHub plugin.
    installStandardContext(event)
    return { user: await comments.options.identify({ event }) ?? null, gate: {} }
  }
  if (options.consoleSession) {
    const user = await options.consoleSession(event, action).catch(() => false as const)
    return user === false ? false : { user: user ?? null, gate: { console: true } }
  }
  return { user: await options.session?.(event).catch(() => null) ?? null, gate: {} }
}
