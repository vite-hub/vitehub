import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { installStandardContext } from "@vite-hub/runtime/h3"

import { normalizeCommentPage } from "../page.ts"

import type { Comments } from "../index.ts"
import type { CommentsPolicyGate } from "../operations-core/define.ts"
import type { CommentAction, CommentsRequestEvent, CommentSubject, CommentsUser } from "../types.ts"

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

/**
 * The subject of an app page: what `page` of `defineComments()` gives for its URL, else `{ kind: "page", id }` with the
 * normalized path. The overlay API, the page tools gate, and Realtime presence all check `authorize` on it.
 */
export async function resolveCommentsPage(comments: Comments, event: CommentsRequestEvent, request: Request, path: string): Promise<{ subject: CommentSubject, revision?: number }> {
  const id = normalizeCommentPage(path)
  if (!comments.options.page) return { subject: { kind: "page", id } }
  // `page` reads `event["~standard"]`. Set it when Nitro did not, as for `identify`.
  installStandardContext(event)
  const mapped = await comments.options.page({ url: new URL(id, forwardedRequestOrigin(request)), event })
  if (!mapped) return { subject: { kind: "page", id } }
  return { subject: { kind: mapped.kind, id: mapped.id }, ...(mapped.revision === undefined ? {} : { revision: mapped.revision }) }
}
