import { defineCapability } from "./capability-runtime.ts"
import { createMessage } from "./messages.ts"

import type {
  AgentCapabilityDefinition,
  AgentChatAgentHookArgs,
  AgentChatOptions,
  AgentChatWebhookRegistrationDefinition,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentTriggerDefinition,
  AgentWebhookRegistrationDefinition,
} from "./types.ts"
import type { Message, MessagePart } from "./messages.ts"
import type { WorkspaceName } from "@vitehub/workspace"

type ChatCapabilityMetadata<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> = {
  chat: AgentChatOptions<TRuntimeConfig>
  kind: "chat"
}

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
  timeout?: number
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

function uiMessagePartsToAgentParts(message: UIMessageLike): Array<MessagePart | string> {
  const parts = Array.isArray(message.parts) ? message.parts : []
  return parts.flatMap((part, index): Array<MessagePart | string> => {
    if (!part || typeof part !== "object") return []
    const record = part as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string") return [record.text]
    if (record.type === "dynamic-tool" || (typeof record.type === "string" && record.type.startsWith("tool-"))) {
      const name = uiToolName(record)
      const id = uiToolId(record, name, index)
      const state = typeof record.state === "string" ? record.state : undefined
      if (state === "output-available" || state === "output-denied" || record.output !== undefined) {
        return [{
          error: typeof record.errorText === "string" ? record.errorText : undefined,
          id,
          name,
          output: record.output,
          state: typeof record.errorText === "string" ? "failed" : "completed",
          type: "tool-result",
        }]
      }
      return [{
        id,
        input: record.input,
        name,
        state: state === "input-available" || state === "input-streaming" ? "proposed" : "running",
        type: "tool-call",
      }]
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

function selectChatHistory(messages: UIMessageLike[], history: AgentChatOptions["history"]): UIMessageLike[] {
  if (history === false || history === "none") return messages.slice(-1)
  if (typeof history === "object" && history.source === "thread" && typeof history.maxMessages === "number") {
    return messages.slice(-Math.max(1, history.maxMessages))
  }
  return messages.slice(-20)
}

function createChatTriggerHookArgs(
  messages: UIMessageLike[],
  run: AgentRunMetadata | undefined,
): AgentChatAgentHookArgs {
  const message = messages.at(-1)
  return {
    history: uiMessagesToAgentMessages(messages),
    message: {
      id: message?.id,
      text: message ? uiMessageText(message) : "",
    },
    run,
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

function chatWebhookRegistrations(options: AgentChatOptions): AgentWebhookRegistrationDefinition[] | undefined {
  const telegram = options.webhooks?.telegram
  if (!telegram) return undefined
  const registrations = Array.isArray(telegram) ? telegram : [telegram]
  return registrations.map((registration: AgentChatWebhookRegistrationDefinition, index) => ({
    ...registration,
    id: registration.id || (registrations.length > 1 ? `telegram-${index + 1}` : "telegram"),
    method: registration.method || "POST",
    provider: registration.provider || "telegram",
    secretHeader: registration.secretHeader || "x-telegram-bot-api-secret-token",
  }))
}

function createChatMessageTrigger<TRuntimeConfig extends AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig>,
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
      const selectedMessages = selectChatHistory(messages, triggerInput.history ?? options.history)
      const hookArgs = createChatTriggerHookArgs(selectedMessages, triggerInput.run)
      const input = {
        context: { chat: { message: hookArgs.message, run: triggerInput.run } },
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

export function chat<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig>,
): AgentCapabilityDefinition<TRuntimeConfig> {
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
