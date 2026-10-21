import type { Adapter, AdapterPostableMessage, RawMessage } from "chat"
import { isRuntimeString } from "./runtime-value.ts"

/** A host restart retries an interrupted chat message under this id. The platform has no message with this id. */
export const interruptedChatRetrySuffix = "#vitehub-retry"

/** Returns true when the platform can attach a native reply to this message id. */
export function isChatReplyTargetId(messageId: unknown): messageId is string {
  return isRuntimeString(messageId) && messageId.length > 0 && !messageId.includes(interruptedChatRetrySuffix)
}

/** Sends a native reply to the triggering message when the adapter supports it. Other adapters get a new thread message. */
export async function postChannelReply(
  adapter: Adapter,
  threadId: string,
  messageId: string | undefined,
  message: AdapterPostableMessage,
): Promise<RawMessage<unknown>> {
  if (adapter.reply && isChatReplyTargetId(messageId)) return await adapter.reply(threadId, messageId, message)
  return await adapter.postMessage(threadId, message)
}
