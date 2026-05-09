import type {
  Agent,
  AgentCallParameters,
  AgentStreamParameters,
  GenerateTextResult,
  LanguageModel,
  ModelMessage,
  StreamTextResult,
  ToolLoopAgentSettings,
  ToolSet,
} from "ai"

export type { Agent } from "ai"

export type MaybePromise<T> = T | Promise<T>
export type AgentRuntimeName = "cloudflare-agents" | "nitro" | "unknown" | "vercel"
export type AgentRuntime = "auto" | AgentRuntimeName
export type AgentExecution = "inline" | "sandbox" | "workflow"
export type AgentWaitUntil = (task: Promise<unknown>) => void
export type AgentIntegrationOption = "auto" | boolean

export interface AgentRuntimeConfig {}

export interface AgentRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  cloudflare?: {
    context?: unknown
    env?: Record<string, unknown>
  }
  event?: unknown
  memo<T>(key: string, create: () => T): T
  request?: Request
  runtime: AgentRuntimeName
  runtimeConfig?: TRuntimeConfig
  sandbox?: unknown
  vercel?: {
    waitUntil?: AgentWaitUntil
  }
  waitUntil: AgentWaitUntil
  workflow?: unknown
}

export type ResolvedAgentRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  AgentRuntimeContext<TRuntimeConfig> & { runtimeConfig: TRuntimeConfig }

export interface Resolvable<T, TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> {
  resolve(context: TContext): MaybePromise<T>
}

export type MaybeResolvable<T, TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  | T
  | Resolvable<T, TContext>
  | ((context: TContext) => MaybePromise<T>)

export interface AgentRunInput<CALL_OPTIONS = never, TOOLS extends ToolSet = ToolSet> {
  abortSignal?: AbortSignal
  context?: Record<string, unknown>
  messages?: ModelMessage[]
  options?: CALL_OPTIONS
  prompt?: string | ModelMessage[]
  timeout?: AgentCallParameters<CALL_OPTIONS, TOOLS>["timeout"]
}

export type AgentRunParameters<CALL_OPTIONS = never, TOOLS extends ToolSet = ToolSet> =
  AgentCallParameters<CALL_OPTIONS, TOOLS>

export type AgentStreamParametersInput<CALL_OPTIONS = never, TOOLS extends ToolSet = ToolSet> =
  AgentStreamParameters<CALL_OPTIONS, TOOLS>

export interface AgentRunContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
> extends ResolvedAgentRuntimeContext<TRuntimeConfig> {
  createAgent: () => Promise<Agent<CALL_OPTIONS, TOOLS>>
  generateText: (options: AgentRunParameters<CALL_OPTIONS, TOOLS>) => PromiseLike<GenerateTextResult<TOOLS, never>>
  input: AgentRunInput<CALL_OPTIONS, TOOLS>
  streamText: (options: AgentStreamParametersInput<CALL_OPTIONS, TOOLS>) => PromiseLike<StreamTextResult<TOOLS, never>>
}

export type AgentRunHandler<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
> = (context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS, TOOLS>) => MaybePromise<Response | GenerateTextResult<TOOLS, never> | StreamTextResult<TOOLS, never> | unknown>

export type AgentToolResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TOOLS extends ToolSet = ToolSet,
> = MaybeResolvable<TOOLS, ResolvedAgentRuntimeContext<TRuntimeConfig>>

export type AgentModelInput = LanguageModel | (string & {})

export type AgentSettings<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
> = Omit<ToolLoopAgentSettings<CALL_OPTIONS, TOOLS>, "model" | "tools"> & {
  description?: string
  model: AgentModelInput
  run?: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS, TOOLS>
  tools?: AgentToolResolver<TRuntimeConfig, TOOLS>
}

export interface AgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
> {
  description?: string
  resolve(context: AgentRuntimeContext<TRuntimeConfig>): Promise<Agent<CALL_OPTIONS, TOOLS>>
  run?(context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS, TOOLS>): MaybePromise<Response | GenerateTextResult<TOOLS, never> | StreamTextResult<TOOLS, never> | unknown>
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
  source?: "nitro-server-agent" | "nitro-server-agents" | "vite-suffix"
}

export type AgentRequestBody<CALL_OPTIONS = never> = {
  messages?: ModelMessage[]
  options?: CALL_OPTIONS
  prompt?: string | ModelMessage[]
  stream?: boolean
}

export interface CloudflareExportedHandlerFetchHandler<TEnv = unknown> {
  (request: Request, env: TEnv, ctx: { waitUntil?: (promise: Promise<unknown>) => void }): Response | Promise<Response>
}
