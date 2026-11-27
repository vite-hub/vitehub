import type { AgentChannelDeliveryEffectContext, AgentRuntimeConfig } from "../types.ts"
import { isRuntimeRecord as isRecord } from "./runtime-type.ts"

export function messageChannelReplyBody<TRuntimeConfig extends AgentRuntimeConfig>(
  context: Pick<AgentChannelDeliveryEffectContext<TRuntimeConfig>, "effect">,
): string | undefined {
  if (typeof context.effect.payload === "string") return context.effect.payload
  if (isRecord(context.effect.payload) && typeof context.effect.payload.body === "string") return context.effect.payload.body
  if (isRecord(context.effect.payload) && typeof context.effect.payload.markdown === "string") return context.effect.payload.markdown
  if (typeof context.effect.metadata?.body === "string") return context.effect.metadata.body
  if (typeof context.effect.metadata?.markdown === "string") return context.effect.metadata.markdown
}

const messageChannelDeliveredReplyBodies = new WeakMap<object, string | undefined>()

export function messageChannelDeliveredReplyBody<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): string | undefined {
  return messageChannelDeliveredReplyBodies.get(context)
}

export function setMessageChannelDeliveredReplyBody<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
  body: string | undefined,
): void {
  messageChannelDeliveredReplyBodies.set(context, body)
}
