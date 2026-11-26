import type { CommentDelivery, CommentMessage, CommentThread } from "@vite-hub/comments/client";

/** The messages written after the thread was resolved. Empty for an open thread. */
export function messagesSinceResolved(thread: Pick<CommentThread, "status" | "resolvedAt" | "messages">): CommentMessage[] {
  const { resolvedAt } = thread;
  if (thread.status !== "resolved" || resolvedAt === undefined) return [];
  return thread.messages.filter(message => message.createdAt > resolvedAt);
}

/** "Comment 3". A comment that waits in the outbox has no number yet. */
export function commentTitle(thread: Pick<CommentThread, "n">): string {
  return thread.n ? `Comment ${thread.n}` : "Comment";
}

/** `data-pending` or `data-failed` for a thread, message, or row that the outbox holds. */
export function deliveryAttributes(delivery: CommentDelivery | undefined) {
  return { "data-failed": delivery?.status === "failed" ? "true" : undefined, "data-pending": delivery?.status === "pending" ? "true" : undefined };
}
