import type {
  Agent,
  AgentCallParameters,
  AgentStreamParameters,
  GenerateTextResult,
  LanguageModel,
  StreamTextResult,
  ToolLoopAgentSettings,
  ToolSet,
} from "ai"
import type { Message, StreamEvent } from "@vitehub/messages"
import type {
  MaybePromise,
  MaybeResolvable,
  Resolvable,
  RuntimeCapabilities,
  RuntimeCapabilityHandle,
  RuntimeHostContext,
  RuntimeWaitUntil,
} from "@vitehub/runtime"

export type { Agent } from "ai"
export type {
  MaybePromise,
  MaybeResolvable,
  Resolvable,
}

export type AgentRuntimeName = "cloudflare-agents" | "nitro" | "unknown" | "vercel"
export type AgentRuntime = "auto" | AgentRuntimeName
export type AgentExecution = "inline" | "sandbox" | "workflow"
export type AgentRuntimeBinding =
  | AgentWorkflowRuntimeBinding

export interface AgentWorkflowRuntimeBinding {
  kind: "workflow"
  name?: string
}
export type AgentWaitUntil = RuntimeWaitUntil
export type AgentIntegrationOption = "auto" | boolean
export type AgentCapabilityHandle<TKind extends string = string, TValue = unknown> = RuntimeCapabilityHandle<TKind, TValue>
export type AgentCapabilities = RuntimeCapabilities

export interface AgentRuntimeConfig {}

export interface AgentRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends Omit<RuntimeHostContext<TRuntimeConfig>, "cloudflare" | "platform" | "runtime"> {
  cloudflare?: RuntimeHostContext<TRuntimeConfig>["cloudflare"]
  devtools?: {
    reportToolStep?: (step: AgentToolStep) => MaybePromise<void>
  }
  run?: AgentRunMetadata
  runtime: AgentRuntimeName
}

export type ResolvedAgentRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  AgentRuntimeContext<TRuntimeConfig> & { runtimeConfig: TRuntimeConfig }

export interface AgentRunInput<CALL_OPTIONS = never, TOOLS extends ToolSet = ToolSet> {
  abortSignal?: AbortSignal
  context?: Record<string, unknown>
  messages?: Message[]
  options?: CALL_OPTIONS
  prompt?: string | Message[]
  timeout?: AgentCallParameters<CALL_OPTIONS, TOOLS>["timeout"]
}

export interface AgentRunMetadata {
  channelId?: string
  messageId?: string
  platform?: string
  runId: string
  threadId?: string
}

export interface AgentRunCallbackContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
> extends ResolvedAgentRuntimeContext<TRuntimeConfig> {
  input: AgentRunInput<CALL_OPTIONS, TOOLS>
  run?: AgentRunMetadata
}

export interface AgentRunResult {
  finishReason?: unknown
  raw?: unknown
  text?: string
  usage?: unknown
  warnings?: unknown
}

export interface AgentRunContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
> extends ResolvedAgentRuntimeContext<TRuntimeConfig> {
  createAgent: () => Promise<Agent<CALL_OPTIONS, TOOLS>>
  generateText: (options: AgentCallParameters<CALL_OPTIONS, TOOLS>) => PromiseLike<GenerateTextResult<TOOLS, never>>
  input: AgentRunInput<CALL_OPTIONS, TOOLS>
  streamText: (options: AgentStreamParameters<CALL_OPTIONS, TOOLS>) => PromiseLike<StreamTextResult<TOOLS, never>>
}

export type AgentRunHandler<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
> = (context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS, TOOLS>) => MaybePromise<Response | AgentRunResult | AsyncIterable<StreamEvent> | GenerateTextResult<TOOLS, never> | StreamTextResult<TOOLS, never> | unknown>

export type AgentToolResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TOOLS extends ToolSet = ToolSet,
> = MaybeResolvable<TOOLS | AgentToolSet, ResolvedAgentRuntimeContext<TRuntimeConfig>>

export type AgentModelInput = LanguageModel

export interface AgentModelInstrumentationContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends ResolvedAgentRuntimeContext<TRuntimeConfig> {
  model: AgentModelInput
  run?: AgentRunMetadata
}

export type AgentModelInstrumentation<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  (context: AgentModelInstrumentationContext<TRuntimeConfig>) => MaybePromise<AgentModelInput>

type AgentSettingsBase<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
> = Omit<ToolLoopAgentSettings<CALL_OPTIONS, TOOLS>, "model" | "tools"> & {
  description?: string
  instrumentModel?: AgentModelInstrumentation<TRuntimeConfig>
  onRunStepFinish?: (step: unknown, context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TOOLS>) => MaybePromise<void>
  onRunToolCallFinish?: (event: unknown, context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TOOLS>) => MaybePromise<void>
  onRunToolCallStart?: (event: unknown, context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TOOLS>) => MaybePromise<void>
  runtime?: AgentRuntimeBinding
  tools?: AgentToolResolver<TRuntimeConfig, TOOLS>
}

export type AgentSettings<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
> = AgentSettingsBase<TRuntimeConfig, CALL_OPTIONS, TOOLS> & (
  | {
    model: AgentModelInput
    run?: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS, TOOLS>
  }
  | {
    model?: AgentModelInput
    run: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS, TOOLS>
  }
)

export interface AgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
> {
  chat?: AgentChatOptions<TRuntimeConfig>
  description?: string
  hooks?: AgentChatAgentHooks<TRuntimeConfig>
  runtime?: AgentRuntimeBinding
  resolve(context: AgentRuntimeContext<TRuntimeConfig>): Promise<Agent<CALL_OPTIONS, TOOLS>>
  run?(context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS, TOOLS>): MaybePromise<Response | AgentRunResult | AsyncIterable<StreamEvent> | GenerateTextResult<TOOLS, never> | StreamTextResult<TOOLS, never> | unknown>
}

export type AgentInput<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  | Agent
  | AgentDefinition<TContext extends AgentRuntimeContext<infer TRuntimeConfig> ? TRuntimeConfig : AgentRuntimeConfig>

export type AgentRegistryModule<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  | { default?: AgentInput<TContext> }
  | AgentInput<TContext>

export type AgentRegistry<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  Record<string, () => MaybePromise<AgentRegistryModule<TContext>>>

export interface AgentModelProviderOptions {
  provider?: "auto" | "vercel-ai-sdk" | (string & {})
}

export interface AgentStateProviderOptions {
  provider?: "auto" | "cloudflare-agents" | "memory" | (string & {})
}

export interface AgentSchedulerProviderOptions {
  provider?: "auto" | "cloudflare-agents" | "memory" | (string & {})
}

export interface AgentSandboxProviderOptions {
  provider?: "auto" | "cloudflare" | "vercel" | (string & {})
}

export interface AgentIntegrationsOptions {
  sandbox?: AgentIntegrationOption
  workflow?: AgentIntegrationOption
}

export interface AgentProvidersOptions {
  model?: AgentModelProviderOptions
  sandbox?: AgentSandboxProviderOptions
  scheduler?: AgentSchedulerProviderOptions
  state?: AgentStateProviderOptions
}

export interface AgentModuleOptions {
  execution?: AgentExecution
  imports?: boolean
  integrations?: AgentIntegrationsOptions
  providers?: AgentProvidersOptions
  route?: boolean | string
  runtime?: AgentRuntime
}

export interface ResolvedAgentModuleOptions {
  execution: AgentExecution
  imports: boolean
  integrations: Required<AgentIntegrationsOptions>
  providers: {
    model: Required<AgentModelProviderOptions>
    sandbox: Required<AgentSandboxProviderOptions>
    scheduler: Required<AgentSchedulerProviderOptions>
    state: Required<AgentStateProviderOptions>
  }
  route: false | string
  runtime: AgentRuntime
}

export interface AgentHandlerOptions<TRuntimeContext extends AgentRuntimeContext = AgentRuntimeContext> {
  inferredName?: string
  lifecycleHooks?: AgentRuntimeHooks<TRuntimeContext>
}

export interface AgentRegistryHandlerOptions<TRuntimeContext extends AgentRuntimeContext = AgentRuntimeContext> {
  agentParam?: string
  lifecycleHooks?: AgentRuntimeHooks<TRuntimeContext>
}

export interface AgentRuntimeHooks<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> {
  error?: (error: unknown, context: TContext) => MaybePromise<void>
  request?: (context: TContext) => MaybePromise<void>
  resolved?: (context: TContext & { agent: Agent }) => MaybePromise<void>
}

export interface DiscoveredAgentDefinition {
  exportName?: string
  handler: string
  name: string
  source?: "nitro-server-agent" | "nitro-server-agent-workspace" | "nitro-server-agents" | "vite-suffix"
  workspace?: string
}

export interface AgentToolStepItem {
  id?: string
  input?: unknown
  name?: string
  output?: unknown
  toolCallId?: string
  toolName?: string
}

export interface AgentToolStep {
  text?: string
  toolCalls?: AgentToolStepItem[]
  toolErrors?: AgentToolStepItem[]
  toolResults?: AgentToolStepItem[]
}

export interface AgentChatAgentBindingOptions {
  event?: "directMessage"
  history?: boolean | "none" | { maxMessages?: number, source: "thread" }
  hooks?: AgentChatAgentHooks
}

export interface AgentChatAgentHookArgs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends Record<string, unknown> {
  runtimeConfig: TRuntimeConfig
  thread: { post: (message: unknown) => MaybePromise<unknown> }
}

export interface AgentChatAgentHooks<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  afterRun?: (args: AgentChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<unknown>
  beforeRun?: (args: AgentChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<unknown>
  error?: (args: { error: unknown } & AgentChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<void>
  prepareInput?: (args: AgentChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<unknown>
  sendResponse?: (args: AgentChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<void>
}

export interface AgentChatEventHookArgs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends Record<string, unknown> {
  runtimeConfig: TRuntimeConfig
}

export interface AgentChatEventHooks<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends Record<string, unknown> {
  onDirectMessage?: (args: { message: { text: string } } & AgentChatEventHookArgs<TRuntimeConfig>) => MaybePromise<void>
}

export interface AgentChatOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  adapters?: MaybeResolvable<Record<string, unknown>, ResolvedAgentRuntimeContext<TRuntimeConfig>>
  agent?: never
  event?: AgentChatAgentBindingOptions["event"]
  execution?: never
  fallbackStreamingPlaceholderText?: string | null | ((context: AgentChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<string | null | undefined>)
  history?: AgentChatAgentBindingOptions["history"]
  hooks?: AgentChatEventHooks<TRuntimeConfig>
  lifecycleHooks?: Record<string, unknown>
  state?: MaybeResolvable<unknown, AgentRuntimeContext<TRuntimeConfig>>
  workflow?: never
  [key: string]: unknown
}

export type AgentRequestBody<CALL_OPTIONS = never> = {
  messages?: Message[]
  options?: CALL_OPTIONS
  prompt?: string | Message[]
  stream?: boolean
}

export type AgentToolPolicyDecision = "allow" | "deny" | "require-approval" | "retryable-failure"

export interface AgentToolPolicyContext {
  input?: unknown
  name: string
}

export interface AgentToolDefinition<TInput = unknown, TOutput = unknown> {
  description?: string
  execute?: (input: TInput) => MaybePromise<TOutput>
  inputSchema?: unknown
  metadata?: Record<string, unknown>
  name: string
  outputSchema?: unknown
  policy?: AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)
}

export type AgentToolSet = Record<string, AgentToolDefinition>

export interface CloudflareExportedHandlerFetchHandler<TEnv = unknown> {
  (request: Request, env: TEnv, ctx: { waitUntil?: (promise: Promise<unknown>) => void }): Response | Promise<Response>
}
