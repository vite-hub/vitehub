import type {
  ChatDefinition,
  ChatInput,
  ChatRuntimeContext,
} from "./types.ts"
import type { Chat } from "chat"

import { isChatDefinition } from "./runtime/definition.ts"

export type {
  ChatCloudflareDurableObjectModuleOptions,
  ChatDefinition,
  ChatDurableObjectStateFactory,
  ChatFactory,
  ChatInput,
  ChatModuleOptions,
  ChatRuntimeContext,
  ChatRuntimeName,
  ChatWaitUntil,
  ChatWebhookHandlerOptions,
  ChatWebhookRuntimeHooks,
  CloudflareDurableObjectStateOptions,
  MaybePromise,
  ResolvedChatModuleOptions,
} from "./types.ts"

export function defineChat<TContext extends ChatRuntimeContext = ChatRuntimeContext>(
  definition: ChatDefinition<TContext>,
): ChatDefinition<TContext> {
  return definition
}

export async function resolveChat<TContext extends ChatRuntimeContext>(
  chat: ChatInput<TContext>,
  context: TContext,
): Promise<Chat> {
  if (!isChatDefinition(chat)) {
    return chat
  }

  if ("bot" in chat) {
    return chat.bot
  }

  return await chat.create(context)
}
