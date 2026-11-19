/**
 * The id of the message that a reply with `requestId` stores in a thread: the same for every retry, so a second try
 * adds no second message, and a client finds the server copy of its waiting reply by it.
 */
export async function replyMessageId(threadId: string, requestId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([threadId, requestId]))))
  return `message_${Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")}`
}
