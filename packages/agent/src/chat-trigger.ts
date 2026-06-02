import { defineCapability } from "./capability-runtime.ts"
import { createMessage } from "./messages.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityTypeContract,
  AgentChatAgentHookArgs,
  AgentChatAdapterResolver,
  AgentChatOptions,
  AgentChatSessionOptions,
  AgentChatWebhookRegistrationDefinition,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentTriggerDefinition,
  AgentWebhookRegistrationDefinition,
} from "./types.ts"
import type { AudioData, Message, MessagePart } from "./messages.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

type ChatCapabilityMetadata<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> = {
  chat: AgentChatOptions<TRuntimeConfig>
  kind: "chat"
}

type ResolvedMaybeResolvable<T> =
  T extends (...args: any[]) => infer TResult
    ? Awaited<TResult>
    : T extends { resolve: (...args: any[]) => infer TResult }
      ? Awaited<TResult>
      : T

type AgentChatAppOrigin<TApp> =
  TApp extends string
    ? TApp
    : TApp extends true
      ? "http"
      : TApp extends { origin?: infer TOrigin }
        ? Extract<TOrigin, string>
        : never

type AgentChatAdapterOrigin<TAdapters> =
  Extract<keyof NonNullable<ResolvedMaybeResolvable<TAdapters>>, string>

type AgentChatKnownOrigin<TOptions> =
  (TOptions extends { app?: infer TApp } ? AgentChatAppOrigin<TApp> : never)
  | (TOptions extends { adapters?: infer TAdapters } ? AgentChatAdapterOrigin<TAdapters> : never)

export type AgentChatOptionsOrigin<TOptions> =
  [AgentChatKnownOrigin<TOptions>] extends [never]
    ? string
    : AgentChatKnownOrigin<TOptions>

type ChatCapabilityTypeContract<TOrigin extends string = string> = AgentCapabilityTypeContract & {
  chatOrigins: TOrigin
}

export type AgentChatCapabilityOrigin<TCapability> =
  TCapability extends AgentCapabilityDefinition<any, any, infer TTypeContract>
    ? TTypeContract extends { chatOrigins: infer TOrigin }
      ? Extract<TOrigin, string>
      : string
    : string

const CHAT_WEBHOOK_DEFAULTS = {
  telegram: {
    method: "POST",
    provider: "telegram",
    secretHeader: "x-telegram-bot-api-secret-token",
  },
} satisfies Record<string, Partial<AgentWebhookRegistrationDefinition> & { provider?: string }>

type KnownChatWebhookPlatform = keyof typeof CHAT_WEBHOOK_DEFAULTS

export type UIMessageLike = {
  createdAt?: Date | string
  id?: string
  metadata?: unknown
  parts?: Array<{ text?: string, type?: string } | Record<string, unknown>>
  role?: string
}

export interface AgentChatMessageTriggerInput {
  history?: AgentChatOptions["history"]
  messages: UIMessageLike[]
  run?: AgentRunMetadata
  session?: {
    action?: "continue" | "new" | "switch"
    id?: string
  }
  timeout?: number
  user?: Record<string, unknown>
}

export interface AgentChatRunContext<
  TMessageMetadata extends object = Record<string, unknown>,
  TUser extends object = Record<string, unknown>,
  TOrigin extends string = string,
> {
  chat?: {
    message?: Omit<AgentChatAgentHookArgs["message"], "metadata"> & { metadata?: TMessageMetadata }
    run?: AgentRunMetadata<TOrigin>
    session?: AgentChatMessageTriggerInput["session"]
    user?: TUser
  }
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

function isAudioData(value: unknown): value is AudioData {
  if (typeof value === "string") return value.length > 0
  if (!value || typeof value !== "object") return false
  if ("byteLength" in value && typeof (value as { byteLength?: unknown }).byteLength === "number") return (value as { byteLength: number }).byteLength > 0
  if ("size" in value && typeof (value as { size?: unknown }).size === "number") return (value as { size: number }).size > 0
  return false
}

function uiAudioPartToAgentPart(part: Record<string, unknown>): MessagePart[] {
  const mediaType = typeof part.mediaType === "string" && part.mediaType.startsWith("audio/")
    ? part.mediaType
    : undefined
  if (!mediaType) return []

  const id = firstString(part.id)
  const base = {
    ...(id ? { id } : {}),
    ...(typeof part.name === "string" ? { name: part.name } : {}),
    ...(typeof part.size === "number" && Number.isFinite(part.size) ? { size: part.size } : {}),
    ...(typeof part.fetchMetadata === "object" && part.fetchMetadata !== null ? { fetchMetadata: part.fetchMetadata as Record<string, string> } : {}),
    mediaType,
    type: "audio" as const,
  }
  if (typeof part.fetchData === "function") {
    return [{ ...base, fetchData: part.fetchData as () => AudioData | Promise<AudioData> }]
  }
  if (typeof part.url === "string" && part.url) {
    return [{ ...base, url: part.url }]
  }
  if (isAudioData(part.data)) {
    return [{ ...base, data: part.data }]
  }
  return []
}

function uiMessagePartsToAgentParts(message: UIMessageLike): Array<MessagePart | string> {
  const parts = Array.isArray(message.parts) ? message.parts : []
  return parts.flatMap((part, index): Array<MessagePart | string> => {
    if (!part || typeof part !== "object") return []
    const record = part as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string") return [record.text]
    if (record.type === "audio") return uiAudioPartToAgentPart(record)
    if (record.type === "dynamic-tool" || (typeof record.type === "string" && record.type.startsWith("tool-"))) {
      const name = uiToolName(record)
      const id = uiToolId(record, name, index)
      const state = typeof record.state === "string" ? record.state : undefined
      const call = {
        id,
        input: record.input,
        name,
        state: state === "input-available" || state === "output-available" ? "proposed" : "running",
        type: "tool-call",
      } satisfies MessagePart
      if (state === "output-available" || state === "output-denied" || record.output !== undefined) {
        return [
          call,
          {
            id,
            name,
            output: record.output,
            state: typeof record.errorText === "string" ? "failed" : "completed",
            type: "tool-result",
            ...(typeof record.errorText === "string" ? { error: record.errorText } : {}),
          },
        ]
      }
      return [call]
    }
    return []
  })
}

function uiMessagesToAgentMessages(messages: UIMessageLike[]): Message[] {
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

function selectChatHistory(messages: UIMessageLike[], history: AgentChatOptions["history"], sessions?: AgentChatOptions["sessions"], triggerSession?: AgentChatMessageTriggerInput["session"]): UIMessageLike[] {
  const sessionMessages = selectChatSession(messages, sessions, triggerSession)
  if (history === false || history === "none") return sessionMessages.slice(-1)
  if (typeof history === "object" && history.source === "thread" && typeof history.maxMessages === "number") {
    return sessionMessages.slice(-Math.max(1, history.maxMessages))
  }
  return sessionMessages.slice(-20)
}

function createChatTriggerHookArgs(
  messages: UIMessageLike[],
  run: AgentRunMetadata | undefined,
  session: AgentChatMessageTriggerInput["session"] | undefined,
): AgentChatAgentHookArgs {
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
  }
}

async function resolveChatThinkingFallback<TRuntimeConfig extends AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig>,
  args: AgentChatAgentHookArgs<TRuntimeConfig>,
): Promise<string | undefined> {
  const fallback = options.fallbackStreamingPlaceholderText
  if (fallback === null) return undefined
  if (typeof fallback === "function") {
    const resolved = await fallback(args)
    return resolved || undefined
  }
  if (typeof fallback === "string") return fallback
  return "Thinking..."
}

function isResolvableObject(value: unknown): value is { resolve: (...args: never[]) => unknown } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

function isStaticAdapterMap(value: AgentChatOptions["adapters"]): value is Record<string, AgentChatAdapterResolver> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isResolvableObject(value)
}

function isKnownChatWebhookPlatform(platform: string): platform is KnownChatWebhookPlatform {
  return platform in CHAT_WEBHOOK_DEFAULTS
}

function hasExplicitChatWebhook(options: AgentChatOptions, platform: string): boolean {
  return !!options.webhooks && Object.prototype.hasOwnProperty.call(options.webhooks, platform)
}

function normalizeChatWebhookRegistrations(
  platform: string,
  input: AgentChatWebhookRegistrationDefinition | AgentChatWebhookRegistrationDefinition[],
): AgentWebhookRegistrationDefinition[] {
  const defaults: Partial<AgentWebhookRegistrationDefinition> & { provider?: string } = isKnownChatWebhookPlatform(platform)
    ? CHAT_WEBHOOK_DEFAULTS[platform]
    : { provider: platform }
  const registrations = Array.isArray(input) ? input : [input]
  return registrations.map((registration, index) => ({
    ...registration,
    id: registration.id || (registrations.length > 1 ? `${platform}-${index + 1}` : platform),
    method: registration.method || defaults.method || "POST",
    provider: registration.provider || defaults.provider || platform,
    secretHeader: registration.secretHeader || defaults.secretHeader,
  }))
}

function inferredChatWebhookRegistrations(options: AgentChatOptions): AgentWebhookRegistrationDefinition[] {
  if (!isStaticAdapterMap(options.adapters)) return []
  return Object.keys(options.adapters)
    .filter(platform => !hasExplicitChatWebhook(options, platform))
    .flatMap(platform => normalizeChatWebhookRegistrations(platform, {}))
}

function explicitChatWebhookRegistrations(options: AgentChatOptions): AgentWebhookRegistrationDefinition[] {
  return Object.entries(options.webhooks ?? {})
    .flatMap(([platform, input]) => normalizeChatWebhookRegistrations(platform, input))
}

export function chatWebhookRegistrations(options: AgentChatOptions): AgentWebhookRegistrationDefinition[] | undefined {
  const registrations = [...explicitChatWebhookRegistrations(options), ...inferredChatWebhookRegistrations(options)]
  return registrations.length ? registrations : undefined
}

function createChatMessageTrigger<TRuntimeConfig extends AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig> = {},
): AgentTriggerDefinition<TRuntimeConfig, WorkspaceName, AgentChatMessageTriggerInput> {
  return {
    devtools: true,
    input: "ui-message[]",
    output: "ui-message-stream",
    webhooks: chatWebhookRegistrations(options),
    async invoke(_context, triggerInput) {
      const messages = Array.isArray(triggerInput?.messages) ? triggerInput.messages : []
      if (!messages.length) {
        throw new TypeError("[vitehub] chat.message trigger requires at least one UI message.")
      }
      const selectedMessages = selectChatHistory(messages, triggerInput.history ?? options.history, options.sessions, triggerInput.session)
      const hookArgs = createChatTriggerHookArgs(selectedMessages, triggerInput.run, triggerInput.session)
      const input = {
        context: {
          chat: {
            message: hookArgs.message,
            run: triggerInput.run,
            session: triggerInput.session,
            user: triggerInput.user,
          },
        },
        messages: uiMessagesToAgentMessages(selectedMessages),
        timeout: triggerInput.timeout,
      } satisfies AgentRunInput
      return {
        input,
        metadata: {
          thinkingFallback: await resolveChatThinkingFallback(options, hookArgs),
        },
        run: triggerInput.run,
      }
    },
  }
}

export function getChatCapabilityOptions<TRuntimeConfig extends AgentRuntimeConfig>(
  capabilities: AgentCapabilityDefinition[],
): AgentChatOptions<TRuntimeConfig> | undefined {
  return capabilities.find(capability => capability.id === "chat" && (capability.metadata as ChatCapabilityMetadata | undefined)?.kind === "chat")
    ?.metadata?.chat as AgentChatOptions<TRuntimeConfig> | undefined
}

export function chat<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  const TOptions extends AgentChatOptions<TRuntimeConfig> = AgentChatOptions<TRuntimeConfig>,
>(
  options: TOptions = {} as TOptions,
): AgentCapabilityDefinition<TRuntimeConfig, WorkspaceName, ChatCapabilityTypeContract<AgentChatOptionsOrigin<TOptions>>> {
  return defineCapability({
    id: "chat",
    metadata: {
      chat: options,
      kind: "chat",
    } satisfies ChatCapabilityMetadata<TRuntimeConfig>,
    prepare(context) {
      context.state.require("chat-history", { optional: true })
    },
    triggers: {
      message: createChatMessageTrigger(options),
    },
  })
}
