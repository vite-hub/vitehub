import type {
  ChatDefinition,
  ChatInput,
  ChatRuntimeContext,
  ChatWebhookRuntimeHooks,
} from "../types.ts"

export function isChatDefinition<TContext extends ChatRuntimeContext>(
  value: ChatInput<TContext>,
): value is ChatDefinition<TContext> {
  return typeof value === "object"
    && value !== null
    && ("bot" in value || "create" in value)
}

export function getChatDefinitionHooks<TContext extends ChatRuntimeContext>(
  chat: ChatInput<TContext>,
): ChatWebhookRuntimeHooks<TContext> | undefined {
  return isChatDefinition(chat) ? chat.hooks : undefined
}
