import { isAsyncIterable } from "./internal/stream-result.ts"

import type {
  AgentChannelDeliveryEffectIntentOptions,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryFinishEffectCallback,
  AgentChannelDeliveryReactionInput,
  AgentChannelDeliveryReplyInput,
  AgentChannelDeliveryStatusInput,
  AgentRuntimeConfig,
} from "./types.ts"

function intent<TKind extends "reaction" | "reply" | "status">(
  kind: TKind,
  payload: AgentChannelDeliveryEffectIntent<TKind>["payload"],
  options: AgentChannelDeliveryEffectIntentOptions = {},
): AgentChannelDeliveryEffectIntent<TKind> {
  return {
    kind,
    ...(options.artifacts?.length ? { artifacts: options.artifacts } : {}),
    ...(options.intent ? { intent: options.intent } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(payload !== undefined ? { payload } : {}),
  }
}

export function defineFinishEffect<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  effect: AgentChannelDeliveryFinishEffectCallback<TRuntimeConfig, CALL_OPTIONS>,
): AgentChannelDeliveryFinishEffectCallback<TRuntimeConfig, CALL_OPTIONS> {
  return effect
}

export function createReplyDeliveryEffectIntent(
  input: AgentChannelDeliveryReplyInput,
  options: AgentChannelDeliveryEffectIntentOptions = {},
): AgentChannelDeliveryEffectIntent<"reply"> {
  if (typeof input === "string" || isAsyncIterable(input)) return intent("reply", input, options)
  const { artifacts, ...payload } = input
  return intent("reply", payload, { ...options, artifacts: options.artifacts ?? artifacts })
}

export function createReactionDeliveryEffectIntent(
  input: AgentChannelDeliveryReactionInput,
  options: AgentChannelDeliveryEffectIntentOptions = {},
): AgentChannelDeliveryEffectIntent<"reaction"> {
  return intent("reaction", input, options)
}

export function createStatusDeliveryEffectIntent(
  input: AgentChannelDeliveryStatusInput,
  options: AgentChannelDeliveryEffectIntentOptions = {},
): AgentChannelDeliveryEffectIntent<"status"> {
  return intent("status", typeof input === "string" ? { state: input } : input, options)
}
