import type { AgentActivity, Message, StreamEvent } from "./messages.ts"
import type { AskAnswerType, AskQuestion } from "./ask.ts"
import type { AgentRunEventPublisher, AgentRunEvents } from "./run-events.ts"
import type { AgentInvocationAnnotationValue, AgentInvocationRecord, AgentInvocations } from "./invocations.ts"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import type { AgentPublicError } from "./agent-error.ts"
import type { JSONSchema7 } from "json-schema"
import type { Adapter, AdapterPostableMessage, IdentityResolver, StateAdapter, TranscriptsConfig } from "chat"
import type { LanguageModel } from "ai"
import type {
  MaybePromise,
  MaybeResolvable,
  ExecutionAuthority,
  Resolvable,
  RuntimeCapabilities,
  RuntimeCapabilityHandle,
  RuntimeDiagnosticError,
  RuntimeHostContext,
  RuntimeWaitUntil,
  OpenTelemetryLogRecordView,
  OpenTelemetrySpanView,
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
import type { BoxDefinition, BoxToolchain } from "@vite-hub/box"
import type { channelDeliveryHandlers } from "./internal/channel-delivery-handlers.ts"
import type { ReplayChannelResult } from "./channel-replay.ts"
import type {
  AgentChannelOptions,
  AgentWebChatChannelOptions,
  DiscordChannelOptions,
  GitHubChannelOptions,
  TelegramChannelOptions,
} from "./channels.ts"

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
export interface AgentHealthDescriptor {
  handler?: (request: Request, options?: Record<string, unknown>) => MaybePromise<Response>
}
export type AgentCapabilityHandle<TKind extends string = string, TValue = unknown> = RuntimeCapabilityHandle<TKind, TValue>
export type AgentCapabilities = RuntimeCapabilities

export interface AgentRuntimeConfig {}

/** Box used by a built-in provider Driver. Callbacks resolve once per invocation. */
export type AgentBoxDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
> = BoxDefinition<AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TContextValues>>

export interface AgentHostIdentity {
  readonly name: string
  readonly workspace?: WorkspaceName
}

export interface AgentGitHubAccess {
  /** Environment for `gh` and `git`: `GH_TOKEN`, `GITHUB_TOKEN`, a Git credential helper, and the commit identity. */
  env: Record<string, string>
  token: string
}

/** The GitHub identity of an Agent. `createGitHubHost()` from `vite-hub/agent/server/github` returns one. */
export interface AgentGitHub {
  access(input?: { repository?: string, signal?: AbortSignal }): Promise<AgentGitHubAccess>
  /** Login of the identity, when it is known. */
  identity?(): string | undefined
}

export interface AgentRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends Omit<RuntimeHostContext<TRuntimeConfig>, "cloudflare" | "platform" | "runtime"> {
  agentIdentity?: AgentHostIdentity
  channelDelivery?: AgentChannelDelivery
  cloudflare?: RuntimeHostContext<TRuntimeConfig>["cloudflare"]
  /** The Agent GitHub identity from `defineAgent({ github })`. */
  githubIdentity?: AgentGitHub
  toolStepReporter?: (step: AgentToolStep) => MaybePromise<void>
  run?: AgentRunMetadata
  runtime: AgentRuntimeName
}

export type ResolvedAgentRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  AgentRuntimeContext<TRuntimeConfig> & {
    capabilities: RuntimeCapabilities
    runtimeConfig: TRuntimeConfig
  }

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
  interface ViteHubAgentInvocationContextValues {
    "agent.channels": string[]
    "agent.colocatedSkills": Record<string, WorkspaceSourceInput>
    "agent.invocation.traceId": string
    "agent.name": string
    "agent.output.eventObserver": (event: StreamEvent) => void
    "agent.output.progressSummary": boolean
    "agent.schedule.turn": boolean
    "agent.trigger": { channelId?: string, id?: string, name?: string, source?: "capability" | "channel" }
    "channel.delivery.titleDelivered": boolean
    "chat.channelState": { keyPrefix: string, state: StateAdapter }
    "chat.finish": AgentChatFinishExtension
    "vitehub.channel.final-output": boolean
    "vitehub.title.response-fallback": boolean
    "workspace.sourceResolution.definition": WorkspaceDefinition
  }
  interface ViteHubAgentFinishExtensions {}
  interface ViteHubAgentOutputExtensions {}
}

export interface AgentInvocationContextValues extends ViteHubAgentInvocationContextValues {
  access: AgentAccessInvocationContextValue
  actor: AgentActor
  "agent.errorHook": boolean
  "agent.finishHook": boolean
  "agent.inspection.configurationUpdated": () => Promise<void>
  "chat.sessionId": string
  "channel.delivery.effects": AgentChannelDeliveryEffectIntent[]
  "channel.delivery.finishEffects": AgentChannelDeliveryFinishEffect[]
  "channel.delivery.supportsTitle": boolean
  "channel.message": unknown
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
    (id: string): unknown
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
  TData = unknown,
> {
  abortSignal?: AbortSignal
  context?: TContext
  /**
   * Structured Invocation input. `defineAgent({ data })` validates it before Capabilities, hooks, and the Driver run.
   * Model and provider Drivers do not read it; use `prompt` or `messages` for model text.
   */
  data?: TData
  message?: string | Message
  messages?: Message[]
  /**
   * Record Channel message writes in the trace instead of calling the provider.
   * Read methods still run.
   */
  dryRun?: boolean
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

export interface AgentActivityLink {
  label: string
  url: string
}

export type AgentActivityStatus = "cancelled" | "completed" | "failed" | "queued" | "running" | "waiting"

export type AgentActivityTaskStatus = "completed" | "in-progress" | "pending"

export type AgentActivityTarget =
  | boolean
  | number
  | string
  | null
  | readonly AgentActivityTarget[]
  | { readonly [key: string]: AgentActivityTarget }

export interface AgentActivityTask {
  status: AgentActivityTaskStatus
  title: string
}

export interface AgentRunActivity {
  links?: readonly AgentActivityLink[]
  runId?: string
  target: AgentActivityTarget
}

export interface AgentRunMetadata<TOrigin extends string = string> {
  activity?: AgentRunActivity
  annotations?: Record<string, AgentInvocationAnnotationValue>
  channelId?: string
  messageId?: string
  origin?: TOrigin
  runId: string
  threadId?: string
}

interface AgentTelemetryExportContextBase<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  agent: {
    name?: string
    version?: string
  }
  run?: AgentRunMetadata
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>
}

export interface AgentTelemetryLogsExportContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends AgentTelemetryExportContextBase<TRuntimeConfig> {
  records: readonly OpenTelemetryLogRecordView[]
  signal: "logs"
}

export interface AgentTelemetryTracesExportContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends AgentTelemetryExportContextBase<TRuntimeConfig> {
  signal: "traces"
  spans: readonly OpenTelemetrySpanView[]
}

export type AgentTelemetryExportContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  | AgentTelemetryLogsExportContext<TRuntimeConfig>
  | AgentTelemetryTracesExportContext<TRuntimeConfig>

export type AgentTelemetry<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> = {
  bivarianceHack(context: AgentTelemetryExportContext<TRuntimeConfig>): MaybePromise<void>
}["bivarianceHack"]

export interface AgentTelemetryContentOptions {
  inputs?: boolean
  instructions?: boolean
  outputs?: boolean
}

export interface AgentTelemetryRegistration<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  content?: AgentTelemetryContentOptions
  exporter: AgentTelemetry<TRuntimeConfig>
  /** Export append-only LogRecords while the invocation is still running. */
  live?: boolean
}

export interface AgentCapabilityTelemetryContext {
  metadata: (metadata: Record<string, unknown>) => void
}

export type AgentCapabilityInspectionBinding = { $state: string } | { $item: string }

export type AgentCapabilityInspectionElement = {
  children?: string[]
  repeat?: { statePath: string, key?: string }
} & (
  | { type: "Stack", props: Record<string, never> }
  | { type: "Section", props: { title: string | AgentCapabilityInspectionBinding } }
  | { type: "Text", props: { text: string | AgentCapabilityInspectionBinding } }
  | { type: "KeyValue", props: { label: string | AgentCapabilityInspectionBinding, value: AgentInspectionValue } }
  | { type: "Tools", props: { names?: string[] | AgentCapabilityInspectionBinding, mcpServer?: string | AgentCapabilityInspectionBinding } }
)

/** Read-only JSON Render spec. The inspector owns the component catalog. */
export interface AgentCapabilityInspectionView {
  root: string
  elements: Record<string, AgentCapabilityInspectionElement>
}

export interface AgentCapabilityInspectionDefinition {
  label: string
  view?: AgentCapabilityInspectionView
}

export interface AgentCapabilityInspection extends AgentCapabilityInspectionDefinition {
  truncated?: boolean
  state?: Record<string, AgentInspectionValue>
}

export interface AgentTelemetryCapabilityMetadata {
  id: string
  inspection?: AgentCapabilityInspection
  metadata?: Record<string, AgentInspectionValue>
}

export interface AgentToolInspection {
  /** Capability that registered this tool, when known. */
  capabilityId?: string;
  description?: string
  /** The tool's declared `icon`. Kept when content capture is off. */
  icon?: string
  inputSchema?: AgentInspectionValue
  name: string
  mcp?: { server: string, name: string }
  /** The tool's declared `title`. Kept when content capture is off, like Capability inspection labels. */
  label?: string
  outputSchema?: AgentInspectionValue
}

export interface AgentTelemetryConfiguration {
  agent?: {
    name?: string
    version?: string
  }
  capabilities?: AgentTelemetryCapabilityMetadata[]
  channels?: Array<{
    id: string
    kind: string
  }>
  driver: {
    kind: AgentDriverKind
    model?: {
      id?: string
      provider?: string
    }
    provider?: string
  }
  /** Stable SHA-256 of the resolved behavior-relevant configuration. */
  fingerprint?: string
  instructions?: string[]
  runtime: {
    name: string
  }
  tools?: AgentToolInspection[]
  workspace?: {
    mode: AgentCapabilityMode
    name?: string
    sources?: Array<string | { id: string, repository?: string }>
  }
}

export interface AgentChannelDelivery {
  agentName: string
  channelId?: string
  id: string
  provider: string
  receivedAt: string
  scope: string
  sourceId: string
}

export type AgentChannelDeliveryEventType =
  | "accepted"
  | "completed"
  | "duplicate"
  | "failed"
  | "invocation.completed"
  | "invocation.failed"
  | "invocation.started"
  | "outbound.completed"
  | "outbound.failed"
  | "outbound.started"
  | "queued"
  | "received"
  | "rejected"
  | "retrying"

export interface AgentChannelDeliveryEventInput {
  attempt?: number
  error?: string
  messageId?: string
  runId?: string
  type: AgentChannelDeliveryEventType
}

export interface AgentChannelDeliveryEvent extends AgentChannelDeliveryEventInput {
  at: string
  deliveryId: string
  id: string
}

export type AgentChannelDeliveryStatus = "accepted" | "completed" | "failed" | "queued" | "received" | "rejected" | "retrying" | "running"

export interface AgentChannelDeliveryInspection extends AgentChannelDelivery {
  events: AgentChannelDeliveryEvent[]
  status: AgentChannelDeliveryStatus
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

export type AgentChannelDeliveryReplyStream = AsyncIterable<string>

export type AgentChannelDeliveryReplyInput = string | AgentChannelDeliveryReplyPayload | AgentChannelDeliveryReplyStream

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
  /**
   * JSON data that identifies the triggering Channel message.
   * Message methods receive it as `context.message`; hooks read it as `event.message.data`.
   */
  message?: unknown
  metadata?: Record<string, unknown>
  run?: AgentRunMetadata
  webhook?: AgentWebhookInvocationOwnership<CALL_OPTIONS>
}

interface AgentWebhookInvocationOwnershipBase {
  concurrencyGroup?: string
  concurrencyTtlMs?: number
  deliveryId: string
}

export type AgentWebhookInvocationOwnership<CALL_OPTIONS = unknown> = AgentWebhookInvocationOwnershipBase & (
  | { busy: "steer", concurrencyKey: string, concurrencyLimit: number, rehydrate?: () => MaybePromise<AgentWebhookRehydrateResult<CALL_OPTIONS>> }
  | { busy?: undefined, concurrencyKey?: string, concurrencyLimit: number, rehydrate?: () => MaybePromise<AgentWebhookRehydrateResult<CALL_OPTIONS>> }
  | { busy?: undefined, concurrencyKey?: string, concurrencyLimit?: undefined, rehydrate?: never }
)

type AgentWebhookRehydrateResult<CALL_OPTIONS = unknown> =
  | (Omit<AgentTriggerRunInvokeResult<CALL_OPTIONS>, "webhook"> & { webhook: AgentWebhookInvocationOwnership<CALL_OPTIONS> })
  | Response

export type AgentTriggerInvokeResult<CALL_OPTIONS = unknown> =
  | AgentTriggerRunInvokeResult<CALL_OPTIONS>
  | Response

/**
 * A static secret, a callback, or an object with its own `resolve` method.
 * Inherited `resolve` methods, including class prototype methods, are rejected.
 * Use an object literal or a class field such as `resolve = (context) => secret`.
 * Resolvers must return a string, `false` to disable verification, or `undefined`.
 */
export type AgentWebhookSecretToken<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<string | false | undefined, AgentCallbackContext<TRuntimeConfig>>

export interface AgentWebhookRegistrationDefinition<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  adapter?: string
  channelId?: string
  durableState?: boolean
  id?: string
  method?: "POST" | (string & {})
  path?: string
  provider: string
  signature?: "github-sha256" | "stripe-sha256" | (string & {}) | {
    preset: "stripe-sha256"
    /** Maximum age of the signed `t` timestamp in integer seconds. Must be finite and non-negative. Defaults to 300. Future timestamps pass the age check. */
    toleranceSeconds?: number
  } | {
    verify: (input: {
      context?: AgentCallbackContext<TRuntimeConfig>
      header: string
      rawBody: Uint8Array
      request: Request
      secret: string
    }) => boolean | Promise<boolean>
  }
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

/** One message that `AgentChannelTriggerContext.dispatch()` sends through a Channel trigger. */
export interface AgentChannelDispatchItem {
  /** Trigger input. */
  input: unknown
  /** Stable key, such as the provider message ID. The Invocation ID derives from it. */
  key: string
}

export interface AgentChannelDispatchOptions {
  /** Record Channel message writes in the trace instead of calling the provider. */
  dryRun?: boolean
  /** Trigger of the same Channel that receives each item. */
  trigger: string
}

/** Durable state of one Channel. Keys that start with `keyPrefix` belong to the Channel. */
export interface AgentChannelStateBinding {
  keyPrefix: string
  state: StateAdapter
}

export interface AgentChannelTriggerContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> extends AgentCallbackContext<TRuntimeConfig> {
  /** The accepted Invocation when a durable webhook delivery is replayed for rehydration. */
  queuedInvocation?: Pick<AgentTriggerRunInvokeResult, "input" | "run">
  actor?: AgentActor
  agentCapabilities: readonly AgentCapabilityDefinition<TRuntimeConfig>[]
  agentName?: string
  channel: AgentChannelDefinition<TRuntimeConfig>
  /** The Channel's State Adapter. Present when a webhook route runs the trigger. */
  channelState?: AgentChannelStateBinding
  /**
   * Starts one Invocation per item through another trigger of this Channel, for a webhook that carries several messages.
   * Items use the same Invocation IDs as `replayChannel()`, so an item that already has an Invocation is skipped.
   */
  dispatch: (items: readonly AgentChannelDispatchItem[], options: AgentChannelDispatchOptions) => Promise<ReplayChannelResult>
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
  /**
   * Dispatched at most once when the webhook queue stops retrying a delivery:
   * the last attempt failed, or the delivery used all its execution leases.
   * An error from this callback is logged and does not change the delivery outcome.
   * A process exit after dispatch leaves an uncertain outcome; the callback is not replayed.
   */
  failed?: (event: AgentTriggerFailedEvent<CALL_OPTIONS>) => MaybePromise<void>
  health?: AgentHealthDescriptor
  input?: string | StandardSchemaV1<unknown, TInput>
  invoke: (context: TContext, input: TInput) => MaybePromise<AgentTriggerInvokeResult<CALL_OPTIONS>>
  output?: "events" | "ui-message-stream" | (string & {})
  webhooks?: AgentWebhookRegistrationDefinition<TRuntimeConfig>[]
}

/** One Agent Invocation, as the Console shows it. */
export interface AgentInvocationReference {
  /** The Console URL of the Invocation. Present when the Agent has a public URL. */
  consoleUrl?: string
  id: string
}

/** The terminal failure of one queued webhook delivery. */
export interface AgentTriggerFailedEvent<CALL_OPTIONS = unknown> {
  /** The number of execution attempts, including the last one. */
  attempts: number
  deliveryId: string
  error: unknown
  /** Present when the queue stored the Invocation input. */
  input?: AgentRunInput<CALL_OPTIONS>
  /** Present when the delivery has a run ID. */
  invocation?: AgentInvocationReference
  publicError: AgentPublicError
  run?: AgentRunMetadata
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
  input?: string | StandardSchemaV1<unknown, TInput>
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
  TData = unknown,
> extends AgentCallbackContext<TRuntimeConfig> {
  actor: AgentActor
  context: AgentInvocationContextStore<TContextValues>
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, TData>
  invoker: AgentInvoker
  run?: AgentRunMetadata
}

export interface AgentInterceptContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
  TData = unknown,
> extends AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TContextValues, TData> {
  /** Invocation `data` after `defineAgent({ data })` validation. */
  data: TData
}

/**
 * Handles an Invocation before the Driver runs.
 * Return `undefined` to continue to the Driver. Return another value to finish the Invocation with that value as its output.
 */
export type AgentInterceptHandler<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
  TData = unknown,
  TIntercept = unknown,
> = (context: AgentInterceptContext<TRuntimeConfig, CALL_OPTIONS, TContextValues, TData>) => MaybePromise<TIntercept | undefined>

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
  get(capabilityId: string): unknown
  get(capabilityId: string, key: string): unknown
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
  TOutput = unknown,
  TData = unknown,
> {
  actor: AgentActor
  error?: unknown
  errorMessage?: string
  extensions: AgentFinishExtensions
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, TData>
  invoker: AgentInvoker
  invocation: {
    /** True when output consumption was cancelled instead of completed. */
    cancelled?: boolean
    durationMs: number
    resultKind?: string
    run?: AgentRunMetadata
    /** The `traceId` of the stored invocation record. Present when the Agent has an invocation journal. */
    traceId?: string
    usage?: AgentUsageRecord
  }
  result?: TOutput
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig> & { runEvents?: AgentRunEventPublisher }
  text?: string
  toolResults: AgentToolStepItem[]
}

export type AgentFinishHookEvent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TMessage = AgentChannelMessage | undefined,
  TData = unknown,
> = Omit<AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS, TOutput, TData>, "error" | "errorMessage"> & {
  /** The Channel message that started this Invocation, or `undefined` without a Channel. */
  message: TMessage
  reaction: (input: AgentChannelDeliveryReactionInput, options?: AgentChannelDeliveryEffectIntentOptions) => AgentChannelDeliveryEffectIntent<"reaction">
  reply: (input: AgentChannelDeliveryReplyInput, options?: AgentChannelDeliveryEffectIntentOptions) => AgentChannelDeliveryEffectIntent<"reply">
  status: (input: AgentChannelDeliveryStatusInput, options?: AgentChannelDeliveryEffectIntentOptions) => AgentChannelDeliveryEffectIntent<"status">
}

export type AgentErrorHookEvent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TMessage = AgentChannelMessage | undefined,
  TData = unknown,
> = Omit<AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS, unknown, TData>, "error" | "errorMessage" | "result" | "text"> & {
  error: unknown
  errorMessage: string
  /** The Channel message that started this Invocation, or `undefined` without a Channel. */
  message: TMessage
  publicError: AgentPublicError
  reaction: (input: AgentChannelDeliveryReactionInput, options?: AgentChannelDeliveryEffectIntentOptions) => AgentChannelDeliveryEffectIntent<"reaction">
  reply: (input: AgentChannelDeliveryReplyInput, options?: AgentChannelDeliveryEffectIntentOptions) => AgentChannelDeliveryEffectIntent<"reply">
  status: (input: AgentChannelDeliveryStatusInput, options?: AgentChannelDeliveryEffectIntentOptions) => AgentChannelDeliveryEffectIntent<"status">
}

export type AgentErrorHook<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TMessage = AgentChannelMessage | undefined,
  TData = unknown,
> = {
  bivarianceHack(event: AgentErrorHookEvent<TRuntimeConfig, CALL_OPTIONS, TMessage, TData>): MaybePromise<void | AgentChannelDeliveryFinishEffectResult>
}["bivarianceHack"]

export type AgentFinishHook<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TMessage = AgentChannelMessage | undefined,
  TData = unknown,
> = {
  bivarianceHack(event: AgentFinishHookEvent<TRuntimeConfig, CALL_OPTIONS, TOutput, TMessage, TData>): MaybePromise<void | AgentChannelDeliveryFinishEffectResult>
}["bivarianceHack"]

export type AgentInputHook<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
  TData = unknown,
> = {
  bivarianceHack(context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TContextValues, TData>): MaybePromise<void>
}["bivarianceHack"]

export interface AgentInvocationHooks<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
  TOutput = unknown,
  TMessage = AgentChannelMessage | undefined,
  TData = unknown,
> {
  "agent:error"?: AgentErrorHook<TRuntimeConfig, CALL_OPTIONS, TMessage, TData>
  "agent:finish"?: AgentFinishHook<TRuntimeConfig, CALL_OPTIONS, TOutput, TMessage, TData>
  "agent:input"?: AgentInputHook<TRuntimeConfig, CALL_OPTIONS, TContextValues, TData>
}

export type AgentHookOwner = "agent" | "capability" | "channel" | "runtime" | "integration" | (string & {})
export type AgentHookOutcome = "error" | "success"

export interface AgentHookObserverEvent {
  durationMs: number
  error?: RuntimeDiagnosticError
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
export type AgentDriverKind = "ask" | "model" | "provider" | "run"

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
  invocation?: { input: AgentCapabilityInputContext, kind?: "run" | "stream" }
  mode?: AgentCapabilityMode
  runtimeContext?: ResolvedAgentRuntimeContext
  /** The enclosing normalized driver, available to capabilities for inheritance. */
  agentDriver?: unknown
  workspaceDefinition?: WorkspaceDefinition
}

export interface AgentCapabilityInputContext {
  get: () => AgentRunInput
  messages: () => Message[]
  set: (input: AgentRunInput) => void
  setMessages: (messages: Message[]) => void
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

export type AgentDriverContributionKind = "Capability tools" | "provider tools"

export interface AgentDriverContribution {
  capabilityId: string
  kind: AgentDriverContributionKind
  names?: string[]
}

/**
 * Each callback receives copies of tool definitions, one per key, preserving prototypes, property flags, and accessor behavior.
 * Accessors and executors use bound functions to retain their contributed instance as receiver. Their function identities can change.
 * Rename non-MCP tools using the supplied definitions to retain Capability ownership.
 * MCP renames must retain metadata.mcpServer and metadata.originalName. Same-key replacements inherit them.
 */
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
  inspection: {
    /** Replace this Capability's captured state without running inspection-time work. */
    set: (state: Record<string, AgentInspectionValue>) => Promise<void>
  }
  input: AgentCapabilityInputContext
  invocation: { input: AgentCapabilityInputContext, kind: "run" | "stream" }
  delivery: {
    effect: (intent: AgentChannelDeliveryEffectIntent) => void
    finishEffect: (effect: AgentChannelDeliveryFinishEffect) => void
  }
  model: {
    resolve: (model?: AgentModelResolver<TRuntimeConfig, Name>, options?: { abortSignal?: AbortSignal }) => Promise<unknown>
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
  telemetry: AgentCapabilityTelemetryContext
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
  bind?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  capabilities?: readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[]
  cli?: AgentCapabilityCliResolver<TRuntimeConfig, Name>
  close?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  configure?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  finish?: AgentFinishExtensionProvider<TRuntimeConfig>
  hooks?: AgentCapabilityHooks<TRuntimeConfig, Name>
  id: string
  inspection?: AgentCapabilityInspectionDefinition
  /** Set to false when the Capability has no model-facing behavior to explain in Agent Driver Instructions. */
  instructionCoverage?: boolean
  input?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<Response | void>
  metadata?: Record<string, unknown>
  mode?: AgentCapabilityMode
  output?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  prepare?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  requires?: AgentCapabilityRequirement[]
  resolve?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  telemetry?: AgentTelemetryRegistration<TRuntimeConfig>
  tools?: AgentCapabilityToolResolver<TRuntimeConfig, Name>
  triggers?: Record<string, AgentTriggerDefinition<TRuntimeConfig, Name, any, any>>
  workspaceSources?: WorkspaceDefinition["sources"]
  workspace?: AgentCapabilityWorkspaceContributionResolver<TRuntimeConfig, Name>
}

export type AgentCapabilityInput<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = AgentCapabilityDefinition<TRuntimeConfig, Name>

type AgentExtensionMount = object
declare const agentStaticCapabilitiesListBrand: unique symbol

export type AgentCapabilitiesList<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = readonly AgentCapabilityInput<TRuntimeConfig, Name>[]

export type AgentStaticCapabilitiesList<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = readonly (AgentCapabilityInput<TRuntimeConfig, Name> | AgentExtensionMount)[] & {
  readonly [agentStaticCapabilitiesListBrand]?: true
}

export type IsTypedAgentStaticCapabilitiesList<T> =
  typeof agentStaticCapabilitiesListBrand extends keyof T ? true : false

export interface AgentCapabilitiesResolverContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> extends AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS>, AgentInvocationCallbackContextValues {
  abortSignal?: AbortSignal
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
> = AgentStaticCapabilitiesList<TRuntimeConfig, Name> | AgentCapabilitiesResolver<TRuntimeConfig, Name, CALL_OPTIONS>

export type AgentAdapterInstructionsValue = string | string[]

export type AgentAdapterInstructions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | AgentInstructionsContent<TRuntimeConfig, Name>
  | {
    /** Markdown with exactly one {{{ instructions }}} slot outside code. */
    template: AgentInstructionsContent<TRuntimeConfig, Name>
    /** Default slot content. Extending instructions replaces this content. */
    content?: AgentInstructionsContent<TRuntimeConfig, Name>
  }
  | {
    /** Discard an inherited template and use this document. */
    mode: "replace"
    value: AgentInstructionsContent<TRuntimeConfig, Name>
  }

export type AgentInstructionsContent<
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

export interface AgentGatewayModel {
  apiKey?: string | { unseal: () => string }
  id: string
}

export type AgentModelInput = AgentGatewayModel | LanguageModel | string

export interface AgentModelResolverContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends AgentAdapterMetadataContext<TRuntimeConfig, Name> {
  abortSignal?: AbortSignal
  runtimeConfig: TRuntimeConfig
}

export type AgentModelResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = AgentModelInput | {
  bivarianceHack(context: AgentModelResolverContext<TRuntimeConfig, Name>): MaybePromise<AgentModelInput>
}["bivarianceHack"]

export interface AgentModelInstrumentationContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentCallbackContext<TRuntimeConfig> {
  actor: AgentActor
  context: AgentInvocationContextStore
  invoker: AgentInvoker
  model: unknown
  run?: AgentRunMetadata
}

export type AgentModelInstrumentation<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  (context: AgentModelInstrumentationContext<TRuntimeConfig>) => MaybePromise<unknown>

export interface AgentCallSettingsInstrumentationContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> extends AgentCallbackContext<TRuntimeConfig> {
  actor: AgentActor
  callSettings: Readonly<Record<string, unknown>>
  context: AgentInvocationContextStore
  input: AgentRunInput<CALL_OPTIONS>
  invoker: AgentInvoker
  model: unknown
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

export interface AgentDriverCapacityQueueOptions {
  maxPending: number
  timeout?: number
}

export interface AgentDriverCapacitySampleContext {
  active: number
  concurrency: number
  pending: number
  signal: AbortSignal
}

export interface AgentDriverCapacitySample {
  concurrency: number
  reason?: string
}

export interface AgentDriverAdaptiveCapacityOptions {
  fallbackConcurrency?: number
  intervalMs?: number
  rampUp?: number
  sample: (context: AgentDriverCapacitySampleContext) => MaybePromise<AgentDriverCapacitySample>
  sampleTimeoutMs?: number
}

export interface AgentDriverCapacityOptions {
  adaptive?: AgentDriverAdaptiveCapacityOptions
  concurrency: number
  queue?: AgentDriverCapacityQueueOptions
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
  repairToolCall?: boolean
  stepLimit?: number
  workspaceFallback?: boolean | {
    enabled?: boolean
    maxToolResults?: number
  }
}

export type AgentProviderPermissions = "allow-all" | "allow-edits" | "allow-edits-unattended" | "ask"

type SingleAttemptAgentOutputDefinition<TOutput> = Omit<AgentOutputDefinition<TOutput>, "maxAttempts"> & {
  maxAttempts?: never
}

export interface AgentProviderUsageLimits {
  checkedAt: string
  windows: readonly {
    id: string
    kind: "session" | "weekly" | "monthly" | "other"
    label: string
    usedPercent: number
    resetsAt?: string
    windowDurationMins?: number
  }[]
  unavailable?: { reason: "unsupported" | "probeFailed" }
}

export interface AgentProviderStatus {
  /** Opaque scope for deduplicating shared limits. Never contains the credential itself. */
  account?: { id: string, kind: "credential" | "account" }
  agent: string
  provider?: "codex" | "claude-code"
  readiness: "ready" | "unavailable" | "unknown" | "unsupported"
  checkedAt: string
  stale: boolean
  installed?: boolean
  authenticated?: boolean
  /** Commands from `driver.requirements` that the Driver shell cannot find. Present when requirements are checked. */
  missingCommands?: string[]
  reason?: string
  usageLimits?: AgentProviderUsageLimits
}

export interface AgentProviderDriverOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TOutput = unknown,
> {
  capacity?: AgentDriverCapacityOptions
  /**
   * Existing directory where the provider runs. The driver does not copy, snapshot, write back, or remove it.
   * Workspace Sources still materialize, but no Workspace session starts. Title and progress summary runs ignore it.
   */
  cwd?: AgentProviderWorkingDirectoryResolver<TRuntimeConfig>
  /** Provider process environment. Every resolved value is treated as a credential in persisted diagnostics. */
  env?: AgentProviderEnvironmentResolver<TRuntimeConfig>
  execution?: {
    attachments?: AgentAttachmentExecutionOptions
  }
  /**
   * Send model requests to an LLM proxy or gateway, such as `cliproxy({ url })` from `@vite-hub/agent/gateways`.
   * ViteHub writes the provider configuration and passes the key and headers in the provider environment.
   * A gateway replaces Codex `credentials`.
   */
  gateway?: AgentDriverGateway
  instructions?: AgentAdapterInstructions<TRuntimeConfig>
  launch?: AgentProviderLaunchResolver<TRuntimeConfig>
  model?: string
  output?: SingleAttemptAgentOutputDefinition<TOutput>
  /** Provider approval policy. Defaults to `"ask"`. `"allow-edits-unattended"` denies escalation without prompting; `"allow-all"` removes provider restrictions. */
  permissions?: AgentProviderPermissions
  providerSettings?: Record<string, unknown>
  /**
   * Commands the Driver shell needs, such as `git`, `gh`, or `unzip`.
   * `status()` checks them where the Driver runs. With `driver.launch`, a resolver is required
   * and each inspection probe checks commands in its shell before starting the provider.
   */
  requirements?: readonly string[]
  /** SQLite file used to persist provider session cursors across process restarts. */
  sessionStorePath?: string
  /**
   * Node.js and package manager pinned by the prepared checkout, with the same declaration as
   * `box.toolchain`. ViteHub provisions them on this host and puts them first on the PATH of the
   * provider and every command it starts. With `defineAgent({ box })`, declare `box.toolchain` instead.
   */
  toolchain?: BoxToolchain
}

export interface AgentProviderSealedCredential {
  unseal(): string
}

export type AgentProviderCredentialValue = string | AgentProviderSealedCredential

export interface AgentProviderCredentialContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> extends Omit<AgentAdapterMetadataContext<TRuntimeConfig>, "actor" | "invoker" | "workspace" | "fs"> {
  /** Inspection has no invocation, actor, or mounted Workspace. */
  purpose?: "invocation" | "inspection"
  actor?: AgentAdapterMetadataContext<TRuntimeConfig>["actor"]
  invoker?: AgentAdapterMetadataContext<TRuntimeConfig>["invoker"]
  workspace?: AgentAdapterMetadataContext<TRuntimeConfig>["workspace"]
  fs?: AgentAdapterMetadataContext<TRuntimeConfig>["fs"]
  abortSignal?: AbortSignal
}

export type AgentProviderEnvironment = Record<string, string | undefined>

export type AgentProviderEnvironmentResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<AgentProviderEnvironment, AgentProviderCredentialContext<TRuntimeConfig>>

export type AgentProviderWorkingDirectoryResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<string, AgentProviderCredentialContext<TRuntimeConfig>>

export interface AgentProviderExitContext {
  /** Provider working directory, still available during this callback. It is temporary unless `driver.cwd` is set. */
  cwd: string
  /** Independent teardown deadline. Stop all I/O when this signal aborts. */
  abortSignal: AbortSignal
}

export interface AgentProviderLaunchCommand {
  /** Host callback after provider shutdown, before Workspace cleanup. Not called by inspection or auxiliary runs. */
  onExit?: (context: AgentProviderExitContext) => MaybePromise<void>
  args?: readonly string[]
  command: string
}

export interface AgentProviderLaunchContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentProviderCredentialContext<TRuntimeConfig> {
  /** Executable the wrapper must start. Requirement inspection starts `sh`; invocations start the provider. */
  command: string
  /** Original provider executable. Use this to select a provider-specific runner. */
  providerCommand: string
  cwd: string
  environment: Readonly<AgentProviderEnvironment>
  /** Framework-owned environment names injected when the provider process starts. Filtered executors must forward them. */
  requiredEnvironment: readonly string[]
}

export type AgentProviderLaunchResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  MaybeResolvable<AgentProviderLaunchCommand, AgentProviderLaunchContext<TRuntimeConfig>>

export type AgentProviderCredentialResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> = MaybeResolvable<AgentProviderCredentialValue, AgentProviderCredentialContext<TRuntimeConfig>>

/**
 * A gateway API key or header value: a string, a sealed Server Env value, or an invocation-time resolver.
 * `undefined` or an empty string fails the invocation, so optional Server Env values can be passed directly.
 */
export type AgentDriverGatewaySecret = MaybeResolvable<AgentProviderCredentialValue | undefined, AgentProviderCredentialContext>

/**
 * An HTTP endpoint that receives the model requests of a provider Driver, such as an LLM proxy or gateway.
 * Build one with a preset from `@vite-hub/agent/gateways` or with `defineGateway()`.
 */
export interface AgentDriverGateway {
  /** Name shown in Agent inspection and diagnostics. */
  name: string
  /**
   * Base URL for each Driver. Codex sends OpenAI Responses requests to `<url>/responses`.
   * Claude Code sends Anthropic Messages requests to `<url>/v1/messages`.
   * A Driver without an entry cannot use this gateway. A resolver runs for each invocation, so the URL can come from Server Env.
   */
  baseURL: Partial<Record<BuiltInAgentDriverName, MaybeResolvable<string, AgentProviderCredentialContext>>>
  /** API key. When it is not set, ViteHub reads the first non-empty variable in `apiKeyEnv`. */
  apiKey?: AgentDriverGatewaySecret
  /** Process environment variables that supply the API key, in lookup order. */
  apiKeyEnv?: readonly string[]
  /** How the gateway receives the API key. `"bearer"` (default) sends `Authorization: Bearer`. `"x-api-key"` sends `x-api-key`. */
  auth?: "bearer" | "x-api-key"
  /** Extra request headers, such as Cloudflare Access service-token headers. Values are treated as secrets. */
  headers?: Record<string, AgentDriverGatewaySecret>
}

type KnownCodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
/** A non-empty reasoning effort advertised by the selected Codex model. */
export type CodexReasoningEffort = KnownCodexReasoningEffort | (string & Record<never, never>)
export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none"

export interface CodexDriverOptions<TOutput = unknown> extends AgentProviderDriverOptions<AgentRuntimeConfig, TOutput> {
  credentialProfile?: string
  credentials?: AgentProviderCredentialResolver
  /** Advanced Codex runtime settings passed to the provider runtime. */
  providerSettings?: Record<string, unknown>
  reasoningEffort?: CodexReasoningEffort
  reasoningSummary?: CodexReasoningSummary
}
export type ClaudeCodeDriverOptions<TOutput = unknown> = AgentProviderDriverOptions<AgentRuntimeConfig, TOutput>

export type BuiltInAgentDriverName = "claude-code" | "codex"

declare const agentDriverCallOptions: unique symbol

type AgentDriverCallOptions<CALL_OPTIONS> = {
  readonly [agentDriverCallOptions]?: (options: CALL_OPTIONS) => CALL_OPTIONS
}

export type BuiltInAgentDriver<CALL_OPTIONS = unknown, TOutput = unknown> =
  | BuiltInAgentDriverName
  | (AgentDriverCallOptions<CALL_OPTIONS> & { kind: "codex" } & CodexDriverOptions<TOutput>)
  | (AgentDriverCallOptions<CALL_OPTIONS> & { kind: "claude-code" } & ClaudeCodeDriverOptions<TOutput>)

export interface AgentModelDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
> {
  ask?: never
  capacity?: AgentDriverCapacityOptions
  credentials?: never
  cwd?: never
  execution?: AgentModelExecutionOptions<TRuntimeConfig, CALL_OPTIONS>
  instructions?: AgentAdapterInstructions<TRuntimeConfig>
  kind?: never
  gateway?: never
  launch?: never
  maxRetries?: number
  model: AgentModelResolver<TRuntimeConfig>
  output?: AgentOutputDefinition<TOutput>
  permissionMode?: never
  permissions?: never
  providerSettings?: never
  reasoningEffort?: never
  reasoningSummary?: never
  sessionStorePath?: never
  toolchain?: never
  run?: never
  sandbox?: never
  sessionKey?: never
  workDir?: never
}

export interface AgentRunDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
  TOutput = unknown,
> {
  ask?: never
  capacity?: AgentDriverCapacityOptions
  credentials?: never
  cwd?: never
  execution?: never
  instructions?: never
  kind?: never
  gateway?: never
  launch?: never
  model?: never
  output?: SingleAttemptAgentOutputDefinition<TOutput>
  permissionMode?: never
  permissions?: never
  providerSettings?: never
  reasoningEffort?: never
  reasoningSummary?: never
  sessionStorePath?: never
  toolchain?: never
  run: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  sandbox?: never
  sessionKey?: never
  workDir?: never
}

/** Jev questions whose answers form `TOutput`. Build each question with `ask.choice()`, `ask.score()`, and the other `ask` builders. */
export type AgentAskQuestions<TOutput = Record<string, unknown>> = {
  readonly [K in keyof TOutput]: AskQuestion & AskAnswerType<TOutput[K]>
}

export type AgentAskQuestionsResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
  TOutput = Record<string, unknown>,
> =
  | AgentAskQuestions<TOutput>
  | ((context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS, WorkspaceName, TContextValues>) => MaybePromise<AgentAskQuestions<TOutput>>)

/**
 * Answers typed questions with TypeSafe Jev in one request. The answers are the Invocation output.
 * Jev reads Invocation `data` when present, else the prompt, else the latest user message.
 * Credentials and the model come from the Server Env group `typesafe`, declared with `typesafeEnv()`.
 */
export interface AgentAskDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
  TOutput = unknown,
> {
  ask: AgentAskQuestionsResolver<TRuntimeConfig, CALL_OPTIONS, TContextValues, TOutput>
  capacity?: AgentDriverCapacityOptions
  credentials?: never
  execution?: never
  instructions?: never
  kind?: never
  gateway?: never
  launch?: never
  model?: never
  permissionMode?: never
  permissions?: never
  providerSettings?: never
  reasoningEffort?: never
  reasoningSummary?: never
  sessionStorePath?: never
  toolchain?: never
  run?: never
  sandbox?: never
  sessionKey?: never
  workDir?: never
}

export type AgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
  TOutput = unknown,
> =
  | AgentModelDriver<TRuntimeConfig, CALL_OPTIONS, TOutput>
  | AgentRunDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues, TOutput>
  | AgentAskDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues, TOutput>
  | BuiltInAgentDriver<CALL_OPTIONS, TOutput>

export type CustomAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
  TOutput = unknown,
> =
  | AgentModelDriver<TRuntimeConfig, CALL_OPTIONS, TOutput>
  | AgentRunDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues, TOutput>
  | AgentAskDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues, TOutput>

export interface AgentDefinitionCliOptions {
  capabilities?: boolean
}

export interface AgentOutputDefinition<TOutput = unknown> {
  maxAttempts?: number
  schema: StandardSchemaV1<unknown, TOutput>
}

export interface AgentUIMessageStreamProjection {
  commentary?: "hidden" | "visible"
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

/** Hooks accepted by an Agent Definition. `TMessage` types `event.message` in outcome hooks. */
export type AgentDefinitionHooks<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContextValues extends object = AgentInvocationContextValues,
  TOutput = unknown,
  TMessage = AgentChannelMessage | undefined,
  TData = unknown,
> = AgentCapabilityHooks<TRuntimeConfig> & AgentHookObserverHooks & AgentInvocationHooks<TRuntimeConfig, CALL_OPTIONS, TContextValues, TOutput, TMessage, TData>

type AgentSharedSettings<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
  TCapabilities extends AgentCapabilitiesInput<TRuntimeConfig, WorkspaceName, CALL_OPTIONS> | undefined = AgentCapabilitiesInput<TRuntimeConfig, WorkspaceName, CALL_OPTIONS> | undefined,
  TOutput = unknown,
  TData = unknown,
  TIntercept = never,
  TDataInput = TData,
> = {
  /** Run the built-in provider Driver inside this Box. Each invocation opens a new Box session. */
  box?: AgentBoxDefinition<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  /**
   * GitHub identity for this Agent. Provider Drivers receive its `access().env`,
   * and the pull request checkout and `git()` use its token.
   */
  github?: AgentGitHub
  health?: AgentHealthDescriptor
  capabilities?: TCapabilities
  channels?: AgentChannelInputs<TRuntimeConfig>
  cli?: AgentDefinitionCliOptions
  /** Standard Schema for Invocation `data`. ViteHub validates `data` before Capabilities, hooks, and the Driver run. */
  data?: StandardSchemaV1<TDataInput, TData>
  description?: string
  hooks?: AgentCapabilityHooks<TRuntimeConfig> & AgentHookObserverHooks & AgentInvocationHooks<TRuntimeConfig, CALL_OPTIONS, TContextValues, TOutput | TIntercept, AgentChannelMessage | undefined, TData>
  /** Finishes the Invocation before the Driver runs when it returns a value other than `undefined`. */
  intercept?: AgentInterceptHandler<TRuntimeConfig, CALL_OPTIONS, TContextValues, TData, TIntercept>
  invoker?: AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues>
  invocations?: AgentInvocations
  messages?: AgentMessageChannelSettings<TRuntimeConfig>
  name?: string
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
  TDriver extends AgentDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues, TOutput> = AgentDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues, TOutput>,
  TData = unknown,
  TIntercept = never,
  TDataInput = TData,
> = AgentSharedSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues, TCapabilities, TOutput, TData, TIntercept, TDataInput> & {
  driver: TDriver
}

declare const agentOutputType: unique symbol
declare const agentDataType: unique symbol
declare const agentDriverOutputType: unique symbol
declare const agentInterceptOutputType: unique symbol

/** Carries the Invocation `data` type that `runAgent()` and related calls accept. This is the `data` schema input type. */
export interface AgentDataCarrier<TDataInput = unknown> {
  [agentDataType]?: TDataInput
}

declare const agentDataOutputType: unique symbol

export interface AgentDataOutputCarrier<TData = unknown> {
  [agentDataOutputType]?: TData
}

export interface AgentDriverOutputCarrier<TOutput = unknown> {
  [agentDriverOutputType]?: [TOutput]
}

export interface AgentInterceptOutputCarrier<TOutput = unknown> {
  [agentInterceptOutputType]?: [TOutput]
}

export interface AgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
  TOutput = unknown,
  TDataInput = unknown,
  TDriverOutput = TOutput,
  TData = unknown,
  TInterceptOutput = TOutput,
> extends AgentDataCarrier<TDataInput>, AgentDataOutputCarrier<TData>, AgentDriverOutputCarrier<TDriverOutput>, AgentInterceptOutputCarrier<TInterceptOutput> {
  [agentOutputType]?: TOutput
  box?: AgentBoxDefinition<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  github?: AgentGitHub
  health?: AgentHealthDescriptor
  capabilities?: AgentCapabilityDefinition<TRuntimeConfig>[]
  channels?: AgentChannels<TRuntimeConfig>
  chat?: AgentChatOptions<TRuntimeConfig>
  cli?: AgentDefinitionCliOptions
  description?: string
  hooks?: AgentCapabilityHooks<TRuntimeConfig, WorkspaceName> & AgentHookObserverHooks & AgentInvocationHooks<TRuntimeConfig, CALL_OPTIONS, TContextValues, TOutput, AgentChannelMessage | undefined, TData>
  invoker?: AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues>
  invocations?: AgentInvocations
  messages?: AgentMessageChannelSettings<TRuntimeConfig>
  name?: string
  runtime?: AgentRuntimeBinding
  runEvents?: AgentRunEvents
  /** Inspect provider credentials and quota without creating an invocation or sending a prompt. */
  status?(context: AgentRuntimeContext<TRuntimeConfig>, options?: {
    abortSignal?: AbortSignal
    /** Defaults to true. Invocation preflight sets false to avoid repeating command checks. */
    checkRequirements?: boolean
  }): Promise<AgentProviderStatus>
  resolve(context: AgentRuntimeContext<TRuntimeConfig>): Promise<AgentAdapter<CALL_OPTIONS>>
  run?(context: AgentRunContext<TRuntimeConfig, CALL_OPTIONS, WorkspaceName, TContextValues>): MaybePromise<Response | AgentRunResult | AsyncIterable<StreamEvent> | unknown>
  uiMessageStream?: AgentUIMessageStreamProjectionResolver<TRuntimeConfig, CALL_OPTIONS, TContextValues>
  version?: string
  workspace?: WorkspaceAgentWorkspaceConfig
}

export type AgentInput<
  TContext extends AgentRuntimeContext<any> = AgentRuntimeContext,
  TOutput = unknown,
  CALL_OPTIONS = any,
  TInvokerProfile extends AgentInvokerProfile = any,
> = AgentDefinition<TContext extends AgentRuntimeContext<infer TRuntimeConfig> ? TRuntimeConfig : AgentRuntimeConfig, CALL_OPTIONS, TInvokerProfile, any, TOutput, unknown, TOutput, unknown, unknown>

export type AgentRegistryModule<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  | { default?: AgentInput<TContext> }
  | AgentInput<TContext>

export type AgentRegistry<TContext extends AgentRuntimeContext<any> = AgentRuntimeContext> =
  Record<string, () => MaybePromise<AgentRegistryModule<TContext>>>

export interface AgentStateProviderOptions {
  authToken?: string
  /** Persistent file databases default to WAL. Select delete for network-backed volumes. */
  journalMode?: "wal" | "delete"
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

export interface AgentWebhookAlias {
  agent: string
  webhook: string
}

export interface AgentRoutesOptions {
  /** Additional public paths handled by an existing Agent webhook, without an HTTP proxy. */
  aliases?: Record<string, AgentWebhookAlias>
  discordGateway?: AgentRouteOption
  inspection?: AgentRouteOption
}

export interface ResolvedAgentRoutesOptions {
  aliases?: Record<string, AgentWebhookAlias>
  discordGateway: false | string
  inspection: false | string
  webhooks: string
}

export interface AgentPreparationOptions {
  workspace: string
  requireNonEmpty?: boolean
  retryDelayMs?: number
  /** Readiness probe path. Defaults to /api/_vitehub/ready. */
  route?: string
}

export interface AgentModuleOptions {
  /** Prepare startup Workspace sources on a persistent Nitro host. */
  preparation?: AgentPreparationOptions
  cli?: false | AgentCliOptions
  execution?: AgentExecution
  eval?: AgentEvalOptions
  imports?: boolean
  integrations?: AgentIntegrationsOptions
  providers?: AgentProvidersOptions
  routes?: AgentRoutesOptions
  runtime?: AgentRuntime
}

export interface ResolvedAgentModuleOptions {
  preparation?: AgentPreparationOptions
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

export type AgentChatTriggerHistory = "none" | { maxAgeMs?: number, maxMessages: number, source: "thread" }

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

export interface AgentChatAgentHookArgs<_TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends Record<string, unknown> {
  history: Message[]
  message: AgentChatMessageHookArgs
  run?: AgentRunMetadata
  session?: {
    action?: "continue" | "new" | "switch"
    id?: string
  }
  thread: { post: (message: unknown) => MaybePromise<unknown> }
}

export interface AgentChatErrorHookArgs<_TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends AgentChatAgentHookArgs<_TRuntimeConfig> {
  error: unknown
  /** The failed Invocation, when the error belongs to a run. */
  invocation?: AgentInvocationReference
  publicError: AgentPublicError
  toolResults: AgentToolStepItem[]
}

export interface AgentChatEventHookArgs<_TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends Record<string, unknown> {
}

export interface AgentChatEventHooks<_TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends Record<string, unknown> {
  onDirectMessage?: (args: { message: { text: string } } & AgentChatEventHookArgs<_TRuntimeConfig>) => MaybePromise<void>
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
  | AgentChannelDeliveryReplyStream
  | { text: string }
  | ((Exclude<AdapterPostableMessage, string> | { text: string }) & {
    artifacts?: readonly PublishedAgentDeliveryArtifact[]
  })

export type AgentChatSendMessage = (message: AgentChatMessage) => Promise<void>

export type AgentMessageConcurrency = "drop" | "parallel" | "queue" | "reject" | "serial" | "steer" | (string & {})

export type AgentMessageDeliveryKind = "direct" | "mention" | "subscribed"

export type AgentMessageLockScope = "agent" | "channel" | "thread" | (string & {})

export interface AgentMessageFilterContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentCallbackContext<TRuntimeConfig> {
  deliveryKind: AgentMessageDeliveryKind
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
  delivery?: "automatic" | "manual"
  durable?: boolean
  /**
   * Add the Console URL of the failed Invocation to each error reply.
   * Off by default, because the link shows internal details to the people in the conversation.
   */
  errorConsoleLink?: boolean
  errorFallbackText?: string | null | ((context: AgentChatErrorHookArgs<TRuntimeConfig> & {
    /** The text ViteHub sends when `errorFallbackText` is not set. */
    defaultText: string
  }) => MaybePromise<string | null | undefined>)
  fallbackStreamingPlaceholderText?: string | readonly string[] | null | ((context: AgentChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<string | null | undefined>)
  final?: {
    delivery: "new-message"
  }
  filter?: AgentMessageFilter<TRuntimeConfig>
  identity?: IdentityResolver
  loading?: {
    intervalMs?: number
    text: string | readonly string[] | null | ((context: AgentChatAgentHookArgs<TRuntimeConfig>) => MaybePromise<string | null | undefined>)
    updates?: "commentary"
  }
  lockScope?: AgentMessageLockScope
  messageHistory?: unknown
  /** Accept human replies without a mention only in threads subscribed through this Agent's chat state. Defaults to false. */
  replyToSubscribedThreads?: boolean
  meta?: StandardSchemaV1<unknown, Record<string, unknown>>
  metaRevision?: string
  sessions?: boolean | AgentChatSessionOptions
  state?: AgentChatStateResolver<TRuntimeConfig>
  stream?: boolean
  streamingUpdateIntervalMs?: number
  threadHistory?: unknown
  timeout?: number
  transcripts?: TranscriptsConfig
  triggerHistory?: AgentChatTriggerHistory
  userName?: string
  [key: string]: unknown
}

export interface AgentActivityUpdate {
  /** ISO timestamp when execution began, excluding admission delay. */
  startedAt?: string
  /** ISO timestamp of the latest lifecycle transition. */
  updatedAt?: string
  agentName?: string
  error?: string
  links: readonly AgentActivityLink[]
  runId: string
  status: AgentActivityStatus
  summary?: string
  tasks: readonly AgentActivityTask[]
}

export interface AgentChannelActivityContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentCallbackContext<TRuntimeConfig> {
  activity: AgentActivityUpdate
  /** Stop activity publication and provider I/O when this signal aborts. */
  abortSignal?: AbortSignal
  channel: AgentChannelDefinition<TRuntimeConfig>
  target: AgentActivityTarget
}

export interface AgentChannelActivityDefinition<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  update(context: AgentChannelActivityContext<TRuntimeConfig>): MaybePromise<void>
}

export interface AgentChannelMessageContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TData = unknown,
> extends AgentCallbackContext<TRuntimeConfig> {
  channel: AgentChannelDefinition<TRuntimeConfig>
  context: AgentInvocationContextStore
  input: AgentRunInput
  /** Message data returned by the Channel trigger. */
  message: TData
  request?: Request
  run?: AgentRunMetadata
  trigger?: {
    channelId: string
    id?: string
    name?: string
  }
  workspace?: ReadonlyWorkspaceFacade | WritableWorkspaceFacade
}

export type AgentChannelMessageMethodHandler<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TData = unknown,
> = {
  bivarianceHack(context: AgentChannelMessageContext<TRuntimeConfig, TData>, ...args: never[]): unknown
}["bivarianceHack"]

/**
 * A function is a write method. A dry run records its call instead of running it.
 * Use `{ read: true, handler }` for a method that only reads provider state.
 */
export type AgentChannelMessageMethod<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TData = unknown,
> =
  | AgentChannelMessageMethodHandler<TRuntimeConfig, TData>
  | { read: true, handler: AgentChannelMessageMethodHandler<TRuntimeConfig, TData> }

/** `channel`, `data`, `kind`, and `then` are reserved for the handle's own properties and Promise protocol. */
export type AgentChannelMessageMethods<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TData = unknown,
> = Record<string, AgentChannelMessageMethod<TRuntimeConfig, TData>> & { [TName in "channel" | "data" | "kind" | "then"]?: never }

export interface AgentChannelMessageDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TData = unknown,
  TMethods extends AgentChannelMessageMethods<TRuntimeConfig, TData> = AgentChannelMessageMethods<TRuntimeConfig, TData>,
> {
  /** Standard Schema for the message data that Channel triggers return. */
  data?: StandardSchemaV1<unknown, TData>
  methods?: TMethods
}

type AgentChannelMessageMethodArgs<TMethod> =
  TMethod extends { handler: (context: never, ...args: infer TArgs) => unknown } ? TArgs
    : TMethod extends (context: never, ...args: infer TArgs) => unknown ? TArgs
      : never

type AgentChannelMessageMethodResult<TMethod> =
  TMethod extends { handler: (...args: never[]) => infer TResult } ? TResult
    : TMethod extends (...args: never[]) => infer TResult ? TResult
      : never

/** Callable form of Channel message methods, without the Channel context argument. */
export type AgentChannelMessageCalls<TMethods> = {
  readonly [TName in keyof TMethods]: (...args: AgentChannelMessageMethodArgs<TMethods[TName]>) => Promise<Awaited<AgentChannelMessageMethodResult<TMethods[TName]>> | (TMethods[TName] extends { read: true } ? never : undefined)>
}

/** Message methods available when Discord, Slack, Teams, or Telegram has an adapter and messages are enabled. */
export interface AgentChannelReplyCalls {
  /** Present when the Channel has a delivery adapter. */
  readonly reply?: (input: AgentChannelDeliveryReplyInput) => Promise<void>
}

/** Message methods that the GitHub Channel provides. They exist only when the Channel has a GitHub App. */
export interface AgentGitHubMessageCalls {
  readonly reaction?: (input: AgentChannelDeliveryReactionInput) => Promise<void>
  /** Present when the Channel has a GitHub App. */
  readonly reply?: (input: AgentChannelDeliveryReplyInput) => Promise<void>
  readonly status?: (input: AgentChannelDeliveryStatusInput) => Promise<void>
}

type AgentMessageChannelKind = "discord" | "slack" | "teams" | "telegram"

type AgentBuiltInChannelMessageCalls<TKind extends string> =
  string extends TKind ? Record<never, never>
    : TKind extends "github" ? AgentGitHubMessageCalls
      : TKind extends AgentMessageChannelKind ? AgentChannelReplyCalls
        : Record<never, never>

/**
 * Handle for the Channel message that started an Invocation.
 * `channel` is the name in the Agent's `channels` map; it discriminates Agents with several Channels.
 */
export type AgentChannelMessage<
  TChannel extends string = string,
  TKind extends string = string,
  TData = unknown,
  TCalls = Record<never, never>,
> = {
  readonly channel: TChannel
  /** Message data returned by the Channel trigger. */
  readonly data: TData
  readonly kind: TKind
} & TCalls

/** A Channel Definition that keeps its kind, message data, and message methods in its type. */
export type AgentChannelDefinitionOf<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TKind extends string = string,
  TData = unknown,
  TMethods extends AgentChannelMessageMethods<TRuntimeConfig, TData> = Record<never, never>,
> = Omit<AgentChannelDefinition<TRuntimeConfig>, "kind" | "message"> & {
  readonly kind: TKind extends "portal" ? string : TKind
  readonly message?: AgentChannelMessageDefinition<TRuntimeConfig, TData, TMethods>
}

type AgentChannelInputKind<TName extends string> =
  TName extends "webChat" ? "web-chat" : TName extends "discord" | "github" | "http" | "slack" | "teams" | "telegram" ? TName : string

type AgentChannelMessageDefinitionOf<TInput> = TInput extends { message?: infer TMessage } ? NonNullable<TMessage> : never

type AgentChannelMessageData<TInput> =
  AgentChannelMessageDefinitionOf<TInput> extends { data?: infer TSchema }
    ? NonNullable<TSchema> extends StandardSchemaV1<unknown, infer TData> ? TData : unknown
    : unknown

/** Declared methods only. The index signature of the base Channel type declares none. */
type AgentChannelDeclaredMethods<TInput> =
  AgentChannelMessageDefinitionOf<TInput> extends { methods?: infer TMethods }
    ? string extends keyof NonNullable<TMethods> ? Record<never, never> : NonNullable<TMethods>
    : Record<never, never>

type AgentChannelMessageFromInput<TName extends string, TInput> =
  TInput extends (...args: never[]) => infer TDefinition
    ? AgentChannelMessageFromInput<TName, TDefinition>
    : TInput extends { kind: infer TKind extends string }
      ? AgentChannelMessage<
        TName,
        TKind,
        AgentChannelMessageData<TInput>,
        Omit<AgentBuiltInChannelMessageCalls<TKind>, keyof AgentChannelDeclaredMethods<TInput>> & AgentChannelMessageCalls<AgentChannelDeclaredMethods<TInput>>
      >
      : AgentChannelMessage<
        TName,
        AgentChannelInputKind<TName>,
        AgentChannelMessageData<TInput>,
        Omit<AgentBuiltInChannelMessageCalls<AgentChannelInputKind<TName>>, keyof AgentChannelDeclaredMethods<TInput>> & AgentChannelMessageCalls<AgentChannelDeclaredMethods<TInput>>
      >

/** Hook `event.message` type for an Agent's `channels` option. */
export type AgentChannelMessageOf<TChannels> =
  [TChannels] extends [undefined]
    ? undefined
    : { [TName in keyof TChannels & string]: AgentChannelMessageFromInput<TName, NonNullable<TChannels[TName]>> }[keyof TChannels & string] | undefined

/** Request query for a Channel history Collection: one string or repeated strings per key. */
export type AgentChannelHistoryQuery = Record<string, string | readonly string[] | undefined>

/**
 * The part of a `@vite-hub/source` Collection that Channel replay uses.
 * A Collection from `defineCollection()` satisfies it.
 */
export interface AgentChannelHistoryCollection<TItem = unknown> {
  page(options: { cursor?: string, limit?: number, query: object, signal?: AbortSignal }): Promise<{ items: TItem[], nextCursor: string | null }>
  parseQuery(input: AgentChannelHistoryQuery): Promise<object>
  readonly querySchema?: StandardSchemaV1
}

/** Past Channel messages that `replayChannel()` sends through a Channel trigger. */
export interface AgentChannelHistory<TItem = unknown> {
  /** Collection of past messages. Each item is the input of `trigger`. */
  collection: AgentChannelHistoryCollection<TItem>
  /** Returns a stable key for an item, such as the provider message ID. Replay derives the Invocation ID from it. */
  key(item: TItem): string
  /** Conversation that the item belongs to. Used to group exports and filter them by thread. */
  thread?(item: TItem): string
  /** Recover a history item from a retained Invocation without vitehub.channel.key. The journal does not retain raw trigger input or input.context. Return undefined when its identity cannot be recovered. */
  invocationItem?(invocation: AgentInvocationRecord): MaybePromise<TItem | undefined>
  /** Channel trigger that receives each item. Optional when the Channel has exactly one trigger. */
  trigger?: string
}

export interface AgentChannelDefinition<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  /** Internal delivery handlers for built-in Channels. */
  [channelDeliveryHandlers]?: AgentChannelDeliveryEffects<TRuntimeConfig>
  activity?: AgentChannelActivityDefinition<TRuntimeConfig>
  adapter?: AgentChatPlatformResolver<TRuntimeConfig>
  capabilities?: readonly AgentCapabilityDefinition<TRuntimeConfig>[]
  /** Past messages that `replayChannel()` and `vitehub channels replay` send through a trigger. */
  history?: AgentChannelHistory
  identity?: IdentityResolver
  kind: string
  listener?: { kind: "telegram-polling" }
  /** Methods that hooks call through `event.message`. */
  message?: AgentChannelMessageDefinition<TRuntimeConfig>
  messages?: false | AgentMessageChannelSettings<TRuntimeConfig>
  route?: unknown
  triggers?: Record<string, AgentTriggerDefinition<TRuntimeConfig, WorkspaceName, any, any, AgentChannelTriggerContext<TRuntimeConfig>>>
  webhooks?: boolean | AgentChannelWebhookRegistrationDefinition<TRuntimeConfig> | AgentChannelWebhookRegistrationDefinition<TRuntimeConfig>[]
}

export type AgentChannelFactory<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  () => AgentChannelDefinition<TRuntimeConfig>

export type AgentChannelInput<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  AgentChannelDefinition<TRuntimeConfig> | AgentChannelFactory<TRuntimeConfig>

type AgentBuiltInChannelInput<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  | AgentChannelInput<TRuntimeConfig>
  | AgentChannelOptions<TRuntimeConfig>
  | AgentWebChatChannelOptions<TRuntimeConfig>
  | DiscordChannelOptions<TRuntimeConfig>
  | GitHubChannelOptions<TRuntimeConfig>
  | TelegramChannelOptions<TRuntimeConfig>

export type AgentChannelInputs<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  Record<string, AgentBuiltInChannelInput<TRuntimeConfig>> & {
    discord?: AgentChannelInput<TRuntimeConfig> | DiscordChannelOptions<TRuntimeConfig>
    github?: AgentChannelInput<TRuntimeConfig> | GitHubChannelOptions<TRuntimeConfig>
    http?: AgentChannelInput<TRuntimeConfig> | AgentChannelOptions<TRuntimeConfig>
    slack?: AgentChannelInput<TRuntimeConfig> | AgentChannelOptions<TRuntimeConfig>
    teams?: AgentChannelInput<TRuntimeConfig> | AgentChannelOptions<TRuntimeConfig>
    telegram?: AgentChannelInput<TRuntimeConfig> | TelegramChannelOptions<TRuntimeConfig>
    webChat?: AgentChannelInput<TRuntimeConfig> | AgentWebChatChannelOptions<TRuntimeConfig>
  }

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
  meta?: never
  metaRevision?: never
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
export type AgentToolSchema<T = unknown> = AgentToolStandardSchema<T> | StandardSchemaV1<unknown, T> | (JSONSchema7 & { "~standard"?: never })

export interface AgentToolExecutionContext {
  abortSignal?: AbortSignal
  toolCallId?: string
}

export interface AgentToolDefinition<TInput = unknown, TOutput = unknown> {
  activity?: AgentActivity
  description?: string
  execute?: (input: TInput, context?: AgentToolExecutionContext) => MaybePromise<TOutput>
  /** Iconify icon name for inspection interfaces, for example `i-lucide-database`. The Console includes the Lucide set. */
  icon?: string
  inputSchema?: AgentToolSchema<TInput>
  metadata?: Record<string, unknown>
  name: string
  outputSchema?: AgentToolSchema<TOutput>
  policy?: AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)
  /** Short past-tense label for each call in traces, for example `Searched meals`. */
  title?: string
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
  materialize?: "build" | "startup" | "lazy"
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

export type AgentInspectionValue = boolean | null | number | string | AgentInspectionValue[] | {
  [key: string]: AgentInspectionValue
}

export interface AgentInspectionCapabilityMetadata {
  id: string
  metadata: Record<string, AgentInspectionValue>
}

export interface AgentInspectionModelMetadata {
  dynamic?: boolean
  id?: string
  provider?: string
  transport?: string
}

export interface AgentInspectionModelExecutionMetadata {
  callSettings?: Record<string, AgentInspectionConfigValue>
  stepLimit?: number
  workspaceFallback?: {
    enabled?: boolean
    maxToolResults?: number
  }
}

export interface AgentInspectionProviderMetadata {
  credentialProfile?: string
  credentials?: true
  /** Present when driver.cwd runs the provider in an existing directory. The path is not exposed. */
  cwd?: "dynamic" | "static"
  environment?: "dynamic" | "static"
  /** Name of the gateway that receives model requests. */
  gateway?: string
  launch?: "dynamic" | "static"
  model?: string
  permissions: AgentProviderPermissions
  provider?: string
  providerSettings?: string[]
  requirements?: readonly string[]
  reasoningEffort?: CodexReasoningEffort
  reasoningSummary?: CodexReasoningSummary
  sessionStore?: "sqlite"
  toolchain?: BoxToolchain
}

export interface AgentInspectionDriverMetadata {
  capacity?: Omit<AgentDriverCapacityOptions, "adaptive"> & {
    active: number
    effectiveConcurrency?: number
    lastSampleAt?: number
    pending: number
    reason?: string
  }
  readonly executionAuthority: ExecutionAuthority
  execution?: AgentInspectionModelExecutionMetadata
  kind: AgentDriverKind | "unknown"
  model?: AgentInspectionModelMetadata
  provider?: AgentInspectionProviderMetadata
}

export interface AgentInspectionConfigMetadata {
  driver: AgentInspectionDriverMetadata
  uiMessageStream?: AgentUIMessageStreamProjection
}

export interface AgentInspectionMetadata {
  capabilities?: AgentInspectionCapabilityMetadata[]
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
  display: string
  estimated: boolean
  source: "custom" | "estimated" | "models.dev" | "provider" | (string & {})
  usd: string
}

export interface AgentUsageCredentialSource {
  label?: string
  source?: "ambient" | "explicit" | "none" | "unknown" | (string & {})
}

export interface AgentUsageRecord {
  calls?: AgentUsageRecord[]
  cost?: AgentUsageCost
  credentialSource?: AgentUsageCredentialSource
  latency?: {
    durationMs?: number
    timeToFirstTokenMs?: number
    tokensPerSecond?: number
  }
  model?: string
  provider?: string
  raw?: unknown
  response?: {
    finishReason?: unknown
    id?: string
    timestamp?: Date | string
  }
  run?: Partial<AgentRunMetadata>
  transport?: "gateway" | (string & {})
  usage?: AgentUsage
}

/** Verified mounted Sources available to an invocation's instruction resolver. */
export interface AgentSourceProvenance {
  mount: string
  provider: "github"
  repository: string
  revision: { id: string, ref?: string }
  root: string
  source: string
}

export interface AgentAdapterMetadataContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends AgentCallbackContext<TRuntimeConfig>, AgentInvocationCallbackContextValues {
  /** Present after a provider Workspace is prepared; omitted during static inspection. */
  sourceProvenance?: readonly AgentSourceProvenance[]
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
  close?: () => Promise<void>
  context: AgentInvocationContextStore
  toolStepReporter?: AgentRuntimeContext<TRuntimeConfig>["toolStepReporter"]
  driverContributions?: AgentDriverContribution[]
  hasCapabilityCleanup?: boolean
  input: AgentRunInput<TOptions>
  instructions?: string
  invoker: AgentInvoker
  messages: Message[]
  modelExecutionInstrumentation?: AgentModelExecutionInstrumentation[]
  nativeStructuredOutput?: boolean
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
  workspaceMaterializationPaths?: readonly string[]
  workspaceMode?: AgentCapabilityMode
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
