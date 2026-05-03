import type {
  ActionEvent,
  Adapter,
  Chat,
  ChatConfig,
  Channel,
  ConcurrencyConfig,
  ConcurrencyStrategy,
  EmojiValue,
  LockScope,
  LockScopeContext,
  Logger,
  LogLevel,
  Message,
  MessageContext,
  ModalSubmitEvent,
  ReactionEvent,
  StateAdapter,
  Thread,
} from "chat"

export type MaybePromise<T> = T | Promise<T>
export type ChatRuntimeName = "nitro" | "cloudflare" | "vercel" | "unknown"
export type ChatWaitUntil = (task: Promise<unknown>) => void

export interface ChatRuntimeConfig {}

export interface ChatRuntimeContext<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> {
  cloudflare?: {
    context?: unknown
    durableObjectStateName?: string
    env?: Record<string, unknown>
  }
  event?: unknown
  memo<T>(key: string, create: () => T): T
  platform?: string
  request?: Request
  runtime: ChatRuntimeName
  runtimeConfig?: TRuntimeConfig
  vercel?: {
    waitUntil?: ChatWaitUntil
  }
  waitUntil: ChatWaitUntil
}

export type ResolvedChatRuntimeContext<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> =
  ChatRuntimeContext<TRuntimeConfig> & { runtimeConfig: TRuntimeConfig }

export interface Resolvable<T, TContext extends ChatRuntimeContext<any> = ChatRuntimeContext> {
  resolve(context: TContext): MaybePromise<T>
}

export type MaybeResolvable<T, TContext extends ChatRuntimeContext<any> = ChatRuntimeContext> =
  | T
  | Resolvable<T, TContext>
  | ((context: TContext) => MaybePromise<T>)

export type AdapterInput<TContext extends ChatRuntimeContext<any> = ChatRuntimeContext> =
  | MaybeResolvable<Record<string, Adapter>, TContext>
  | Record<string, MaybeResolvable<Adapter, TContext>>

export interface ChatHookArgs<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> {
  bot: Chat
  channel?: Channel
  context?: MessageContext
  event?: unknown
  message?: Message
  runtimeConfig: TRuntimeConfig
  thread?: Thread
}

export type ChatMessageHook<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> = (args: ChatHookArgs<TRuntimeConfig> & {
  context?: MessageContext
  message: Message
  thread: Thread
}) => MaybePromise<void>

export type ChatDirectMessageHook<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> = (args: ChatHookArgs<TRuntimeConfig> & {
  channel: Channel
  context?: MessageContext
  message: Message
  thread: Thread
}) => MaybePromise<void>

export type ChatEventHook<TEvent, TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> = (args: ChatHookArgs<TRuntimeConfig> & {
  event: TEvent
}) => MaybePromise<void>

export interface ChatNewMessageHook<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> {
  handler: ChatMessageHook<TRuntimeConfig>
  pattern: RegExp
}

export type ChatReactionHookInput<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> =
  | ChatEventHook<ReactionEvent, TRuntimeConfig>
  | Record<string, ChatEventHook<ReactionEvent, TRuntimeConfig>>
  | {
    emoji: Array<EmojiValue | string>
    handler: ChatEventHook<ReactionEvent, TRuntimeConfig>
  }

export type ChatActionHookInput<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> =
  | ChatEventHook<ActionEvent, TRuntimeConfig>
  | Record<string, ChatEventHook<ActionEvent, TRuntimeConfig>>

export type ChatModalSubmitHookInput<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> =
  | ChatEventHook<ModalSubmitEvent, TRuntimeConfig>
  | Record<string, ChatEventHook<ModalSubmitEvent, TRuntimeConfig>>

export interface ChatEventHooks<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> {
  onAction?: ChatActionHookInput<TRuntimeConfig>
  onDirectMessage?: ChatDirectMessageHook<TRuntimeConfig>
  onModalSubmit?: ChatModalSubmitHookInput<TRuntimeConfig>
  onNewMention?: ChatMessageHook<TRuntimeConfig>
  onNewMessage?: ChatNewMessageHook<TRuntimeConfig> | Array<ChatNewMessageHook<TRuntimeConfig>>
  onReaction?: ChatReactionHookInput<TRuntimeConfig>
  onSubscribedMessage?: ChatMessageHook<TRuntimeConfig>
}

export interface ChatWebhookRuntimeHooks<TContext extends ChatRuntimeContext<any> = ChatRuntimeContext> {
  error?: (error: unknown, context: TContext) => MaybePromise<void>
  request?: (context: TContext) => MaybePromise<void>
  resolved?: (context: TContext & { bot: Chat }) => MaybePromise<void>
  webhook?: (context: TContext & { bot: Chat }) => MaybePromise<void>
}

type ChatConfigPassthrough = Omit<ChatConfig, "adapters" | "state" | "userName">

export interface DefineChatOptions<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> extends ChatConfigPassthrough {
  adapters: AdapterInput<ResolvedChatRuntimeContext<TRuntimeConfig>>
  concurrency?: ConcurrencyStrategy | ConcurrencyConfig
  fallbackStreamingPlaceholderText?: string | null
  hooks?: ChatEventHooks<TRuntimeConfig>
  lifecycleHooks?: ChatWebhookRuntimeHooks<ChatRuntimeContext<TRuntimeConfig>>
  lockScope?: LockScope | ((context: LockScopeContext) => LockScope | Promise<LockScope>)
  logger?: Logger | LogLevel
  onLockConflict?: ChatConfig["onLockConflict"]
  setup?: (bot: Chat, context: ResolvedChatRuntimeContext<TRuntimeConfig>) => MaybePromise<void>
  state: MaybeResolvable<StateAdapter, ChatRuntimeContext<TRuntimeConfig>>
  userName?: ChatConfig["userName"]
}

export interface ResolveChatOptions {
  inferredName?: string
}

export interface ChatDefinition<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> {
  lifecycleHooks?: ChatWebhookRuntimeHooks<ChatRuntimeContext<TRuntimeConfig>>
  resolve(context: ChatRuntimeContext<TRuntimeConfig>, options?: ResolveChatOptions): Promise<Chat>
}

export type ChatInput<TContext extends ChatRuntimeContext<any> = ChatRuntimeContext> =
  | Chat
  | ChatDefinition<any>

export interface CloudflareDurableObjectStateOptions {
  binding?: string
  className?: string
  locationHint?: DurableObjectLocationHint
  migrationTag?: string
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

export interface ChatWebhookModuleOptions {
  chatParam?: string
  route?: string
  routeParam?: string
}

export interface ChatModuleOptions {
  cloudflare?: {
    durableObjectState?: boolean | ChatCloudflareDurableObjectModuleOptions
  }
  imports?: boolean
  provider?: "auto" | "cloudflare" | "nitro" | "vercel"
  webhook?: string | false | ChatWebhookModuleOptions
}

export interface ResolvedChatModuleOptions {
  cloudflare?: {
    durableObjectState?: false | Required<Pick<ChatCloudflareDurableObjectModuleOptions, "binding" | "className" | "migrationTag">> & {
      autoWrangler: boolean
      name?: string
    }
  }
  imports: boolean
  provider: "auto" | "cloudflare" | "nitro" | "vercel"
  webhook: false | Required<ChatWebhookModuleOptions>
}

export interface ChatWebhookHandlerOptions<TContext extends ChatRuntimeContext = ChatRuntimeContext> {
  inferredName?: string
  lifecycleHooks?: ChatWebhookRuntimeHooks<TContext>
  platform?: string
  routeParam?: string
}

export interface ChatWebhookRegistryHandlerOptions<TContext extends ChatRuntimeContext = ChatRuntimeContext> extends ChatWebhookHandlerOptions<TContext> {
  chatParam?: string
}

export interface DiscoveredChatDefinition {
  handler: string
  name: string
  source?: string
}

export type ChatDurableObjectStateResolver = Resolvable<StateAdapter, ChatRuntimeContext>

export type {
  ActionEvent,
  Adapter,
  Channel,
  Message,
  MessageContext,
  ModalSubmitEvent,
  ReactionEvent,
  StateAdapter,
  Thread,
}
