import { defineCapability } from "../capability-runtime.ts"

import type { AgentCapabilityDefinition } from "../capability-runtime.ts"
import type { AgentRuntimeConfig } from "../types.ts"
import type { ChatCapabilityOptions } from "./types.ts"

export const chatCapabilityId = "chat"

export interface ChatCapabilityDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> extends AgentCapabilityDefinition<ChatCapabilityOptions<TRuntimeConfig>, TRuntimeConfig> {
  id: typeof chatCapabilityId
  options: ChatCapabilityOptions<TRuntimeConfig>
}

export function isChatCapability(value: unknown): value is ChatCapabilityDefinition {
  return !!value
    && typeof value === "object"
    && (value as { id?: unknown }).id === chatCapabilityId
    && "options" in value
}

export function chat<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: ChatCapabilityOptions<TRuntimeConfig>,
): ChatCapabilityDefinition<TRuntimeConfig> {
  return defineCapability({
    id: chatCapabilityId,
    options,
    configure(context) {
      context.routes.add({
        handler: "@vitehub/agent/nitro:defineAgentChatWebhookHandler",
        method: "POST",
        route: "/api/agents/[agent]/chat/[platform]",
      })
      context.runtime.alias({
        find: "@vitehub/agent/chat/runtime/agent-chat",
        replacement: "@vitehub/agent/chat/runtime/agent-chat",
      })
    },
    prepare(context) {
      if (options.history) {
        if (!context.workspace) throw new Error("[vitehub:agent] chat({ history }) requires an agent workspace.")
        context.state.require("chat.history")
      }
    },
    bind(context) {
      context.invocations.add("chat:directMessage", async event => event)
    },
  }) as ChatCapabilityDefinition<TRuntimeConfig>
}

export type {
  ChatActionHookInput,
  ChatAgentAfterRunArgs,
  ChatAgentBeforeRunArgs,
  ChatAgentErrorArgs,
  ChatAgentHookArgs,
  ChatAgentHooks,
  ChatCapabilityOptions,
  ChatDirectMessageHook,
  ChatEventHook,
  ChatEventHooks,
  ChatHistory,
  ChatMessageHook,
  ChatModalSubmitHookInput,
  ChatNewMessageHook,
  ChatReactionHookInput,
  ChatStreamingPlaceholder,
} from "./types.ts"
