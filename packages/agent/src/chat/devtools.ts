import { registerViteHubDevtoolsFeature } from "@vite-hub/devtools"
import { defineRpcFunction } from "@vitejs/devtools-kit"
import { Message, parseMarkdown, toPlainText } from "chat"

import {
  chatDevtoolsAdapterName,
  chatDevtoolsBridgeRoute,
  chatDevtoolsClearRpc,
  chatDevtoolsFeatureId,
  chatDevtoolsGetStateRpc,
  chatDevtoolsSendRpc,
  chatDevtoolsStreamChannel,
  chatDevtoolsTitle,
} from "./devtools-shared.js"

import type { Adapter, AdapterPostableMessage, FormattedContent, Message as ChatMessage, RawMessage } from "chat"
import type { Plugin } from "vite"
import type { DevToolsRpcServerFunctions, ViteDevToolsNodeContext } from "@vitejs/devtools-kit"
import type {
  ChatDevtoolsClearInput,
  ChatDevtoolsConversation,
  ChatDevtoolsFileTreeItem,
  ChatDevtoolsMetadata,
  ChatDevtoolsMessage,
  ChatDevtoolsMessageRole,
  ChatDevtoolsSendInput,
  ChatDevtoolsSendResult,
  ChatDevtoolsStateResult,
  ChatDevtoolsStreamEvent,
  ChatDevtoolsTool,
  ChatDevtoolsToolDefinition,
  ChatDevtoolsToolStatus,
} from "./devtools-shared.js"

export {
  chatDevtoolsAdapterName,
  chatDevtoolsBridgeRoute,
  chatDevtoolsClearRpc,
  chatDevtoolsFeatureId,
  chatDevtoolsGetStateRpc,
  chatDevtoolsSendRpc,
  chatDevtoolsStreamChannel,
  chatDevtoolsTitle,
} from "./devtools-shared.js"

export type {
  ChatDevtoolsClearInput,
  ChatDevtoolsConversation,
  ChatDevtoolsFileKind,
  ChatDevtoolsFileTreeItem,
  ChatDevtoolsInvokerProfile,
  ChatDevtoolsMetadata,
  ChatDevtoolsMessage,
  ChatDevtoolsMessageRole,
  ChatDevtoolsSendInput,
  ChatDevtoolsSendResult,
  ChatDevtoolsStateResult,
  ChatDevtoolsStreamEvent,
  ChatDevtoolsTool,
  ChatDevtoolsToolDefinition,
  ChatDevtoolsToolStatus,
} from "./devtools-shared.js"

export const chatDevtoolsRpcClear: string = chatDevtoolsClearRpc
export const chatDevtoolsRpcGetState: string = chatDevtoolsGetStateRpc
export const chatDevtoolsRpcSend: string = chatDevtoolsSendRpc

export interface ChatDevtoolsTranscriptMessage {
  author: ChatDevtoolsMessageRole
  chat?: string
  id: string
  text: string
  threadId?: string
  timestamp: string
  tools?: ChatDevtoolsTool[]
}

export type ChatDevtoolsTranscriptTool = ChatDevtoolsTool

export interface ChatDevtoolsResult {
  chatName?: string
  chats?: string[]
  messages?: ChatDevtoolsTranscriptMessage[]
  selected?: string
  status?: string
}

export interface ChatDevtoolsAdapter extends Adapter {
  clearDevtoolsTranscript(chat?: string): void
  createDevtoolsMessage(text: string, chat?: string): ChatMessage
  getDevtoolsState(chat?: string): ChatDevtoolsStateResult
}

export interface ChatDevtoolsAdapterOptions {
  metadata?: ChatDevtoolsMetadata
  name?: string
}

export interface ChatDevToolsOptions {
  devtools?: false
}

export type ChatDevToolsPlugin = Plugin
export type ChatDevToolsPanelPlugin = Plugin

export type ChatDevtoolsBridgeRequest =
  | { action: "get-state" }
  | ({ action: "send" } & ChatDevtoolsSendInput)
  | ({ action: "clear" } & ChatDevtoolsClearInput)

export interface ChatDevtoolsToolStatusInput {
  id?: string
  input?: unknown
  name: string
  output?: unknown
  status?: ChatDevtoolsToolStatus
  text?: string
}

export interface ChatDevtoolsToolStepItem {
  id?: string
  input?: unknown
  name?: string
  output?: unknown
  toolCallId?: string
  toolName?: string
}

export interface ChatDevtoolsToolStep {
  text?: string
  toolCalls?: ChatDevtoolsToolStepItem[]
  toolErrors?: ChatDevtoolsToolStepItem[]
  toolResults?: ChatDevtoolsToolStepItem[]
}

export interface ChatDevtoolsToolStepReportOptions {
  label?: (tool: ChatDevtoolsToolStepItem, status: ChatDevtoolsToolStatus) => string | undefined
  outputPreviewLength?: number
}

export interface ChatDevtoolsTypingThread {
  startTyping(text?: string): Promise<unknown>
}

type ResolvedChatDevtoolsMetadata = Required<Omit<ChatDevtoolsMetadata, "title" | "version">> & Pick<ChatDevtoolsMetadata, "title" | "version">

interface ChatDevtoolsFullStreamToolPart {
  error?: unknown
  id?: string
  input?: unknown
  output?: unknown
  title?: string
  toolCallId?: string
  toolName?: string
  type?: string
}

const chatDevtoolsToolStatusType = "vitehub.chat.devtools.tool"
export const chatDevtoolsPanelPluginName = "@vite-hub/agent/chat/devtools-panel"
const defaultOutputPreviewLength = 4_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function truncateText(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, Math.max(0, length - 3))}...` : value
}

function previewValue(value: unknown, length = defaultOutputPreviewLength): unknown {
  if (isRecord(value)) {
    if (typeof value.stdout === "string" && value.stdout) {
      return truncateText(value.stdout.trimEnd(), length)
    }
    if (typeof value.stderr === "string" && value.stderr) {
      return truncateText(value.stderr.trimEnd(), length)
    }
  }
  if (typeof value === "string") {
    return truncateText(value, length)
  }
  if (value instanceof Error) {
    return truncateText(value.message, length)
  }
  return value
}

function commandLabel(input: unknown): string | undefined {
  return isRecord(input) && typeof input.command === "string"
    ? truncateText(input.command.trim(), 80)
    : undefined
}

function commandFromInput(input: unknown): string | undefined {
  return isRecord(input) && typeof input.command === "string" ? input.command.trim() : undefined
}

function isUnsupportedShellOutput(output: unknown): boolean {
  if (typeof output === "string") {
    return output.includes("Unsupported shell syntax:")
      || output.includes("Unsupported workspace shell command:")
  }
  if (isRecord(output)) {
    return isUnsupportedShellOutput(output.stderr) || isUnsupportedShellOutput(output.stdout)
  }
  return false
}

function isConversationalEchoTool(tool: Pick<ChatDevtoolsTool, "input" | "name" | "output">): boolean {
  const command = commandFromInput(tool.input)
  return tool.name === "shell"
    && !!command
    && /^echo(?:\s|$)/.test(command)
    && isUnsupportedShellOutput(tool.output)
}

function isGenericTypingText(text: string): boolean {
  const normalized = text.trim()
  return !normalized || normalized === "..." || normalized === "Thinking..."
}

function toolName(tool: { name?: unknown, toolName?: unknown }): string {
  return typeof tool.toolName === "string" && tool.toolName
    ? tool.toolName
    : typeof tool.name === "string" && tool.name
      ? tool.name
      : "tool"
}

function toolId(tool: { id?: unknown, toolCallId?: unknown }, name: string, index: number): string {
  return typeof tool.toolCallId === "string" && tool.toolCallId
    ? tool.toolCallId
    : typeof tool.id === "string" && tool.id
      ? tool.id
      : `${name}-${index + 1}`
}

function defaultToolLabel(tool: { input?: unknown, name?: unknown, toolName?: unknown }): string {
  return commandLabel(tool.input) || toolName(tool)
}

function createToolStatus(input: ChatDevtoolsToolStatusInput) {
  return {
    id: input.id,
    input: input.input,
    name: input.name,
    output: input.output,
    status: input.status || "completed",
    text: input.text || input.name,
    type: chatDevtoolsToolStatusType,
  }
}

export function createChatDevtoolsToolStatus(input: ChatDevtoolsToolStatusInput): string {
  return JSON.stringify(createToolStatus(input))
}

export function parseChatDevtoolsToolStatus(text: string): Omit<ChatDevtoolsTool, "updatedAt"> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed) || parsed.type !== chatDevtoolsToolStatusType) {
      return
    }

    const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "tool"
    const status: ChatDevtoolsToolStatus = parsed.status === "running" || parsed.status === "error" ? parsed.status : "completed"
    return {
      id: typeof parsed.id === "string" && parsed.id ? parsed.id : `${name}-${Date.now()}`,
      input: parsed.input,
      name,
      output: parsed.output,
      status,
      text: typeof parsed.text === "string" && parsed.text.trim() ? parsed.text.trim() : name,
    }
  }
  catch {
    return
  }
}

export async function reportChatDevtoolsToolStep(
  thread: ChatDevtoolsTypingThread,
  step: ChatDevtoolsToolStep,
  options: ChatDevtoolsToolStepReportOptions = {},
): Promise<void> {
  if (step.text?.trim()) return

  const latestError = step.toolErrors?.at(-1)
  const latestResult = step.toolResults?.at(-1)
  const latestTool = latestError || latestResult || step.toolCalls?.at(-1)
  if (!latestTool) return

  const status: ChatDevtoolsToolStatus = latestError === latestTool ? "error" : latestResult === latestTool ? "completed" : "running"
  const name = toolName(latestTool)
  const toolCalls = step.toolCalls?.length || 0
  const toolErrors = step.toolErrors?.length || 0
  const toolResults = step.toolResults?.length || 0
  const text = options.label?.(latestTool, status) || defaultToolLabel(latestTool)
  await thread.startTyping(createChatDevtoolsToolStatus({
    id: toolId(latestTool, name, (toolErrors || toolResults || toolCalls) - 1),
    input: latestTool.input,
    name,
    output: "output" in latestTool ? previewValue(latestTool.output, options.outputPreviewLength) : undefined,
    status,
    text,
  }))
}

async function reportToolStepItem(
  thread: ChatDevtoolsTypingThread,
  tool: ChatDevtoolsToolStepItem,
  status: ChatDevtoolsToolStatus,
  index: number,
  options: ChatDevtoolsToolStepReportOptions,
): Promise<void> {
  const name = toolName(tool)
  await thread.startTyping(createChatDevtoolsToolStatus({
    id: toolId(tool, name, index),
    input: tool.input,
    name,
    output: "output" in tool ? previewValue(tool.output, options.outputPreviewLength) : undefined,
    status,
    text: options.label?.(tool, status) || defaultToolLabel(tool),
  }))
}

export function createChatDevtoolsStepReporter(
  thread: ChatDevtoolsTypingThread,
  options: ChatDevtoolsToolStepReportOptions = {},
): (step: ChatDevtoolsToolStep) => Promise<void> {
  return async (step) => {
    if (step.text?.trim()) return

    for (const [index, toolCall] of (step.toolCalls || []).entries()) {
      await reportToolStepItem(thread, toolCall, "running", index, options)
    }
    for (const [index, toolResult] of (step.toolResults || []).entries()) {
      await reportToolStepItem(thread, toolResult, "completed", index, options)
    }
    for (const [index, toolError] of (step.toolErrors || []).entries()) {
      await reportToolStepItem(thread, toolError, "error", index, options)
    }
  }
}

function statusFromFullStreamPart(part: ChatDevtoolsFullStreamToolPart): ChatDevtoolsToolStatusInput | undefined {
  if (part.type === "tool-input-start") {
    const name = toolName(part)
    return {
      id: part.toolCallId || part.id,
      name,
      status: "running",
      text: part.title || name,
    }
  }

  if (part.type === "tool-call") {
    const name = toolName(part)
    return {
      id: part.toolCallId || part.id,
      input: part.input,
      name,
      status: "running",
      text: part.title || defaultToolLabel(part),
    }
  }

  if (part.type === "tool-result") {
    const name = toolName(part)
    return {
      id: part.toolCallId || part.id,
      input: part.input,
      name,
      output: previewValue(part.output),
      status: "completed",
      text: part.title || defaultToolLabel(part),
    }
  }

  if (part.type === "tool-error") {
    const name = toolName(part)
    return {
      id: part.toolCallId || part.id,
      input: part.input,
      name,
      output: previewValue(part.error),
      status: "error",
      text: part.title || defaultToolLabel(part),
    }
  }

  if (part.type === "tool-output-denied") {
    const name = toolName(part)
    return {
      id: part.toolCallId || part.id,
      input: part.input,
      name,
      output: previewValue(part.output ?? "Tool output denied"),
      status: "error",
      text: part.title || defaultToolLabel(part),
    }
  }
}

export function observeChatDevtoolsStream<T>(thread: ChatDevtoolsTypingThread, stream: AsyncIterable<T>): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const part of stream) {
        if (isRecord(part)) {
          const status = statusFromFullStreamPart(part)
          if (status) {
            await thread.startTyping(createChatDevtoolsToolStatus(status))
          }
        }
        yield part
      }
    },
  }
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function renderPostableText(message: AdapterPostableMessage): string {
  if (typeof message === "string") {
    return message
  }
  if ("markdown" in message && typeof message.markdown === "string") {
    return message.markdown
  }
  if ("raw" in message && typeof message.raw === "string") {
    return message.raw
  }
  if ("ast" in message) {
    return toPlainText(message.ast as FormattedContent)
  }
  if ("card" in message) {
    return "[card]"
  }
  return JSON.stringify(message)
}

function threadIdForChat(adapterName: string, chat?: string): string {
  return `${adapterName}:${chat || "chat"}:thread`
}

function chatFromThreadId(adapterName: string, threadId: string): string {
  const prefix = `${adapterName}:`
  return threadId.startsWith(prefix) ? threadId.slice(prefix.length).split(":")[0] || "chat" : "chat"
}

function createTranscriptMessage(role: ChatDevtoolsMessageRole, text: string): ChatDevtoolsMessage {
  return {
    id: createId(role),
    role,
    text,
    createdAt: new Date().toISOString(),
  }
}

function normalizeDevtoolsMetadata(metadata: ChatDevtoolsMetadata | undefined): ResolvedChatDevtoolsMetadata {
  return {
    files: metadata?.files ? [...metadata.files] : [],
    instructions: metadata?.instructions ? [...metadata.instructions] : [],
    invokerProfiles: metadata?.invokerProfiles ? [...metadata.invokerProfiles] : [],
    title: metadata?.title,
    tools: metadata?.tools ? [...metadata.tools] : [],
    version: metadata?.version,
  }
}

export function createDevtoolsAdapter(options: ChatDevtoolsAdapterOptions = {}): ChatDevtoolsAdapter {
  const adapterName = options.name || chatDevtoolsAdapterName
  const metadata = normalizeDevtoolsMetadata(options.metadata)
  const transcripts = new Map<string, ChatDevtoolsMessage[]>()
  const typingMessageIds = new Map<string, string>()

  function getMessages(chat?: string): ChatDevtoolsMessage[] {
    const key = chat || "chat"
    const existing = transcripts.get(key)
    if (existing) return existing
    const next: ChatDevtoolsMessage[] = []
    transcripts.set(key, next)
    return next
  }

  function findMessage(threadId: string, id: string): ChatDevtoolsMessage | undefined {
    return getMessages(chatFromThreadId(adapterName, threadId)).find(message => message.id === id)
  }

  function findLatestMessage(threadId: string): ChatDevtoolsMessage | undefined {
    const messages = getMessages(chatFromThreadId(adapterName, threadId))
    return messages[messages.length - 1]
  }

  function ensureTypingMessage(threadId: string): ChatDevtoolsMessage {
    const id = typingMessageIds.get(threadId)
    const existing = id ? findMessage(threadId, id) : undefined
    if (existing) {
      existing.loading = true
      typingMessageIds.set(threadId, existing.id)
      return existing
    }

    const message = createTranscriptMessage("assistant", "")
    message.loading = true
    typingMessageIds.set(threadId, message.id)
    getMessages(chatFromThreadId(adapterName, threadId)).push(message)
    return message
  }

  function recordToolStatus(threadId: string, text: string): boolean {
    const tool = parseChatDevtoolsToolStatus(text)
    if (!tool) return false
    if (isConversationalEchoTool(tool)) return true

    const typingMessageId = typingMessageIds.get(threadId)
    const latestMessage = findLatestMessage(threadId)
    const message = typingMessageId || latestMessage?.role === "user"
      ? ensureTypingMessage(threadId)
      : latestMessage || ensureTypingMessage(threadId)
    const tools = message.tools ||= []
    const next = { ...tool, updatedAt: new Date().toISOString() }
    const existing = tools.find(item => item.id === tool.id)
      || (tool.id ? undefined : tools.find(item => item.name === tool.name && item.text === tool.text))
    if (existing) {
      Object.assign(existing, {
        ...next,
        input: next.input === undefined ? existing.input : next.input,
        text: next.text === tool.name && existing.text !== existing.name ? existing.text : next.text,
      })
    }
    else tools.push(next)
    for (let index = tools.length - 1; index >= 0; index--) {
      const current = tools[index]
      if (!current || current.text !== current.name) continue
      if (tools.some(item => item.name === current.name && item.text !== item.name)) {
        tools.splice(index, 1)
      }
    }
    for (let index = 0; index < tools.length; index++) {
      const current = tools[index]
      if (!current || current.text === current.name) continue
      const duplicateIndex = tools.findIndex((item, itemIndex) =>
        itemIndex > index
        && item.name === current.name
        && item.text === current.text
      )
      if (duplicateIndex === -1) continue
      const duplicate = tools[duplicateIndex]
      Object.assign(current, {
        ...current,
        input: current.input ?? duplicate.input,
        output: current.output ?? duplicate.output,
        status: current.status === "running" || duplicate.status === "running" ? "running" : duplicate.status,
        updatedAt: duplicate.updatedAt > current.updatedAt ? duplicate.updatedAt : current.updatedAt,
      })
      tools.splice(duplicateIndex, 1)
      index--
    }
    message.loading = typingMessageIds.get(threadId) === message.id || tools.some(item => item.status === "running")
    return true
  }

  function postOrReplaceTypingMessage(threadId: string, text: string): ChatDevtoolsMessage {
    const typingMessageId = typingMessageIds.get(threadId)
    if (typingMessageId) {
      const existing = findMessage(threadId, typingMessageId)
      typingMessageIds.delete(threadId)
      if (existing) {
        existing.loading = false
        if (!existing.text || isGenericTypingText(existing.text) || !isGenericTypingText(text)) {
          existing.text = text
        }
        return existing
      }
    }

    const reply = createTranscriptMessage("assistant", text)
    getMessages(chatFromThreadId(adapterName, threadId)).push(reply)
    return reply
  }

  return {
    name: adapterName,
    userName: "ViteHub Chat",
    channelIdFromThreadId: threadId => threadId,
    decodeThreadId: threadId => threadId,
    encodeThreadId: value => String(value),
    addReaction: async () => {},
    clearDevtoolsTranscript(chat?: string) {
      if (chat) {
        transcripts.set(chat, [])
        for (const [threadId] of typingMessageIds) {
          if (chatFromThreadId(adapterName, threadId) === chat) typingMessageIds.delete(threadId)
        }
      }
      else {
        transcripts.clear()
        typingMessageIds.clear()
      }
    },
    createDevtoolsMessage(text: string, chat?: string) {
      const threadId = threadIdForChat(adapterName, chat)
      const message = createTranscriptMessage("user", text)
      getMessages(chat).push(message)
      return new Message({
        attachments: [],
        author: {
          fullName: "ViteHub DevTools",
          isBot: false,
          isMe: false,
          userId: "vitehub-devtools-user",
          userName: "devtools",
        },
        formatted: parseMarkdown(text),
        id: message.id,
        metadata: {
          dateSent: new Date(message.createdAt),
          edited: false,
        },
        raw: message,
        text,
        threadId,
      })
    },
    deleteMessage: async () => {},
    editMessage: async (threadId, messageId, message) => {
      const text = renderPostableText(message)
      const existing = findMessage(threadId, messageId)
      if (existing) {
        existing.loading = false
        existing.text = text
        if (typingMessageIds.get(threadId) === messageId) typingMessageIds.delete(threadId)
      }
      return { id: messageId, threadId, raw: { text } }
    },
    fetchMessages: async threadId => ({ messages: getMessages(chatFromThreadId(adapterName, threadId)) as never }),
    fetchThread: async threadId => ({
      id: threadId,
      channelId: threadId,
      isDM: true,
      metadata: {},
    }),
    getDevtoolsState(chat?: string) {
      const chats = [...transcripts.entries()].map(([name, messages]) => ({
        name,
        messages: [...messages],
      }))
      if (!chats.length) {
        chats.push({ name: chat || "chat", messages: [...getMessages(chat)] })
      }
      return {
        chats,
        files: metadata.files,
        instructions: metadata.instructions,
        invokerProfiles: metadata.invokerProfiles,
        selected: chat && chats.some(item => item.name === chat) ? chat : chats[0]!.name,
        ...(metadata.title ? { title: metadata.title } : {}),
        tools: metadata.tools,
        ...(metadata.version ? { version: metadata.version } : {}),
      }
    },
    handleWebhook: async () => new Response(null, { status: 204 }),
    initialize: async () => {},
    isDM: () => true,
    parseMessage: raw => raw as ChatMessage,
    postMessage: async (threadId, message): Promise<RawMessage> => {
      const text = renderPostableText(message)
      const reply = postOrReplaceTypingMessage(threadId, text)
      return { id: reply.id, threadId, raw: { text } }
    },
    removeReaction: async () => {},
    renderFormatted: content => toPlainText(content),
    startTyping: async (threadId, status) => {
      if (!status || !recordToolStatus(threadId, status)) {
        const message = ensureTypingMessage(threadId)
        const nextText = status || ""
        if (message.text && !isGenericTypingText(message.text) && isGenericTypingText(nextText)) {
          return
        }
        message.text = nextText
      }
    },
  }
}

function resolveViteServerUrl(ctx: ViteDevToolsNodeContext): string {
  const localUrl = ctx.viteServer?.resolvedUrls?.local?.[0]
  if (localUrl) return localUrl

  const address = ctx.viteServer?.httpServer?.address()
  if (typeof address === "object" && address?.port) {
    return `http://localhost:${address.port}/`
  }

  const port = ctx.viteConfig.server.port || 5173
  return `http://localhost:${port}/`
}

async function postChatDevtoolsBridge(ctx: ViteDevToolsNodeContext, route: string, body: ChatDevtoolsBridgeRequest): Promise<ChatDevtoolsStateResult> {
  const response = await fetch(new URL(route, resolveViteServerUrl(ctx)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Chat DevTools bridge failed with ${response.status}: ${await response.text()}`)
  }

  return await response.json() as ChatDevtoolsStateResult
}

function toChatDevtoolsErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function writeChatDevtoolsStream(
  ctx: ViteDevToolsNodeContext,
  route: string,
  body: ChatDevtoolsBridgeRequest,
  stream: { close: () => void, error: (error: unknown) => void, signal: AbortSignal, write: (event: ChatDevtoolsStreamEvent) => unknown },
): Promise<void> {
  try {
    const response = await fetch(new URL(route, resolveViteServerUrl(ctx)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
      signal: stream.signal,
    })

    if (!response.ok) {
      throw new Error(`Chat DevTools bridge failed with ${response.status}: ${await response.text()}`)
    }
    if (!response.body) {
      throw new Error("Chat DevTools bridge did not return a stream.")
    }

    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let pending = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split("\n")
      pending = lines.pop() || ""
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line) as ChatDevtoolsStreamEvent
        if (event.type === "error") {
          stream.write(event)
          stream.close()
          return
        }
        if (event.type === "done") {
          const chat = "chat" in body && typeof body.chat === "string" ? body.chat : undefined
          const invokerProfileId = "invokerProfileId" in body && typeof body.invokerProfileId === "string" ? body.invokerProfileId : undefined
          stream.write({
            type: "state",
            state: await postChatDevtoolsBridge(ctx, route, {
              action: "get-state",
              ...(chat ? { chat } : {}),
              ...(invokerProfileId ? { invokerProfileId } : {}),
            }),
          })
          stream.close()
          return
        }
        stream.write(event)
      }
    }
    const tail = pending.trim()
    if (tail) {
      stream.write(JSON.parse(tail) as ChatDevtoolsStreamEvent)
    }
    stream.close()
  }
  catch (cause) {
    if (!stream.signal.aborted) {
      stream.write({ message: toChatDevtoolsErrorMessage(cause), type: "error" })
      stream.close()
    }
  }
}

export function chatDevTools(options: ChatDevToolsOptions = {}): ChatDevToolsPlugin {
  return {
    name: "@vite-hub/agent/chat/devtools",
    devtools: chatDevToolsPanel(options).devtools,
  }
}

export function chatDevToolsPanel(options: ChatDevToolsOptions = {}): ChatDevToolsPanelPlugin {
  return {
    name: chatDevtoolsPanelPluginName,
    devtools: {
      setup(ctx) {
        if (options.devtools === false) return

        const streaming = (ctx.rpc as { streaming?: { create: <T>(name: string, options?: { closedStreamRetention?: number, replayWindow?: number }) => { start: () => { close: () => void, error: (error: unknown) => void, id: string, signal: AbortSignal, write: (event: T) => unknown } } } }).streaming
        const chatStream = streaming?.create<ChatDevtoolsStreamEvent>(chatDevtoolsStreamChannel, {
          replayWindow: 1024,
          closedStreamRetention: 30_000,
        })

        registerViteHubDevtoolsFeature(ctx, {
          bridge: chatDevtoolsBridgeRoute,
          icon: "ph:chat-circle-duotone",
          id: chatDevtoolsFeatureId,
          packageName: "@vite-hub/agent",
          title: chatDevtoolsTitle,
        })

        ctx.rpc.register(defineRpcFunction({
          name: chatDevtoolsGetStateRpc,
          type: "query",
          setup: () => ({ handler: async () => await postChatDevtoolsBridge(ctx, chatDevtoolsBridgeRoute, { action: "get-state" }) }),
        }) as never)
        ctx.rpc.register(defineRpcFunction({
          name: chatDevtoolsSendRpc,
          type: "action",
          setup: () => ({
            handler: async (input): Promise<ChatDevtoolsSendResult> => {
              if (!chatStream) {
                return await postChatDevtoolsBridge(ctx, chatDevtoolsBridgeRoute, { action: "send", ...input })
              }
              const stream = chatStream.start()
              void writeChatDevtoolsStream(ctx, chatDevtoolsBridgeRoute, { action: "send", ...input }, stream)
              return {
                chats: [],
                selected: input.chat || "",
                streamId: stream.id,
              }
            },
          }),
        }) as never)
        ctx.rpc.register(defineRpcFunction({
          name: chatDevtoolsClearRpc,
          type: "action",
          setup: () => ({ handler: async input => await postChatDevtoolsBridge(ctx, chatDevtoolsBridgeRoute, { action: "clear", ...input }) }),
        }) as never)
      },
    },
  }
}

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcServerFunctions {
    [chatDevtoolsGetStateRpc]: () => Promise<ChatDevtoolsStateResult>
    [chatDevtoolsSendRpc]: (input: ChatDevtoolsSendInput) => Promise<ChatDevtoolsSendResult>
    [chatDevtoolsClearRpc]: (input: ChatDevtoolsClearInput) => Promise<ChatDevtoolsStateResult>
  }
}

export type ChatDevtoolsRpcServerFunctions = Pick<
  DevToolsRpcServerFunctions,
  typeof chatDevtoolsGetStateRpc | typeof chatDevtoolsSendRpc | typeof chatDevtoolsClearRpc
>
