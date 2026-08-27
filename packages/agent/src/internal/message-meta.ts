import { parseStandardSchema } from "@vite-hub/internal/http-request"

import { chatTriggerUserMeta, hasDerivedChatTriggerInvoker, markDerivedChatTriggerInvoker } from "../chat-message-input.ts"
import { createAgentInvocationContextStore } from "../invocation-context.ts"
import { normalizeAgentInvoker } from "../invoker.ts"
import { hasRuntimeType, isRuntimeObject, isRuntimeRecord } from "./runtime-type.ts"

import type { AgentDefinition, AgentInvocationContextStore, AgentRunInput, AgentRunMetadata, AgentRuntimeConfig } from "../types.ts"

const parsedAgentMessageMetaContextKey = "vitehub.agent.messageMetaParsed"
interface ParsedAgentMessageMetaReceipt {
  revision?: string
}
export interface ParsedAgentMessageMetaState {
  derivedInvoker?: true
  revision?: string
}

const parsedAgentMessageMetaReceipts = new WeakMap<object, WeakMap<object, Map<string | undefined, ParsedAgentMessageMetaReceipt>>>()

function parsedAgentMessageMetaReceipt<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  invocationContext: AgentInvocationContextStore,
  run?: AgentRunMetadata,
): ParsedAgentMessageMetaReceipt | undefined {
  const { channelId, revision, schema } = activeMessageSettings(definition, invocationContext, run)
  if (!definition || !schema || !isRuntimeObject(schema)) return
  let definitionReceipts = parsedAgentMessageMetaReceipts.get(definition)
  if (!definitionReceipts) {
    definitionReceipts = new WeakMap()
    parsedAgentMessageMetaReceipts.set(definition, definitionReceipts)
  }
  let schemaReceipts = definitionReceipts.get(schema)
  if (!schemaReceipts) {
    schemaReceipts = new Map()
    definitionReceipts.set(schema, schemaReceipts)
  }
  let receipt = schemaReceipts.get(channelId)
  if (!receipt) {
    receipt = Object.freeze({ revision })
    schemaReceipts.set(channelId, receipt)
  }
  return receipt
}

export function hasParsedAgentMessageMeta<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  input: AgentRunInput<CALL_OPTIONS>,
  run?: AgentRunMetadata,
): boolean {
  const invocationContext = createAgentInvocationContextStore(input.context)
  return input.context?.[parsedAgentMessageMetaContextKey] === parsedAgentMessageMetaReceipt(definition, invocationContext, run)
}

export function parsedAgentMessageMetaState<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  input: AgentRunInput<CALL_OPTIONS>,
  run?: AgentRunMetadata,
): ParsedAgentMessageMetaState | undefined {
  const invocationContext = createAgentInvocationContextStore(input.context)
  const receipt = parsedAgentMessageMetaReceipt(definition, invocationContext, run)
  if (input.context?.[parsedAgentMessageMetaContextKey] !== receipt) return
  return {
    ...(hasDerivedChatTriggerInvoker(invocationContext.get("invoker")) ? { derivedInvoker: true } : {}),
    ...(receipt?.revision !== undefined ? { revision: receipt.revision } : {}),
  }
}

export function restoreParsedAgentMessageMeta<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  input: AgentRunInput<CALL_OPTIONS>,
  run?: AgentRunMetadata,
  state?: ParsedAgentMessageMetaState,
): AgentRunInput<CALL_OPTIONS> {
  if (!state) return input
  if (state.derivedInvoker) markDerivedChatTriggerInvoker(input.context?.invoker)
  const receipt = parsedAgentMessageMetaReceipt(definition, createAgentInvocationContextStore(input.context), run)
  if (!receipt || state.revision === undefined || receipt.revision !== state.revision) return input
  return {
    ...input,
    context: { ...input.context, [parsedAgentMessageMetaContextKey]: receipt },
  }
}

function withParsedMeta(invoker: unknown, rawMeta: unknown, meta: Record<string, unknown>, user: unknown, derived: boolean): unknown {
  if (!isRuntimeObject(invoker)) return invoker
  if (!derived) return invoker
  // SAFETY: isRuntimeObject established the mutable string-keyed record representation.
  const record = invoker as Record<string, unknown>
  if (record.kind !== "chat" || !isRuntimeObject(record.meta)) return invoker
  const invokerMeta: Record<string, unknown> = { ...record.meta }
  if (isRuntimeObject(rawMeta)) {
    for (const key of Object.keys(rawMeta)) delete invokerMeta[key]
  }
  const normalizedInvoker: Record<string, unknown> = {
    ...record,
    meta: { ...invokerMeta, ...chatTriggerUserMeta(isRuntimeRecord(user) ? user : undefined), ...meta },
  }
  if (isRuntimeObject(rawMeta) && Object.hasOwn(rawMeta, "email")) normalizedInvoker.email = undefined
  const normalized = normalizeAgentInvoker(normalizedInvoker)
  markDerivedChatTriggerInvoker(normalized)
  return normalized
}

function activeMessageSettings<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  invocationContext: AgentInvocationContextStore,
  run?: AgentRunMetadata,
) {
  const trigger = invocationContext.get("agent.trigger")
  const triggerChannelId = isRuntimeObject(trigger) && hasRuntimeType(trigger.channelId, "string") ? trigger.channelId : undefined
  const channelId = run?.channelId || triggerChannelId
  const configuredChannelMessages = channelId ? definition?.channels?.[channelId]?.messages : undefined
  const channelMessages = configuredChannelMessages || undefined
  const messages = channelMessages?.meta ? channelMessages : definition?.messages
  return { channelId, revision: messages?.metaRevision, schema: messages?.meta }
}

export async function parseAgentMessageMeta<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  invocationContext: AgentInvocationContextStore,
  run?: AgentRunMetadata,
): Promise<void> {
  const { schema } = activeMessageSettings(definition, invocationContext, run)
  if (!schema) return
  const receipt = parsedAgentMessageMetaReceipt(definition, invocationContext, run)
  if (receipt && invocationContext.get(parsedAgentMessageMetaContextKey) === receipt) return
  if (!schema["~standard"] || !hasRuntimeType(schema["~standard"].validate, "function")) {
    throw new TypeError("[vitehub] defineAgent({ messages: { meta } }) requires a Standard Schema.")
  }
  const channel = invocationContext.get("channel")
  const chat = invocationContext.get("chat")
  if (!isRuntimeObject(channel) && !isRuntimeObject(chat)) return
  const rawMeta = channel?.meta !== undefined
    ? channel.meta
    : chat?.meta !== undefined
      ? chat.meta
      : {}
  const meta = await parseStandardSchema(schema, rawMeta, "agent channel metadata")
  if (!isRuntimeObject(meta) || Array.isArray(meta)) {
    throw new TypeError("[vitehub] Agent channel metadata schema must return an object.")
  }
  if (isRuntimeObject(channel)) invocationContext.set("channel", { ...channel, meta }, { overwrite: true })
  if (isRuntimeObject(chat)) invocationContext.set("chat", { ...chat, meta }, { overwrite: true })
  // SAFETY: the object-output check above establishes a metadata record.
  const user = isRuntimeObject(channel) ? channel.user : isRuntimeObject(chat) ? chat.user : undefined
  const invoker = withParsedMeta(
    invocationContext.get("invoker"),
    rawMeta,
    meta as Record<string, unknown>,
    user,
    hasDerivedChatTriggerInvoker(invocationContext.get("invoker")),
  )
  if (invoker !== invocationContext.get("invoker")) {
    invocationContext.set("actor", invoker, { overwrite: true })
    invocationContext.set("invoker", invoker, { overwrite: true })
  }
  if (receipt) invocationContext.set(parsedAgentMessageMetaContextKey, receipt, { overwrite: true })
}

export async function withParsedAgentMessageMeta<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  input: AgentRunInput<CALL_OPTIONS>,
  run?: AgentRunMetadata,
): Promise<AgentRunInput<CALL_OPTIONS>> {
  const invocationContext = createAgentInvocationContextStore(input.context)
  await parseAgentMessageMeta(definition, invocationContext, run)
  return { ...input, context: { ...input.context, ...invocationContext.toJSON() } }
}
