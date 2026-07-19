import { loadAiSdk } from "../internal/ai-sdk-runtime.ts"
import {
  chatDevtoolsClearRpc,
  chatDevtoolsGetStateRpc,
  chatDevtoolsMaterializeSourceRpc,
  chatDevtoolsSendRpc,
} from "./devtools-shared.js"

import type { UIMessage } from "ai"
import type { AgentRunInput, AgentRunMetadata } from "../types.ts"
import type { ChatDevtoolsMetadata, ChatDevtoolsMetadataStatus } from "./devtools-shared.js"

type ChatDevtoolsAction = "clear" | "get-state" | "materialize-source" | "send"

export interface ChatDevtoolsBridgeBody {
  action?: string
  chat?: string
  invokerFallback?: boolean
  invokerProfileId?: string
  meta?: unknown
  path?: string
  source?: string
  stream?: boolean
  text?: string
}

export interface ChatDevtoolsInvokerSelection {
  invokerFallback?: boolean
  invokerProfileId?: string
  meta?: Record<string, unknown>
}

export interface ChatDevtoolsSession {
  invokerFallback?: boolean
  invokerProfileId?: string
  thinkingFallback?: string | null
  title?: string
  uiMessages: UIMessage[]
}

interface ChatDevtoolsMetadataRuntimeState {
  metadata: ChatDevtoolsMetadata
  metadataError?: string
  metadataSelectionKey?: string
  metadataStatus: ChatDevtoolsMetadataStatus
  metadataTask?: Promise<void>
}

export function normalizeChatDevtoolsAction(action: string): ChatDevtoolsAction | undefined {
  if (action === "get-state" || action === chatDevtoolsGetStateRpc) return "get-state"
  if (action === "send" || action === chatDevtoolsSendRpc) return "send"
  if (action === "clear" || action === chatDevtoolsClearRpc) return "clear"
  if (action === "materialize-source" || action === chatDevtoolsMaterializeSourceRpc) return "materialize-source"
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined
}

export function createChatDevtoolsMetadataInput(
  selection: ChatDevtoolsInvokerSelection,
  run: AgentRunMetadata,
  user: Record<string, unknown>,
): AgentRunInput {
  const meta = optionalRecord(selection.meta)
  const message = { metadata: {}, text: "" }
  return {
    context: {
      invoker: {
        id: "devtools",
        kind: "devtools",
        label: "DevTools User",
        ...(meta ? { meta } : {}),
      },
      ...(!selection.invokerFallback && selection.invokerProfileId ? { invokerProfileId: selection.invokerProfileId } : {}),
      channel: {
        message,
        ...(meta ? { meta } : {}),
        run,
        user,
      },
      chat: {
        message,
        ...(meta ? { meta } : {}),
        user,
      },
    },
    messages: [],
  }
}

export function validChatDevtoolsInvokerProfileId(metadata: ChatDevtoolsMetadata | undefined, value: string | undefined): string | undefined {
  return value && metadata?.invokerProfiles?.some(profile => profile.id === value)
    ? value
    : undefined
}

export function normalizeChatDevtoolsInvokerSelection(
  input: { invokerFallback?: boolean, invokerProfileId?: string, meta?: unknown } | undefined,
): ChatDevtoolsInvokerSelection {
  const meta = optionalRecord(input?.meta)
  if (input?.invokerFallback === true) {
    return {
      invokerFallback: true,
      ...(meta ? { meta } : {}),
    }
  }
  const invokerProfileId = input?.invokerProfileId?.trim()
  return {
    ...(invokerProfileId ? { invokerProfileId } : {}),
    ...(meta ? { meta } : {}),
  }
}

export function chatDevtoolsMetadataSelection(
  metadata: ChatDevtoolsMetadata,
  selection: ChatDevtoolsInvokerSelection,
): ChatDevtoolsInvokerSelection {
  const meta = optionalRecord(selection.meta)
  if (selection.invokerFallback) {
    return {
      invokerFallback: true,
      ...(meta ? { meta } : {}),
    }
  }
  const invokerProfileId = validChatDevtoolsInvokerProfileId(metadata, selection.invokerProfileId)
  return {
    ...(invokerProfileId ? { invokerProfileId } : {}),
    ...(meta ? { meta } : {}),
  }
}

export function chatDevtoolsMetadataSelectionKey(selection: ChatDevtoolsInvokerSelection): string {
  const invoker = selection.invokerFallback ? "fallback" : selection.invokerProfileId ? `profile:${selection.invokerProfileId}` : "default"
  return `${invoker}:${JSON.stringify(selection.meta || {})}`
}

export function chatDevtoolsMetadataWithAgentName(metadata: ChatDevtoolsMetadata, name: string): ChatDevtoolsMetadata {
  return {
    ...metadata,
    name: metadata.name || name,
  }
}

export function chatDevtoolsMetadataErrorMessage(): string {
  return "Chat DevTools metadata inspection failed."
}

export async function refreshChatDevtoolsMetadata(options: {
  canResolve: boolean
  force?: boolean
  name: string
  onStaticMetadata?: (metadata: ChatDevtoolsMetadata) => void
  resolve: (selection: ChatDevtoolsInvokerSelection) => Promise<ChatDevtoolsMetadata>
  selection?: ChatDevtoolsInvokerSelection
  state: ChatDevtoolsMetadataRuntimeState
  staticMetadata: ChatDevtoolsMetadata
}): Promise<void> {
  if (!options.canResolve) {
    options.state.metadata = chatDevtoolsMetadataWithAgentName(options.staticMetadata, options.name)
    options.onStaticMetadata?.(options.state.metadata)
    options.state.metadataError = undefined
    options.state.metadataSelectionKey = "static"
    options.state.metadataStatus = "ready"
    options.state.metadataTask = undefined
    return
  }

  const selection = chatDevtoolsMetadataSelection(options.staticMetadata, options.selection || {})
  const selectionKey = chatDevtoolsMetadataSelectionKey(selection)
  if (!options.force && options.state.metadataSelectionKey === selectionKey) return

  options.state.metadata = chatDevtoolsMetadataWithAgentName(options.staticMetadata, options.name)
  options.onStaticMetadata?.(options.state.metadata)
  options.state.metadataError = undefined
  options.state.metadataSelectionKey = selectionKey
  options.state.metadataStatus = "loading"

  const task = options.resolve(selection)
    .then((metadata) => {
      if (options.state.metadataTask !== task || options.state.metadataSelectionKey !== selectionKey) return
      options.state.metadata = chatDevtoolsMetadataWithAgentName(metadata, options.name)
      options.state.metadataError = undefined
      options.state.metadataStatus = "ready"
      options.state.metadataTask = undefined
    })
    .catch(() => {
      if (options.state.metadataTask !== task || options.state.metadataSelectionKey !== selectionKey) return
      options.state.metadataError = chatDevtoolsMetadataErrorMessage()
      options.state.metadataStatus = "error"
      options.state.metadataTask = undefined
    })
  options.state.metadataTask = task
  if (options.force) await task
}

export function chatDevtoolsSessionTitle(session: ChatDevtoolsSession): string | undefined {
  const title = session.title || [...session.uiMessages].reverse().map(chatDevtoolsTitleFromUIMessage).find(Boolean)
  if (title) session.title = title
  return title
}

function chatDevtoolsTitleFromUIMessage(message: UIMessage): string | undefined {
  for (const part of message.parts || []) {
    const data = (part as { data?: unknown }).data
    if (
      (part as { type?: unknown }).type === "data-title"
      && data
      && typeof data === "object"
      && (data as { type?: unknown }).type === "title"
      && typeof (data as { title?: unknown }).title === "string"
    ) {
      const title = (data as { title: string }).title.trim()
      if (title) return title
    }
  }
}

export function createChatDevtoolsUserUIMessage(text: string, id: string): UIMessage {
  return {
    id,
    metadata: {},
    parts: [{ text, type: "text" }],
    role: "user",
  }
}

function uiMessageMetadata(message: UIMessage): Record<string, unknown> | undefined {
  return optionalRecord(message.metadata)
}

function hasCompletedMetadata(message: UIMessage): boolean {
  const completedAt = uiMessageMetadata(message)?.completedAt
  return typeof completedAt === "string" && completedAt.trim().length > 0
}

function isToolUIMessagePart(part: unknown): part is Record<string, unknown> {
  const record = optionalRecord(part)
  if (!record) return false
  return record.type === "dynamic-tool"
    || (typeof record.type === "string" && record.type.startsWith("tool-"))
}

function uiToolPartName(part: Record<string, unknown>): string | undefined {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" && part.toolName ? part.toolName : undefined
  }
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.slice("tool-".length) || undefined
  }
}

function toolPartHasOutput(part: Record<string, unknown>): boolean {
  return part.state === "output-available"
    || part.state === "output-denied"
    || Object.prototype.hasOwnProperty.call(part, "output")
    || typeof part.errorText === "string"
}

function completedMaterializeSourceToolIds(message: UIMessage): string[] {
  return (message.parts || []).flatMap((part, index) => {
    if (!isToolUIMessagePart(part) || !toolPartHasOutput(part)) return []
    const toolPart = part as unknown as Record<string, unknown>
    const name = uiToolPartName(toolPart)
    if (name !== "materialize_sources") return []
    if (typeof toolPart.toolCallId === "string" && toolPart.toolCallId) return [toolPart.toolCallId]
    if (typeof toolPart.id === "string" && toolPart.id) return [toolPart.id]
    return [`${name}-${index}`]
  })
}

function hasIncompleteToolParts(message: UIMessage): boolean {
  return (message.parts || []).some(part => isToolUIMessagePart(part) && !toolPartHasOutput(part))
}

export function createChatDevtoolsPromptHistory(messages: UIMessage[]): UIMessage[] {
  return messages.filter(message => message.role !== "assistant" || hasCompletedMetadata(message) || !hasIncompleteToolParts(message))
}

export function materializedChatDevtoolsSourceKeys(metadata: ChatDevtoolsMetadata | undefined): string[] {
  const sources = new Set<string>()
  const pending = [...(metadata?.files || [])]
  while (pending.length) {
    const file = pending.shift()!
    if (file.source && (file.status === "ready" || file.materialized || file.materializedAt)) sources.add(file.source)
    pending.push(...(file.children || []))
  }
  return [...sources]
}

export async function consumeChatDevtoolsUIMessageStream(options: {
  baseMessages: UIMessage[]
  emptyAssistantText?: string
  onChange: (message: UIMessage) => Promise<void>
  onCompletedMaterializations: () => Promise<void>
  session: ChatDevtoolsSession
  startedAt: string
  stream: ReadableStream<unknown>
}): Promise<void> {
  const { readUIMessageStream } = await loadAiSdk() as { readUIMessageStream: typeof import("ai").readUIMessageStream }
  const refreshedMaterializationToolIds = new Set<string>()
  let latestAssistant: UIMessage | undefined

  for await (const assistantMessage of readUIMessageStream({ stream: options.stream as never })) {
    const now = new Date().toISOString()
    latestAssistant = {
      ...assistantMessage as UIMessage,
      metadata: {
        ...((assistantMessage as UIMessage).metadata as Record<string, unknown> | undefined),
        createdAt: options.startedAt,
        updatedAt: now,
      },
    }
    options.session.title = chatDevtoolsTitleFromUIMessage(latestAssistant) || options.session.title
    options.session.uiMessages = [...options.baseMessages, latestAssistant]

    const completedIds = completedMaterializeSourceToolIds(latestAssistant)
      .filter(id => !refreshedMaterializationToolIds.has(id))
    if (completedIds.length) {
      for (const id of completedIds) refreshedMaterializationToolIds.add(id)
      await options.onCompletedMaterializations()
    }
    await options.onChange(latestAssistant)
  }

  if (!latestAssistant) return
  latestAssistant = {
    ...latestAssistant,
    metadata: {
      ...(latestAssistant.metadata as Record<string, unknown> | undefined),
      completedAt: new Date().toISOString(),
    },
  }
  if (options.emptyAssistantText && !textFromUIMessage(latestAssistant).trim()) {
    latestAssistant = {
      ...latestAssistant,
      parts: [...(latestAssistant.parts || []), { text: options.emptyAssistantText, type: "text" }],
    }
  }
  options.session.title = chatDevtoolsTitleFromUIMessage(latestAssistant) || options.session.title
  options.session.uiMessages = [...options.baseMessages, latestAssistant]
  await options.onChange(latestAssistant)
}

function textFromUIMessage(message: UIMessage): string {
  return (message.parts || [])
    .filter((part): part is { text: string, type: "text" } => (
      (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map(part => part.text)
    .join("")
}
