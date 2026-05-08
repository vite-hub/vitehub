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
export type ChatWebhookProcessingMode = "defer" | "inline"

export interface ChatRuntimeConfig {}

export interface ChatRuntimeContext<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> {
  cloudflare?: {
    context?: unknown
    durableObjectStateName?: string
    env?: Record<string, unknown>
  }
  dev?: boolean
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

export interface ChatWorkflowHandle<TPayload = any, TResult = any> {
  defer: (payload: TPayload, options?: { id?: string }) => MaybePromise<WorkflowRunLike<TPayload>>
  getRun: (id: string) => MaybePromise<WorkflowRunLike<TPayload, TResult>>
  name: string
  run: (payload: TPayload, options?: { id?: string }) => MaybePromise<WorkflowRunLike<TPayload, TResult>>
}

export interface WorkflowRunLike<TPayload = any, TResult = any> {
  id: string
  result?: TResult
  status: string
  payload?: TPayload
}

export interface ChatHookArgs<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> {
  bot: Chat
  channel?: Channel
  context?: MessageContext
  event?: unknown
  message?: Message
  runtimeConfig: TRuntimeConfig
  thread?: Thread
  workflow: TWorkflow
}

export type ChatMessageHook<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> = (args: ChatHookArgs<TRuntimeConfig, TWorkflow> & {
  context?: MessageContext
  message: Message
  thread: Thread
}) => MaybePromise<void>

export type ChatDirectMessageHook<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> = (args: ChatHookArgs<TRuntimeConfig, TWorkflow> & {
  channel: Channel
  context?: MessageContext
  message: Message
  thread: Thread
}) => MaybePromise<void>

export type ChatEventHook<
  TEvent,
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> = (args: ChatHookArgs<TRuntimeConfig, TWorkflow> & {
  event: TEvent
}) => MaybePromise<void>

export interface ChatNewMessageHook<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> {
  handler: ChatMessageHook<TRuntimeConfig, TWorkflow>
  pattern: RegExp
}

export type ChatReactionHookInput<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> =
  | ChatEventHook<ReactionEvent, TRuntimeConfig, TWorkflow>
  | Record<string, ChatEventHook<ReactionEvent, TRuntimeConfig, TWorkflow>>
  | {
    emoji: Array<EmojiValue | string>
    handler: ChatEventHook<ReactionEvent, TRuntimeConfig, TWorkflow>
  }

export type ChatActionHookInput<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> =
  | ChatEventHook<ActionEvent, TRuntimeConfig, TWorkflow>
  | Record<string, ChatEventHook<ActionEvent, TRuntimeConfig, TWorkflow>>

export type ChatModalSubmitHookInput<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> =
  | ChatEventHook<ModalSubmitEvent, TRuntimeConfig, TWorkflow>
  | Record<string, ChatEventHook<ModalSubmitEvent, TRuntimeConfig, TWorkflow>>

export interface ChatEventHooks<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> {
  onAction?: ChatActionHookInput<TRuntimeConfig, TWorkflow>
  onDirectMessage?: ChatDirectMessageHook<TRuntimeConfig, TWorkflow>
  onModalSubmit?: ChatModalSubmitHookInput<TRuntimeConfig, TWorkflow>
  onNewMention?: ChatMessageHook<TRuntimeConfig, TWorkflow>
  onNewMessage?: ChatNewMessageHook<TRuntimeConfig, TWorkflow> | Array<ChatNewMessageHook<TRuntimeConfig, TWorkflow>>
  onReaction?: ChatReactionHookInput<TRuntimeConfig, TWorkflow>
  onSubscribedMessage?: ChatMessageHook<TRuntimeConfig, TWorkflow>
}

export interface ChatWebhookRuntimeHooks<TContext extends ChatRuntimeContext<any> = ChatRuntimeContext> {
  error?: (error: unknown, context: TContext) => MaybePromise<void>
  request?: (context: TContext) => MaybePromise<void>
  resolved?: (context: TContext & { bot: Chat }) => MaybePromise<void>
  webhook?: (context: TContext & { bot: Chat }) => MaybePromise<void>
}

type ChatConfigPassthrough = Omit<ChatConfig, "adapters" | "state" | "userName">

export interface DefineChatOptions<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> extends ChatConfigPassthrough, ChatEventHooks<TRuntimeConfig, TWorkflow> {
  adapters: AdapterInput<ResolvedChatRuntimeContext<TRuntimeConfig>>
  concurrency?: ConcurrencyStrategy | ConcurrencyConfig
  fallbackStreamingPlaceholderText?: string | null
  hooks?: ChatEventHooks<TRuntimeConfig, TWorkflow>
  lifecycleHooks?: ChatWebhookRuntimeHooks<ChatRuntimeContext<TRuntimeConfig>>
  lockScope?: LockScope | ((context: LockScopeContext) => LockScope | Promise<LockScope>)
  logger?: Logger | LogLevel
  onLockConflict?: ChatConfig["onLockConflict"]
  setup?: (bot: Chat, context: ResolvedChatRuntimeContext<TRuntimeConfig>) => MaybePromise<void>
  state: MaybeResolvable<StateAdapter, ChatRuntimeContext<TRuntimeConfig>>
  userName?: ChatConfig["userName"]
  workflow?: TWorkflow
}

export interface ResolveChatOptions {
  adapters?: Record<string, Adapter>
  inferredName?: string
}

export interface ChatDefinition<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> {
  lifecycleHooks?: ChatWebhookRuntimeHooks<ChatRuntimeContext<TRuntimeConfig>>
  resolve(context: ChatRuntimeContext<TRuntimeConfig>, options?: ResolveChatOptions): Promise<Chat>
}

export type ChatInput<TContext extends ChatRuntimeContext<any> = ChatRuntimeContext> =
  | Chat
  | ChatDefinition<TContext extends ChatRuntimeContext<infer TRuntimeConfig> ? TRuntimeConfig : ChatRuntimeConfig>

export type CloudflareDurableObjectLocationHint =
  | "wnam"
  | "enam"
  | "sam"
  | "weur"
  | "eeur"
  | "apac"
  | "oc"
  | "afr"
  | "me"

export type CloudflareExportedHandlerFetchHandler<TEnv = unknown> = (
  request: Request,
  env: TEnv,
  ctx: { waitUntil?: (promise: Promise<unknown>) => void },
) => Response | Promise<Response>

export interface CloudflareDurableObjectStateOptions {
  binding?: string
  className?: string
  locationHint?: CloudflareDurableObjectLocationHint
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
  processing?: ChatWebhookProcessingMode
  route?: string
  routeParam?: string
}

export interface ChatDevModuleOptions {
  devtools?: boolean | { url?: string }
  initialize?: boolean
  localStateFallback?: boolean
}

export interface ChatModuleOptions {
  cloudflare?: {
    durableObjectState?: boolean | ChatCloudflareDurableObjectModuleOptions
  }
  dev?: false | ChatDevModuleOptions
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
  dev: false | Required<Omit<ChatDevModuleOptions, "devtools">> & {
    devtools: false | { url?: string }
  }
  imports: boolean
  provider: "auto" | "cloudflare" | "nitro" | "vercel"
  webhook: false | Required<ChatWebhookModuleOptions>
}

export interface ChatWebhookHandlerOptions<TContext extends ChatRuntimeContext = ChatRuntimeContext> {
  processing?: ChatWebhookProcessingMode
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
