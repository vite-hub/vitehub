import * as v from "valibot"
import { isRuntimeRecord } from "./runtime-type.ts"
import type { AgentChatMessage, AgentChannelDeliveryEffectContext, AgentInvocationContextStore, AgentRuntimeConfig } from "../types.ts"

export const chatFinishDeliveryRegistrarKey = Symbol("vitehub.chat.finish.delivery-registrar")

export interface ChatFinishDeliveryCapture {
  content: string
  error?: string
  skipped?: string
  truncated: boolean
}

export type ChatFinishDeliveryCallback = (capture: ChatFinishDeliveryCapture) => Promise<void>

export interface ChatFinishDeliveryOptions {
  shouldSkip?: () => boolean
  continueOnError?: boolean
}

export interface ChatFinishDeliveryRegistrar {
  [chatFinishDeliveryRegistrarKey]?: (
    message: AgentChatMessage,
    callback: ChatFinishDeliveryCallback,
    options?: ChatFinishDeliveryOptions,
  ) => boolean
}

const deferredReplyTraces = new WeakMap<object, (callback: ChatFinishDeliveryCallback) => boolean>()
const directReplyTraces = new WeakMap<ChatFinishDeliveryRegistrar, (message: AgentChatMessage) => ChatFinishDeliveryCallback>()
const primaryReplyTraces = new WeakMap<ChatFinishDeliveryRegistrar, ChatFinishDeliveryCallback>()

export function setChatFinishDirectReplyTrace(
  extension: ChatFinishDeliveryRegistrar,
  createCallback: (message: AgentChatMessage) => ChatFinishDeliveryCallback,
): void {
  directReplyTraces.set(extension, createCallback)
}

export function chatFinishDirectReplyTrace(
  extension: ChatFinishDeliveryRegistrar,
  message: AgentChatMessage,
): ChatFinishDeliveryCallback | undefined {
  return directReplyTraces.get(extension)?.(message)
}

export function setChatFinishPrimaryReplyTrace(
  extension: ChatFinishDeliveryRegistrar,
  callback: ChatFinishDeliveryCallback,
): void {
  primaryReplyTraces.set(extension, callback)
}

export function chatFinishPrimaryReplyTrace(
  extension: ChatFinishDeliveryRegistrar,
): ChatFinishDeliveryCallback | undefined {
  return primaryReplyTraces.get(extension)
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

/**
 * Input context key that the Chat route sets for each automatic-delivery
 * Invocation. "pending" means the Chat finish effect posts the final text.
 * "posted" means the route owns streaming or posting it.
 */
export const chatFinalReplyContextKey = "vitehub.chat.final-reply"
export type ChatFinalReplyMode = "pending" | "posted"
export const chatFinalReplyIntent = "chat.final-reply"

export function chatFinalReplyMode(input: { context?: unknown } | undefined): ChatFinalReplyMode | undefined {
  const context = input?.context
  if (!isRuntimeRecord(context)) return
  const mode = context[chatFinalReplyContextKey]
  return mode === "pending" || mode === "posted" ? mode : undefined
}

/** Input context key where Capabilities add notices for the final chat reply. */
export const chatFinalReplyNoticesContextKey = "vitehub.chat.final-reply.notices"

const chatFinalReplyNoticeSchema = v.pipe(v.string(), v.trim(), v.nonEmpty())

export function chatFinalReplyNotices(input: { context?: unknown } | undefined): string[] {
  const context = input?.context
  if (!isRuntimeRecord(context)) return []
  const notices = context[chatFinalReplyNoticesContextKey]
  return Array.isArray(notices) ? notices.filter((notice): notice is string => v.safeParse(chatFinalReplyNoticeSchema, notice).success) : []
}

const chatFinalReplyTexts = new WeakMap<AgentInvocationContextStore, string>()

/** Remember the delivered final text of one Invocation so a finish hook reply with the same text is not posted twice. */
export function setChatFinalReplyText(store: AgentInvocationContextStore, text: string): void {
  chatFinalReplyTexts.set(store, text)
}

export function chatFinalReplyText(store: AgentInvocationContextStore): string | undefined {
  return chatFinalReplyTexts.get(store)
}
