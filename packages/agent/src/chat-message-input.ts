import { createMessage, isAttachmentData, isAttachmentPart } from "./messages.ts"
import { normalizeAgentInvoker } from "./invoker.ts"

import type {
  AgentChatAgentHookArgs,
  AgentChatOptions,
  AgentChatSessionOptions,
  AgentChatTriggerHistory,
  AgentInvoker,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
} from "./types.ts"
import type { AttachmentData, AttachmentPart, Message, MessagePart } from "./messages.ts"

export type UIMessageLike = {
  createdAt?: Date | string
  id?: string
  metadata?: unknown
  parts?: Array<{ text?: string, type?: string } | Record<string, unknown>>
  role?: string
}

export interface AgentChatMessageTriggerInput {
  abortSignal?: AbortSignal
  context?: AgentRunInput["context"]
  invoker?: AgentInvoker
  invokerProfileId?: string
  meta?: Record<string, unknown>
  messages: UIMessageLike[]
  run?: AgentRunMetadata
  session?: {
    action?: "continue" | "new" | "switch"
    id?: string
  }
  timeout?: number
  triggerHistory?: AgentChatTriggerHistory
  user?: Record<string, unknown>
}

export interface ChatMessageTriggerInputResult<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  hookArgs: AgentChatAgentHookArgs<TRuntimeConfig>
  input: AgentRunInput
  selectedMessages: UIMessageLike[]
}

function uiMessageText(message: UIMessageLike): string {
  const parts = Array.isArray(message.parts) ? message.parts : []
  return parts
    .filter((part): part is { text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map(part => part.text)
    .join("")
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0)
}

function chatIdentity(user: Record<string, unknown> | undefined, run: AgentRunMetadata | undefined): string | undefined {
  const identity = firstString(user?.id, user?.sub, user?.email, user?.username)?.trim()
  if (!identity) return
  return run?.origin ? `${run.origin}:${identity}` : identity
}

export function resolveChatTriggerInvoker(triggerInput: AgentChatMessageTriggerInput | undefined): AgentInvoker | undefined {
  const userMeta: Record<string, unknown> = {}
  for (const key of ["id", "sub", "email", "username", "name", "customer"]) {
    const value = firstString(triggerInput?.user?.[key])?.trim()
    if (value) userMeta[key] = value
  }
  const meta = Object.keys(userMeta).length || triggerInput?.meta
    ? { ...userMeta, ...triggerInput?.meta }
    : undefined
  const invokerId = chatIdentity(triggerInput?.user, triggerInput?.run)
  return triggerInput?.invoker
    ? normalizeAgentInvoker(triggerInput.invoker, "chat.message input.invoker")
    : invokerId
      ? normalizeAgentInvoker({
          id: invokerId,
          kind: "chat",
          ...(meta ? { meta } : {}),
        }, "chat.message input.user")
      : undefined
}

function uiToolName(part: Record<string, unknown>): string {
  if (part.type === "dynamic-tool") {
    return firstString(part.toolName, part.name) || "tool"
  }
  return typeof part.type === "string" && part.type.startsWith("tool-")
    ? part.type.slice("tool-".length)
    : firstString(part.toolName, part.name) || "tool"
}

function uiToolId(part: Record<string, unknown>, name: string, index: number): string {
  return firstString(part.toolCallId, part.id) || `${name}-${index + 1}`
}

function uiAttachmentPartToAgentPart(part: Record<string, unknown>): MessagePart[] {
  const mediaType = typeof part.mediaType === "string" && part.mediaType ? part.mediaType : undefined
  const inputType = isAttachmentPart(part) ? part.type : undefined
  const type = mediaType?.startsWith("audio/")
    ? "audio"
    : mediaType?.startsWith("image/")
      ? "image"
      : inputType
  if (!type || !mediaType) return []

  const id = firstString(part.id)
  const data = isAttachmentData(part.data) ? part.data : undefined
  const fetchData = typeof part.fetchData === "function"
    ? part.fetchData as () => AttachmentData | Promise<AttachmentData>
    : undefined
  const name = firstString(part.name, part.filename)
  const url = typeof part.url === "string" && part.url ? part.url : undefined
  if (!data && !fetchData && !url) return []
  const attachment = {
    ...(data ? { data } : {}),
    ...(fetchData ? { fetchData } : {}),
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(typeof part.size === "number" && Number.isFinite(part.size) ? { size: part.size } : {}),
    ...(typeof part.fetchMetadata === "object" && part.fetchMetadata !== null ? { fetchMetadata: part.fetchMetadata as Record<string, string> } : {}),
    mediaType,
    type,
    ...(url ? { url } : {}),
  } satisfies AttachmentPart
  return [attachment]
}

function uiMessagePartsToAgentParts(message: UIMessageLike): Array<MessagePart | string> {
  const parts = Array.isArray(message.parts) ? message.parts : []
  return parts.flatMap((part, index): Array<MessagePart | string> => {
    if (!part || typeof part !== "object") return []
    const record = part as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string") return [record.text]
    if ((record.type === "data" || (typeof record.type === "string" && record.type.startsWith("data-"))) && "data" in record) {
      return [{
        data: record.data,
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        type: record.type as "data" | `data-${string}`,
      }]
    }
    if (record.type === "audio" || record.type === "file" || record.type === "image") {
      return uiAttachmentPartToAgentPart(record)
    }
    if (record.type === "dynamic-tool" || (typeof record.type === "string" && record.type.startsWith("tool-"))) {
      const state = typeof record.state === "string" ? record.state : undefined
      const approval = typeof record.approval === "object" && record.approval !== null
        ? record.approval as Record<string, unknown>
        : undefined
      if ((state === "approval-requested" || state === "approval-responded") && typeof approval?.id === "string") {
        const name = uiToolName(record)
        const toolCallId = uiToolId(record, name, index)
        const call = {
          id: toolCallId,
          input: record.input,
          name,
          state: "proposed",
          type: "tool-call",
        } satisfies MessagePart
        const request = {
          id: approval.id,
          input: record.input,
          name,
          toolCallId,
          type: "approval-request",
        } satisfies MessagePart
        if (state === "approval-requested") return [call, request]
        if (typeof approval.approved !== "boolean") return []
        return [
          call,
          request,
          {
            approved: approval.approved,
            id: approval.id,
            ...(typeof approval.reason === "string" ? { reason: approval.reason } : {}),
            type: "approval-decision",
          },
        ]
      }
      const errorText = typeof record.errorText === "string" ? record.errorText : undefined
      const hasToolError = errorText !== undefined
      const hasToolOutput = state === "output-available" || state === "output-denied" || state === "output-error" || record.output !== undefined || hasToolError
      if (!hasToolOutput) {
        return []
      }
      const name = uiToolName(record)
      const id = uiToolId(record, name, index)
      const call = {
        id,
        input: record.input,
        name,
        state: state === "input-available" || hasToolOutput ? "proposed" : "running",
        type: "tool-call",
      } satisfies MessagePart
      return [
        call,
        {
          id,
          name,
          state: hasToolError ? "failed" : "completed",
          type: "tool-result",
          ...(hasToolError ? { error: errorText } : {}),
          ...(record.output !== undefined ? { output: record.output } : {}),
        },
      ]
    }
    return []
  })
}

export function uiMessagesToAgentMessages(messages: UIMessageLike[]): Message[] {
  return messages.map((message, index) => {
    const role = message.role === "assistant" || message.role === "system" || message.role === "tool" || message.role === "user"
      ? message.role
      : "user"
    return createMessage({
      createdAt: message.createdAt,
      id: message.id || `ui-${index}`,
      metadata: typeof message.metadata === "object" && message.metadata !== null ? message.metadata as Record<string, unknown> : undefined,
      parts: uiMessagePartsToAgentParts(message),
      role,
    })
  })
}

function metadataRecord(message: UIMessageLike | undefined): Record<string, unknown> | undefined {
  return typeof message?.metadata === "object" && message.metadata !== null
    ? message.metadata as Record<string, unknown>
    : undefined
}

function nestedSessionId(metadata: Record<string, unknown> | undefined): string | undefined {
  const chat = typeof metadata?.chat === "object" && metadata.chat !== null ? metadata.chat as Record<string, unknown> : undefined
  const session = typeof metadata?.session === "object" && metadata.session !== null ? metadata.session as Record<string, unknown> : undefined
  return firstString(
    metadata?.sessionId,
    metadata?.chatSessionId,
    chat?.sessionId,
    session?.id,
  )
}

function uiMessageSessionId(message: UIMessageLike, metadataKey?: string): string | undefined {
  const metadata = metadataRecord(message)
  return firstString(
    metadataKey ? metadata?.[metadataKey] : undefined,
    nestedSessionId(metadata),
  )
}

function uiMessageTime(message: UIMessageLike): number | undefined {
  const metadata = metadataRecord(message)
  const raw = message.createdAt || metadata?.createdAt || metadata?.updatedAt
  const time = raw instanceof Date ? raw.getTime() : typeof raw === "string" ? Date.parse(raw) : undefined
  return typeof time === "number" && Number.isFinite(time) ? time : undefined
}

function normalizeSessionOptions(sessions: AgentChatOptions["sessions"]): AgentChatSessionOptions | undefined {
  if (!sessions) return undefined
  return sessions === true ? { strategy: "manual" } : sessions
}

export function resolveChatSessionId(
  messages: UIMessageLike[],
  sessions: AgentChatOptions["sessions"],
  triggerSession?: AgentChatMessageTriggerInput["session"],
): string | undefined {
  const options = normalizeSessionOptions(sessions)
  if (!options) return triggerSession?.id
  const strategy = options.strategy || (options.idleTimeoutMs ? "idle-timeout" : "manual")
  const manualId = triggerSession?.id || uiMessageSessionId(messages.at(-1) || {}, options.metadataKey)
  if (strategy === "manual") return manualId
  const selected = strategy === "idle-timeout"
    ? selectIdleSession(messages, options)
    : selectIdleSession(selectManualSession(messages, options, triggerSession), options)
  const first = selected[0]
  const boundary = first?.id || uiMessageTime(first || {})?.toString()
  return boundary ? `${manualId ? `${manualId}:` : ""}idle:${boundary}` : manualId
}

function selectManualSession(messages: UIMessageLike[], sessions: AgentChatSessionOptions, triggerSession?: AgentChatMessageTriggerInput["session"]): UIMessageLike[] {
  if (triggerSession?.action === "new") return messages.slice(-1)
  const selectedId = triggerSession?.id || uiMessageSessionId(messages.at(-1) || {}, sessions.metadataKey)
  if (!selectedId) return messages
  const filtered = messages.filter(message => uiMessageSessionId(message, sessions.metadataKey) === selectedId)
  return filtered.length ? filtered : messages
}

function selectIdleSession(messages: UIMessageLike[], sessions: AgentChatSessionOptions): UIMessageLike[] {
  const timeout = sessions.idleTimeoutMs
  if (!timeout || timeout <= 0 || messages.length < 2) return messages
  for (let index = messages.length - 1; index > 0; index--) {
    const current = uiMessageTime(messages[index]!)
    const previous = uiMessageTime(messages[index - 1]!)
    if (current !== undefined && previous !== undefined && current - previous > timeout) {
      return messages.slice(index)
    }
  }
  return messages
}

function selectChatSession(messages: UIMessageLike[], sessions: AgentChatOptions["sessions"], triggerSession?: AgentChatMessageTriggerInput["session"]): UIMessageLike[] {
  const options = normalizeSessionOptions(sessions)
  if (!options) return messages
  const strategy = options.strategy || (options.idleTimeoutMs ? "idle-timeout" : "manual")
  if (strategy === "manual") return selectManualSession(messages, options, triggerSession)
  if (strategy === "idle-timeout") return selectIdleSession(messages, options)
  return selectIdleSession(selectManualSession(messages, options, triggerSession), options)
}

function normalizedMaxMessages(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : undefined
}

function threadHistoryMaxMessages(threadHistory: unknown): number | undefined {
  if (!threadHistory || typeof threadHistory !== "object" || Array.isArray(threadHistory)) return
  return normalizedMaxMessages((threadHistory as { maxMessages?: unknown }).maxMessages)
}

export function resolveChatTriggerHistory(
  options: Pick<AgentChatOptions, "threadHistory" | "triggerHistory"> | undefined,
  triggerHistory?: AgentChatTriggerHistory,
): AgentChatTriggerHistory | undefined {
  if (triggerHistory !== undefined) return triggerHistory
  if (options?.triggerHistory !== undefined) return options.triggerHistory
  const maxMessages = threadHistoryMaxMessages(options?.threadHistory)
  return maxMessages === undefined ? undefined : { maxMessages, source: "thread" }
}

export function chatTriggerHistoryLimit(triggerHistory: AgentChatTriggerHistory | undefined): number | undefined {
  if (triggerHistory === "none") return
  if (!triggerHistory || triggerHistory.source !== "thread") return
  return normalizedMaxMessages(triggerHistory.maxMessages) ?? 20
}

function selectChatHistory(messages: UIMessageLike[], triggerHistory: AgentChatTriggerHistory | undefined, sessions?: AgentChatOptions["sessions"], triggerSession?: AgentChatMessageTriggerInput["session"]): UIMessageLike[] {
  const sessionMessages = selectChatSession(messages, sessions, triggerSession)
  if (triggerHistory === "none") return sessionMessages.slice(-1)
  const limit = chatTriggerHistoryLimit(triggerHistory)
  if (limit) return sessionMessages.slice(-limit)
  return sessionMessages.slice(-20)
}

function createChatTriggerHookArgs<TRuntimeConfig extends AgentRuntimeConfig>(
  messages: UIMessageLike[],
  run: AgentRunMetadata | undefined,
  session: AgentChatMessageTriggerInput["session"] | undefined,
): AgentChatAgentHookArgs<TRuntimeConfig> {
  const message = messages.at(-1)
  const metadata = metadataRecord(message)
  return {
    history: uiMessagesToAgentMessages(messages),
    message: {
      id: message?.id,
      ...(metadata ? { metadata } : {}),
      text: message ? uiMessageText(message) : "",
    },
    run,
    session,
    thread: {
      post: async () => undefined,
    },
  } as AgentChatAgentHookArgs<TRuntimeConfig>
}

export function createChatMessageTriggerInput<TRuntimeConfig extends AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig>,
  triggerInput: AgentChatMessageTriggerInput | undefined,
): ChatMessageTriggerInputResult<TRuntimeConfig> {
  const messages = Array.isArray(triggerInput?.messages) ? triggerInput.messages : []
  if (!messages.length) {
    throw new TypeError("[vitehub] chat.message trigger requires at least one UI message.")
  }
  const triggerHistory = resolveChatTriggerHistory(options, triggerInput?.triggerHistory)
  const selectedMessages = selectChatHistory(messages, triggerHistory, options.sessions, triggerInput?.session)
  const hookArgs = createChatTriggerHookArgs<TRuntimeConfig>(selectedMessages, triggerInput?.run, triggerInput?.session)
  const invoker = resolveChatTriggerInvoker(triggerInput)
  return {
    hookArgs,
    input: {
      abortSignal: triggerInput?.abortSignal,
      context: {
        ...triggerInput?.context,
        ...(invoker ? { invoker } : {}),
        ...(triggerInput?.invokerProfileId ? { invokerProfileId: triggerInput.invokerProfileId } : {}),
        channel: {
          message: hookArgs.message,
          run: triggerInput?.run,
          session: triggerInput?.session,
          meta: triggerInput?.meta,
          user: triggerInput?.user,
        },
        chat: {
          message: hookArgs.message,
          session: triggerInput?.session,
          meta: triggerInput?.meta,
          user: triggerInput?.user,
        },
      },
      messages: uiMessagesToAgentMessages(selectedMessages),
      timeout: triggerInput?.timeout,
    },
    selectedMessages,
  }
}
