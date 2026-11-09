import { commentsRuntime, hasCommentsRuntime } from "./operations-core/server.ts"

import type { Comments } from "./index.ts"
import type { CommentsRuntime } from "./operations-core/service.ts"

export interface Installed {
  runtime: CommentsRuntime
  sync?: (threadId: string) => Promise<void>
}

/** The runtime that `installComments()` connected to each definition. */
export const runtimes = new WeakMap<Comments, Installed>()

/** The runtime that the generated Nitro plugin builds on the first call, per definition. */
export const runtimeBuilds = new WeakMap<Comments, () => Promise<CommentsRuntime>>()

export const pendingKey: unique symbol = Symbol.for("vitehub.comments.pending")

/**
 * The runtime of a definition. The generated Nitro plugin builds it on the first call, so a server API call before
 * any operation builds it too.
 */
export async function runtimeOf(comments: Comments): Promise<CommentsRuntime | undefined> {
  const installed = runtimes.get(comments)?.runtime
  if (installed) return installed
  const build = runtimeBuilds.get(comments)
  if (build) return await build().catch(() => undefined)
  if (!hasCommentsRuntime()) return undefined
  const built = await commentsRuntime().catch(() => undefined)
  return built?.definition === comments.options ? built : undefined
}

/** The runtime that `installComments()` connected, for the overlay API and the MCP tools. */
export function commentsRuntimeOf(comments: Comments): CommentsRuntime | undefined {
  return runtimes.get(comments)?.runtime
}

/** The runtime of a definition, or the one that the generated Nitro plugin builds on first use, for the overlay API. */
export async function resolveCommentsRuntime(comments: Comments): Promise<CommentsRuntime | undefined> {
  return runtimeOf(comments)
}
