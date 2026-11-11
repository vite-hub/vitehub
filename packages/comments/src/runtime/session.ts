import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { getStandardContext } from "@vite-hub/runtime/h3"

import { normalizeCommentPage } from "../page.ts"

import type { Comments } from "../index.ts"
import type { CommentsPolicyGate } from "../operations-core/define.ts"
import type { CommentsRequestEvent, CommentSubject, CommentsUser } from "../types.ts"

export interface CommentsSessionOptions {
  /** Reads the ViteHub Auth user only when no custom `identify` is configured. */
  session?: (event: CommentsRequestEvent) => Promise<CommentsUser | null | undefined>
}

/** The user of a request, and what the server checked before the policy runs. */
export interface CommentsIdentity {
  user: CommentsUser | null
  gate: CommentsPolicyGate
}

/**
 * The user of a request, shared by the overlay API, Realtime presence, the MCP tools, and the comment operations.
 * With `identify`, the app decides: `identify` names the user and `authorize` decides what they may do. Without
 * `identify`, it is the user of `session`: the ViteHub Auth user, else the person signed in with GitHub.
 */
export async function resolveCommentsIdentity(comments: Comments, event: CommentsRequestEvent, options: CommentsSessionOptions = {}): Promise<CommentsIdentity> {
  if (comments.options.identify) {
    // `identify` reads `event["~standard"]`. Set it when Nitro did not, such as for a Request from a test.
    getStandardContext(event)
    return { user: await comments.options.identify({ event }) ?? null, gate: {} }
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
  getStandardContext(event)
  const mapped = await comments.options.page({ url: new URL(id, forwardedRequestOrigin(request)), event })
  if (!mapped) return { subject: { kind: "page", id } }
  return { subject: { kind: mapped.kind, id: mapped.id }, ...(mapped.revision === undefined ? {} : { revision: mapped.revision }) }
}
