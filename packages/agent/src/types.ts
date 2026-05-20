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
import type {
  ReadonlyWorkspaceFacade,
  WorkspaceDefinitionInput,
  WorkspaceName,
} from "@vitehub/workspace"

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

export interface AgentRunInput<CALL_OPTIONS = unknown> {
  abortSignal?: AbortSignal
  context?: Record<string, unknown>
  messages?: Message[]
  options?: CALL_OPTIONS
  prompt?: string | Message[]
  timeout?: number
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
  CALL_OPTIONS = unknown,
> extends ResolvedAgentRuntimeContext<TRuntimeConfig> {
  input: AgentRunInput<CALL_OPTIONS>
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
  CALL_OPTIONS = unknown,
> extends ResolvedAgentRuntimeContext<TRuntimeConfig> {
  adapter?: AgentAdapter<CALL_OPTIONS>
  input: AgentRunInput<CALL_OPTIONS>
  messages: Message[]
  prompt?: string
  tools?: AgentToolSet
}

export type AgentRunHandler<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = (context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<Response | AgentRunResult | AsyncIterable<StreamEvent> | unknown>

export type AgentToolResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> = MaybeResolvable<AgentToolSet | undefined, ResolvedAgentRuntimeContext<TRuntimeConfig>>

export type AgentToolResolverWithWorkspace<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | Record<string, unknown>
  | undefined
  | ((context: AgentAdapterMetadataContext<TRuntimeConfig, Name>) => MaybePromise<unknown>)

export type AgentCapabilityMode = "read" | "write"

export interface AgentCapabilityRequirement {
  primitive?: "bash" | "blob" | "db" | "kv" | "mcp" | "sandbox" | "skills" | "workspace" | (string & {})
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
export type AgentOutputRenderer = (
  result: unknown,
  context: AgentCapabilityRuntimeContext,
) => MaybePromise<unknown>

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
  output: {
    render: (renderer: AgentOutputRenderer) => void
  }
  state: {
    require: (name: string, options?: { optional?: boolean }) => void
  }
  tools: {
    add: (tools: AgentToolSet | undefined) => void
    transform: (transform: AgentToolTransform) => void
  }
}

export interface AgentCapabilityDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  bind?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  close?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  configure?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  description?: string
  hooks?: AgentCapabilityHooks<TRuntimeConfig, Name>
  id: string
  input?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  instructions?:
    | AgentAdapterInstructions<TRuntimeConfig, Name>
    | false
    | ((context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<AgentAdapterInstructionsValue | false | undefined>)
  metadata?: Record<string, unknown>
  mode?: AgentCapabilityMode
  name?: string
  output?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  prepare?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  requires?: AgentCapabilityRequirement[]
  resolve?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  tools?: AgentCapabilityToolResolver<TRuntimeConfig, Name>
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
  extends ResolvedAgentRuntimeContext<TRuntimeConfig> {
  model: AgentModelInput
  run?: AgentRunMetadata
}

export type AgentModelInstrumentation<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  (context: AgentModelInstrumentationContext<TRuntimeConfig>) => MaybePromise<AgentModelInput>

type AgentSettingsBase<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = {
  chat?: AgentChatOptions<TRuntimeConfig>
  description?: string
  hooks?: AgentChatAgentHooks<TRuntimeConfig> & AgentCapabilityHooks<TRuntimeConfig>
  instructions?: AgentAdapterInstructions<TRuntimeConfig>
  instrumentModel?: AgentModelInstrumentation<TRuntimeConfig>
  capabilities?: AgentCapabilitiesList<TRuntimeConfig>
  model?: AgentModelResolver<TRuntimeConfig>
  provider?: AgentModelProvider
  runtime?: AgentRuntimeBinding
  tools?: never
  workspace?: WorkspaceAgentWorkspaceConfig
  [key: string]: unknown
}

export type AgentSettings<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = AgentSettingsBase<TRuntimeConfig, CALL_OPTIONS> & (
  | {
    run: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS>
  }
  | {
    model: NonNullable<AgentSettingsBase<TRuntimeConfig, CALL_OPTIONS>["model"]>
    provider: NonNullable<AgentSettingsBase<TRuntimeConfig, CALL_OPTIONS>["provider"]>
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
  hooks?: AgentChatAgentHooks<TRuntimeConfig> & AgentCapabilityHooks<TRuntimeConfig>
  runtime?: AgentRuntimeBinding
  resolve(context: AgentRuntimeContext<TRuntimeConfig>): Promise<AgentAdapter<CALL_OPTIONS>>
  run?(context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS>): MaybePromise<Response | AgentRunResult | AsyncIterable<StreamEvent> | unknown>
  workspace?: WorkspaceAgentWorkspaceConfig
}

export type AgentInput<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  AgentDefinition<TContext extends AgentRuntimeContext<infer TRuntimeConfig> ? TRuntimeConfig : AgentRuntimeConfig>

export type AgentRegistryModule<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  | { default?: AgentInput<TContext> }
  | AgentInput<TContext>

export type AgentRegistry<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  Record<string, () => MaybePromise<AgentRegistryModule<TContext>>>

export type AgentModelProvider = "ai-sdk" | "tanstack-ai" | (string & {})

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
  tools?: AgentDevtoolsToolDefinition[]
}

export interface AgentAdapterResult {
  finishReason?: unknown
  raw?: unknown
  text?: string
  usage?: unknown
  warnings?: unknown
}

export interface AgentAdapterMetadataContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends ResolvedAgentRuntimeContext<TRuntimeConfig> {
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
  devtools?: AgentRuntimeContext<TRuntimeConfig>["devtools"]
  hasCapabilityCleanup?: boolean
  input: AgentRunInput<TOptions>
  instructions?: string
  messages: Message[]
  outputRenderers?: Array<(result: unknown) => MaybePromise<unknown>>
  prompt?: string
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
