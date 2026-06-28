import type { Message, StreamEvent } from "./messages.ts"
import type { Adapter, AdapterPostableMessage, IdentityResolver, StateAdapter, TranscriptsConfig } from "chat"
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
  WorkspaceRules,
  WorkspaceSourceInput,
} from "@vite-hub/workspace"

export type {
  MaybePromise,
  MaybeResolvable,
  Resolvable,
}

export type AgentRuntimeName = "cloudflare-agents" | "deno" | "unknown" | "vercel" | "vite"
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

export type AgentInvokerMeta = Record<string, unknown>

export interface AgentInvoker<TMeta extends AgentInvokerMeta = AgentInvokerMeta> {
  id: string
  kind?: "anonymous" | "chat" | "devtools" | (string & {})
  label?: string
  meta?: TMeta
}

export type AgentActor<TMeta extends AgentInvokerMeta = AgentInvokerMeta> = AgentInvoker<TMeta>
export type AgentInvokerProfile<TMeta extends AgentInvokerMeta = AgentInvokerMeta> = AgentInvoker<TMeta>

export interface AgentAccessWorkspaceScopeContext<TScopeName extends string = string> {
  all: boolean
  paths: string[]
  role: "viewer" | "admin" | (string & {})
  scope: TScopeName
}

export interface AgentAccessInvocationContextValue<TScopeName extends string = string> {
  workspaceScope?: AgentAccessWorkspaceScopeContext<TScopeName>
}

declare global {
  interface ViteHubAgentInvocationContextValues {}
}

export interface AgentInvocationContextValues extends ViteHubAgentInvocationContextValues {
  access: AgentAccessInvocationContextValue
  actor: AgentActor
  "channel.delivery.effects": AgentChannelDeliveryEffectIntent[]
  "channel.delivery.finishEffects": AgentChannelDeliveryFinishEffect[]
  invoker: AgentInvoker
}

export type AgentRunInputContextValues = Partial<AgentInvocationContextValues> & Record<string, unknown>

export interface AgentInvocationContextStore<TValues extends object = AgentInvocationContextValues> {
  entries: () => IterableIterator<[string, unknown]>
  get: {
    <TKey extends keyof TValues & string>(id: TKey): TValues[TKey] | undefined
    <T = unknown>(id: string): T | undefined
  }
  has: (id: string) => boolean
  set: {
    <TKey extends keyof TValues & string>(id: TKey, value: TValues[TKey], options?: { overwrite?: boolean }): void
    (id: string, value: unknown, options?: { overwrite?: boolean }): void
  }
  toJSON: () => Record<string, unknown>
}

export interface AgentInvokerResolveContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
> extends AgentCallbackContext<TRuntimeConfig> {
  context: AgentInvocationContextStore<TContextValues>
  defaultInvoker: AgentInvoker
  input: AgentRunInput<CALL_OPTIONS>
  profiles: readonly TProfile[]
  run?: AgentRunMetadata
  selectedProfile?: TProfile
}

export interface AgentInvokerOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
> {
  profiles?: readonly TProfile[]
  resolve?: (context: AgentInvokerResolveContext<TRuntimeConfig, CALL_OPTIONS, TProfile, TContextValues>) => MaybePromise<AgentInvoker | null | undefined>
}

export interface AgentRunInput<
  CALL_OPTIONS = unknown,
  TContext extends object = AgentRunInputContextValues,
> {
  abortSignal?: AbortSignal
  context?: TContext
  message?: string | Message
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

export type AgentChannelDeliveryEffectKind = "reaction" | "reply" | "status" | (string & {})

export type AgentDeliveryArtifactPlacement = "inline" | "attachment" | "link"

export interface AgentDeliveryArtifact {
  alt?: string
  mediaType?: string
  path: string
  placement?: AgentDeliveryArtifactPlacement
}

export interface PublishedAgentDeliveryArtifact extends AgentDeliveryArtifact {
  channelAttachmentId?: string
  url?: string
}

export interface AgentChannelDeliveryEffectIntent<
  TKind extends AgentChannelDeliveryEffectKind = AgentChannelDeliveryEffectKind,
> {
  artifacts?: readonly PublishedAgentDeliveryArtifact[]
  intent?: string
  kind: TKind
  metadata?: Record<string, unknown>
  payload?: unknown
}

export interface AgentChannelDeliveryEffectContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> extends AgentCallbackContext<TRuntimeConfig> {
  channel: AgentChannelDefinition<TRuntimeConfig>
  effect: AgentChannelDeliveryEffectIntent
  finish?: AgentFinishEvent<TRuntimeConfig>
  input: AgentRunInput
  run?: AgentRunMetadata
  trigger?: {
    channelId: string
    id?: string
    name?: string
  }
  workspace?: ReadonlyWorkspaceFacade | WritableWorkspaceFacade
}

export interface AgentChannelDeliveryFinishEffectContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> extends AgentCallbackContext<TRuntimeConfig> {
  input: AgentRunInput
  run?: AgentRunMetadata
  workspace?: ReadonlyWorkspaceFacade | WritableWorkspaceFacade
}

export type AgentChannelDeliveryEffectHandler<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> = (context: AgentChannelDeliveryEffectContext<TRuntimeConfig>) => MaybePromise<void>

export type AgentChannelDeliveryEffects<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> = Partial<Record<AgentChannelDeliveryEffectKind, AgentChannelDeliveryEffectHandler<TRuntimeConfig> | readonly AgentChannelDeliveryEffectHandler<TRuntimeConfig>[]>>
export type AgentChannelDeliveryFinishEffect =
  | AgentChannelDeliveryEffectIntent
  | readonly AgentChannelDeliveryEffectIntent[]
  | ((event: AgentFinishEvent, context: AgentChannelDeliveryFinishEffectContext) => MaybePromise<AgentChannelDeliveryEffectIntent | readonly AgentChannelDeliveryEffectIntent[] | false | null | undefined>)

export interface AgentTriggerRunInvokeResult<CALL_OPTIONS = unknown> {
  delivery?: {
    effects?: AgentChannelDeliveryEffectIntent | readonly AgentChannelDeliveryEffectIntent[]
    finishEffects?: AgentChannelDeliveryFinishEffect | readonly AgentChannelDeliveryFinishEffect[]
  }
  input: AgentRunInput<CALL_OPTIONS>
  metadata?: Record<string, unknown>
  run?: AgentRunMetadata
}

export type AgentTriggerInvokeResult<CALL_OPTIONS = unknown> =
  | AgentTriggerRunInvokeResult<CALL_OPTIONS>
  | Response

export type AgentWebhookSecretToken<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<string | false, AgentCallbackContext<TRuntimeConfig>>

export interface AgentWebhookRegistrationDefinition<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  adapter?: string
  channelId?: string
  id?: string
  method?: "POST" | (string & {})
  path?: string
  provider: string
  signature?: "github-sha256" | (string & {})
  secretHeader?: string
  secretToken?: AgentWebhookSecretToken<TRuntimeConfig>
  url?: string
}

export type AgentChannelWebhookRegistrationDefinition<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  Omit<AgentWebhookRegistrationDefinition<TRuntimeConfig>, "provider"> & { provider?: string }

export interface AgentTriggerContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends AgentCallbackContext<TRuntimeConfig> {
  actor?: AgentActor
  capability: AgentCapabilityDefinition<TRuntimeConfig, Name>
  trigger: {
    capabilityId: string
    id: `${string}.${string}`
    name: string
    source: "capability"
  }
}

export interface AgentChannelTriggerContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> extends AgentCallbackContext<TRuntimeConfig> {
  actor?: AgentActor
  channel: AgentChannelDefinition<TRuntimeConfig>
  trigger: {
    channelId: string
    id: `${string}.${string}`
    name: string
    source: "channel"
  }
}

export interface AgentTriggerDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TInput = unknown,
  CALL_OPTIONS = unknown,
  TContext extends AgentCallbackContext<TRuntimeConfig> = AgentTriggerContext<TRuntimeConfig, Name>,
> {
  devtools?: boolean | Record<string, unknown>
  input?: unknown
  invoke: (context: TContext, input: TInput) => MaybePromise<AgentTriggerInvokeResult<CALL_OPTIONS>>
  output?: "events" | "ui-message-stream" | (string & {})
  webhooks?: AgentWebhookRegistrationDefinition<TRuntimeConfig>[]
}

export interface ResolvedAgentTriggerDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TInput = unknown,
  CALL_OPTIONS = unknown,
> {
  capabilityId?: string
  channelId?: string
  definition: AgentTriggerDefinition<TRuntimeConfig, WorkspaceName, TInput, CALL_OPTIONS>
  devtools?: boolean | Record<string, unknown>
  id: `${string}.${string}`
  input?: unknown
  invoke: (input: TInput) => MaybePromise<AgentTriggerInvokeResult<CALL_OPTIONS>>
  name: string
  output?: "events" | "ui-message-stream" | (string & {})
  source: "capability" | "channel"
  webhooks?: AgentWebhookRegistrationDefinition<TRuntimeConfig>[]
}

export interface AgentRunCallbackContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> extends AgentCallbackContext<TRuntimeConfig> {
  actor: AgentActor
  context: AgentInvocationContextStore<TContextValues>
  input: AgentRunInput<CALL_OPTIONS>
  invoker: AgentInvoker
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
  entries: () => Array<[string, unknown]>
  get<T = unknown>(capabilityId: string): T | undefined
  get<T = unknown>(capabilityId: string, key: string): T | undefined
  toJSON: () => Record<string, unknown>
}

export interface AgentOutputExtensionEvent {
  extensions: AgentInvocationExtensions
  result: unknown
}

export interface AgentFinishEvent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  actor: AgentActor
  error?: unknown
  errorMessage?: string
  extensions: AgentInvocationExtensions
  input: AgentRunInput<CALL_OPTIONS>
  invoker: AgentInvoker
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

export type AgentInputHook<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> = (context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TContextValues>) => MaybePromise<void>

export interface AgentInvocationHooks<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> {
  "agent:finish"?: AgentFinishHook<TRuntimeConfig, CALL_OPTIONS>
  "agent:input"?: AgentInputHook<TRuntimeConfig, CALL_OPTIONS, TContextValues>
}

export type AgentHookOwner = "agent" | "capability" | "channel" | "runtime" | "integration" | (string & {})
export type AgentHookOutcome = "error" | "success"

export interface AgentHookObserverEvent {
  durationMs: number
  error?: {
    message: string
    name?: string
  }
  ids?: Record<string, string | undefined>
  metadata?: Record<string, unknown>
  name: string
  outcome: AgentHookOutcome
  owner: AgentHookOwner
  phase?: string
}

export type AgentHookObserver = (event: Readonly<AgentHookObserverEvent>) => MaybePromise<void>

export interface AgentHookObserverHooks {
  "hook:observe"?: AgentHookObserver | readonly AgentHookObserver[]
}

export interface AgentRunContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  Name extends WorkspaceName = WorkspaceName,
  TContextValues extends object = AgentInvocationContextValues,
> extends AgentCallbackContext<TRuntimeConfig> {
  adapter?: AgentAdapter<CALL_OPTIONS>
  actor: AgentActor
  context: AgentInvocationContextStore<TContextValues>
  input: AgentRunInput<CALL_OPTIONS>
  invoker: AgentInvoker
  messages: Message[]
  prompt?: string
  providerTools?: AgentProviderToolContribution[]
  tools?: AgentToolSet
  workspace?: ReadonlyWorkspaceFacade<Name> | WritableWorkspaceFacade<Name>
}

export type AgentRunHandler<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> = (context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS, WorkspaceName, TContextValues>) => MaybePromise<Response | AgentRunResult | AsyncIterable<StreamEvent> | unknown>

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
export type AgentDriverKind = "harness" | "model" | "run"

export interface AgentCapabilityCliStandardSchemaResultSuccess<T = unknown> {
  issues?: undefined
  value: T
}

export interface AgentCapabilityCliStandardSchemaResultFailure {
  issues: readonly unknown[]
}

export interface AgentCapabilityCliStandardSchemaV1<T = unknown> {
  "~standard": {
    validate: (input: unknown) => AgentCapabilityCliStandardSchemaResultSuccess<T> | AgentCapabilityCliStandardSchemaResultFailure | Promise<AgentCapabilityCliStandardSchemaResultSuccess<T> | AgentCapabilityCliStandardSchemaResultFailure>
  }
}

export type AgentCapabilityCliOutputFormat = "json" | "text"

export interface AgentCapabilityCliOutputDefinition<TOutput = unknown> {
  format?: AgentCapabilityCliOutputFormat
  schema?: AgentCapabilityCliStandardSchemaV1<TOutput>
}

export interface AgentCapabilityCliRunContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TInput = unknown,
> {
  argv: readonly string[]
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>
  input: TInput
  json: boolean
}

export interface AgentCapabilityCliCommand<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TInput = unknown,
  TOutput = unknown,
> {
  commands?: Record<string, AgentCapabilityCliCommand<TRuntimeConfig, Name>>
  description?: string
  effects?: readonly string[]
  examples?: readonly string[]
  input?: AgentCapabilityCliStandardSchemaV1<TInput>
  output?: AgentCapabilityCliStandardSchemaV1<TOutput> | AgentCapabilityCliOutputDefinition<TOutput>
  run?: {
    bivarianceHack(context: AgentCapabilityCliRunContext<TRuntimeConfig, Name, TInput>): MaybePromise<TOutput>
  }["bivarianceHack"]
}

export interface AgentCapabilityCliContribution<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  commands: Record<string, AgentCapabilityCliCommand<TRuntimeConfig, Name>>
  description?: string
  name: string
}

export interface AgentCapabilityCliExecutionInput {
  argv?: readonly string[]
  input?: unknown
  json?: boolean
}

export interface AgentCapabilityCliExecutionResult<TOutput = unknown> {
  argv: string[]
  capability: string
  cli: string
  command: string
  durationMs: number
  exitCode: number
  json?: TOutput
  outputTruncated: false
  stderr: string
  stdout: string
}

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
  harnessWorkspacePaths?: readonly string[]
  mode?: AgentCapabilityMode
  runtimeContext?: ResolvedAgentRuntimeContext
  workspaceDefinition?: WorkspaceDefinition
}

export type AgentCapabilityToolResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | Record<string, unknown>
  | ((context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<Record<string, unknown> | undefined>)

export interface AgentCapabilityWorkspaceContribution {
  rules?: WorkspaceRules
  sources?: Record<string, WorkspaceSourceInput>
}

export type AgentCapabilityWorkspaceContributionResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | AgentCapabilityWorkspaceContribution
  | ((context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<AgentCapabilityWorkspaceContribution | false | null | undefined>)

export type AgentCapabilityPhase = "configure" | "prepare" | "bind" | "input" | "resolve" | "output" | "close"
export type AgentCapabilityHookName = `capability:${AgentCapabilityPhase}` | `capability:${AgentCapabilityPhase}:after`

export interface AgentInstructionBlock {
  id: string
  instructions: string
}

export type AgentDriverContributionKind = "Capability instructions" | "Capability tools" | "provider tools"

export interface AgentDriverContribution {
  capabilityId: string
  kind: AgentDriverContributionKind
  names?: string[]
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
export type AgentOutputExtensionProvider = (event: AgentOutputExtensionEvent) => MaybePromise<unknown>
export type AgentFinishExtensionProvider<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = {
  bivarianceHack(event: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>): MaybePromise<unknown>
}["bivarianceHack"]

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
  delivery: {
    effect: (intent: AgentChannelDeliveryEffectIntent) => void
    finishEffect: (effect: AgentChannelDeliveryFinishEffect) => void
  }
  model: {
    resolve: (model?: AgentModelResolver<TRuntimeConfig, Name>) => Promise<AgentModelInput>
  }
  modelExecution: {
    instrument: (instrumentation: AgentModelExecutionInstrumentation<TRuntimeConfig>) => void
  }
  output: {
    extensions: AgentInvocationExtensions
    final: (renderer: AgentOutputRenderer) => void
    provide: (value: unknown | AgentOutputExtensionProvider) => void
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
  invocationContext?: object
  workspaceScopes?: string
  workspaceSources?: string
}

export interface AgentCapabilityDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TTypeContract extends AgentCapabilityTypeContract = AgentCapabilityTypeContract,
> {
  readonly __vitehubTypeContract?: TTypeContract
  bind?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  capabilities?: readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[]
  cli?: AgentCapabilityCliContribution<TRuntimeConfig, Name>
  close?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  configure?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  finish?: AgentFinishExtensionProvider<TRuntimeConfig>
  hooks?: AgentCapabilityHooks<TRuntimeConfig, Name>
  id: string
  input?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<Response | void>
  instructions?:
    | AgentAdapterInstructions<TRuntimeConfig, Name>
    | false
    | ((context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<AgentAdapterInstructionsValue | false | undefined>)
  harnessWorkspacePaths?: readonly string[]
  metadata?: Record<string, unknown>
  mode?: AgentCapabilityMode
  output?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  prepare?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  requires?: AgentCapabilityRequirement[]
  resolve?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  tools?: AgentCapabilityToolResolver<TRuntimeConfig, Name>
  triggers?: Record<string, AgentTriggerDefinition<TRuntimeConfig, Name, any, any>>
  workspaceSources?: WorkspaceDefinition["sources"]
  workspace?: AgentCapabilityWorkspaceContributionResolver<TRuntimeConfig, Name>
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
  actor: AgentActor
  context: AgentInvocationContextStore
  invoker: AgentInvoker
  model: AgentModelInput
  run?: AgentRunMetadata
}

export type AgentModelInstrumentation<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  (context: AgentModelInstrumentationContext<TRuntimeConfig>) => MaybePromise<AgentModelInput>

export interface AgentCallSettingsInstrumentationContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> extends AgentCallbackContext<TRuntimeConfig> {
  actor: AgentActor
  callSettings: Readonly<Record<string, unknown>>
  context: AgentInvocationContextStore
  input: AgentRunInput<CALL_OPTIONS>
  invoker: AgentInvoker
  model: AgentModelInput
  run?: AgentRunMetadata
  tools?: AgentToolSet
}

export type AgentCallSettingsInstrumentation<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> =
  (context: AgentCallSettingsInstrumentationContext<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<Record<string, unknown> | void>

export interface AgentModelExecutionInstrumentation<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  callSettings?: AgentCallSettingsInstrumentation<TRuntimeConfig, CALL_OPTIONS>
  model?: AgentModelInstrumentation<TRuntimeConfig>
}

export interface AgentModelExecutionOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  callSettings?: Record<string, unknown>
  instrumentation?: AgentModelExecutionInstrumentation<TRuntimeConfig, CALL_OPTIONS>
  stepLimit?: number
  workspaceFallback?: boolean | {
    enabled?: boolean
    maxToolResults?: number
  }
}

export interface AgentHarnessCredentialSource {
  label?: string
  source?: "ambient" | "explicit" | "none" | "unknown" | (string & {})
}

export type AgentHarnessSessionKey<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> =
  | string
  | ((context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TContextValues>) => MaybePromise<string | undefined>)

export type AgentHarnessDriverInput<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> =
  | object
  | ((context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<object>)

export type AgentHarnessSandboxInput<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> =
  | object
  | ((context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TContextValues>) => MaybePromise<object | undefined>)

export interface AgentModelDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  credentials?: never
  execution?: AgentModelExecutionOptions<TRuntimeConfig, CALL_OPTIONS>
  harness?: never
  instructions?: AgentAdapterInstructions<TRuntimeConfig>
  model: AgentModelResolver<TRuntimeConfig>
  permissionMode?: never
  permissions?: never
  run?: never
  sandbox?: never
  sessionKey?: never
}

export interface AgentHarnessDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> {
  credentials?: AgentHarnessCredentialSource
  execution?: never
  harness: AgentHarnessDriverInput<TRuntimeConfig, CALL_OPTIONS>
  instructions?: never
  model?: never
  permissionMode?: never
  permissions?: never
  run?: never
  sandbox?: AgentHarnessSandboxInput<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  sessionKey?: AgentHarnessSessionKey<TRuntimeConfig, CALL_OPTIONS, TContextValues>
}

export interface AgentRunDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> {
  credentials?: never
  execution?: never
  harness?: never
  instructions?: AgentAdapterInstructions<TRuntimeConfig>
  model?: never
  permissionMode?: never
  permissions?: never
  run: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  sandbox?: never
  sessionKey?: never
}

export type AgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> =
  | AgentModelDriver<TRuntimeConfig, CALL_OPTIONS>
  | AgentHarnessDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  | AgentRunDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues>

type AgentSharedSettings<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
  TCapabilities extends readonly AgentCapabilityDefinition<TRuntimeConfig>[] | undefined = AgentCapabilitiesList<TRuntimeConfig> | undefined,
> = {
  capabilities?: TCapabilities
  channels?: AgentChannels<TRuntimeConfig>
  description?: string
  hooks?: AgentCapabilityHooks<TRuntimeConfig> & AgentHookObserverHooks & AgentInvocationHooks<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  invoker?: AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues>
  messages?: AgentMessageChannelSettings<TRuntimeConfig>
  runtime?: AgentRuntimeBinding
  version?: string
  workspace?: WorkspaceAgentWorkspaceConfig
}

export type AgentSettings<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
  TCapabilities extends readonly AgentCapabilityDefinition<TRuntimeConfig>[] | undefined = AgentCapabilitiesList<TRuntimeConfig> | undefined,
> = AgentSharedSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues, TCapabilities> & {
  driver: AgentDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues>
}

export interface AgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
> {
  capabilities?: AgentCapabilityDefinition<TRuntimeConfig>[]
  channels?: AgentChannels<TRuntimeConfig>
  chat?: AgentChatOptions<TRuntimeConfig>
  description?: string
  hooks?: AgentCapabilityHooks<TRuntimeConfig, WorkspaceName> & AgentHookObserverHooks & AgentInvocationHooks<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  invoker?: AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues>
  messages?: AgentMessageChannelSettings<TRuntimeConfig>
  runtime?: AgentRuntimeBinding
  resolve(context: AgentRuntimeContext<TRuntimeConfig>): Promise<AgentAdapter<CALL_OPTIONS>>
  run?(context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS, WorkspaceName, TContextValues>): MaybePromise<Response | AgentRunResult | AsyncIterable<StreamEvent> | unknown>
  version?: string
  workspace?: WorkspaceAgentWorkspaceConfig
}

export type AgentInput<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  AgentDefinition<TContext extends AgentRuntimeContext<infer TRuntimeConfig> ? TRuntimeConfig : AgentRuntimeConfig, any, any, any>

export type AgentRegistryModule<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  | { default?: AgentInput<TContext> }
  | AgentInput<TContext>

export type AgentRegistry<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  Record<string, () => MaybePromise<AgentRegistryModule<TContext>>>

export interface AgentStateProviderOptions {
  authToken?: string
  provider?: "auto" | "cloudflare" | "cloudflare-agents" | "libsql" | "memory" | "sqlite" | (string & {})
  tablePrefix?: string
  url?: string
}

export type ResolvedAgentStateProviderOptions =
  Omit<AgentStateProviderOptions, "provider"> & { provider: NonNullable<AgentStateProviderOptions["provider"]> }

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

export type AgentRouteOption = boolean | string

export interface AgentRoutesOptions {
  chat?: AgentRouteOption
  webhooks?: AgentRouteOption
}

export interface ResolvedAgentRoutesOptions {
  chat: false | string
  webhooks: false | string
}

export interface AgentModuleOptions {
  cli?: false | AgentCliOptions
  devtools?: false
  execution?: AgentExecution
  eval?: false | AgentEvalOptions
  imports?: boolean
  integrations?: AgentIntegrationsOptions
  providers?: AgentProvidersOptions
  routes?: AgentRoutesOptions
  runtime?: AgentRuntime
}

export interface ResolvedAgentModuleOptions {
  execution: AgentExecution
  imports: boolean
  integrations: Required<AgentIntegrationsOptions>
  providers: {
    sandbox: Required<AgentSandboxProviderOptions>
    scheduler: Required<AgentSchedulerProviderOptions>
    state: ResolvedAgentStateProviderOptions
  }
  routes: ResolvedAgentRoutesOptions
  runtime: AgentRuntime
}

export interface AgentHandlerOptions<TRuntimeContext extends AgentRuntimeContext = AgentRuntimeContext> {
  inferredName?: string
  lifecycleHooks?: AgentRuntimeHooks<TRuntimeContext>
  workspace?: WorkspaceName
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
  source?: "server-agent" | "server-agent-workspace" | "server-agents" | "vite-suffix"
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

export interface AgentChatErrorHookArgs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends AgentChatAgentHookArgs<TRuntimeConfig> {
  error: unknown
}

export interface AgentChatEventHookArgs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends Record<string, unknown> {
}

export interface AgentChatEventHooks<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends Record<string, unknown> {
  onDirectMessage?: (args: { message: { text: string } } & AgentChatEventHookArgs<TRuntimeConfig>) => MaybePromise<void>
}

export type AgentChatPlatformResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<Adapter, AgentCallbackContext<TRuntimeConfig>>

export type AgentChatPlatformsResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<Record<string, AgentChatPlatformResolver<TRuntimeConfig>>, AgentCallbackContext<TRuntimeConfig>>

export interface AgentChatStateContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentCallbackContext<TRuntimeConfig> {
  chat: {
    agentName: string
    stateKeyPrefix: string
  }
}

export type AgentChatStateResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<StateAdapter, AgentChatStateContext<TRuntimeConfig>>

export type AgentChatMessage = AdapterPostableMessage | { text: string }

export type AgentChatSendMessage = (message: AgentChatMessage) => Promise<void>

export type AgentMessageConcurrency = "drop" | "parallel" | "queue" | "reject" | (string & {})

export type AgentMessageLockScope = "agent" | "channel" | "thread" | (string & {})

export interface AgentChatFinishExtension {
  provider?: string
  run?: Partial<AgentRunMetadata>
  sendMessage: AgentChatSendMessage
}

export interface AgentMessageChannelSettings<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  concurrency?: AgentMessageConcurrency
  dedupeTtlMs?: number
  errorFallbackText?: string | null | ((context: AgentChatErrorHookArgs<TRuntimeConfig>) => MaybePromise<string | null | undefined>)
  fallbackStreamingPlaceholderText?: string | readonly string[] | null | ((context: AgentChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<string | null | undefined>)
  history?: AgentChatAgentBindingOptions["history"]
  identity?: IdentityResolver
  lockScope?: AgentMessageLockScope
  messageHistory?: unknown
  sessions?: boolean | AgentChatSessionOptions
  state?: AgentChatStateResolver<TRuntimeConfig>
  stream?: boolean
  streamingUpdateIntervalMs?: number
  threadHistory?: unknown
  transcripts?: TranscriptsConfig
  userName?: string
  [key: string]: unknown
}

export interface AgentChannelDefinition<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  adapter?: AgentChatPlatformResolver<TRuntimeConfig>
  effects?: AgentChannelDeliveryEffects<TRuntimeConfig>
  identity?: IdentityResolver
  kind: string
  messages?: false | AgentMessageChannelSettings<TRuntimeConfig>
  route?: unknown
  triggers?: Record<string, AgentTriggerDefinition<TRuntimeConfig, WorkspaceName, any, any, AgentChannelTriggerContext<TRuntimeConfig>>>
  webhooks?: boolean | AgentChannelWebhookRegistrationDefinition<TRuntimeConfig> | AgentChannelWebhookRegistrationDefinition<TRuntimeConfig>[]
}

export type AgentChannels<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  Record<string, AgentChannelDefinition<TRuntimeConfig>>

export interface AgentChatOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentMessageChannelSettings<TRuntimeConfig> {
  adapters?: never
  agent?: never
  event?: AgentChatAgentBindingOptions["event"]
  execution?: never
  hooks?: AgentChatEventHooks<TRuntimeConfig>
  identity?: IdentityResolver
  lifecycleHooks?: Record<string, unknown>
  platforms?: AgentChatPlatformsResolver<TRuntimeConfig>
  webhooks?: Record<string, false | AgentChannelWebhookRegistrationDefinition<TRuntimeConfig> | AgentChannelWebhookRegistrationDefinition<TRuntimeConfig>[]>
  workflow?: never
  [key: string]: unknown
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
  name?: never
}

export type WorkspaceAgentWorkspaceReference<Name extends WorkspaceName = WorkspaceName> = {
  mode?: AgentCapabilityMode
  name: Name
} & {
  [Key in keyof Omit<WorkspaceAgentWorkspaceOptions, "mode" | "name">]?: never
}

export type WorkspaceAgentWorkspaceConfig<Name extends WorkspaceName = WorkspaceName> =
  | Name
  | WorkspaceAgentWorkspaceReference<Name>
  | WorkspaceAgentWorkspaceOptions

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

export type AgentDevtoolsConfigValue = boolean | null | number | string

export interface AgentDevtoolsModelMetadata {
  dynamic?: boolean
  id?: string
  provider?: string
}

export interface AgentDevtoolsModelExecutionMetadata {
  callSettings?: Record<string, AgentDevtoolsConfigValue>
  stepLimit?: number
  workspaceFallback?: {
    enabled?: boolean
    maxToolResults?: number
  }
}

export interface AgentDevtoolsHarnessMetadata {
  credentials?: AgentHarnessCredentialSource
  provider?: string
  sandbox?: boolean
  sessionKey?: boolean
}

export interface AgentDevtoolsDriverMetadata {
  execution?: AgentDevtoolsModelExecutionMetadata
  harness?: AgentDevtoolsHarnessMetadata
  kind: "harness" | "model" | "run"
  model?: AgentDevtoolsModelMetadata
}

export interface AgentDevtoolsConfigMetadata {
  driver: AgentDevtoolsDriverMetadata
}

export interface AgentDevtoolsMetadata {
  config?: AgentDevtoolsConfigMetadata
  files?: AgentDevtoolsFileTreeItem[]
  instructions?: string[]
  invokerProfiles?: AgentInvokerProfile[]
  name?: string
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
  details?: Record<string, unknown>
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

export interface AgentUsageCredentialSource {
  label?: string
  source?: AgentHarnessCredentialSource["source"]
}

export interface AgentUsageRecord {
  cost?: AgentUsageCost
  credentialSource?: AgentUsageCredentialSource
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
  summary?: string
  usage?: AgentUsage
}

export interface AgentAdapterMetadataContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends AgentCallbackContext<TRuntimeConfig> {
  actor: AgentActor
  context: AgentInvocationContextStore
  driver?: {
    kind: AgentDriverKind
  }
  fs: ReadonlyWorkspaceFacade<Name>["fs"]
  invoker: AgentInvoker
  workspace: ReadonlyWorkspaceFacade<Name>
}

export interface AgentAdapterRunContext<
  TOptions = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  actor: AgentActor
  capabilityInstructions?: AgentInstructionBlock[]
  close?: () => Promise<void>
  context: AgentInvocationContextStore
  devtools?: AgentRuntimeContext<TRuntimeConfig>["devtools"]
  driverContributions?: AgentDriverContribution[]
  hasCapabilityCleanup?: boolean
  harnessWorkspacePaths?: readonly string[]
  input: AgentRunInput<TOptions>
  instructions?: string
  invoker: AgentInvoker
  messages: Message[]
  modelExecutionInstrumentation?: AgentModelExecutionInstrumentation[]
  outputRenderers?: Array<(result: unknown) => MaybePromise<unknown>>
  prompt?: string
  providerTools?: AgentProviderToolContribution[]
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>
  sourceInstructions?: string
  tools?: AgentToolSet
  workspace?: ReadonlyWorkspaceFacade<Name>
  workspaceDefinition?: WorkspaceDefinition
  workspaceInstructionBindings?: Record<string, unknown>
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
