/**
 * The id of the message that a reply with `requestId` stores in a thread. Every retry gets the same id, so the primary
 * key of the messages refuses a second message, and the client's outbox finds the server copy of its waiting reply.
 * The server and the browser client both import it, so it has no other import.
 */
export async function replyMessageId(threadId: string, requestId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([threadId, requestId]))))
  return `message_${Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")}`
}
