import type { Message, StreamEvent } from "./messages.ts"
import type { AgentRunEventPublisher, AgentRunEvents } from "./run-events.ts"
import type { Box, BoxDefinition, BoxRequirement } from "@vite-hub/box"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import type { JSONSchema7 } from "json-schema"
import type { Adapter, AdapterPostableMessage, IdentityResolver, StateAdapter, TranscriptsConfig } from "chat"
import type {
  MaybePromise,
  MaybeResolvable,
  ExecutionAuthority,
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
import type { LocalHarnessSandboxOptions } from "./harness/local-sandbox.ts"

export type {
  MaybePromise,
  MaybeResolvable,
  Resolvable,
}

export type AgentRuntimeName = "cloudflare-agents" | "deno" | "unknown" | "vercel" | "vite"
export type AgentRuntime = "auto" | AgentRuntimeName
export type AgentExecution = "inline" | "sandbox" | "workflow"
export type AgentRuntimeBinding = false | AgentWorkflowRuntimeBinding

export interface AgentWorkflowRuntimeBinding {
  kind: "workflow"
  name?: string
}
export type AgentWaitUntil = RuntimeWaitUntil
export type AgentIntegrationOption = "auto" | boolean
export type AgentCapabilityHandle<TKind extends string = string, TValue = unknown> = RuntimeCapabilityHandle<TKind, TValue>
export type AgentCapabilities = RuntimeCapabilities

export interface AgentRuntimeConfig {}

export interface AgentHostIdentity {
  readonly name: string
  readonly workspace?: WorkspaceName
}

export interface AgentRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends Omit<RuntimeHostContext<TRuntimeConfig>, "cloudflare" | "platform" | "runtime"> {
  agentIdentity?: AgentHostIdentity
  cloudflare?: RuntimeHostContext<TRuntimeConfig>["cloudflare"]
  toolStepReporter?: (step: AgentToolStep) => MaybePromise<void>
  run?: AgentRunMetadata
  runtime: AgentRuntimeName
}

export type ResolvedAgentRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  AgentRuntimeContext<TRuntimeConfig> & { runtimeConfig: TRuntimeConfig }

export type AgentCallbackContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  Omit<ResolvedAgentRuntimeContext<TRuntimeConfig>, "runtimeConfig"> & {
    runEvents?: AgentRunEventPublisher
  }

export type AgentInvokerMeta = Record<string, unknown>

export interface AgentInvoker<TMeta extends AgentInvokerMeta = AgentInvokerMeta> {
  email?: {
    address: string
    domain: string
  }
  id: string
  kind?: "anonymous" | "chat" | (string & {})
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
  sources: string[]
}

export interface AgentAccessInvocationContextValue<TScopeName extends string = string> {
  workspaceScope?: AgentAccessWorkspaceScopeContext<TScopeName>
}

declare global {
  interface ViteHubAgentInvocationContextValues {}
  interface ViteHubAgentFinishExtensions {}
  interface ViteHubAgentOutputExtensions {}
}

export interface AgentInvocationContextValues extends ViteHubAgentInvocationContextValues {
  access: AgentAccessInvocationContextValue
  actor: AgentActor
  "agent.finishHook": boolean
  "channel.delivery.effects": AgentChannelDeliveryEffectIntent[]
  "channel.delivery.finishEffects": AgentChannelDeliveryFinishEffect[]
  "channel.delivery.supportsTitle": boolean
  invoker: AgentInvoker
}

type AgentInvocationCallbackContextKey = {
  [Key in keyof ViteHubAgentInvocationContextValues]: Key extends string
    ? Key extends "actor" | "chat" | "invoker" | `agent.${string}` | `channel.delivery.${string}` | `chat.${string}` | `workspace.${string}`
      ? never
      : Key
    : never
}[keyof ViteHubAgentInvocationContextValues]

interface AgentInvocationCallbackContextValues extends Partial<Pick<ViteHubAgentInvocationContextValues, AgentInvocationCallbackContextKey>> {
  access?: AgentAccessInvocationContextValue
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
  TPayload = AgentChannelDeliveryEffectPayload<TKind>,
> {
  artifacts?: readonly PublishedAgentDeliveryArtifact[]
  intent?: string
  kind: TKind
  metadata?: Record<string, unknown>
  payload?: TPayload
}

export interface AgentChannelDeliveryEffectIntentOptions {
  artifacts?: readonly PublishedAgentDeliveryArtifact[]
  intent?: string
  metadata?: Record<string, unknown>
}

export interface AgentChannelDeliveryReplyPayload {
  artifacts?: readonly PublishedAgentDeliveryArtifact[]
  body?: string
  markdown?: string
}

export type AgentChannelDeliveryReplyInput = string | AgentChannelDeliveryReplyPayload

export interface AgentChannelDeliveryReactionPayload {
  action?: "remove" | (string & {})
  content?: string
  emoji?: string
}

export type AgentChannelDeliveryReactionInput = string | AgentChannelDeliveryReactionPayload

export type AgentChannelDeliveryStatusState = "error" | "failure" | "pending" | "success" | (string & {})

export interface AgentChannelDeliveryStatusPayload {
  context?: string
  description?: string
  sha?: string
  state?: AgentChannelDeliveryStatusState
  target_url?: string
}

export type AgentChannelDeliveryStatusInput = AgentChannelDeliveryStatusState | AgentChannelDeliveryStatusPayload

export type AgentChannelDeliveryEffectPayload<TKind extends AgentChannelDeliveryEffectKind> =
  TKind extends "reaction" ? AgentChannelDeliveryReactionInput
    : TKind extends "reply" ? AgentChannelDeliveryReplyInput
      : TKind extends "status" ? AgentChannelDeliveryStatusInput
        : unknown

export interface AgentChannelDeliveryEffectContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> extends AgentCallbackContext<TRuntimeConfig> {
  channel: AgentChannelDefinition<TRuntimeConfig>
  context: AgentInvocationContextStore
  effect: AgentChannelDeliveryEffectIntent
  finish?: AgentFinishEvent<TRuntimeConfig>
  input: AgentRunInput
  request?: Request
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
  CALL_OPTIONS = unknown,
> extends AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS> {
  channel?: AgentChannelDefinition<any>
  error?: unknown
  errorMessage?: string
  event: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>
  extensions: AgentFinishExtensions
  invocation: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>["invocation"]
  output?: unknown
  reaction: (input: AgentChannelDeliveryReactionInput, options?: AgentChannelDeliveryEffectIntentOptions) => AgentChannelDeliveryEffectIntent<"reaction">
  reply: (input: AgentChannelDeliveryReplyInput, options?: AgentChannelDeliveryEffectIntentOptions) => AgentChannelDeliveryEffectIntent<"reply">
  result?: AgentRunResult
  request?: Request
  status: (input: AgentChannelDeliveryStatusInput, options?: AgentChannelDeliveryEffectIntentOptions) => AgentChannelDeliveryEffectIntent<"status">
  text?: string
  workspace?: ReadonlyWorkspaceFacade
}

export type AgentChannelDeliveryEffectHandler<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> = (context: AgentChannelDeliveryEffectContext<TRuntimeConfig>) => MaybePromise<void>

export type AgentChannelDeliveryEffects<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> = Partial<Record<AgentChannelDeliveryEffectKind, AgentChannelDeliveryEffectHandler<TRuntimeConfig> | readonly AgentChannelDeliveryEffectHandler<TRuntimeConfig>[]>>
export type AgentChannelDeliveryFinishEffectResult =
  AgentChannelDeliveryEffectIntent | readonly AgentChannelDeliveryEffectIntent[] | false | null | undefined
export type AgentChannelDeliveryFinishEffectCallback<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = {
  (context: AgentChannelDeliveryFinishEffectContext<TRuntimeConfig, CALL_OPTIONS>, event?: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>): MaybePromise<AgentChannelDeliveryFinishEffectResult>
  active?: (context: AgentChannelDeliveryFinishEffectContext<TRuntimeConfig, CALL_OPTIONS>) => boolean
  kind?: AgentChannelDeliveryEffectKind
}
export type AgentChannelDeliveryFinishEffect<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> =
  | AgentChannelDeliveryEffectIntent
  | readonly AgentChannelDeliveryEffectIntent[]
  | AgentChannelDeliveryFinishEffectCallback<TRuntimeConfig, CALL_OPTIONS>

export interface AgentTriggerRunInvokeResult<CALL_OPTIONS = unknown> {
  delivery?: {
    effects?: AgentChannelDeliveryEffectIntent | readonly AgentChannelDeliveryEffectIntent[]
    finishEffects?: AgentChannelDeliveryFinishEffect | readonly AgentChannelDeliveryFinishEffect[]
  }
  input: AgentRunInput<CALL_OPTIONS>
  metadata?: Record<string, unknown>
  run?: AgentRunMetadata
  webhook?: AgentWebhookInvocationOwnership
}

export interface AgentWebhookInvocationOwnership {
  concurrencyKey?: string
  concurrencyTtlMs?: number
  deliveryId: string
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
  agentCapabilities: readonly AgentCapabilityDefinition<TRuntimeConfig>[]
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
  artifacts?: readonly PublishedAgentDeliveryArtifact[]
  finishReason?: unknown
  raw?: unknown
  text?: string
  usage?: unknown
  usageRecord?: AgentUsageRecord
  warnings?: unknown
}

export interface AgentFinishExtensionValues extends ViteHubAgentFinishExtensions {}
export interface AgentOutputExtensionValues extends ViteHubAgentOutputExtensions {}

export interface AgentInvocationExtensions<TValues extends object = Record<string, unknown>> {
  entries: () => Array<[string, unknown]>
  get<TKey extends keyof TValues & string>(capabilityId: TKey): TValues[TKey] | undefined
  get<TKey extends keyof TValues & string, TField extends keyof NonNullable<TValues[TKey]> & string>(
    capabilityId: TKey,
    key: TField
  ): NonNullable<TValues[TKey]>[TField] | undefined
  get<T = unknown>(capabilityId: string): T | undefined
  get<T = unknown>(capabilityId: string, key: string): T | undefined
  toJSON: () => Record<string, unknown>
}

export type AgentFinishExtensions = AgentInvocationExtensions<AgentFinishExtensionValues>
export type AgentOutputExtensions = AgentInvocationExtensions<AgentOutputExtensionValues>

export interface AgentOutputExtensionEvent {
  extensions: AgentOutputExtensions
  result: unknown
}

export interface AgentFinishEvent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  actor: AgentActor
  error?: unknown
  errorMessage?: string
  extensions: AgentFinishExtensions
  input: AgentRunInput<CALL_OPTIONS>
  invoker: AgentInvoker
  invocation: {
    durationMs: number
    resultKind?: string
    run?: AgentRunMetadata
    usage?: AgentUsageRecord
  }
  result?: unknown
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig> & { runEvents?: AgentRunEventPublisher }
  text?: string
}

export interface AgentFinishHookEvent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> extends AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS> {
  reaction: (input: AgentChannelDeliveryReactionInput, options?: AgentChannelDeliveryEffectIntentOptions) => AgentChannelDeliveryEffectIntent<"reaction">
  reply: (input: AgentChannelDeliveryReplyInput, options?: AgentChannelDeliveryEffectIntentOptions) => AgentChannelDeliveryEffectIntent<"reply">
  status: (input: AgentChannelDeliveryStatusInput, options?: AgentChannelDeliveryEffectIntentOptions) => AgentChannelDeliveryEffectIntent<"status">
}

export type AgentFinishHook<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = (event: AgentFinishHookEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void | AgentChannelDeliveryFinishEffectResult>

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
  rest?: true
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

export type AgentCapabilityCliResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | AgentCapabilityCliContribution<TRuntimeConfig, Name>
  | ((context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<AgentCapabilityCliContribution<TRuntimeConfig, Name> | undefined>)

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
  abortSignal?: AbortSignal
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

export type AgentCapabilityBashCommand =
  | string
  | {
      command: string
      description?: string
      install?: string
    }

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

export type AgentDriverContributionKind = "Capability tools" | "provider tools"

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
    extensions: AgentOutputExtensions
    final: (renderer: AgentOutputRenderer, options?: { order?: "last" }) => void
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
  workspaceSources?: string
}

export interface AgentCapabilityDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TTypeContract extends AgentCapabilityTypeContract = AgentCapabilityTypeContract,
> {
  readonly __vitehubTypeContract?: TTypeContract
  bash?: readonly AgentCapabilityBashCommand[]
  bind?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  capabilities?: readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[]
  cli?: AgentCapabilityCliResolver<TRuntimeConfig, Name>
  close?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  configure?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  finish?: AgentFinishExtensionProvider<TRuntimeConfig>
  hooks?: AgentCapabilityHooks<TRuntimeConfig, Name>
  id: string
  input?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<Response | void>
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
> = readonly AgentCapabilityInput<TRuntimeConfig, Name>[]

export interface AgentCapabilitiesResolverContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> extends AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS>, AgentInvocationCallbackContextValues {
  driver: {
    kind: AgentDriverKind
  }
}

export type AgentCapabilitiesResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
  TCapabilities extends AgentCapabilitiesList<TRuntimeConfig, Name> = AgentCapabilitiesList<TRuntimeConfig, Name>,
> = (
  context: AgentCapabilitiesResolverContext<TRuntimeConfig, CALL_OPTIONS>,
) => MaybePromise<TCapabilities>

export type AgentCapabilitiesInput<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
> = AgentCapabilitiesList<TRuntimeConfig, Name> | AgentCapabilitiesResolver<TRuntimeConfig, Name, CALL_OPTIONS>

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

export interface AgentAttachmentExecutionOptions {
  maxBytes?: number
}

export interface AgentModelExecutionOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  attachments?: AgentAttachmentExecutionOptions
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

export interface CodexAuthOptions {
  gateway?: {
    apiKey?: string
    baseUrl?: string
  }
  openai?: {
    apiKey?: string
    baseUrl?: string
    organization?: string
    project?: string
  }
  openaiCompatible?: {
    apiKey?: string
    baseUrl?: string
    modelProviderName?: string
    queryParamsJson?: string
  }
}

export type CodexDriverSandboxOptions<CALL_OPTIONS = unknown> =
  | false
  | LocalHarnessSandboxOptions
  | AgentHarnessSandboxProviderInput<AgentRuntimeConfig, CALL_OPTIONS>

export interface CodexDriverOptions<CALL_OPTIONS = unknown> {
  auth?: CodexAuthOptions
  credentials?: AgentHarnessCredentialSource
  env?: Record<string, string | undefined>
  instructions?: AgentHarnessInstructions<AgentRuntimeConfig, CALL_OPTIONS>
  model?: string
  port?: number
  reasoningEffort?: "low" | "medium" | "high"
  sandbox?: CodexDriverSandboxOptions<CALL_OPTIONS>
  startupTimeoutMs?: number
  webSearch?: boolean
  workDir?: AgentHarnessWorkDir<AgentRuntimeConfig, CALL_OPTIONS>
}

export interface ClaudeCodeAuthOptions {
  anthropic?: {
    apiKey?: string
    authToken?: string
    baseUrl?: string
  }
  gateway?: {
    apiKey?: string
    baseUrl?: string
  }
}

export type ClaudeCodeThinkingConfig =
  | {
    display?: "summarized" | "omitted"
    type: "adaptive" | "enabled"
  }
  | {
    type: "disabled"
  }

export interface ClaudeCodeDriverOptions {
  auth?: ClaudeCodeAuthOptions
  credentials?: AgentHarnessCredentialSource
  env?: Record<string, string | undefined>
  maxTurns?: number
  model?: string
  port?: number
  sandbox?: false | LocalHarnessSandboxOptions
  startupTimeoutMs?: number
  thinking?: ClaudeCodeThinkingConfig
}

export type BuiltInAgentDriverName = "claude-code" | "codex"

export type BuiltInAgentDriver<CALL_OPTIONS = unknown> =
  | BuiltInAgentDriverName
  | ({ kind: "codex" } & CodexDriverOptions<CALL_OPTIONS>)
  | ({ kind: "claude-code" } & ClaudeCodeDriverOptions)

export type AgentHarnessSessionKey<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> =
  | string
  | ((context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TContextValues>) => MaybePromise<string | undefined>)

export type AgentHarnessInstructions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> =
  | string
  | ((context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TContextValues>) => MaybePromise<string | undefined>)

export type AgentHarnessWorkDir<
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

export type AgentHarnessSandboxProvider = object

export type AgentHarnessSandboxProviderInput<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> =
  | AgentHarnessSandboxProvider
  | ((context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TContextValues>) => MaybePromise<AgentHarnessSandboxProvider | undefined>)

export interface AgentModelDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  credentials?: never
  execution?: AgentModelExecutionOptions<TRuntimeConfig, CALL_OPTIONS>
  harness?: never
  instructions?: AgentAdapterInstructions<TRuntimeConfig>
  kind?: never
  model: AgentModelResolver<TRuntimeConfig>
  permissionMode?: never
  permissions?: never
  run?: never
  sandbox?: never
  sessionKey?: never
  workDir?: never
}

export interface AgentHarnessDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> {
  credentials?: AgentHarnessCredentialSource
  execution?: never
  harness: AgentHarnessDriverInput<TRuntimeConfig, CALL_OPTIONS>
  instructions?: AgentHarnessInstructions<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  kind?: never
  model?: never
  permissionMode?: never
  permissions?: never
  requires?: readonly BoxRequirement[]
  run?: never
  sandbox?: AgentHarnessSandboxProviderInput<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  sessionKey?: AgentHarnessSessionKey<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  workDir?: AgentHarnessWorkDir<TRuntimeConfig, CALL_OPTIONS, TContextValues>
}

export interface AgentRunDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> {
  credentials?: never
  execution?: never
  harness?: never
  instructions?: never
  kind?: never
  model?: never
  permissionMode?: never
  permissions?: never
  run: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  sandbox?: never
  sessionKey?: never
  workDir?: never
}

export type AgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> =
  | AgentModelDriver<TRuntimeConfig, CALL_OPTIONS>
  | AgentHarnessDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  | AgentRunDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  | BuiltInAgentDriver<CALL_OPTIONS>

export type CustomAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> =
  | AgentModelDriver<TRuntimeConfig, CALL_OPTIONS>
  | AgentHarnessDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  | AgentRunDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues>

export interface AgentDefinitionCliOptions {
  capabilities?: boolean
}

export interface AgentOutputDefinition<TOutput = unknown> {
  schema: StandardSchemaV1<unknown, TOutput>
}

export interface AgentUIMessageStreamProjection {
  reasoning?: "hidden" | "visible"
  tools?: "hidden" | "full"
}

export type AgentUIMessageStreamProjectionResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> =
  | AgentUIMessageStreamProjection
  | ((context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TContextValues>) => MaybePromise<AgentUIMessageStreamProjection>)

type AgentSharedSettings<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
  TCapabilities extends AgentCapabilitiesInput<TRuntimeConfig, WorkspaceName, CALL_OPTIONS> | undefined = AgentCapabilitiesInput<TRuntimeConfig, WorkspaceName, CALL_OPTIONS> | undefined,
  TOutput = unknown,
> = {
  box?: BoxDefinition<AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TContextValues>>
  capabilities?: TCapabilities
  channels?: AgentChannelInputs<TRuntimeConfig>
  cli?: AgentDefinitionCliOptions
  description?: string
  hooks?: AgentCapabilityHooks<TRuntimeConfig> & AgentHookObserverHooks & AgentInvocationHooks<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  invoker?: AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues>
  messages?: AgentMessageChannelSettings<TRuntimeConfig>
  name?: string
  output?: AgentOutputDefinition<TOutput>
  runtime?: AgentRuntimeBinding
  runEvents?: AgentRunEvents
  uiMessageStream?: AgentUIMessageStreamProjectionResolver<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  version?: string
  workspace?: WorkspaceAgentWorkspaceConfig
}

export type AgentSettings<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
  TCapabilities extends AgentCapabilitiesInput<TRuntimeConfig, WorkspaceName, CALL_OPTIONS> | undefined = AgentCapabilitiesInput<TRuntimeConfig, WorkspaceName, CALL_OPTIONS> | undefined,
  TOutput = unknown,
  TDriver extends AgentDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues> = AgentDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues>,
> = AgentSharedSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues, TCapabilities, TOutput> & {
  driver: TDriver
}

export interface AgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
  TOutput = unknown,
> {
  box?: BoxDefinition<AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TContextValues>>
  capabilities?: AgentCapabilityDefinition<TRuntimeConfig>[]
  channels?: AgentChannels<TRuntimeConfig>
  chat?: AgentChatOptions<TRuntimeConfig>
  cli?: AgentDefinitionCliOptions
  description?: string
  hooks?: AgentCapabilityHooks<TRuntimeConfig, WorkspaceName> & AgentHookObserverHooks & AgentInvocationHooks<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  invoker?: AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues>
  messages?: AgentMessageChannelSettings<TRuntimeConfig>
  name?: string
  output?: AgentOutputDefinition<TOutput>
  runtime?: AgentRuntimeBinding
  runEvents?: AgentRunEvents
  resolve(context: AgentRuntimeContext<TRuntimeConfig>): Promise<AgentAdapter<CALL_OPTIONS>>
  run?(context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS, WorkspaceName, TContextValues>): MaybePromise<Response | AgentRunResult | AsyncIterable<StreamEvent> | unknown>
  uiMessageStream?: AgentUIMessageStreamProjectionResolver<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  version?: string
  workspace?: WorkspaceAgentWorkspaceConfig
}

export type AgentInput<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext, TOutput = unknown> =
  AgentDefinition<TContext extends AgentRuntimeContext<infer TRuntimeConfig> ? TRuntimeConfig : AgentRuntimeConfig, any, any, any, TOutput>

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
  discordGateway?: AgentRouteOption
}

export interface ResolvedAgentRoutesOptions {
  chat: false | string
  discordGateway: false | string
  webhooks: string
}

export interface AgentModuleOptions {
  cli?: false | AgentCliOptions
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
}

export type AgentChatTriggerHistory = "none" | { maxMessages?: number, source: "thread" }

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

type AgentChatVersionBoundAdapterMethod =
  | "fetchChannelMessages"
  | "fetchMessage"
  | "fetchMessages"
  | "initialize"
  | "listThreads"
  | "parseMessage"

// Chat SDK messages and instances carry private state, so keep version-bound values opaque at this boundary.
export type AgentChatPlatformAdapter = Omit<Adapter, AgentChatVersionBoundAdapterMethod> & {
  fetchChannelMessages?: (...args: Parameters<NonNullable<Adapter["fetchChannelMessages"]>>) => Promise<unknown>
  fetchMessage?: (...args: Parameters<NonNullable<Adapter["fetchMessage"]>>) => Promise<unknown>
  fetchMessages: (...args: Parameters<Adapter["fetchMessages"]>) => Promise<unknown>
  initialize: (chat: never) => Promise<void>
  listThreads?: (...args: Parameters<NonNullable<Adapter["listThreads"]>>) => Promise<unknown>
  parseMessage: (raw: never) => unknown
}

export type AgentChatPlatformResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<AgentChatPlatformAdapter, AgentCallbackContext<TRuntimeConfig>>

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

export interface AgentWebhookStateContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentCallbackContext<TRuntimeConfig> {
  webhook: {
    agentName: string
    channelId?: string
    provider: string
    stateKeyPrefix: string
  }
}

export type AgentWebhookStateResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<StateAdapter, AgentWebhookStateContext<TRuntimeConfig>>

export type AgentChatMessage =
  | AdapterPostableMessage
  | { text: string }
  | ((Exclude<AdapterPostableMessage, string> | { text: string }) & {
    artifacts?: readonly PublishedAgentDeliveryArtifact[]
  })

export type AgentChatSendMessage = (message: AgentChatMessage) => Promise<void>

export type AgentMessageConcurrency = "drop" | "parallel" | "queue" | "reject" | (string & {})

export type AgentMessageLockScope = "agent" | "channel" | "thread" | (string & {})

export interface AgentMessageFilterContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentCallbackContext<TRuntimeConfig> {
  message: Message
  thread: {
    post: AgentChatSendMessage
  }
}

export type AgentMessageFilter<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  (context: AgentMessageFilterContext<TRuntimeConfig>) => MaybePromise<boolean>

export interface AgentChatFinishExtension {
  provider?: string
  run?: Partial<AgentRunMetadata>
  sendMessage: AgentChatSendMessage
}

export interface AgentMessageChannelSettings<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  commentary?: "hidden" | "message"
  concurrency?: AgentMessageConcurrency
  dedupeTtlMs?: number
  errorFallbackText?: string | null | ((context: AgentChatErrorHookArgs<TRuntimeConfig>) => MaybePromise<string | null | undefined>)
  fallbackStreamingPlaceholderText?: string | readonly string[] | null | ((context: AgentChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<string | null | undefined>)
  filter?: AgentMessageFilter<TRuntimeConfig>
  identity?: IdentityResolver
  lockScope?: AgentMessageLockScope
  messageHistory?: unknown
  sessions?: boolean | AgentChatSessionOptions
  state?: AgentChatStateResolver<TRuntimeConfig>
  stream?: boolean
  streamingUpdateIntervalMs?: number
  threadHistory?: unknown
  transcripts?: TranscriptsConfig
  triggerHistory?: AgentChatTriggerHistory
  userName?: string
  [key: string]: unknown
}

export interface AgentChannelDefinition<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  adapter?: AgentChatPlatformResolver<TRuntimeConfig>
  capabilities?: readonly AgentCapabilityDefinition<TRuntimeConfig>[]
  effects?: AgentChannelDeliveryEffects<TRuntimeConfig>
  identity?: IdentityResolver
  kind: string
  messages?: false | AgentMessageChannelSettings<TRuntimeConfig>
  route?: unknown
  triggers?: Record<string, AgentTriggerDefinition<TRuntimeConfig, WorkspaceName, any, any, AgentChannelTriggerContext<TRuntimeConfig>>>
  webhooks?: boolean | AgentChannelWebhookRegistrationDefinition<TRuntimeConfig> | AgentChannelWebhookRegistrationDefinition<TRuntimeConfig>[]
}

export type AgentChannelFactory<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  () => AgentChannelDefinition<TRuntimeConfig>

export type AgentChannelInput<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  AgentChannelDefinition<TRuntimeConfig> | AgentChannelFactory<TRuntimeConfig>

export type AgentChannelInputs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  Record<string, AgentChannelInput<TRuntimeConfig>>

export type AgentChannels<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  Record<string, AgentChannelDefinition<TRuntimeConfig>>

interface AgentChatBaseOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentMessageChannelSettings<TRuntimeConfig> {
  adapters?: never
  agent?: never
  event?: AgentChatAgentBindingOptions["event"]
  execution?: never
  hooks?: AgentChatEventHooks<TRuntimeConfig>
  identity?: IdentityResolver
  lifecycleHooks?: Record<string, unknown>
  webhooks?: Record<string, false | AgentChannelWebhookRegistrationDefinition<TRuntimeConfig> | AgentChannelWebhookRegistrationDefinition<TRuntimeConfig>[]>
  workflow?: never
  [key: string]: unknown
}

export interface AgentChatCapabilityOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentChatBaseOptions<TRuntimeConfig> {
  platforms?: never
  webhooks?: never
}

export interface AgentChatOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentChatBaseOptions<TRuntimeConfig> {
  platforms?: AgentChatPlatformsResolver<TRuntimeConfig>
}

export type AgentToolPolicyDecision = "allow" | "deny" | "require-approval" | "retryable-failure"

export interface AgentToolPolicyContext {
  input?: unknown
  name: string
}

export type AgentToolStandardSchema<T = unknown> = StandardSchemaV1<unknown, T> & StandardJSONSchemaV1<unknown, T>
export type AgentToolSchema<T = unknown> = AgentToolStandardSchema<T> | (JSONSchema7 & { "~standard"?: never })

export interface AgentToolExecutionContext {
  abortSignal?: AbortSignal
}

export interface AgentToolDefinition<TInput = unknown, TOutput = unknown> {
  description?: string
  execute?: (input: TInput, context?: AgentToolExecutionContext) => MaybePromise<TOutput>
  inputSchema?: AgentToolSchema<TInput>
  metadata?: Record<string, unknown>
  name: string
  outputSchema?: AgentToolSchema<TOutput>
  policy?: AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)
}

export type AgentToolSet = Record<string, AgentToolDefinition>

export interface WorkspaceAgentWorkspaceOptions extends Omit<WorkspaceDefinitionInput, "name"> {
  commit?: boolean | string
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

export interface AgentInspectionFileTreeItem {
  children?: AgentInspectionFileTreeItem[]
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

export interface AgentInspectionToolDefinition {
  category?: string
  commands?: string[]
  description?: string
  icon?: string
  name: string
  preset?: string
  status?: "available" | "disabled"
}

export type AgentInspectionConfigValue = boolean | null | number | string

export interface AgentInspectionModelMetadata {
  dynamic?: boolean
  id?: string
  provider?: string
}

export interface AgentInspectionModelExecutionMetadata {
  callSettings?: Record<string, AgentInspectionConfigValue>
  stepLimit?: number
  workspaceFallback?: {
    enabled?: boolean
    maxToolResults?: number
  }
}

export interface AgentInspectionHarnessMetadata {
  credentials?: AgentHarnessCredentialSource
  provider?: string
  sandboxProvider?: string
  sessionKey?: boolean
}

export interface AgentInspectionDriverMetadata {
  readonly executionAuthority: ExecutionAuthority
  execution?: AgentInspectionModelExecutionMetadata
  harness?: AgentInspectionHarnessMetadata
  kind: "harness" | "model" | "run" | "unknown"
  model?: AgentInspectionModelMetadata
}

export interface AgentInspectionConfigMetadata {
  driver: AgentInspectionDriverMetadata
  uiMessageStream?: AgentUIMessageStreamProjection
}

export interface AgentInspectionMetadata {
  config?: AgentInspectionConfigMetadata
  files?: AgentInspectionFileTreeItem[]
  instructions?: string[]
  invokerProfiles?: AgentInvokerProfile[]
  name?: string
  tools?: AgentInspectionToolDefinition[]
  version?: string
  warnings?: AgentInspectionWarning[]
}

export interface AgentInspectionWarning {
  id: string
  kind: "instruction-coverage"
  message: string
  primitive: "capability" | "skill" | "source"
  severity: "warning"
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
  usage?: AgentUsage
}

export interface AgentAdapterMetadataContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends AgentCallbackContext<TRuntimeConfig>, AgentInvocationCallbackContextValues {
  actor: AgentActor
  context: AgentInvocationContextStore
  driver?: {
    kind: AgentDriverKind
  }
  fs: ReadonlyWorkspaceFacade<Name>["fs"]
  invoker: AgentInvoker
  workspace: ReadonlyWorkspaceFacade<Name>
}

export interface AgentGlobalSkill {
  path: string
  source: WorkspaceSourceInput
  sourceKey: string
}

export interface AgentAdapterRunContext<
  TOptions = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  actor: AgentActor
  box?: Box
  close?: () => Promise<void>
  context: AgentInvocationContextStore
  toolStepReporter?: AgentRuntimeContext<TRuntimeConfig>["toolStepReporter"]
  driverContributions?: AgentDriverContribution[]
  globalSkills?: readonly AgentGlobalSkill[]
  hasCapabilityCleanup?: boolean
  harnessSandboxProvider?: object
  harnessWorkDir?: string
  input: AgentRunInput<TOptions>
  instructions?: string
  invoker: AgentInvoker
  messages: Message[]
  modelExecutionInstrumentation?: AgentModelExecutionInstrumentation[]
  output?: AgentOutputDefinition
  outputRenderers?: Array<(result: unknown) => MaybePromise<unknown>>
  prompt?: string
  providerTools?: AgentProviderToolContribution[]
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>
  tools?: AgentToolSet
  workspace?: ReadonlyWorkspaceFacade<Name>
  workspaceMaterializationSource?: ReadonlyWorkspaceFacade<Name>
  workspaceAutoCommit?: boolean | string
  workspaceDefinition?: WorkspaceDefinition
  workspaceInstructionBindings?: Record<string, unknown>
}

export interface AgentAdapter<
  TOptions = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  generate(context: AgentAdapterRunContext<TOptions, TRuntimeConfig, Name>): MaybePromise<AgentAdapterResult | Response | AsyncIterable<StreamEvent> | unknown>
  metadata?(context: AgentAdapterMetadataContext<TRuntimeConfig, Name>): MaybePromise<AgentInspectionMetadata | undefined>
  name: string
  stream?(context: AgentAdapterRunContext<TOptions, TRuntimeConfig, Name>): MaybePromise<Response | AsyncIterable<StreamEvent> | AgentAdapterResult | unknown>
}

export type AgentAdapterFactory<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TOptions = unknown,
  Name extends WorkspaceName = WorkspaceName,
> = (context: ResolvedAgentRuntimeContext<TRuntimeConfig>) => MaybePromise<AgentAdapter<TOptions, TRuntimeConfig, Name>>
