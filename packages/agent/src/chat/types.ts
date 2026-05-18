import type {
  ActionEvent,
  Adapter,
  Channel,
  Chat,
  ChatConfig,
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
  Thread,
} from "chat"
import type { RuntimeHostContext } from "@vitehub/runtime"
import type {
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentRuntimeName,
  MaybePromise,
  MaybeResolvable,
  ResolvedAgentRuntimeContext,
} from "../types.ts"
import type { AgentMessage } from "../messages.ts"

export interface AgentChatRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends ResolvedAgentRuntimeContext<TRuntimeConfig> {
  dev?: boolean
  platform: string
  request?: Request
  runtime: AgentRuntimeName
}

export type ChatAdapterInput<TContext extends RuntimeHostContext<any> = AgentChatRuntimeContext> =
  | MaybeResolvable<Record<string, Adapter>, TContext>
  | Record<string, MaybeResolvable<Adapter, TContext>>

export interface ChatHookArgs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  bot: Chat
  channel?: Channel
  context?: MessageContext
  event?: unknown
  message?: Message
  runtimeConfig: TRuntimeConfig
  thread?: Thread
}

export type ChatMessageHook<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  (args: ChatHookArgs<TRuntimeConfig> & { context?: MessageContext, message: Message, thread: Thread }) => MaybePromise<void>

export type ChatDirectMessageHook<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  (args: ChatHookArgs<TRuntimeConfig> & { channel: Channel, context?: MessageContext, message: Message, thread: Thread }) => MaybePromise<void>

export type ChatEventHook<TEvent, TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  (args: ChatHookArgs<TRuntimeConfig> & { event: TEvent }) => MaybePromise<void>

export interface ChatNewMessageHook<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  handler: ChatMessageHook<TRuntimeConfig>
  pattern: RegExp
}

export type ChatReactionHookInput<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  | ChatEventHook<ReactionEvent, TRuntimeConfig>
  | Record<string, ChatEventHook<ReactionEvent, TRuntimeConfig>>
  | { emoji: Array<EmojiValue | string>, handler: ChatEventHook<ReactionEvent, TRuntimeConfig> }

export type ChatActionHookInput<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  | ChatEventHook<ActionEvent, TRuntimeConfig>
  | Record<string, ChatEventHook<ActionEvent, TRuntimeConfig>>

export type ChatModalSubmitHookInput<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  | ChatEventHook<ModalSubmitEvent, TRuntimeConfig>
  | Record<string, ChatEventHook<ModalSubmitEvent, TRuntimeConfig>>

export interface ChatEventHooks<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  onAction?: ChatActionHookInput<TRuntimeConfig>
  onDirectMessage?: ChatDirectMessageHook<TRuntimeConfig>
  onModalSubmit?: ChatModalSubmitHookInput<TRuntimeConfig>
  onNewMention?: ChatMessageHook<TRuntimeConfig>
  onNewMessage?: ChatNewMessageHook<TRuntimeConfig> | Array<ChatNewMessageHook<TRuntimeConfig>>
  onReaction?: ChatReactionHookInput<TRuntimeConfig>
  onSubscribedMessage?: ChatMessageHook<TRuntimeConfig>
}

export type ChatHistory =
  | boolean
  | false
  | {
    maxMessages?: number
    source: "thread"
  }

export type ChatStateProvider =
  | "auto"
  | "memory"
  | "workspace"
  | "cloudflare"
  | {
    prefix?: string
    provider: "kv"
    store?: string
  }

export interface ChatAgentHookArgs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends ChatHookArgs<TRuntimeConfig> {
  channel: Channel
  history: AgentMessage[]
  message: Message
  run: AgentRunMetadata
  thread: Thread
}

export interface ChatAgentBeforeRunArgs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends ChatAgentHookArgs<TRuntimeConfig> {
  input: AgentRunInput
}

export interface ChatAgentAfterRunArgs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends ChatAgentBeforeRunArgs<TRuntimeConfig> {
  result: unknown
}

export interface ChatAgentErrorArgs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends ChatAgentHookArgs<TRuntimeConfig> {
  error: unknown
  input?: AgentRunInput
}

export interface ChatAgentHooks<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  afterRun?: (args: ChatAgentAfterRunArgs<TRuntimeConfig>) => MaybePromise<unknown>
  beforeRun?: (args: ChatAgentBeforeRunArgs<TRuntimeConfig>) => MaybePromise<AgentRunInput | void>
  error?: (args: ChatAgentErrorArgs<TRuntimeConfig>) => MaybePromise<void>
  prepareInput?: (args: ChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<AgentRunInput>
  sendResponse?: (args: ChatAgentAfterRunArgs<TRuntimeConfig>) => MaybePromise<void>
}

export type ChatStreamingPlaceholder<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  | string
  | null
  | ((context: ChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<string | null | undefined>)

type ChatConfigPassthrough = Omit<ChatConfig, "adapters" | "fallbackStreamingPlaceholderText" | "state" | "userName">

export interface ChatCapabilityOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends ChatConfigPassthrough, ChatEventHooks<TRuntimeConfig> {
  adapters: ChatAdapterInput<AgentChatRuntimeContext<TRuntimeConfig>>
  concurrency?: ConcurrencyStrategy | ConcurrencyConfig
  fallbackStreamingPlaceholderText?: ChatStreamingPlaceholder<TRuntimeConfig>
  history?: ChatHistory
  hooks?: ChatEventHooks<TRuntimeConfig> & { agent?: ChatAgentHooks<TRuntimeConfig> }
  lockScope?: LockScope | ((context: LockScopeContext) => LockScope | Promise<LockScope>)
  logger?: Logger | LogLevel
  onLockConflict?: ChatConfig["onLockConflict"]
  setup?: (bot: Chat, context: AgentChatRuntimeContext<TRuntimeConfig>) => MaybePromise<void>
  state?: ChatStateProvider
  userName?: ChatConfig["userName"]
}
