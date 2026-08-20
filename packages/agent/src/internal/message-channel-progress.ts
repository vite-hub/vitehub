import { resolveRuntimeValue } from "@vite-hub/runtime"

import type { AgentCapabilityRuntimeContext, AgentChannelDefinition } from "../types.ts"
import type { Adapter } from "chat"

export const activeMessageChannelContextKey = "agent.channel.active"
export const messageChannelProgressContextKey = "agent.channel.progress"
export const messageChannelProgressClearedContextKey = "agent.channel.progress.cleared"

export interface MessageChannelProgressReference {
  messageId: string
  threadId: string
}

export async function updateMessageChannelProgress(
  context: AgentCapabilityRuntimeContext,
  summary: string,
): Promise<boolean> {
  const channel = context.context.get<AgentChannelDefinition>(activeMessageChannelContextKey)
  const progress = context.context.get<MessageChannelProgressReference>(messageChannelProgressContextKey)
  if (!channel?.adapter || !progress) return false
  const adapter = await resolveRuntimeValue(channel.adapter, context as never) as Adapter | undefined
  if (!adapter?.editMessage) return false
  await adapter.editMessage(progress.threadId, progress.messageId, { markdown: summary })
  return true
}
