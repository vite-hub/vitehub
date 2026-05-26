import type {
  DefineChatOptions,
  ChatDefinition,
  ChatInput,
  ChatRuntimeContext,
  ChatWorkflowHandle,
  ChatWebhookRuntimeHooks,
} from "../types.ts"

export const chatDefinitionOptions = Symbol.for("vitehub.chat.definitionOptions")

export type ChatDefinitionWithOptions<TContext extends ChatRuntimeContext = ChatRuntimeContext> =
  ChatDefinition<TContext extends ChatRuntimeContext<infer TRuntimeConfig> ? TRuntimeConfig : unknown> & {
    [chatDefinitionOptions]?: DefineChatOptions<any, ChatWorkflowHandle<any, any> | undefined>
  }

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

export function getChatDefinitionOptions<TContext extends ChatRuntimeContext>(
  chat: ChatInput<TContext>,
): DefineChatOptions<any, ChatWorkflowHandle<any, any> | undefined> | undefined {
  return isChatDefinition(chat)
    ? (chat as ChatDefinitionWithOptions<TContext>)[chatDefinitionOptions]
    : undefined
}
