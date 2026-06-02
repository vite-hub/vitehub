import type { Message, StreamEvent } from "./messages.ts"
import type { Adapter, IdentityResolver, StateAdapter, TranscriptsConfig } from "chat"
import type {
  MaybePromise,
  MaybeResolvable,
  Resolvable,
  RuntimeCapabilities,
  RuntimeCapabilityHandle,
  RuntimeHostContext,
  RuntimeWaitUntil,
} from "@vite-hub/runtime"
import type {
  ReadonlyWorkspaceFacade,
  WritableWorkspaceFacade,
  WorkspaceDefinition,
  WorkspaceDefinitionInput,
  WorkspaceName,
} from "@vite-hub/workspace"

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

export type AgentCallbackContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  Omit<ResolvedAgentRuntimeContext<TRuntimeConfig>, "runtimeConfig">

export interface AgentInvocationContextStore {
  entries: () => IterableIterator<[string, unknown]>
  get: <T = unknown>(id: string) => T | undefined
  has: (id: string) => boolean
  set: (id: string, value: unknown) => void
  toJSON: () => Record<string, unknown>
}

export interface AgentRunInput<
  CALL_OPTIONS = unknown,
  TContext extends object = Record<string, unknown>,
> {
  abortSignal?: AbortSignal
  context?: TContext
  messages?: Message[]
  options?: CALL_OPTIONS
  prompt?: string | Message[]
  timeout?: number
}

export interface AgentScheduleInvocationInput {
  id: string
  kind: "schedule"
  runId?: string
  scheduleId?: string
  scheduledAt: Date
  target?: string
}

export interface AgentRunMetadata<TOrigin extends string = string> {
  channelId?: string
  messageId?: string
  origin?: TOrigin
  runId: string
  threadId?: string
}

export interface AgentTriggerInvokeResult<CALL_OPTIONS = unknown> {
  input: AgentRunInput<CALL_OPTIONS>
  metadata?: Record<string, unknown>
  run?: AgentRunMetadata
}

export interface AgentWebhookRegistrationDefinition {
  id?: string
  method?: "POST" | (string & {})
  path?: string
  provider: string
  secretHeader?: string
  secretToken?: string
  url?: string
}

export type AgentChatWebhookRegistrationDefinition =
  Omit<AgentWebhookRegistrationDefinition, "provider"> & { provider?: string }

export interface AgentChatAppOptions<TOrigin extends string = string> {
  origin?: TOrigin
  route?: never
}

export type AgentChatAppExposure<TOrigin extends string = string> = boolean | TOrigin | AgentChatAppOptions<TOrigin>

export interface AgentTriggerContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends AgentCallbackContext<TRuntimeConfig> {
  capability: AgentCapabilityDefinition<TRuntimeConfig, Name>
  trigger: {
    capabilityId: string
    id: `${string}.${string}`
    name: string
  }
}

export interface AgentTriggerDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TInput = unknown,
  CALL_OPTIONS = unknown,
> {
  devtools?: boolean | Record<string, unknown>
  input?: unknown
  invoke: (context: AgentTriggerContext<TRuntimeConfig, Name>, input: TInput) => MaybePromise<AgentTriggerInvokeResult<CALL_OPTIONS>>
  output?: "events" | "ui-message-stream" | (string & {})
  webhooks?: AgentWebhookRegistrationDefinition[]
}

export interface ResolvedAgentTriggerDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TInput = unknown,
  CALL_OPTIONS = unknown,
> {
  capabilityId: string
  definition: AgentTriggerDefinition<TRuntimeConfig, WorkspaceName, TInput, CALL_OPTIONS>
  devtools?: boolean | Record<string, unknown>
  id: `${string}.${string}`
  input?: unknown
  invoke: (input: TInput) => MaybePromise<AgentTriggerInvokeResult<CALL_OPTIONS>>
  name: string
  output?: "events" | "ui-message-stream" | (string & {})
  webhooks?: AgentWebhookRegistrationDefinition[]
}

export interface AgentRunCallbackContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> extends AgentCallbackContext<TRuntimeConfig> {
  context: AgentInvocationContextStore
  input: AgentRunInput<CALL_OPTIONS>
  run?: AgentRunMetadata
}

export interface AgentRunResult {
  finishReason?: unknown
  raw?: unknown
  text?: string
  usage?: unknown
  usageRecord?: AgentUsageRecord
  warnings?: unknown
}

export interface AgentInvocationExtensions {
  get<T = unknown>(capabilityId: string): T | undefined
}

export interface AgentFinishEvent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  error?: unknown
  extensions: AgentInvocationExtensions
  input: AgentRunInput<CALL_OPTIONS>
  invocation: {
    durationMs: number
    run?: AgentRunMetadata
  }
  result?: unknown
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>
}

export type AgentFinishHook<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = (event: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void>

export interface AgentInvocationHooks<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  "agent:finish"?: AgentFinishHook<TRuntimeConfig, CALL_OPTIONS>
}

export interface AgentRunContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  Name extends WorkspaceName = WorkspaceName,
> extends AgentCallbackContext<TRuntimeConfig> {
  adapter?: AgentAdapter<CALL_OPTIONS>
  context: AgentInvocationContextStore
  input: AgentRunInput<CALL_OPTIONS>
  messages: Message[]
  prompt?: string
  providerTools?: AgentProviderToolContribution[]
  tools?: AgentToolSet
  workspace?: ReadonlyWorkspaceFacade<Name> | WritableWorkspaceFacade<Name>
}

export type AgentRunHandler<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = (context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<Response | AgentRunResult | AsyncIterable<StreamEvent> | unknown>

export type AgentToolResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> = MaybeResolvable<AgentToolSet | undefined, AgentCallbackContext<TRuntimeConfig>>

export type AgentToolResolverWithWorkspace<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | Record<string, unknown>
  | undefined
  | ((context: AgentAdapterMetadataContext<TRuntimeConfig, Name>) => MaybePromise<unknown>)

export type AgentCapabilityMode = "read" | "write"

export interface AgentCapabilityRequirement {
  primitive?: "workspace-shell" | "blob" | "db" | "kv" | "mcp" | "sandbox" | "schedule" | "skills" | "workspace" | (string & {})
  workspace?: {
    mode?: AgentCapabilityMode
    paths?: string[]
    required?: boolean
  }
}

export interface AgentCapabilityContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends AgentAdapterMetadataContext<TRuntimeConfig, Name> {
  mode?: AgentCapabilityMode
  workspaceDefinition?: WorkspaceDefinition
}

export type AgentCapabilityToolResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | Record<string, unknown>
  | ((context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<Record<string, unknown> | undefined>)

export type AgentCapabilityPhase = "configure" | "prepare" | "bind" | "input" | "resolve" | "output" | "close"
export type AgentCapabilityHookName = `capability:${AgentCapabilityPhase}` | `capability:${AgentCapabilityPhase}:after`

export interface AgentInstructionBlock {
  id: string
  instructions: string
}

export type AgentToolTransform = (tools: AgentToolSet | undefined) => MaybePromise<AgentToolSet | undefined>
export interface AgentProviderToolContribution {
  args?: Record<string, unknown>
  id: `${string}.${string}`
  name: string
}
export type AgentOutputRenderer = (
  result: unknown,
  context: AgentCapabilityRuntimeContext,
) => MaybePromise<unknown>
export type AgentFinishExtensionProvider = (event: AgentFinishEvent) => MaybePromise<unknown>

export interface AgentCapabilityStateRequirement {
  name: string
  optional?: boolean
}

export type AgentCapabilityHooks<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = Partial<Record<AgentCapabilityHookName, (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>>>

export interface AgentCapabilityRuntimeContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends AgentCapabilityContext<TRuntimeConfig, Name> {
  capability: AgentCapabilityDefinition<TRuntimeConfig, Name>
  instructions: {
    add: (instructions: AgentAdapterInstructionsValue | false | undefined, options?: { id?: string }) => void
  }
  input: {
    get: () => AgentRunInput
    messages: () => Message[]
    set: (input: AgentRunInput) => void
    setMessages: (messages: Message[]) => void
  }
  model: {
    resolve: (model?: AgentModelResolver<TRuntimeConfig, Name>) => Promise<AgentModelInput>
  }
  output: {
    render: (renderer: AgentOutputRenderer) => void
  }
  providerTools: {
    add: (tool: AgentProviderToolContribution) => void
  }
  finish: {
    provide: (value: unknown | AgentFinishExtensionProvider) => void
  }
  state: {
    require: (name: string, options?: { optional?: boolean }) => void
  }
  tools: {
    add: (tools: AgentToolSet | undefined) => void
    transform: (transform: AgentToolTransform) => void
  }
}

export interface AgentCapabilityTypeContract {
  inputContext?: object
  workspaceSources?: string
}

export interface AgentCapabilityDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TTypeContract extends AgentCapabilityTypeContract = AgentCapabilityTypeContract,
> {
  readonly __vitehubTypeContract?: TTypeContract
  bind?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  close?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  configure?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  hooks?: AgentCapabilityHooks<TRuntimeConfig, Name>
  id: string
  input?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  instructions?:
    | AgentAdapterInstructions<TRuntimeConfig, Name>
    | false
    | ((context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<AgentAdapterInstructionsValue | false | undefined>)
  metadata?: Record<string, unknown>
  mode?: AgentCapabilityMode
  output?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  prepare?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  requires?: AgentCapabilityRequirement[]
  resolve?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  tools?: AgentCapabilityToolResolver<TRuntimeConfig, Name>
  triggers?: Record<string, AgentTriggerDefinition<TRuntimeConfig, Name, any, any>>
}

export type AgentCapabilityInput<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = AgentCapabilityDefinition<TRuntimeConfig, Name>

export type AgentCapabilitiesList<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = Array<AgentCapabilityInput<TRuntimeConfig, Name>>

export type AgentAdapterInstructionsValue = string | string[]

export type AgentAdapterInstructions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | AgentAdapterInstructionsPart<TRuntimeConfig, Name>
  | Array<AgentAdapterInstructionsPart<TRuntimeConfig, Name>>

export type AgentAdapterInstructionsPart<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | AgentAdapterInstructionsValue
  | ((context: AgentAdapterMetadataContext<TRuntimeConfig, Name>) => MaybePromise<AgentAdapterInstructionsValue | undefined>)

export type AgentModelInput = unknown

export type AgentModelResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = MaybeResolvable<AgentModelInput, AgentAdapterMetadataContext<TRuntimeConfig, Name>>

export interface AgentModelInstrumentationContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentCallbackContext<TRuntimeConfig> {
  context: AgentInvocationContextStore
  model: AgentModelInput
  run?: AgentRunMetadata
}

export type AgentModelInstrumentation<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  (context: AgentModelInstrumentationContext<TRuntimeConfig>) => MaybePromise<AgentModelInput>

type AgentSettingsBase<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> = {
  adapterOptions?: Record<string, unknown>
  description?: string
  hooks?: AgentCapabilityHooks<TRuntimeConfig> & AgentInvocationHooks<TRuntimeConfig>
  instructions?: AgentAdapterInstructions<TRuntimeConfig>
  instrumentModel?: AgentModelInstrumentation<TRuntimeConfig>
  capabilities?: AgentCapabilitiesList<TRuntimeConfig>
  model?: AgentModelResolver<TRuntimeConfig>
  runtime?: AgentRuntimeBinding
  title?: string
  version?: string
  workspace?: WorkspaceAgentWorkspaceConfig
}

export type AgentSettings<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = AgentSettingsBase<TRuntimeConfig> & (
  | {
    run: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS>
  }
  | {
    model: NonNullable<AgentSettingsBase<TRuntimeConfig>["model"]>
    run?: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS>
  }
)

export interface AgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  capabilities?: AgentCapabilityDefinition<TRuntimeConfig>[]
  chat?: AgentChatOptions<TRuntimeConfig>
  description?: string
  hooks?: AgentCapabilityHooks<TRuntimeConfig, WorkspaceName> & AgentInvocationHooks<TRuntimeConfig, CALL_OPTIONS>
  runtime?: AgentRuntimeBinding
  resolve(context: AgentRuntimeContext<TRuntimeConfig>): Promise<AgentAdapter<CALL_OPTIONS>>
  run?(context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS>): MaybePromise<Response | AgentRunResult | AsyncIterable<StreamEvent> | unknown>
  title?: string
  version?: string
  workspace?: WorkspaceAgentWorkspaceConfig
}

export type AgentInput<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  AgentDefinition<TContext extends AgentRuntimeContext<infer TRuntimeConfig> ? TRuntimeConfig : AgentRuntimeConfig>

export type AgentRegistryModule<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  | { default?: AgentInput<TContext> }
  | AgentInput<TContext>

export type AgentRegistry<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  Record<string, () => MaybePromise<AgentRegistryModule<TContext>>>

export interface AgentStateProviderOptions {
  provider?: "auto" | "cloudflare" | "cloudflare-agents" | "memory" | (string & {})
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
  sandbox?: AgentSandboxProviderOptions
  scheduler?: AgentSchedulerProviderOptions
  state?: AgentStateProviderOptions
}

export interface AgentEvalOptions {
  cache?: boolean
  forceRerunTriggers?: string[]
  hideTable?: boolean
  maxConcurrency?: number
  scoreThreshold?: number
  server?: {
    port?: number
  }
  setupFiles?: string[]
  testTimeout?: number
  trialCount?: number
}

export type AgentCliOptions = Record<never, never>

export interface AgentModuleOptions {
  cli?: false | AgentCliOptions
  devtools?: false
  execution?: AgentExecution
  eval?: false | AgentEvalOptions
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
  resolved?: (context: TContext & { agent: AgentAdapter }) => MaybePromise<void>
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
}

export interface AgentChatSessionOptions {
  idleTimeoutMs?: number
  metadataKey?: string
  strategy?: "manual" | "idle-timeout" | "hybrid"
}

export interface AgentChatMessageHookArgs {
  id?: string
  metadata?: Record<string, unknown>
  text: string
}

export interface AgentChatAgentHookArgs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends Record<string, unknown> {
  history: Message[]
  message: AgentChatMessageHookArgs
  run?: AgentRunMetadata
  session?: {
    action?: "continue" | "new" | "switch"
    id?: string
  }
  thread: { post: (message: unknown) => MaybePromise<unknown> }
}

export interface AgentChatEventHookArgs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends Record<string, unknown> {
}

export interface AgentChatEventHooks<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends Record<string, unknown> {
  onDirectMessage?: (args: { message: { text: string } } & AgentChatEventHookArgs<TRuntimeConfig>) => MaybePromise<void>
}

export type AgentChatAdapterResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<Adapter, AgentCallbackContext<TRuntimeConfig>>

export type AgentChatAdaptersResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<Record<string, AgentChatAdapterResolver<TRuntimeConfig>>, AgentCallbackContext<TRuntimeConfig>>

export type AgentChatIdentityResolver = IdentityResolver

export interface AgentChatStateContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentCallbackContext<TRuntimeConfig> {
  chat: {
    agentName: string
    stateKeyPrefix: string
  }
}

export type AgentChatStateResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<StateAdapter, AgentChatStateContext<TRuntimeConfig>>

export interface AgentChatOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  adapters?: AgentChatAdaptersResolver<TRuntimeConfig>
  agent?: never
  app?: AgentChatAppExposure
  event?: AgentChatAgentBindingOptions["event"]
  execution?: never
  fallbackStreamingPlaceholderText?: string | null | ((context: AgentChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<string | null | undefined>)
  history?: AgentChatAgentBindingOptions["history"]
  hooks?: AgentChatEventHooks<TRuntimeConfig>
  identity?: AgentChatIdentityResolver
  lifecycleHooks?: Record<string, unknown>
  sessions?: boolean | AgentChatSessionOptions
  state?: AgentChatStateResolver<TRuntimeConfig>
  transcripts?: TranscriptsConfig
  userName?: string
  webhooks?: Record<string, AgentChatWebhookRegistrationDefinition | AgentChatWebhookRegistrationDefinition[]>
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

export interface WorkspaceAgentWorkspaceOptions extends Omit<WorkspaceDefinitionInput, "name"> {
  mode?: AgentCapabilityMode
}

export type WorkspaceAgentWorkspaceConfig = WorkspaceName | WorkspaceAgentWorkspaceOptions

export interface AgentDevtoolsFileTreeItem {
  children?: AgentDevtoolsFileTreeItem[]
  kind: "directory" | "file"
  label?: string
  materialize?: "build" | "lazy"
  materialized?: boolean
  materializedAt?: string
  path: string
  source?: string
  status?: "lazy" | "updating" | "ready" | "error"
  updatedAt?: string
}

export interface AgentDevtoolsToolDefinition {
  category?: string
  commands?: string[]
  description?: string
  icon?: string
  name: string
  preset?: string
  status?: "available" | "disabled"
}

export interface AgentDevtoolsMetadata {
  files?: AgentDevtoolsFileTreeItem[]
  instructions?: string[]
  title?: string
  tools?: AgentDevtoolsToolDefinition[]
  version?: string
}

export interface AgentAdapterResult {
  finishReason?: unknown
  raw?: unknown
  text?: string
  usage?: unknown
  usageRecord?: AgentUsageRecord
  warnings?: unknown
}

export interface AgentUsage {
  inputTokenDetails?: Record<string, number>
  inputTokens?: number
  outputTokenDetails?: Record<string, number>
  outputTokens?: number
  raw?: unknown
  totalTokens?: number
}

export interface AgentUsageCost {
  amount: string
  currency: "USD" | (string & {})
  estimated: boolean
  source: "custom" | "estimated" | "provider" | "vercel-ai-gateway" | (string & {})
}

export interface AgentUsageRecord {
  cost?: AgentUsageCost
  latency?: {
    durationMs?: number
    timeToFirstTokenMs?: number
    tokensPerSecond?: number
  }
  model?: {
    id?: string
    provider?: string
  }
  raw?: unknown
  response?: {
    finishReason?: unknown
    id?: string
    timestamp?: Date | string
  }
  run?: Partial<AgentRunMetadata>
  usage?: AgentUsage
}

export interface AgentAdapterMetadataContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends AgentCallbackContext<TRuntimeConfig> {
  context: AgentInvocationContextStore
  fs: ReadonlyWorkspaceFacade<Name>["fs"]
  workspace: ReadonlyWorkspaceFacade<Name>
}

export interface AgentAdapterRunContext<
  TOptions = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  capabilityInstructions?: AgentInstructionBlock[]
  close?: () => Promise<void>
  context: AgentInvocationContextStore
  devtools?: AgentRuntimeContext<TRuntimeConfig>["devtools"]
  hasCapabilityCleanup?: boolean
  input: AgentRunInput<TOptions>
  instructions?: string
  messages: Message[]
  outputRenderers?: Array<(result: unknown) => MaybePromise<unknown>>
  prompt?: string
  providerTools?: AgentProviderToolContribution[]
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>
  tools?: AgentToolSet
  workspace?: ReadonlyWorkspaceFacade<Name>
}

export interface AgentAdapter<
  TOptions = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  generate(context: AgentAdapterRunContext<TOptions, TRuntimeConfig, Name>): MaybePromise<AgentAdapterResult | Response | AsyncIterable<StreamEvent> | unknown>
  metadata?(context: AgentAdapterMetadataContext<TRuntimeConfig, Name>): MaybePromise<AgentDevtoolsMetadata | undefined>
  name: string
  stream?(context: AgentAdapterRunContext<TOptions, TRuntimeConfig, Name>): MaybePromise<Response | AsyncIterable<StreamEvent> | AgentAdapterResult | unknown>
}

export type AgentAdapterFactory<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TOptions = unknown,
  Name extends WorkspaceName = WorkspaceName,
> = (context: ResolvedAgentRuntimeContext<TRuntimeConfig>) => MaybePromise<AgentAdapter<TOptions, TRuntimeConfig, Name>>

export interface CloudflareExportedHandlerFetchHandler<TEnv = unknown> {
  (request: Request, env: TEnv, ctx: { waitUntil?: (promise: Promise<unknown>) => void }): Response | Promise<Response>
}
