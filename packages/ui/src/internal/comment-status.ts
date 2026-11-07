import type { CommentMessage, CommentThread } from "@vite-hub/comments/client";

/** The messages written after the thread was resolved. Empty for an open thread. */
export function messagesSinceResolved(thread: Pick<CommentThread, "status" | "resolvedAt" | "messages">): CommentMessage[] {
  const { resolvedAt } = thread;
  if (thread.status !== "resolved" || resolvedAt === undefined) return [];
  return thread.messages.filter(message => message.createdAt > resolvedAt);
}

/**
 * Whether someone replied after the thread was resolved, such as an agent that says what it changed. The thread stays
 * resolved, and lists show it with the open threads until someone resolves it again.
 */
export const repliedSinceResolved = (thread: Pick<CommentThread, "status" | "resolvedAt" | "messages">): boolean =>
  messagesSinceResolved(thread).length > 0;
