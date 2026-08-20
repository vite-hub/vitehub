import { resolveRuntimeValue } from "@vite-hub/runtime"

import type { AgentCapabilityRuntimeContext, AgentChannelDefinition, AgentInvocationContextStore, AgentRuntimeConfig } from "../types.ts"
import type { Adapter } from "chat"

export const activeMessageChannelContextKey = "agent.channel.active"
export const messageChannelProgressContextKey = "agent.channel.progress"
export const messageChannelProgressClearedContextKey = "agent.channel.progress.cleared"
export const messageChannelProgressUpdatesClosedContextKey = "agent.channel.progress.updates-closed"
const messageChannelProgressCleanupTimeoutMs = 1_000

export async function withinMessageChannelProgressDeadline<T>(
  operation: Promise<T>,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          onTimeout?.()
          reject(new Error(message))
        }, messageChannelProgressCleanupTimeoutMs)
      }),
    ])
  }
  finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export interface MessageChannelProgressReference {
  messageId: string
  ready?: Promise<MessageChannelProgressReference | undefined>
  reusable?: boolean
  threadId: string
}

async function resolveMessageChannelProgressReference(
  progress: MessageChannelProgressReference | undefined,
): Promise<{ messageId: string, threadId: string } | undefined> {
  const resolved = progress?.ready ? await progress.ready : progress
  if (typeof resolved?.messageId !== "string" || typeof resolved.threadId !== "string") return
  return { messageId: resolved.messageId, threadId: resolved.threadId }
}

interface MessageChannelProgressRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig> {
  [key: string]: unknown
  adapter?: Adapter
  channel?: AgentChannelDefinition<TRuntimeConfig>
  context: AgentInvocationContextStore
}

export async function clearMessageChannelProgress<TRuntimeConfig extends AgentRuntimeConfig>(
  context: MessageChannelProgressRuntimeContext<TRuntimeConfig>,
): Promise<boolean> {
  const channel = context.channel || context.context.get<AgentChannelDefinition<TRuntimeConfig>>(activeMessageChannelContextKey)
  const progress = await resolveMessageChannelProgressReference(context.context.get<MessageChannelProgressReference>(messageChannelProgressContextKey))
  if (!channel?.adapter || !progress || context.context.get<boolean>(messageChannelProgressClearedContextKey) === true) return false
  const adapter = context.adapter || await resolveRuntimeValue(channel.adapter, context as never) as Adapter | undefined
  if (!adapter?.deleteMessage) return false
  try {
    await withinMessageChannelProgressDeadline(
      adapter.deleteMessage(progress.threadId, progress.messageId),
      "[vitehub] Timed out clearing message Channel progress.",
    )
  }
  catch (error) {
    const reference = context.context.get<MessageChannelProgressReference>(messageChannelProgressContextKey)
    if (reference) reference.reusable = false
    throw error
  }
  context.context.set(messageChannelProgressClearedContextKey, true, { overwrite: true })
  return true
}

export async function updateMessageChannelProgress(
  context: AgentCapabilityRuntimeContext,
  summary: string,
): Promise<boolean> {
  if (context.context.get<boolean>(messageChannelProgressUpdatesClosedContextKey) === true) return false
  const channel = context.context.get<AgentChannelDefinition>(activeMessageChannelContextKey)
  const progress = await resolveMessageChannelProgressReference(context.context.get<MessageChannelProgressReference>(messageChannelProgressContextKey))
  if (!channel?.adapter || !progress) return false
  const adapter = await resolveRuntimeValue(channel.adapter, context as never) as Adapter | undefined
  if (!adapter?.editMessage || context.context.get<boolean>(messageChannelProgressUpdatesClosedContextKey) === true) return false
  await adapter.editMessage(progress.threadId, progress.messageId, { markdown: summary })
  return true
}
