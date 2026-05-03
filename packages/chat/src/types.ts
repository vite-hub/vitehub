import type { Chat, StateAdapter } from "chat"

export type MaybePromise<T> = T | Promise<T>
export type ChatRuntimeName = "nitro" | "cloudflare" | "vercel" | "unknown"
export type ChatWaitUntil = (task: Promise<unknown>) => void

export interface ChatRuntimeContext {
  cloudflare?: {
    context?: unknown
    env?: Record<string, unknown>
  }
  event?: unknown
  memo<T>(key: string, create: () => T): T
  platform?: string
  request?: Request
  runtime: ChatRuntimeName
  runtimeConfig?: unknown
  vercel?: {
    waitUntil?: ChatWaitUntil
  }
  waitUntil: ChatWaitUntil
}

export type ChatFactory<TContext extends ChatRuntimeContext = ChatRuntimeContext> = (
  context: TContext
) => MaybePromise<Chat>

export type ChatDefinition<TContext extends ChatRuntimeContext = ChatRuntimeContext> =
  | { bot: Chat, hooks?: ChatWebhookRuntimeHooks<TContext> }
  | { create: ChatFactory<TContext>, hooks?: ChatWebhookRuntimeHooks<TContext> }

export type ChatInput<TContext extends ChatRuntimeContext = ChatRuntimeContext> =
  | Chat
  | ChatDefinition<TContext>

export interface CloudflareDurableObjectStateOptions {
  binding?: string
  locationHint?: DurableObjectLocationHint
  name?: string
  shardKey?: (threadId: string) => string
}

export interface ChatCloudflareDurableObjectModuleOptions {
  autoWrangler?: boolean
  binding?: string
  className?: string
  migrationTag?: string
  name?: string
}

export interface ChatModuleOptions {
  cloudflare?: {
    durableObjectState?: false | ChatCloudflareDurableObjectModuleOptions
  }
  entry?: string | false
  imports?: boolean
  route?: string | false
}

export interface ResolvedChatModuleOptions {
  cloudflare?: {
    durableObjectState?: false | Required<Pick<ChatCloudflareDurableObjectModuleOptions, "binding" | "className" | "migrationTag">> & {
      autoWrangler: boolean
      name?: string
    }
  }
  entry: string | false
  imports: boolean
  route: string | false
}

export interface ChatWebhookHandlerOptions<TContext extends ChatRuntimeContext = ChatRuntimeContext> {
  hooks?: ChatWebhookRuntimeHooks<TContext>
  platform?: string
  routeParam?: string
}

export interface ChatWebhookRuntimeHooks<TContext extends ChatRuntimeContext = ChatRuntimeContext> {
  error?: (error: unknown, context: TContext) => MaybePromise<void>
  request?: (context: TContext) => MaybePromise<void>
  resolved?: (context: TContext & { bot: Chat }) => MaybePromise<void>
  webhook?: (context: TContext & { bot: Chat }) => MaybePromise<void>
}

export type ChatDurableObjectStateFactory = (
  context: ChatRuntimeContext,
  options?: CloudflareDurableObjectStateOptions
) => StateAdapter
