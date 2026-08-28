import type { AgentChatMessage, AgentChannelDeliveryEffectContext, AgentRuntimeConfig } from "../types.ts"

export const chatFinishDeliveryRegistrarKey = Symbol("vitehub.chat.finish.delivery-registrar")

export interface ChatFinishDeliveryCapture {
  content: string
  error?: string
  skipped?: string
  truncated: boolean
}

export type ChatFinishDeliveryCallback = (capture: ChatFinishDeliveryCapture) => Promise<void>

export interface ChatFinishDeliveryRegistrar {
  [chatFinishDeliveryRegistrarKey]?: (
    message: AgentChatMessage,
    callback: ChatFinishDeliveryCallback,
  ) => boolean
}

const deferredReplyTraces = new WeakMap<object, (callback: ChatFinishDeliveryCallback) => boolean>()
const directReplyTraces = new WeakMap<object, (message: AgentChatMessage) => ChatFinishDeliveryCallback>()

export function setChatFinishDirectReplyTrace(
  extension: object,
  createCallback: (message: AgentChatMessage) => ChatFinishDeliveryCallback,
): void {
  directReplyTraces.set(extension, createCallback)
}

export function chatFinishDirectReplyTrace(
  extension: object,
  message: AgentChatMessage,
): ChatFinishDeliveryCallback | undefined {
  return directReplyTraces.get(extension)?.(message)
}

export function setMessageChannelDeferredReplyTrace<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
  registrar: (callback: ChatFinishDeliveryCallback) => boolean,
): void {
  deferredReplyTraces.set(context, registrar)
}

export function registerMessageChannelDeferredReplyTrace<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
  callback: ChatFinishDeliveryCallback,
): boolean {
  return deferredReplyTraces.get(context)?.(callback) ?? false
}
