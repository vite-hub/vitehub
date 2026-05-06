import { registerViteHubDevtoolsPanel } from "@vitehub/devtools"
import { defineRpcFunction } from "@vitejs/devtools-kit"
import { Message, parseMarkdown, toPlainText } from "chat"

import {
  chatDevtoolsAdapterName,
  chatDevtoolsBridgeRoute,
  chatDevtoolsClearRpc,
  chatDevtoolsGetStateRpc,
  chatDevtoolsPanelId,
  chatDevtoolsRoute,
  chatDevtoolsSendRpc,
  chatDevtoolsTitle,
  chatDevtoolsUrlEnv,
} from "./devtools-shared.js"

import type { Adapter, AdapterPostableMessage, FormattedContent, Message as ChatMessage, RawMessage } from "chat"
import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"
import type { DevToolsRpcServerFunctions, ViteDevToolsNodeContext } from "@vitejs/devtools-kit"
import type {
  ChatDevtoolsClearInput,
  ChatDevtoolsConversation,
  ChatDevtoolsMessage,
  ChatDevtoolsMessageRole,
  ChatDevtoolsSendInput,
  ChatDevtoolsStateResult,
  ChatDevtoolsTool,
  ChatDevtoolsToolStatus,
} from "./devtools-shared.js"

export {
  chatDevtoolsAdapterName,
  chatDevtoolsBridgeRoute,
  chatDevtoolsClearRpc,
  chatDevtoolsGetStateRpc,
  chatDevtoolsPanelId,
  chatDevtoolsRoute,
  chatDevtoolsSendRpc,
  chatDevtoolsTitle,
  chatDevtoolsUrlEnv,
} from "./devtools-shared.js"

export type {
  ChatDevtoolsClearInput,
  ChatDevtoolsConversation,
  ChatDevtoolsMessage,
  ChatDevtoolsMessageRole,
  ChatDevtoolsSendInput,
  ChatDevtoolsStateResult,
  ChatDevtoolsTool,
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
  name?: string
}

export interface ChatDevToolsOptions {
  devtools?: false | { url?: string }
  route?: string
}

export type ChatDevToolsPlugin = Plugin & { nitro: NitroModule }

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
  input?: unknown
  output?: unknown
  toolCallId?: string
  toolName?: string
}

export interface ChatDevtoolsToolStep {
  text?: string
  toolCalls?: ChatDevtoolsToolStepItem[]
  toolResults?: ChatDevtoolsToolStepItem[]
}

export interface ChatDevtoolsToolStepReportOptions {
  label?: (tool: ChatDevtoolsToolStepItem, status: ChatDevtoolsToolStatus) => string | undefined
  outputPreviewLength?: number
}

export interface ChatDevtoolsTypingThread {
  startTyping(text?: string): Promise<unknown>
}

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
const defaultOutputPreviewLength = 4_000
const chatDevtoolsClientDist = new URL("../dist/devtools-client", import.meta.url).pathname

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function truncateText(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, Math.max(0, length - 3))}...` : value
}

function previewValue(value: unknown, length = defaultOutputPreviewLength): unknown {
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

function defaultToolLabel(tool: { input?: unknown, toolName?: string }): string {
  return commandLabel(tool.input) || tool.toolName || "tool"
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

  const latestTool = step.toolResults?.at(-1) || step.toolCalls?.at(-1)
  if (!latestTool?.toolName) return

  const status: ChatDevtoolsToolStatus = step.toolResults?.at(-1) === latestTool ? "completed" : "running"
  const toolCalls = step.toolCalls?.filter(tool => tool.toolName).length || 0
  const toolResults = step.toolResults?.filter(tool => tool.toolName).length || 0
  const text = options.label?.(latestTool, status) || defaultToolLabel(latestTool)
  await thread.startTyping(createChatDevtoolsToolStatus({
    id: latestTool.toolCallId || `${latestTool.toolName}-${toolResults || toolCalls}`,
    input: latestTool.input,
    name: latestTool.toolName,
    output: "output" in latestTool ? previewValue(latestTool.output, options.outputPreviewLength) : undefined,
    status,
    text,
  }))
}

function statusFromFullStreamPart(part: ChatDevtoolsFullStreamToolPart): ChatDevtoolsToolStatusInput | undefined {
  if (part.type === "tool-input-start") {
    const name = part.toolName || "tool"
    return {
      id: part.toolCallId || part.id,
      name,
      status: "running",
      text: part.title || name,
    }
  }

  if (part.type === "tool-call") {
    const name = part.toolName || "tool"
    return {
      id: part.toolCallId || part.id,
      input: part.input,
      name,
      status: "running",
      text: part.title || defaultToolLabel(part),
    }
  }

  if (part.type === "tool-result") {
    const name = part.toolName || "tool"
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
    const name = part.toolName || "tool"
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
    const name = part.toolName || "tool"
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

export function createDevtoolsAdapter(options: ChatDevtoolsAdapterOptions = {}): ChatDevtoolsAdapter {
  const adapterName = options.name || chatDevtoolsAdapterName
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

  function latestAssistantMessage(threadId: string): ChatDevtoolsMessage | undefined {
    return getMessages(chatFromThreadId(adapterName, threadId)).findLast(message => message.role === "assistant")
  }

  function ensureTypingMessage(threadId: string): ChatDevtoolsMessage {
    const id = typingMessageIds.get(threadId) || latestAssistantMessage(threadId)?.id
    const existing = id ? findMessage(threadId, id) : undefined
    if (existing) {
      typingMessageIds.set(threadId, existing.id)
      return existing
    }

    const message = createTranscriptMessage("assistant", "")
    typingMessageIds.set(threadId, message.id)
    getMessages(chatFromThreadId(adapterName, threadId)).push(message)
    return message
  }

  function recordToolStatus(threadId: string, text: string): boolean {
    const tool = parseChatDevtoolsToolStatus(text)
    if (!tool) return false

    const message = ensureTypingMessage(threadId)
    const tools = message.tools ||= []
    const existing = tools.find(item => item.id === tool.id)
    const next = { ...tool, updatedAt: new Date().toISOString() }
    if (existing) Object.assign(existing, next)
    else tools.push(next)
    return true
  }

  function postOrReplaceTypingMessage(threadId: string, text: string): ChatDevtoolsMessage {
    const typingMessageId = typingMessageIds.get(threadId)
    if (typingMessageId) {
      const existing = findMessage(threadId, typingMessageId)
      typingMessageIds.delete(threadId)
      if (existing) {
        existing.text = text
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
      if (existing) existing.text = text
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
        selected: chat && chats.some(item => item.name === chat) ? chat : chats[0]!.name,
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
        ensureTypingMessage(threadId).text = status || ""
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

export function chatDevTools(options: ChatDevToolsOptions = {}): ChatDevToolsPlugin {
  const route = options.route || chatDevtoolsBridgeRoute
  const devtoolsUrl = options.devtools && typeof options.devtools === "object"
    ? options.devtools.url
    : process.env[chatDevtoolsUrlEnv]

  const nitroModule: NitroModule = {
    name: "@vitehub/chat/devtools",
    setup(nitro) {
      if (options.devtools === false || !nitro.options.dev) {
        return
      }

      nitro.options.handlers ||= []
      const handlerExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js"
      const handler = new URL(`./runtime/chat-devtools-handler${handlerExtension}`, import.meta.url).pathname
      if (!nitro.options.handlers.some(item => item.route === route && item.method === "POST" && item.handler === handler)) {
        nitro.options.handlers.push({ handler, method: "POST", route })
      }
    },
  }

  return {
    name: "@vitehub/chat/devtools",
    nitro: nitroModule,
    devtools: {
      setup(ctx) {
        if (options.devtools === false) return

        registerViteHubDevtoolsPanel(ctx, {
          distDir: chatDevtoolsClientDist,
          icon: "i-lucide-message-square",
          id: chatDevtoolsPanelId,
          route: chatDevtoolsRoute,
          title: chatDevtoolsTitle,
          url: devtoolsUrl,
        })

        ctx.rpc.register(defineRpcFunction({
          name: chatDevtoolsGetStateRpc,
          type: "query",
          jsonSerializable: true,
          setup: () => ({ handler: async () => await postChatDevtoolsBridge(ctx, route, { action: "get-state" }) }),
        }) as never)
        ctx.rpc.register(defineRpcFunction({
          name: chatDevtoolsSendRpc,
          type: "action",
          jsonSerializable: true,
          setup: () => ({ handler: async input => await postChatDevtoolsBridge(ctx, route, { action: "send", ...input }) }),
        }) as never)
        ctx.rpc.register(defineRpcFunction({
          name: chatDevtoolsClearRpc,
          type: "action",
          jsonSerializable: true,
          setup: () => ({ handler: async input => await postChatDevtoolsBridge(ctx, route, { action: "clear", ...input }) }),
        }) as never)
      },
    },
  }
}

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcServerFunctions {
    [chatDevtoolsGetStateRpc]: () => Promise<ChatDevtoolsStateResult>
    [chatDevtoolsSendRpc]: (input: ChatDevtoolsSendInput) => Promise<ChatDevtoolsStateResult>
    [chatDevtoolsClearRpc]: (input: ChatDevtoolsClearInput) => Promise<ChatDevtoolsStateResult>
  }
}

export type ChatDevtoolsRpcServerFunctions = Pick<
  DevToolsRpcServerFunctions,
  typeof chatDevtoolsGetStateRpc | typeof chatDevtoolsSendRpc | typeof chatDevtoolsClearRpc
>
