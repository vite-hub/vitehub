import type {
  AgentChatOptions,
  AgentExecution,
  AgentInput,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeContext,
  AgentRuntimeName,
} from "../index.ts"
import type {
  MaybePromise,
  MaybeResolvable,
  Resolvable,
  RuntimeCapabilities,
  RuntimeCapabilityHandle,
  RuntimeHostContext,
  RuntimeWaitUntil,
} from "@vitehub/runtime"
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

export type {
  MaybePromise,
  MaybeResolvable,
  Resolvable,
}
export type ChatRuntimeName = "nitro" | "cloudflare" | "vercel" | "unknown"
export type ChatWaitUntil = RuntimeWaitUntil
export type ChatWebhookProcessingMode = "defer" | "inline"
export type ChatCapabilityHandle<TKind extends string = string, TValue = unknown> = RuntimeCapabilityHandle<TKind, TValue>
export type ChatCapabilities = RuntimeCapabilities

export interface ChatRuntimeConfig {}

export interface ChatRuntimeContext<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig>
  extends Omit<RuntimeHostContext<TRuntimeConfig>, "runtime"> {
  dev?: boolean
  runtime: ChatRuntimeName
}

export type ResolvedChatRuntimeContext<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> =
  ChatRuntimeContext<TRuntimeConfig> & { runtimeConfig: TRuntimeConfig }

export type ChatCallbackContext<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> =
  Omit<ResolvedChatRuntimeContext<TRuntimeConfig>, "runtimeConfig">

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

export type ChatAgentEvent = "directMessage"

export type ChatAgentHistory =
  | boolean
  | "none"
  | {
    maxMessages?: number
    source: "thread"
  }

export interface ChatAgentMetadata {
  channelId?: string
  messageId?: string
  platform?: string
  runId: string
  source: "chat"
  threadId?: string
}

export interface ChatAgentHookArgs<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> extends ChatHookArgs<TRuntimeConfig, TWorkflow> {
  channel: Channel
  history: NonNullable<AgentRunInput["messages"]>
  message: Message
  run: AgentRunMetadata
  thread: Thread
}

export interface ChatAgentBeforeRunArgs<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> extends ChatAgentHookArgs<TRuntimeConfig, TWorkflow> {
  input: AgentRunInput
}

export interface ChatAgentAfterRunArgs<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> extends ChatAgentBeforeRunArgs<TRuntimeConfig, TWorkflow> {
  result: unknown
}

export interface ChatAgentErrorArgs<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> extends ChatAgentHookArgs<TRuntimeConfig, TWorkflow> {
  error: unknown
  input?: AgentRunInput
}

export interface ChatAgentHooks<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> {
  afterRun?: (args: ChatAgentAfterRunArgs<TRuntimeConfig, TWorkflow>) => MaybePromise<unknown>
  beforeRun?: (args: ChatAgentBeforeRunArgs<TRuntimeConfig, TWorkflow>) => MaybePromise<AgentRunInput | void>
  error?: (args: ChatAgentErrorArgs<TRuntimeConfig, TWorkflow>) => MaybePromise<void>
  prepareInput?: (args: ChatAgentHookArgs<TRuntimeConfig, TWorkflow>) => MaybePromise<AgentRunInput>
  sendResponse?: (args: ChatAgentAfterRunArgs<TRuntimeConfig, TWorkflow>) => MaybePromise<void>
}

export interface ChatAgentBindingOptions<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> {
  definition?: AgentInput<ChatAgentRuntimeContext<TRuntimeConfig>>
  event?: ChatAgentEvent
  execution?: Extract<AgentExecution, "inline"> | "workflow"
  history?: ChatAgentHistory
  hooks?: ChatAgentHooks<TRuntimeConfig, TWorkflow>
  name: string
}

export type ChatAgentBinding<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> = string | ChatAgentBindingOptions<TRuntimeConfig, TWorkflow>

export interface ChatAgentRuntimeContext<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig>
  extends AgentRuntimeContext<TRuntimeConfig> {
  runtime: AgentRuntimeName
}

export interface ChatWebhookRuntimeHooks<TContext extends ChatRuntimeContext<any> = ChatRuntimeContext> {
  error?: (error: unknown, context: TContext) => MaybePromise<void>
  request?: (context: TContext) => MaybePromise<void>
  resolved?: (context: TContext & { bot: Chat }) => MaybePromise<void>
  webhook?: (context: TContext & { bot: Chat }) => MaybePromise<void>
}

export type ChatStreamingPlaceholder<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> =
  | string
  | null
  | ((context: ChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<string | null | undefined>)

type ChatConfigPassthrough = Omit<ChatConfig, "adapters" | "fallbackStreamingPlaceholderText" | "state" | "userName">

export interface DefineChatOptions<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> extends ChatConfigPassthrough, ChatEventHooks<TRuntimeConfig, TWorkflow> {
  adapters: AdapterInput<ChatCallbackContext<TRuntimeConfig>>
  agent?: ChatAgentBinding<TRuntimeConfig, TWorkflow>
  concurrency?: ConcurrencyStrategy | ConcurrencyConfig
  fallbackStreamingPlaceholderText?: ChatStreamingPlaceholder<TRuntimeConfig>
  hooks?: ChatEventHooks<TRuntimeConfig, TWorkflow>
  lifecycleHooks?: ChatWebhookRuntimeHooks<ChatRuntimeContext<TRuntimeConfig>>
  lockScope?: LockScope | ((context: LockScopeContext) => LockScope | Promise<LockScope>)
  logger?: Logger | LogLevel
  onLockConflict?: ChatConfig["onLockConflict"]
  setup?: (bot: Chat, context: ChatCallbackContext<TRuntimeConfig>) => MaybePromise<void>
  state: MaybeResolvable<StateAdapter, ChatCallbackContext<TRuntimeConfig>>
  userName?: ChatConfig["userName"]
  workflow?: TWorkflow
}

export interface ResolveChatOptions {
  adapters?: Record<string, Adapter>
  inferredName?: string
  state?: StateAdapter
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
  initialize?: boolean
  localStateFallback?: boolean
}

export interface ChatModuleOptions {
  cloudflare?: {
    durableObjectState?: boolean | ChatCloudflareDurableObjectModuleOptions
  }
  dev?: false | ChatDevModuleOptions
  devtools?: false
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
  dev: false | Required<ChatDevModuleOptions>
  devtools?: false
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
  exportName?: string
  handler: string
  name: string
  source?: string
  workspace?: string
}

export type AgentChatConfig<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
> = Omit<DefineChatOptions<TRuntimeConfig, TWorkflow>, "agent">

export type AgentChatMetadata<TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig> =
  AgentChatOptions<TRuntimeConfig> & AgentChatConfig<TRuntimeConfig>

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
