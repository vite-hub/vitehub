import type {
  ChatDefinition,
  ChatInput,
  ChatRuntimeContext,
  ChatWebhookRuntimeHooks,
} from "../types.ts"

export function isChatDefinition<TContext extends ChatRuntimeContext>(
  value: ChatInput<TContext>,
): value is ChatDefinition<TContext extends ChatRuntimeContext<infer TRuntimeConfig> ? TRuntimeConfig : unknown> {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof value.resolve === "function"
}

export function getChatDefinitionLifecycleHooks<TContext extends ChatRuntimeContext>(
  chat: ChatInput<TContext>,
): ChatWebhookRuntimeHooks<TContext> | undefined {
  return isChatDefinition(chat) && "lifecycleHooks" in chat
    ? chat.lifecycleHooks as ChatWebhookRuntimeHooks<TContext> | undefined
    : undefined
}
