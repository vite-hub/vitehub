import type { CommentsAuthorizeContext as OperationsContext, CommentsDefinition } from "./operations-core/define.ts"
import type { CommentsAuthorizeContext as LiveContext, DefineCommentsOptions as LiveOptions } from "./types.ts"

/** Both entry forms share a factory; each runtime supplies its own action and thread shape. */
export interface CommentsAuthorizeContext {
  user: LiveContext["user"]
  action: LiveContext["action"] | OperationsContext["action"]
  /** The live-site thread scope. Operations use `subject` instead. */
  scope?: LiveContext["scope"]
  thread?: LiveContext["thread"] | OperationsContext["thread"]
  actor?: OperationsContext["actor"]
  subject?: OperationsContext["subject"]
}

export type DefineCommentsOptions = Omit<LiveOptions, "authorize"> & Omit<CommentsDefinition, "authorize"> & {
  authorize?: (context: CommentsAuthorizeContext) => boolean | void | Promise<boolean | void>
}
