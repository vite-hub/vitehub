import type {
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryFinishEffectCallback,
  AgentChannelDeliveryReactionInput,
  AgentChannelDeliveryReplyInput,
  AgentChannelDeliveryStatusInput,
  AgentFinishEvent,
  AgentRuntimeConfig,
  PublishedAgentDeliveryArtifact,
} from "./types.ts"

export interface AgentChannelDeliveryEffectIntentOptions {
  artifacts?: readonly PublishedAgentDeliveryArtifact[]
  intent?: string
  metadata?: Record<string, unknown>
}

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

export function getAgentFinishText(event: Pick<AgentFinishEvent, "result" | "text">): string | undefined {
  if (typeof event.text === "string" && event.text) return event.text
  if (typeof event.result === "string" && event.result) return event.result
  if (!event.result || typeof event.result !== "object" || event.result instanceof Response) return
  return textFromResult(event.result as Record<string, unknown>)
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return descriptor && "value" in descriptor ? descriptor.value : undefined
}

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return
  const text = content.flatMap((part) => {
    if (typeof part === "string") return [part]
    if (!part || typeof part !== "object") return []
    const record = part as Record<string, unknown>
    const type = ownValue(record, "type")
    if (type !== "text" && type !== "text-delta") return []
    const value = ownValue(record, "text") ?? ownValue(record, "textDelta") ?? ownValue(record, "delta")
    return typeof value === "string" ? [value] : []
  }).join("")
  return text || undefined
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = ownValue(record, key)
  return typeof value === "string" ? value : undefined
}

function nonEmptyStringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringValue(record, key)
  return value || undefined
}

function textFromResult(result: Record<string, unknown>): string | undefined {
  const text = nonEmptyStringValue(result, "text")
    ?? nonEmptyStringValue(result, "output")
    ?? nonEmptyStringValue(result, "_output")
  if (text) return text
  const contentText = textFromContent(ownValue(result, "content"))
  if (contentText) return contentText
  const steps = ownValue(result, "steps")
  if (!Array.isArray(steps)) return
  for (const step of steps.slice().reverse()) {
    if (!step || typeof step !== "object") continue
    const record = step as Record<string, unknown>
    const stepText = nonEmptyStringValue(record, "text") ?? textFromContent(ownValue(record, "content"))
    if (stepText) return stepText
  }
}

export function reply(
  input: AgentChannelDeliveryReplyInput,
  options: AgentChannelDeliveryEffectIntentOptions = {},
): AgentChannelDeliveryEffectIntent<"reply"> {
  if (typeof input === "string") return intent("reply", input, options)
  const { artifacts, ...payload } = input
  return intent("reply", payload, { ...options, artifacts: options.artifacts ?? artifacts })
}

export function reaction(
  input: AgentChannelDeliveryReactionInput,
  options: AgentChannelDeliveryEffectIntentOptions = {},
): AgentChannelDeliveryEffectIntent<"reaction"> {
  return intent("reaction", input, options)
}

export function status(
  input: AgentChannelDeliveryStatusInput,
  options: AgentChannelDeliveryEffectIntentOptions = {},
): AgentChannelDeliveryEffectIntent<"status"> {
  return intent("status", typeof input === "string" ? { state: input } : input, options)
}
