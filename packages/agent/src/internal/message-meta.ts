import { parseStandardSchema } from "@vite-hub/internal/http-request"

import { createAgentInvocationContextStore } from "../invocation-context.ts"
import { hasRuntimeType, isRuntimeObject } from "./runtime-type.ts"

import type { AgentDefinition, AgentInvocationContextStore, AgentRunInput, AgentRunMetadata, AgentRuntimeConfig } from "../types.ts"

const parsedAgentMessageMetaContextKey = "vitehub.agent.messageMetaParsed"
const parsedAgentMessageMetaReceipt = Object.freeze({})

export function hasParsedAgentMessageMeta(input: AgentRunInput): boolean {
  return input.context?.[parsedAgentMessageMetaContextKey] === parsedAgentMessageMetaReceipt
}

export function restoreParsedAgentMessageMeta<CALL_OPTIONS>(input: AgentRunInput<CALL_OPTIONS>): AgentRunInput<CALL_OPTIONS> {
  return {
    ...input,
    context: { ...input.context, [parsedAgentMessageMetaContextKey]: parsedAgentMessageMetaReceipt },
  }
}

function withParsedMeta(invoker: unknown, rawMeta: Record<string, unknown>, meta: Record<string, unknown>): unknown {
  if (!isRuntimeObject(invoker)) return invoker
  const record = invoker as Record<string, unknown>
  if (record.kind !== "chat" || !isRuntimeObject(record.meta)) return invoker
  const invokerMeta: Record<string, unknown> = { ...record.meta }
  for (const key of Object.keys(rawMeta)) delete invokerMeta[key]
  return { ...record, meta: { ...invokerMeta, ...meta } }
}

function activeMessageSettings<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  invocationContext: AgentInvocationContextStore,
  run?: AgentRunMetadata,
) {
  const trigger = invocationContext.get("agent.trigger")
  const triggerChannelId = isRuntimeObject(trigger) && hasRuntimeType(trigger.channelId, "string") ? trigger.channelId : undefined
  const channelId = run?.channelId || triggerChannelId
  return channelId ? definition?.channels?.[channelId]?.messages : undefined
}

export async function parseAgentMessageMeta<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  invocationContext: AgentInvocationContextStore,
  run?: AgentRunMetadata,
): Promise<void> {
  const channelMessages = activeMessageSettings(definition, invocationContext, run)
  const schema = channelMessages ? channelMessages.meta ?? definition?.messages?.meta : definition?.messages?.meta
  if (!schema) return
  if (invocationContext.get(parsedAgentMessageMetaContextKey) === parsedAgentMessageMetaReceipt) return
  if (!schema["~standard"] || !hasRuntimeType(schema["~standard"].validate, "function")) {
    throw new TypeError("[vitehub] defineAgent({ messages: { meta } }) requires a Standard Schema.")
  }
  const channel = invocationContext.get("channel")
  const chat = invocationContext.get("chat")
  if (!isRuntimeObject(channel) && !isRuntimeObject(chat)) return
  const rawMeta = channel?.meta ?? chat?.meta ?? {}
  const meta = await parseStandardSchema(schema, rawMeta, "agent channel metadata")
  if (!isRuntimeObject(meta) || Array.isArray(meta)) {
    throw new TypeError("[vitehub] Agent channel metadata schema must return an object.")
  }
  if (isRuntimeObject(channel)) invocationContext.set("channel", { ...channel, meta }, { overwrite: true })
  if (isRuntimeObject(chat)) invocationContext.set("chat", { ...chat, meta }, { overwrite: true })
  const invoker = withParsedMeta(invocationContext.get("invoker"), rawMeta, meta)
  if (invoker !== invocationContext.get("invoker")) {
    invocationContext.set("actor", invoker, { overwrite: true })
    invocationContext.set("invoker", invoker, { overwrite: true })
  }
  invocationContext.set(parsedAgentMessageMetaContextKey, parsedAgentMessageMetaReceipt, { overwrite: true })
}

export async function withParsedAgentMessageMeta<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  input: AgentRunInput<CALL_OPTIONS>,
  run?: AgentRunMetadata,
): Promise<AgentRunInput<CALL_OPTIONS>> {
  const invocationContext = createAgentInvocationContextStore(input.context)
  await parseAgentMessageMeta(definition, invocationContext, run)
  return { ...input, context: invocationContext.toJSON() }
}
