import agentRegistry from "#vitehub/agent/registry"
import { acquireAgentCapacity, configureAgentCapacity, inspectAgentCapacity } from "./internal/agent-capacity.ts"
import { normalizeAgentDriver } from "./internal/agent-driver.ts"
import { agentOutputEventObserverContextKey, progressSummaryOutputContextKey, type AgentOutputEventObserver } from "./internal/agent-output-events.ts"
import { openAgentInvocationLifecycle, type AgentInvocationLifecycle } from "./internal/invocation-lifecycle.ts"
import { cloneWithPropertyDescriptors, toReadableAsyncIterableStream } from "./internal/stream-result.ts"
import { validateAgentOutput } from "./internal/agent-structured-output.ts"
import { loadAgentWorkflowModule, loadAgentWorkflowRuntimeStateModule } from "./internal/workflow-runtime-loaders.ts"
import { agentErrorDetails, agentErrorMessage } from "./agent-error.ts"
import {
  createBackedAgentInvocationController,
  startLiveAgentInvocation,
} from "./agent-invocation.ts"
import { agentInvocationInputSupport, sendAgentInvocationInput, withAgentInvocationControlId } from "./internal/agent-invocation-control.ts"
import {
  createReactionDeliveryEffectIntent,
  createReplyDeliveryEffectIntent,
  createStatusDeliveryEffectIntent,
} from "./delivery-effects.ts"
import { createTraceEventLog, getViteHubErrorShape, resolveRuntimeContext } from "@vite-hub/runtime"
import { agentResultKind, finalTextFromAgentOutput, hasTraceableStreamResult, isAsyncIterable, resolveAgentUsageRecord, streamAgentOutputToEvents, toAgentRunResult, toAgentStreamEvent, usageRecordFromStreamChunk } from "./agent-output.ts"
import { defineChatCapability, getChatCapabilityOptions } from "./chat-trigger.ts"
import {
  bindMessageChannelInstructions,
  finishMessageChannelTitleDelivery,
  isMessageChannelTitleEffectIntent,
  messageChannelTitleDeliveredContextKey,
  prepareMessageChannelTitleDelivery,
  resolveAgentChannelChatOptions,
} from "./internal/channels.ts"
import type { MessageChannelTitleDeliveryAttempt } from "./internal/channels.ts"
import {
  discord as builtInDiscord,
  github as builtInGitHub,
  http as builtInHttp,
  channelHasCustomTitleEffect,
  messageChannelSupportsTitleEffect,
  messageChannelTitleSupportContextKey,
  slack as builtInSlack,
  teams as builtInTeams,
  telegram as builtInTelegram,
  webChat as builtInWebChat,
} from "./channels.ts"
import { agentInvocationCallbackContextValues, createAgentInvocationContextStore } from "./invocation-context.ts"
import { bindAgentRunEvents } from "./run-events.ts"
import type { AgentMessagePhase } from "./messages.ts"
import {
  createFallbackAgentInvoker,
  normalizeAgentInvokerOptions,
  resolveAgentInvoker,
} from "./invoker.ts"
import {
  parseScheduledAgentTurnInput,
  scheduledAgentChannelIdsContextKey,
  scheduledAgentNameContextKey,
  scheduledAgentTurnContextKey,
} from "./internal/scheduled-turn.ts"
import { finalChannelOutputContextKey, finalChannelOutputSelectedSymbol, responseTitleFallbackContextKey } from "./internal/final-channel-output.ts"
import { synthesizedAgentOutputSymbol } from "./internal/synthesized-agent-output.ts"
import {
  colocatedAgentSkillsContextKey,
  colocatedAgentSkillsSymbol,
  type ColocatedAgentSkills,
} from "./internal/colocated-agent-skills.ts"

import {
  applyCapabilityToolTransforms,
  applyOutputRenderers,
  createAgentInvocationExtensions,
  normalizeCapabilities,
  resolveAgentCapabilities,
  resolveAgentCapabilityDefinitions,
  resolveStaticCapabilityTools,
  validateAgentCapabilityComposition,
  withCapabilityCleanup,
  withResponseCleanup,
} from "./capability-runtime.ts"
import type { AgentCapabilityRegistries, CapabilityCleanupOutcome, ResolvedAgentFinishExtensionProvider, ResolvedAgentOutputExtensionProvider } from "./capability-runtime.ts"
import { formatUnknownAgentMessage } from "./registry-error.ts"
import { cancellableAsyncIterableSource, createAgentUIMessageStreamResponse, finalizeUiMessageStreamOutput, isUIMessageStreamResponse, isUIMessageStreamResult, normalizeUiMessageStream, uiMessageStreamFromResponse, uiMessageTextDelta, withReadableStreamCleanup } from "./stream-output.ts"
import {
  applyAgentToolPolicies,
  withAgentToolStepReporting,
  withJsonCompatibleToolOutputs,
} from "./tool-runtime.ts"
import {
  traceAgentInvocationError,
  traceAgentChannelDeliveryEffect,
  traceAgentInvocationFinish,
  traceAgentInvocationStart,
  traceAgentStreamEvent,
  traceAgentStreamEvents,
} from "./trace.ts"
import { runObservedAgentHook } from "./hooks.ts"
import {
  resolveAgentTriggerInvocation as resolveAgentTriggerInvocationWithResolvedContext,
  resolveAgentTriggers as resolveAgentTriggersWithResolvedContext,
  runAgentTriggerWith,
  streamAgentTriggerWith,
} from "./trigger-runtime.ts"
import {
  isWorkspaceAgentOptions,
  resolveWorkspaceAgentDefaultInstructions,
  resolveWorkspaceInstructionBindings,
  workspaceAgentOwnsWorkspaceDefinition,
  workspaceDefinitionFromOptions,
  workspaceDefinitionWithAutoCommitRules,
  workspaceModeFromOptions,
  workspaceNameFromOptions,
} from "./workspace-agent.ts"

import type {
  AgentAdapter,
  AgentAdapterFactory,
  AgentAdapterRunContext,
  AgentCapabilitiesInput,
  AgentCapabilitiesResolver,
  AgentChannelDefinition,
  AgentChannelInputs,
  AgentChannels,
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentCapabilityTypeContract,
  AgentChannelDeliveryEffectHandler,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryFinishEffect,
  AgentChannelDeliveryFinishEffectResult,
  AgentChannelDeliveryFinishEffectContext,
  AgentDefinition,
  AgentDriver,
  AgentDriverContribution,
  AgentDriverKind,
  CustomAgentDriver,
  AgentErrorHookEvent,
  AgentFinishEvent,
  AgentFinishHookEvent,
  AgentFinishExtensions,
  AgentInput,
  AgentInvocationContextStore,
  AgentInvocationContextValues,
  AgentHookObserverHooks,
  AgentInvoker,
  AgentInvokerOptions,
  AgentInvokerProfile,
  AgentModelDriver,
  AgentOutputDefinition,
  AgentModelResolver,
  AgentRegistry,
  AgentRegistryModule,
  AgentRunContext,
  AgentRunInput,
  AgentRunMetadata,
  AgentRunResult,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentSettings,
  AgentStaticCapabilitiesList,
  AgentUsageRecord,
  AgentWorkflowRuntimeBinding,
  MaybePromise,
  ResolvedAgentTriggerDefinition,
  ResolvedAgentRuntimeContext,
} from "./types.ts"
import type {
  AgentInvocationController,
  AgentInvocationSnapshot,
} from "./agent-invocation.ts"
import type { StreamEvent } from "./messages.ts"
import type { AgentTraceContext } from "./trace.ts"
import type { ResolvedAgentTriggerInvocation, ResolvedAgentTriggerInvocationResult } from "./trigger-runtime.ts"
import type {
  WorkspaceAgentDefinition,
  WorkspaceAgentOptions,
} from "./workspace-agent.ts"
import type {
  ReadonlyWorkspaceFacade,
  WritableWorkspaceFacade,
  WorkspaceDefinition,
  WorkspaceName,
  WorkspaceSession,
  WorkspaceSessionOptions,
} from "@vite-hub/workspace"
import type { WorkflowHandle } from "@vite-hub/workflow"
import type { Box, BoxRequirement } from "@vite-hub/box"
import { isHarnessBoxActive, shareBoxSessions } from "./harness/shared-box.ts"

export type {
  AgentInvocationControlOutcome,
  AgentInvocationControlResult,
  AgentInvocationController,
  AgentInvocationInputMode,
  AgentInvocationInputSupport,
  AgentInvocationInspection,
  AgentInvocationSnapshot,
  AgentInvocationStatus,
} from "./agent-invocation.ts"

export type {
  AgentAccessInvocationContextValue,
  AgentAccessWorkspaceScopeContext,
  AgentAdapter,
  AgentAdapterFactory,
  AgentAdapterInstructions,
  AgentAdapterInstructionsPart,
  AgentAdapterInstructionsValue,
  AgentAdapterMetadataContext,
  AgentAdapterResult,
  AgentAdapterRunContext,
  AgentActor,
  AgentCapabilities,
  AgentCapabilitiesInput,
  AgentCapabilitiesList,
  AgentCapabilitiesResolver,
  AgentCapabilitiesResolverContext,
  AgentCallSettingsInstrumentation,
  AgentCallSettingsInstrumentationContext,
  BuiltInAgentDriver,
  BuiltInAgentDriverName,
  AgentCapabilityHandle,
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityHookName,
  AgentCapabilityHooks,
  AgentCapabilityCliCommand,
  AgentCapabilityCliContribution,
  AgentCapabilityCliExecutionInput,
  AgentCapabilityCliExecutionResult,
  AgentCapabilityCliOutputDefinition,
  AgentCapabilityCliOutputFormat,
  AgentCapabilityCliRunContext,
  AgentCapabilityCliResolver,
  AgentCapabilityCliStandardSchemaResultFailure,
  AgentCapabilityCliStandardSchemaResultSuccess,
  AgentCapabilityCliStandardSchemaV1,
  AgentCapabilityInput,
  AgentCapabilityMode,
  AgentCapabilityPhase,
  AgentCapabilityRuntimeContext,
  AgentChannelDeliveryEffectContext,
  AgentChannelDeliveryEffectHandler,
  AgentChannelDeliveryFinishEffect,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryEffectIntentOptions,
  AgentChannelDeliveryEffectPayload,
  AgentChannelDeliveryEffectKind,
  AgentChannelDeliveryEffects,
  AgentChannelDeliveryFinishEffectCallback,
  AgentChannelDeliveryFinishEffectResult,
  AgentChannelDeliveryFinishEffectContext,
  AgentChannelDeliveryReactionInput,
  AgentChannelDeliveryReactionPayload,
  AgentChannelDeliveryReplyInput,
  AgentChannelDeliveryReplyPayload,
  AgentChannelDeliveryReplyStream,
  AgentChannelDeliveryStatusInput,
  AgentChannelDeliveryStatusPayload,
  AgentChannelDeliveryStatusState,
  AgentChatAgentHookArgs,
  AgentChatErrorHookArgs,
  AgentChatEventHookArgs,
  AgentChatEventHooks,
  AgentChatFinishExtension,
  AgentChatMessage,
  AgentChatMessageHookArgs,
  AgentChatOptions,
  AgentChatPlatformAdapter,
  AgentChatPlatformResolver,
  AgentChatPlatformsResolver,
  AgentChatSendMessage,
  AgentChatSessionOptions,
  AgentChatTriggerHistory,
  AgentChannelDefinition,
  AgentChannelFactory,
  AgentChannelInput,
  AgentChannelInputs,
  AgentChannelTriggerContext,
  AgentChannels,
  AgentDeliveryArtifact,
  AgentDeliveryArtifactPlacement,
  AgentDefinition,
  AgentDefinitionCliOptions,
  AgentInspectionConfigMetadata,
  AgentInspectionConfigValue,
  AgentInspectionDriverMetadata,
  AgentInspectionFileTreeItem,
  AgentInspectionHarnessMetadata,
  AgentInspectionMetadata,
  AgentInspectionModelExecutionMetadata,
  AgentInspectionModelMetadata,
  AgentInspectionToolDefinition,
  AgentDriver,
  AgentDriverCapacityOptions,
  AgentDriverCapacityQueueOptions,
  AgentDriverContribution,
  AgentDriverContributionKind,
  AgentDriverKind,
  AgentExecution,
  AgentErrorHook,
  AgentErrorHookEvent,
  AgentFinishEvent,
  AgentFinishExtensions,
  AgentFinishExtensionValues,
  AgentFinishHook,
  AgentFinishHookEvent,
  AgentHostIdentity,
  AgentHarnessCredentialSource,
  AgentHarnessDriver,
  AgentHarnessDriverInput,
  AgentHarnessInstructions,
  AgentHarnessSandboxProvider,
  AgentHarnessSandboxProviderInput,
  AgentHarnessSessionKey,
  AgentHarnessWorkDir,
  AgentInput,
  AgentInputHook,
  AgentIntegrationOption,
  AgentHookObserver,
  AgentHookObserverEvent,
  AgentHookObserverHooks,
  AgentHookOutcome,
  AgentHookOwner,
  AgentInvocationExtensions,
  AgentOutputExtensions,
  AgentOutputExtensionValues,
  AgentInvocationContextStore,
  AgentInvocationContextValues,
  AgentInvocationHooks,
  AgentIntegrationsOptions,
  AgentInvoker,
  AgentInvokerMeta,
  AgentInvokerOptions,
  AgentInvokerProfile,
  AgentInvokerResolveContext,
  AgentMessageChannelSettings,
  AgentMessageConcurrency,
  AgentMessageDeliveryKind,
  AgentMessageFilter,
  AgentMessageFilterContext,
  AgentMessageLockScope,
  AgentOutputDefinition,
  AgentGatewayModel,
  AgentModelInput,
  AgentModelDriver,
  AgentModelExecutionInstrumentation,
  AgentModelResolverContext,
  AgentModelExecutionOptions,
  AgentModelInstrumentation,
  AgentModelResolver,
  AgentModelInstrumentationContext,
  AgentModuleOptions,
  AgentOutputExtensionEvent,
  AgentOutputExtensionProvider,
  AgentOutputRenderer,
  AgentProvidersOptions,
  AgentRegistryHandlerOptions,
  AgentRegistry,
  AgentRegistryModule,
  AgentRunContext,
  AgentRunCallbackContext,
  AgentRunDriver,
  AgentRunHandler,
  AgentRunInput,
  AgentRunInputContextValues,
  AgentRunMetadata,
  AgentRunResult,
  AgentRuntime,
  AgentRuntimeBinding,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeHooks,
  AgentRuntimeName,
  AgentUsage,
  AgentUsageCredentialSource,
  AgentUsageCost,
  AgentUsageRecord,
  AgentUIMessageStreamProjection,
  AgentUIMessageStreamProjectionResolver,
  AgentWebhookRegistrationDefinition,
  AgentChannelWebhookRegistrationDefinition,
  AgentWorkflowRuntimeBinding,
  AgentSandboxProviderOptions,
  AgentSchedulerProviderOptions,
  AgentSettings,
  AgentToolDefinition,
  AgentToolSchema,
  AgentToolStandardSchema,
  AgentToolTransform,
  AgentToolPolicyContext,
  AgentToolPolicyDecision,
  AgentStateProviderOptions,
  AgentTriggerContext,
  AgentTriggerDefinition,
  AgentTriggerInvokeResult,
  AgentTriggerRunInvokeResult,
  AgentToolResolver,
  AgentToolStep,
  AgentWaitUntil,
  ClaudeCodeAuthOptions,
  ClaudeCodeDriverOptions,
  ClaudeCodeThinkingConfig,
  CodexAuthOptions,
  CodexDriverOptions,
  CodexDriverSandboxOptions,
  CustomAgentDriver,
  DiscoveredAgentDefinition,
  MaybePromise,
  MaybeResolvable,
  PublishedAgentDeliveryArtifact,
  Resolvable,
  ResolvedAgentModuleOptions,
  ResolvedAgentStateProviderOptions,
  ResolvedAgentTriggerDefinition,
  ResolvedAgentRuntimeContext,
  WorkspaceAgentWorkspaceOptions,
  WorkspaceAgentWorkspaceConfig,
} from "./types.ts"

export {
  createAgentInspectionMetadata,
  materializeAgentInspectionSourceMetadata,
  resolveAgentInspectionMetadata,
  workspaceAgentOwnsWorkspaceDefinition,
  workspaceDefinitionFromOptions,
} from "./workspace-agent.ts"

export {
  agentInvokerContextKey,
  defineAgentInvoker,
} from "./invoker.ts"

export type {
  WorkspaceAgentDefinition,
  WorkspaceAgentDefaults,
  WorkspaceAgentOptions,
} from "./workspace-agent.ts"

export type {
  AgentMessagePhase,
  Message,
  MessageMetadata,
  MessagePart,
  MessageRole,
  RunEvent,
  StreamEvent,
  ToolInvocation,
  ToolInvocationState,
} from "./messages.ts"

export {
  agentChatContextKey,
  getAgentChatContext,
} from "./chat-trigger.ts"

export type {
  AgentChannelContext,
  AgentChatContext,
  AgentChatRunContext,
} from "./chat-trigger.ts"

const syntheticWorkspaceRun = Symbol.for("vitehub.syntheticWorkspaceRun")
const baseAgentResolve = Symbol.for("vitehub.baseAgentResolve")
const baseAgentModel = Symbol.for("vitehub.baseAgentModel")
const baseAgentDriverKind = Symbol.for("vitehub.baseAgentDriverKind")
const baseAgentDefinitionResolve = Symbol.for("vitehub.baseAgentDefinitionResolve")
const baseAgentOutput = Symbol.for("vitehub.baseAgentOutput")
const baseAgentBoxRequirements = Symbol.for("vitehub.baseAgentBoxRequirements")
const baseAgentCapabilitiesResolver = Symbol.for("vitehub.baseAgentCapabilitiesResolver")
type WorkspaceSourceNames<TWorkspace> =
  TWorkspace extends { sources: infer TSources }
    ? Extract<keyof NonNullable<TSources>, string>
    : string
type WorkspaceContribution<TWorkspace> =
  TWorkspace extends (...args: any[]) => infer TResult
    ? NonNullable<Awaited<TResult>>
    : NonNullable<TWorkspace>
type WorkspaceContributionSourceNames<TWorkspace> =
  WorkspaceContribution<TWorkspace> extends { sources?: infer TSources }
    ? Extract<keyof NonNullable<TSources>, string>
    : never
type CapabilityWorkspaceSourceNames<TCapability> =
  (TCapability extends { workspaceSources: infer TSources }
    ? Extract<keyof NonNullable<TSources>, string>
    : never)
  | (TCapability extends { workspace: infer TWorkspace }
    ? WorkspaceContributionSourceNames<TWorkspace>
    : never)
  | (TCapability extends { capabilities: infer TCapabilities }
    ? AgentCapabilitiesWorkspaceSourceNames<TCapabilities>
    : never)
type ResolvedAgentCapabilitiesInput<TCapabilities> =
  TCapabilities extends (...args: any[]) => infer TResult
    ? Awaited<TResult>
    : TCapabilities
type AgentCapabilitiesWorkspaceSourceNames<TCapabilities> =
  ResolvedAgentCapabilitiesInput<TCapabilities> extends readonly (infer TCapability)[]
    ? CapabilityWorkspaceSourceNames<TCapability>
    : never
type WorkspaceSourceHasRemovedScopes<TSource, TDepth extends readonly unknown[] = []> =
  TDepth["length"] extends 8
    ? false
    : TSource extends object
      ? "scopes" extends keyof TSource
        ? true
        : TSource extends { source: infer TWrappedSource }
          ? WorkspaceSourceHasRemovedScopes<TWrappedSource, [...TDepth, unknown]>
          : false
      : false
type WorkspaceSourceNamesWithRemovedScopes<TSources> =
  {
    [TSourceName in keyof NonNullable<TSources>]:
    true extends WorkspaceSourceHasRemovedScopes<NonNullable<TSources>[TSourceName]>
      ? TSourceName
      : never
  }[keyof NonNullable<TSources>]
type WorkspaceSourcesWithRemovedScopes<TWorkspace> =
  WorkspaceContribution<TWorkspace> extends { sources?: infer TSources }
    ? WorkspaceSourceNamesWithRemovedScopes<TSources>
    : never
type CapabilityWorkspaceSourcesWithRemovedScopes<TCapability> =
  (TCapability extends { workspaceSources: infer TSources }
    ? WorkspaceSourceNamesWithRemovedScopes<TSources>
    : never)
  | (TCapability extends { workspace: infer TWorkspace }
    ? WorkspaceSourcesWithRemovedScopes<TWorkspace>
    : never)
  | (TCapability extends { capabilities: infer TCapabilities }
    ? AgentCapabilitiesWorkspaceSourcesWithRemovedScopes<TCapabilities>
    : never)
type AgentCapabilitiesWorkspaceSourcesWithRemovedScopes<TCapabilities> =
  ResolvedAgentCapabilitiesInput<TCapabilities> extends readonly (infer TCapability)[]
    ? CapabilityWorkspaceSourcesWithRemovedScopes<TCapability>
    : never
type InvalidWorkspaceSourceGrant<TSourceName> = {
  readonly __vitehubInvalidWorkspaceSourceGrant: TSourceName
}
type InvalidWorkspaceSourceOption<TSourceName> = {
  readonly __vitehubInvalidWorkspaceSourceOption: TSourceName
}
type ValidateCapabilityWorkspaceSources<
  TSourceName,
  TWorkspace,
  TCapabilities,
  TCapability,
> =
  [TSourceName] extends [never]
    ? TCapability
    : TSourceName extends string
    ? string extends TSourceName
      ? TCapability
      : Exclude<TSourceName, WorkspaceSourceNames<TWorkspace> | AgentCapabilitiesWorkspaceSourceNames<TCapabilities>> extends never
        ? TCapability
        : TCapability & InvalidWorkspaceSourceGrant<Exclude<TSourceName, WorkspaceSourceNames<TWorkspace> | AgentCapabilitiesWorkspaceSourceNames<TCapabilities>>>
    : TCapability
type ValidateAgentCapability<TCapability, TWorkspace, TCapabilities> =
  TCapability extends AgentCapabilityDefinition<any, any, infer TTypeContract>
    ? TTypeContract extends { workspaceSources: infer TSourceName }
      ? ValidateCapabilityWorkspaceSources<TSourceName, TWorkspace, TCapabilities, TCapability>
      : TCapability
    : TCapability
type ValidateAgentCapabilitiesList<TCapabilities, TWorkspace> =
  TCapabilities extends readonly [unknown, ...unknown[]] | readonly []
    ? { [Index in keyof TCapabilities]: ValidateAgentCapability<TCapabilities[Index], TWorkspace, TCapabilities> }
    : TCapabilities extends readonly (infer TCapability)[]
      ? readonly ValidateAgentCapability<TCapability, TWorkspace, TCapabilities>[]
      : TCapabilities
type ValidateAgentCapabilities<TCapabilities, TWorkspace> =
  TCapabilities extends (...args: infer TArgs) => infer TResult
    ? (...args: TArgs) => TResult extends PromiseLike<infer TResolved>
      ? Promise<ValidateAgentCapabilitiesList<TResolved, TWorkspace>>
      : ValidateAgentCapabilitiesList<TResult, TWorkspace>
    : ValidateAgentCapabilitiesList<TCapabilities, TWorkspace>
type UnionToIntersection<T> =
  (T extends unknown ? (value: T) => void : never) extends (value: infer TIntersection) => void
    ? TIntersection
    : never
type CapabilityInvocationContextValues<TCapability> =
  TCapability extends AgentCapabilityDefinition<any, any, infer TTypeContract>
    ? TTypeContract extends AgentCapabilityTypeContract
      ? TTypeContract["invocationContext"] extends object
        ? TTypeContract["invocationContext"]
        : never
      : never
    : never
type AgentCapabilitiesInvocationContextValues<TCapabilities> =
  AgentInvocationContextValues & UnionToIntersection<
    ResolvedAgentCapabilitiesInput<TCapabilities> extends readonly [unknown, ...unknown[]] | readonly []
      ? CapabilityInvocationContextValues<ResolvedAgentCapabilitiesInput<TCapabilities>[number]>
      : ResolvedAgentCapabilitiesInput<TCapabilities> extends readonly (infer TCapability)[]
        ? CapabilityInvocationContextValues<TCapability>
        : unknown
  >
type ValidateWorkspaceAgentOptions<TOptions> =
  TOptions extends { capabilities?: infer TCapabilities, workspace: infer TWorkspace }
    ? { capabilities?: ValidateAgentCapabilities<TCapabilities, TWorkspace> }
      & ([WorkspaceSourcesWithRemovedScopes<TWorkspace> | AgentCapabilitiesWorkspaceSourcesWithRemovedScopes<TCapabilities>] extends [never]
        ? unknown
        : InvalidWorkspaceSourceOption<WorkspaceSourcesWithRemovedScopes<TWorkspace> | AgentCapabilitiesWorkspaceSourcesWithRemovedScopes<TCapabilities>>)
    : unknown
type BaseAgentResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig, CALL_OPTIONS = unknown> =
  (context: AgentRuntimeContext<TRuntimeConfig>) => Promise<AgentAdapter<CALL_OPTIONS>>
type AgentDefinitionWithBaseResolve<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
> = AgentDefinition<TRuntimeConfig, CALL_OPTIONS, any, any, TOutput> & {
  [baseAgentBoxRequirements]?: readonly BoxRequirement[]
  [baseAgentCapabilitiesResolver]?: AgentCapabilitiesResolver<TRuntimeConfig, WorkspaceName, CALL_OPTIONS>
  [baseAgentDriverKind]?: AgentDriverKind
  [baseAgentOutput]?: AgentOutputDefinition<TOutput>
  [baseAgentResolve]?: BaseAgentResolver<TRuntimeConfig, CALL_OPTIONS>
  [baseAgentModel]?: AgentModelResolver<TRuntimeConfig>
  [colocatedAgentSkillsSymbol]?: ColocatedAgentSkills
}
interface AgentWorkflowInvocationPayload<CALL_OPTIONS = unknown> {
  capabilities?: Record<string, false>
  input: AgentRunInput<CALL_OPTIONS>
  run?: Partial<AgentRunMetadata>
  runtime?: AgentRuntimeContext["runtime"]
  runtimeConfig?: AgentRuntimeConfig
}
interface AgentWorkflowRun<TOutput = unknown> {
  id: string
  metadata?: unknown
  payload?: unknown
  provider: string
  result?: TOutput
  status: "cancelled" | "completed" | "failed" | "queued" | "running" | "unknown"
}
interface StartedAgentWorkflow<CALL_OPTIONS = unknown, TOutput = unknown> {
  handle: WorkflowHandle<AgentWorkflowInvocationPayload<CALL_OPTIONS>, TOutput>
  run: AgentWorkflowRun<TOutput>
}
interface ScheduleRunContextLike {
  attemptId?: string
  id: string
  input?: unknown
  runId?: string
  scheduleId?: string
  scheduledAt: Date
  target?: string
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

const agentWorkflowHandles = new WeakMap<object, Map<string, WorkflowHandle<AgentWorkflowInvocationPayload, unknown>>>()
const agentWorkflowNames = new Set<string>()
const agentIdentityOwner = Symbol("vitehub.agentIdentityOwner")

interface DefaultAgentWorkflowRuntimeBinding extends AgentWorkflowRuntimeBinding {
  discoveryDefault: true
}

function withAgentIdentityOwner<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
): AgentRuntimeContext<TRuntimeConfig> {
  if (!context.agentIdentity || (context as AgentRuntimeContext & { [agentIdentityOwner]?: object })[agentIdentityOwner]) return context
  return { ...context, [agentIdentityOwner]: agent as object } as AgentRuntimeContext<TRuntimeConfig>
}

function hasAgentDefinition(value: unknown): value is AgentDefinition {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

function resolveAgentWorkflowRuntimeBinding<
  TRuntimeConfig extends AgentRuntimeConfig,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): AgentWorkflowRuntimeBinding | undefined {
  if (!hasAgentDefinition(agent)) return undefined
  return agent.runtime && agent.runtime.kind === "workflow" ? agent.runtime : undefined
}

function resolveAgentWorkflowName<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  binding: AgentWorkflowRuntimeBinding,
  context: AgentRuntimeContext<TRuntimeConfig>,
): string {
  const definition = hasAgentDefinition(agent) ? agent : undefined
  const name = binding.name || ("discoveryDefault" in binding ? context.agentIdentity?.name : definition?.name || context.agentIdentity?.name)
  if (name) return name
  throw new Error("[vitehub] Agent runtime workflow() requires a name when invoked directly. A stable Workflow Definition target requires workflow(\"name\").")
}

async function getAgentWorkflowHandle<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOutput,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput>,
  name: string,
  reuseRegistry: boolean,
): Promise<WorkflowHandle<AgentWorkflowInvocationPayload<CALL_OPTIONS>, TOutput>> {
  const handles = agentWorkflowHandles.get(agent as object) || new Map<string, WorkflowHandle<AgentWorkflowInvocationPayload, unknown>>()
  const cacheKey = `${reuseRegistry ? "registry" : "inline"}:${name}`
  const existing = handles.get(cacheKey)
  if (existing) return existing as WorkflowHandle<AgentWorkflowInvocationPayload<CALL_OPTIONS>, TOutput>

  const { createWorkflow } = await loadAgentWorkflowModule()
  const { getInlineWorkflowDefinitions, getWorkflowRuntimeRegistry } = await loadAgentWorkflowRuntimeStateModule()
  const handle = (reuseRegistry && getWorkflowRuntimeRegistry()?.[name]) || (agentWorkflowNames.has(name) && getInlineWorkflowDefinitions().has(name))
    ? createWorkflow<AgentWorkflowInvocationPayload<CALL_OPTIONS>, TOutput>(name)
    : createWorkflow<AgentWorkflowInvocationPayload<CALL_OPTIONS>, TOutput>(name, async (workflowContext) => {
        const { runAgentWorkflowDefinition } = await import("./runtime/workflow.ts")
        return await runAgentWorkflowDefinition(agent as never, workflowContext as never, runAgentInline as never) as TOutput
      })
  agentWorkflowNames.add(name)
  handles.set(cacheKey, handle as WorkflowHandle<AgentWorkflowInvocationPayload, unknown>)
  agentWorkflowHandles.set(agent as object, handles)
  return handle
}

async function runAgentAsWorkflow<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOutput,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: { fresh?: boolean } = {},
): Promise<StartedAgentWorkflow<CALL_OPTIONS, TOutput> | undefined> {
  const binding = resolveAgentWorkflowRuntimeBinding<TRuntimeConfig>(agent)
  if (!binding || ("discoveryDefault" in binding && !context.agentIdentity)) return undefined
  if ("discoveryDefault" in binding) {
    const { getWorkflowRuntimeConfig } = await loadAgentWorkflowRuntimeStateModule()
    if (!getWorkflowRuntimeConfig()) return undefined
  }
  if ("discoveryDefault" in binding && context.agentIdentity) {
    const owner = (context as AgentRuntimeContext & { [agentIdentityOwner]?: object })[agentIdentityOwner]
    if (owner && owner !== agent) return undefined
  }
  const capabilityNames = Object.entries(context.capabilities || {})
    .filter(([, capability]) => capability !== false)
    .map(([name]) => name)
  const disabledCapabilities = Object.fromEntries(
    Object.entries(context.capabilities || {}).filter(([, capability]) => capability === false),
  ) as Record<string, false>
  // ponytail: Host capability handles and registries cannot cross a Workflow payload without losing identity.
  if ("discoveryDefault" in binding && capabilityNames.length) return undefined

  const handle = await getAgentWorkflowHandle<TRuntimeConfig, CALL_OPTIONS, TOutput>(agent, resolveAgentWorkflowName(agent, binding, context), Boolean(context.agentIdentity))
  const resolvedContext = createResolvedRuntimeContext(context)
  const workflowInput = { ...input }
  // ponytail: AbortSignal is live process state and cannot cross a durable Workflow payload.
  delete workflowInput.abortSignal
  const inheritedRun = options.fresh && context.run
    ? Object.fromEntries(Object.entries(context.run).filter(([key]) => key !== "runId"))
    : context.run
  const payload: AgentWorkflowInvocationPayload<CALL_OPTIONS> = {
    ...(context.agentIdentity ? { agentIdentity: context.agentIdentity } : {}),
    ...(Object.keys(disabledCapabilities).length ? { capabilities: disabledCapabilities } : {}),
    input: workflowInput,
    runtime: context.runtime,
    runtimeConfig: resolvedContext.runtimeConfig,
    ...(inheritedRun ? { run: inheritedRun } : {}),
  }
  const workflowEvent = {
    ...(context.cloudflare?.env ? { env: context.cloudflare.env } : {}),
    waitUntil: context.waitUntil,
    context: {
      ...(context.cloudflare ? { cloudflare: context.cloudflare } : {}),
      waitUntil: context.waitUntil,
    },
  }
  const { runWithWorkflowRuntimeEvent } = await loadAgentWorkflowRuntimeStateModule()
  const run = await runWithWorkflowRuntimeEvent(workflowEvent, () => handle.run(
    payload,
    !options.fresh && context.run?.runId ? { id: context.run.runId } : {},
  ))
  return { handle, run }
}

function resolveRegistryModule<TContext extends AgentRuntimeContext>(
  module: AgentRegistryModule<TContext>,
): AgentInput<TContext> | undefined {
  return typeof module === "object" && module !== null && "default" in module
    ? module.default as AgentInput<TContext> | undefined
    : module as AgentInput<TContext>
}

function createResolvedRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentRuntimeContext<TRuntimeConfig>,
): ResolvedAgentRuntimeContext<TRuntimeConfig> {
  return resolveRuntimeContext(context) as ResolvedAgentRuntimeContext<TRuntimeConfig>
}

function createTraceId(run?: AgentRunMetadata): string {
  return run?.runId || globalThis.crypto?.randomUUID?.() || `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createAgentCallbackContext<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentRuntimeContext<TRuntimeConfig>,
) {
  const { runtimeConfig: _runtimeConfig, ...callbackContext } = createResolvedRuntimeContext(context)
  return callbackContext
}

type AgentTriggerContextValue = {
  channelId?: string
  id?: string
  name?: string
  source?: "capability" | "channel"
}

function channelDeliveryEffectHandlers<TRuntimeConfig extends AgentRuntimeConfig>(
  channel: AgentChannelDefinition<TRuntimeConfig>,
  intent: AgentChannelDeliveryEffectIntent,
): readonly AgentChannelDeliveryEffectHandler<TRuntimeConfig>[] {
  const handlers = channel.effects?.[intent.kind]
  if (!handlers) return []
  return typeof handlers === "function" ? [handlers] : [...handlers]
}

function activeAgentChannel<TRuntimeConfig extends AgentRuntimeConfig>(
  channels: AgentChannels<TRuntimeConfig> | undefined,
  context: AgentInvocationContextStore,
  run?: AgentRunMetadata,
) {
  const trigger = context.get<AgentTriggerContextValue>("agent.trigger")
  const channelId = run?.channelId || trigger?.channelId
  const channel = channelId ? channels?.[channelId] : undefined
  return channel && channelId ? { channel, channelId, trigger } : undefined
}

async function setChannelDeliverySupportContext<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  channels: AgentChannels<TRuntimeConfig> | undefined,
  invocationContext: AgentInvocationContextStore,
  runtimeContext: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  run?: AgentRunMetadata,
): Promise<void> {
  const active = activeAgentChannel(channels, invocationContext, run)
  if (!active) return
  if (!channelDeliveryEffectHandlers(active.channel, { kind: "title" }).length) {
    invocationContext.set(messageChannelTitleSupportContextKey, false, { overwrite: true })
    return
  }
  if (channelHasCustomTitleEffect(active.channel)) {
    invocationContext.set(messageChannelTitleSupportContextKey, true, { overwrite: true })
    return
  }
  const { runtimeConfig: _runtimeConfig, ...callbackContext } = runtimeContext
  const supported = await messageChannelSupportsTitleEffect({
    ...callbackContext,
    channel: active.channel,
    context: invocationContext,
    effect: { kind: "title" },
    input,
    request: runtimeContext.request,
    run,
    trigger: {
      channelId: active.channelId,
      ...(active.trigger?.id ? { id: active.trigger.id } : {}),
      ...(active.trigger?.name ? { name: active.trigger.name } : {}),
    },
  })
  invocationContext.set(messageChannelTitleSupportContextKey, supported, { overwrite: true })
}

async function applyChannelDeliveryEffectIntents<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  intents: readonly AgentChannelDeliveryEffectIntent[],
  finish?: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>,
): Promise<void> {
  if (!intents.length) return
  const active = activeAgentChannel(context.channels, context.context, context.run)

  for (const intent of intents) {
    const handlers = active ? channelDeliveryEffectHandlers(active.channel, intent) : []
    const metadata = {
      "channel.effect.intent": intent.intent,
      "channel.effect.kind": intent.kind,
      "channel.effect.supported": handlers.length > 0,
    }
    if (!active || !handlers.length) {
      await runObservedAgentHook(context.hooks, {
        ids: { channelId: active?.channelId, runId: context.run?.runId },
        metadata,
        name: "channel:delivery-effect",
        owner: "channel",
        phase: "effect",
      }, async () => {
        await traceAgentChannelDeliveryEffect(toTraceContext(context), intent, metadata)
      })
      continue
    }

    const titleDelivery = isMessageChannelTitleEffectIntent(intent)
      ? await prepareMessageChannelTitleDelivery(context.context, context.run, intent).catch(async (error) => {
          await traceAgentChannelDeliveryEffect(toTraceContext(context), intent, {
            ...metadata,
            "error.message": agentErrorMessage(error),
          })
          return { deliver: true } as MessageChannelTitleDeliveryAttempt
        })
      : undefined
    if (titleDelivery?.error) {
      await traceAgentChannelDeliveryEffect(toTraceContext(context), intent, {
        ...metadata,
        "error.message": agentErrorMessage(titleDelivery.error),
      })
    }
    if (titleDelivery && !titleDelivery.deliver) {
      await traceAgentChannelDeliveryEffect(toTraceContext(context), intent, {
        ...metadata,
        "channel.effect.skipped": titleDelivery.reason,
      })
      continue
    }

    let delivered = true
    for (const handler of handlers) {
      try {
        await runObservedAgentHook(context.hooks, {
          ids: { channelId: active.channelId, runId: context.run?.runId },
          metadata,
          name: "channel:delivery-effect",
          owner: "channel",
          phase: "effect",
        }, async () => {
          await handler({
            ...context.runtimeContext,
            channel: active.channel,
            context: context.context,
            effect: intent,
            ...(finish ? { finish: finish as never } : {}),
            input: context.input,
            request: context.runtimeContext.request,
            run: context.run,
            trigger: {
              channelId: active.channelId,
              ...(active.trigger?.id ? { id: active.trigger.id } : {}),
              ...(active.trigger?.name ? { name: active.trigger.name } : {}),
            },
            workspace: context.workspace,
          })
          await traceAgentChannelDeliveryEffect(toTraceContext(context), intent, metadata)
        })
      }
      catch (error) {
        delivered = false
        await traceAgentChannelDeliveryEffect(toTraceContext(context), intent, {
          ...metadata,
          "error.message": agentErrorMessage(error),
        })
      }
    }
    if (titleDelivery) {
      try {
        await finishMessageChannelTitleDelivery(titleDelivery, delivered, Boolean(finish))
      }
      catch (error) {
        await traceAgentChannelDeliveryEffect(toTraceContext(context), intent, {
          ...metadata,
          "error.message": agentErrorMessage(error),
        })
      }
    }
    if (titleDelivery && delivered) {
      context.context.set(messageChannelTitleDeliveredContextKey, true, { overwrite: true })
    }
  }
}

export { applyAgentToolPolicies, withAgentToolStepReporting } from "./tool-runtime.ts"
export { defineCapability } from "./capability-runtime.ts"
export { defineFinishEffect } from "./delivery-effects.ts"
export { isResolvedAgentTriggerHandledInvocation, verifyAgentWebhookRequest } from "./trigger-runtime.ts"
export type { AgentWebhookVerificationResult, ResolvedAgentTriggerHandledInvocation, ResolvedAgentTriggerInvocation, ResolvedAgentTriggerInvocationResult } from "./trigger-runtime.ts"
export * from "./messages.ts"
export {
  agentInvocationStreamRoute,
  createAgentInvocationStreamResponse,
  readAgentInvocationStream,
} from "./invocation-stream.ts"
export type { AgentInvocationStreamErrorEvent, AgentInvocationStreamEvent } from "./invocation-stream.ts"
export type { AgentDevLoopAgentSummary, AgentDevLoopDiscoveryResponse } from "./invocation-stream.ts"

export type {
  AgentRunEvent,
  AgentRunEventInput,
  AgentRunEventPublisher,
  AgentRunEvents,
  AgentRunEventStore,
  AgentRunEventStoreResolveContext,
  AgentRunEventStoreResolver,
} from "./run-events.ts"

function resolveCapabilityCliRunSurface(definition: Pick<AgentDefinition, "cli"> | undefined): boolean {
  if (definition?.cli?.capabilities !== undefined) return definition.cli.capabilities !== false
  return true
}

function normalizeAgentChannels<TRuntimeConfig extends AgentRuntimeConfig>(
  inputs: AgentChannelInputs<TRuntimeConfig> | undefined,
): AgentChannels<TRuntimeConfig> | undefined {
  if (!inputs) return inputs
  let channels: AgentChannels<TRuntimeConfig> | undefined
  for (const [id, input] of Object.entries(inputs)) {
    const value = input as unknown
    if (typeof value === "object" && value && "kind" in value && typeof value.kind === "string") continue
    const channel = typeof input === "function"
      ? input()
      : id === "discord"
        ? builtInDiscord<TRuntimeConfig>(input as never)
        : id === "github"
          ? builtInGitHub<TRuntimeConfig>(input as never)
          : id === "http"
            ? builtInHttp<TRuntimeConfig>(input as never)
            : id === "slack"
              ? builtInSlack<TRuntimeConfig>(input as never)
              : id === "teams"
                ? builtInTeams<TRuntimeConfig>(input as never)
                : id === "telegram"
                  ? builtInTelegram<TRuntimeConfig>(input as never)
                  : id === "webChat"
                    ? builtInWebChat<TRuntimeConfig>(input as never)
                    : undefined
    if (!channel || typeof channel !== "object" || typeof channel.kind !== "string") {
      throw new TypeError(typeof input === "function"
        ? `[vitehub] Channel factory "${id}" must return an Agent Channel definition.`
        : `[vitehub] Channel "${id}" must be an Agent Channel definition or use a built-in Channel name.`)
    }
    channels ||= { ...inputs } as AgentChannels<TRuntimeConfig>
    channels[id] = channel
  }
  return channels || (inputs as AgentChannels<TRuntimeConfig>)
}

function capabilitiesContributeWorkspace(capabilities: unknown): boolean {
  return Array.isArray(capabilities)
    && normalizeCapabilities(capabilities).some(capability => Boolean(capability.workspace))
}

function capabilitiesRequireWritableWorkspace(capabilities: unknown): boolean {
  return Array.isArray(capabilities)
    && normalizeCapabilities(capabilities).some(capability =>
      capability.requires?.some(requirement => requirement.workspace?.mode === "write"),
    )
}

function agentContributesWorkspace(options: {
  capabilities?: unknown
  channels?: AgentChannels
}): boolean {
  if (capabilitiesContributeWorkspace(options.capabilities)) return true
  return Object.values(options.channels || {})
    .some(channel => capabilitiesContributeWorkspace(channel.capabilities))
}

function agentRequiresWritableWorkspace(options: {
  capabilities?: unknown
  channels?: AgentChannels
}): boolean {
  if (capabilitiesRequireWritableWorkspace(options.capabilities)) return true
  return Object.values(options.channels || {})
    .some(channel => capabilitiesRequireWritableWorkspace(channel.capabilities))
}

function defineBaseAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TOutput = unknown,
>(
  options: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, AgentInvocationContextValues, AgentCapabilitiesInput<TRuntimeConfig, WorkspaceName, CALL_OPTIONS> | undefined, TOutput>,
): AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, AgentInvocationContextValues, TOutput> {
  const driver = normalizeAgentDriver(options)
  const { box, capabilities, cli, description, hooks, messages, name, runtime = defaultAgentWorkflowRuntime(), runEvents, uiMessageStream, version, workspace } = options
  const channels = normalizeAgentChannels(options.channels)
  if (box && driver.kind !== "harness") {
    throw new Error("[vitehub] defineAgent({ box }) currently requires a harness Agent Driver.")
  }
  if (box && driver.kind === "harness" && (driver.hasSandbox || driver.sandbox !== undefined || driver.workDir !== undefined)) {
    throw new Error("[vitehub] defineAgent({ box }) owns harness execution. Move driver.sandbox and driver.workDir to the Box.")
  }
  const run = driver.kind === "run" ? driver.run : undefined
  const capabilitiesResolver = typeof capabilities === "function"
    ? capabilities as AgentCapabilitiesResolver<TRuntimeConfig, WorkspaceName, CALL_OPTIONS>
    : undefined
  const baseCapabilities = normalizeCapabilities(Array.isArray(capabilities) ? capabilities : undefined)
  const invoker = normalizeAgentInvokerOptions(options.invoker) as AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS> | undefined
  const channelChat = resolveAgentChannelChatOptions<TRuntimeConfig>(channels, messages)
  const chatCapability = getChatCapabilityOptions<TRuntimeConfig>(baseCapabilities)
  if (chatCapability && channelChat) {
    throw new TypeError("[vitehub] defineAgent({ channels }) cannot be combined with the chat() capability. Move chat options to defineAgent({ messages, channels }).")
  }
  const chat = chatCapability || channelChat
  const normalizedCapabilities = channelChat
    ? [...baseCapabilities, defineChatCapability(channelChat) as AgentCapabilityDefinition<TRuntimeConfig>]
    : baseCapabilities
  if (!workspace) validateAgentCapabilityComposition(normalizedCapabilities, { hasWorkspace: false })
  const resolveBaseAgent: BaseAgentResolver<TRuntimeConfig, CALL_OPTIONS> = async (context) => {
    const resolvedAdapter = driver.kind === "model"
      ? (await import("./ai-sdk.ts")).createAiSdkAdapter({
          execution: driver.execution,
          instructions: driver.instructions,
          model: driver.model,
        } as never) as AgentAdapter<CALL_OPTIONS>
      : driver.kind === "harness"
        ? (await import("./harness-agent.ts")).createHarnessAgentAdapter<CALL_OPTIONS>(
            (driver.resolve ? await driver.resolve() : driver) as never,
          )
        : undefined
    if (!resolvedAdapter) {
      throw new Error("[vitehub] Agent Driver is required unless the agent uses driver.run.")
    }
    const resolvedContext = createResolvedRuntimeContext(context)
    return typeof resolvedAdapter === "function"
      ? await (resolvedAdapter as AgentAdapterFactory<TRuntimeConfig, CALL_OPTIONS>)(resolvedContext)
      : resolvedAdapter
  }

  const definition = {
    ...(driver.kind === "harness" && driver.requires?.length ? { [baseAgentBoxRequirements]: driver.requires } : {}),
    ...(driver.kind === "model" ? { [baseAgentModel]: driver.model } : {}),
    [baseAgentDriverKind]: driver.kind,
    ...(driver.output ? { [baseAgentOutput]: driver.output } : {}),
    ...(capabilitiesResolver ? { [baseAgentCapabilitiesResolver]: capabilitiesResolver } : {}),
    [baseAgentResolve]: resolveBaseAgent,
    box,
    channels,
    chat,
    cli,
    description,
    hooks,
    invoker,
    messages,
    name,
    runtime,
    runEvents,
    run,
    uiMessageStream,
    version,
    workspace,
    ...(normalizedCapabilities.length ? { capabilities: normalizedCapabilities } : {}),
    async resolve(context) {
      context = withAgentIdentityOwner(definition, context)
      const adapterInstance = await resolveBaseAgent(context)
      const resolvedContext = createResolvedRuntimeContext(context)
      const resolvedTools = driver.kind === "model" && normalizedCapabilities.length && !workspace
        ? await resolveStaticCapabilityTools({ capabilities: normalizedCapabilities }, resolvedContext)
        : undefined
      const capabilityTools = Object.keys(resolvedTools || {}).length
        ? withAgentToolStepReporting(withJsonCompatibleToolOutputs(applyAgentToolPolicies(resolvedTools) || {}), context.toolStepReporter)
        : undefined
      return capabilityTools
        ? { ...adapterInstance, tools: capabilityTools }
        : adapterInstance
    },
  } as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS, TOutput>
  configureAgentCapacity(definition, driver.capacity)
  Object.defineProperty(definition, "__vitehubAgentSettings", {
    value: channels === options.channels ? options : { ...options, channels },
  })
  Object.defineProperty(definition, baseAgentDefinitionResolve, {
    value: definition.resolve,
  })
  return definition
}

export function workflow(name?: string): AgentWorkflowRuntimeBinding {
  return {
    kind: "workflow",
    ...(name ? { name } : {}),
  }
}

function defaultAgentWorkflowRuntime(): DefaultAgentWorkflowRuntimeBinding {
  return { discoveryDefault: true, kind: "workflow" }
}

function createSyntheticWorkspaceRun<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOutput,
>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS, any, any, TOutput>,
): NonNullable<AgentDefinition<TRuntimeConfig, CALL_OPTIONS>["run"]> {
  const run: NonNullable<AgentDefinition<TRuntimeConfig, CALL_OPTIONS>["run"]> = async (context) => {
    let release = await acquireAgentCapacity(definition, context.input.abortSignal)
    try {
      const adapter = await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(definition as never, context)
      const invocationContext = await createAgentInvocationContext(definition as never, context as never, context.input)
      const result = await adapter.generate(toAgentAdapterRunContext(invocationContext) as never)
      const textOutput = typeof result === "object" && result && "text" in result && typeof (result as { text?: unknown }).text === "string"
        ? (result as { text: string }).text
        : undefined
      if (textOutput !== undefined && result && typeof result === "object") {
        const eagerStreams: AsyncIterable<unknown>[] = []
        for (const property of ["stream", "fullStream", "textStream"] as const) {
          let descriptor: PropertyDescriptor | undefined
          for (let owner: object | null = result; owner && !descriptor; owner = Object.getPrototypeOf(owner))
            descriptor = Object.getOwnPropertyDescriptor(owner, property)
          if (descriptor && "value" in descriptor && isAsyncIterable(descriptor.value)) eagerStreams.push(descriptor.value)
        }
        await Promise.allSettled([...new Set(eagerStreams)].map(stream => cancellableAsyncIterableSource(stream).cancel()))
      }
      const output = textOutput ?? result
      if (!release) return output
      if (output instanceof Response) {
        if (!output.body) return output
        const finish = release
        const response = await withResponseCleanup(output, async () => finish(), { abortSignal: context.input.abortSignal })
        release = undefined
        return response
      }
      if (isAsyncIterable(output)) {
        const finish = release
        const source = cancellableAsyncIterableSource(output)
        const streamed = withCapabilityCleanup(source.stream, async () => finish(), {
          abortSignal: context.input.abortSignal,
          cancelOnAbort: source.cancel,
        })
        release = undefined
        return typeof (output as ReadableStream<unknown>).getReader === "function"
          ? toReadableAsyncIterableStream(streamed)
          : streamed
      }
      if (output && typeof output === "object") {
        const capacityRelease = release
        const sources = new Set<ReturnType<typeof cancellableAsyncIterableSource>>()
        const preservedStreams = new Map<AsyncIterable<unknown>, AsyncIterable<unknown>>()
        let finished = false
        const finish = async (reason?: unknown, completedSource?: ReturnType<typeof cancellableAsyncIterableSource>) => {
          if (finished) return
          finished = true
          context.input.abortSignal?.removeEventListener("abort", onAbort)
          await Promise.allSettled([...sources].filter(source => source !== completedSource).map(source => source.cancel(reason)))
          capacityRelease()
        }
        const onAbort = () => void finish(context.input.abortSignal?.reason).catch(() => {})
        const wrapStream = (stream: AsyncIterable<unknown>) => {
          const existing = preservedStreams.get(stream)
          if (existing) return existing
          if (finished) throw new Error("[vitehub] Agent Invocation output has already finished.")
          const source = cancellableAsyncIterableSource(stream)
          sources.add(source)
          const wrapped = withCapabilityCleanup(source.stream, outcome => finish(outcome.failed ? outcome.error : undefined, source), {
            abortSignal: context.input.abortSignal,
            cancelOnAbort: source.cancel,
          })
          const preserved = typeof (stream as ReadableStream<unknown>).getReader === "function"
            ? toReadableAsyncIterableStream(wrapped)
            : wrapped
          preservedStreams.set(stream, preserved)
          return preserved
        }
        const descriptors: PropertyDescriptorMap = {}
        let hasStreamSurface = false
        let unresolvedLazyStreamSurfaces = 0
        try {
          for (const property of ["stream", "fullStream", "textStream"] as const) {
            let descriptor: PropertyDescriptor | undefined
            for (let owner: object | null = output; owner && !descriptor; owner = Object.getPrototypeOf(owner))
              descriptor = Object.getOwnPropertyDescriptor(owner, property)
            if (!descriptor) continue
            if ("get" in descriptor) {
              hasStreamSurface = true
              unresolvedLazyStreamSurfaces++
              let initialized = false
              let value: unknown
              descriptors[property] = {
                configurable: true,
                enumerable: descriptor.enumerable ?? false,
                get() {
                  if (!initialized) {
                    try {
                      const resolved = descriptor.get?.call(output)
                      if (isAsyncIterable(resolved)) value = wrapStream(resolved)
                      else {
                        value = resolved
                        unresolvedLazyStreamSurfaces--
                        if (!unresolvedLazyStreamSurfaces && !sources.size) void finish().catch(() => {})
                      }
                      if (isAsyncIterable(resolved)) unresolvedLazyStreamSurfaces--
                      initialized = true
                    }
                    catch (error) {
                      void finish(error).catch(() => {})
                      throw error
                    }
                  }
                  return value
                },
              }
            }
            else {
              if (!isAsyncIterable(descriptor.value)) continue
              hasStreamSurface = true
              descriptors[property] = {
                ...descriptor,
                value: wrapStream(descriptor.value),
              }
            }
          }
          if (isUIMessageStreamResult(output)) {
            hasStreamSurface = true
            unresolvedLazyStreamSurfaces++
            const toUIMessageStream = output.toUIMessageStream as (...args: unknown[]) => ReadableStream<unknown>
            let uiMessageStreamResolved = false
            descriptors.toUIMessageStream = {
              configurable: true,
              enumerable: false,
              value: (...args: unknown[]) => {
                if (finished) throw new Error("[vitehub] Agent Invocation output has already finished.")
                try {
                  const stream = toUIMessageStream.apply(output, args)
                  if (!uiMessageStreamResolved) {
                    uiMessageStreamResolved = true
                    unresolvedLazyStreamSurfaces--
                  }
                  return wrapStream(stream)
                }
                catch (error) {
                  void finish(error).catch(() => {})
                  throw error
                }
              },
            }
          }
        }
        catch (error) {
          await finish(error)
          throw error
        }
        if (hasStreamSurface) {
          if (context.input.abortSignal?.aborted) onAbort()
          else context.input.abortSignal?.addEventListener("abort", onAbort, { once: true })
          const preserved = resultWithPreservedProperties(output, descriptors)
          release = undefined
          return preserved
        }
      }
      return output
    }
    finally {
      release?.()
    }
  }
  return Object.assign(run, { [syntheticWorkspaceRun]: true })
}

type AgentCapabilitiesOption<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
  CALL_OPTIONS,
  TCapabilities extends AgentStaticCapabilitiesList<TRuntimeConfig, Name> | undefined,
> = TCapabilities | AgentCapabilitiesResolver<
  TRuntimeConfig,
  Name,
  CALL_OPTIONS,
  TCapabilities extends readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[]
    ? TCapabilities
    : readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[]
>

export interface DefineAgent {
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    Name extends WorkspaceName = WorkspaceName,
    CALL_OPTIONS = unknown,
    const TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
    const TCapabilities extends AgentStaticCapabilitiesList<TRuntimeConfig, Name> | undefined = AgentStaticCapabilitiesList<TRuntimeConfig, Name> | undefined,
    TOutput = unknown,
    const TOptions extends WorkspaceAgentOptions<
      TRuntimeConfig,
      Name,
      CALL_OPTIONS,
      TInvokerProfile,
      AgentCapabilitiesInvocationContextValues<TCapabilities>,
      AgentCapabilitiesOption<TRuntimeConfig, Name, CALL_OPTIONS, TCapabilities>,
      TOutput,
      CustomAgentDriver<TRuntimeConfig, CALL_OPTIONS, AgentCapabilitiesInvocationContextValues<TCapabilities>, TOutput>
    > = WorkspaceAgentOptions<
      TRuntimeConfig,
      Name,
      CALL_OPTIONS,
      TInvokerProfile,
      AgentCapabilitiesInvocationContextValues<TCapabilities>,
      AgentCapabilitiesOption<TRuntimeConfig, Name, CALL_OPTIONS, TCapabilities>,
      TOutput,
      CustomAgentDriver<TRuntimeConfig, CALL_OPTIONS, AgentCapabilitiesInvocationContextValues<TCapabilities>, TOutput>
    >,
  >(
    options: TOptions & { capabilities?: AgentCapabilitiesOption<TRuntimeConfig, Name, CALL_OPTIONS, TCapabilities>, driver: CustomAgentDriver<TRuntimeConfig, CALL_OPTIONS, AgentCapabilitiesInvocationContextValues<TCapabilities>, TOutput> } & ValidateWorkspaceAgentOptions<TOptions>,
  ): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS, TInvokerProfile, AgentCapabilitiesInvocationContextValues<TCapabilities>, AgentCapabilitiesOption<TRuntimeConfig, Name, CALL_OPTIONS, TCapabilities>, TOutput>
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    Name extends WorkspaceName = WorkspaceName,
    CALL_OPTIONS = unknown,
    const TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
    const TCapabilities extends AgentStaticCapabilitiesList<TRuntimeConfig, Name> | undefined = AgentStaticCapabilitiesList<TRuntimeConfig, Name> | undefined,
    TOutput = unknown,
    const TOptions extends WorkspaceAgentOptions<
      TRuntimeConfig,
      Name,
      CALL_OPTIONS,
      TInvokerProfile,
      AgentCapabilitiesInvocationContextValues<TCapabilities>,
      AgentCapabilitiesOption<TRuntimeConfig, Name, CALL_OPTIONS, TCapabilities>
    > = WorkspaceAgentOptions<
      TRuntimeConfig,
      Name,
      CALL_OPTIONS,
      TInvokerProfile,
      AgentCapabilitiesInvocationContextValues<TCapabilities>,
      AgentCapabilitiesOption<TRuntimeConfig, Name, CALL_OPTIONS, TCapabilities>
    >,
  >(
    options: TOptions & { capabilities?: AgentCapabilitiesOption<TRuntimeConfig, Name, CALL_OPTIONS, TCapabilities>, driver: AgentDriver<TRuntimeConfig, CALL_OPTIONS, AgentCapabilitiesInvocationContextValues<TCapabilities>, TOutput> } & ValidateWorkspaceAgentOptions<TOptions>,
  ): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS, TInvokerProfile, AgentCapabilitiesInvocationContextValues<TCapabilities>, AgentCapabilitiesOption<TRuntimeConfig, Name, CALL_OPTIONS, TCapabilities>, TOutput>
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    CALL_OPTIONS = unknown,
    const TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
    const TCapabilities extends AgentStaticCapabilitiesList<TRuntimeConfig> | undefined = AgentStaticCapabilitiesList<TRuntimeConfig> | undefined,
    TOutput = unknown,
  >(
    options: AgentSettings<
      TRuntimeConfig,
      CALL_OPTIONS,
      TInvokerProfile,
      AgentCapabilitiesInvocationContextValues<TCapabilities>,
      AgentCapabilitiesOption<TRuntimeConfig, WorkspaceName, CALL_OPTIONS, TCapabilities>,
      TOutput,
      CustomAgentDriver<TRuntimeConfig, CALL_OPTIONS, AgentCapabilitiesInvocationContextValues<TCapabilities>, TOutput>
    > & { capabilities?: AgentCapabilitiesOption<TRuntimeConfig, WorkspaceName, CALL_OPTIONS, TCapabilities>, workspace?: never },
  ): AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, AgentCapabilitiesInvocationContextValues<TCapabilities>, TOutput>
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    CALL_OPTIONS = unknown,
    const TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
    const TCapabilities extends AgentStaticCapabilitiesList<TRuntimeConfig> | undefined = AgentStaticCapabilitiesList<TRuntimeConfig> | undefined,
    TOutput = unknown,
  >(
    options: AgentSettings<
      TRuntimeConfig,
      CALL_OPTIONS,
      TInvokerProfile,
      AgentCapabilitiesInvocationContextValues<TCapabilities>,
      AgentCapabilitiesOption<TRuntimeConfig, WorkspaceName, CALL_OPTIONS, TCapabilities>,
      TOutput
    > & { capabilities?: AgentCapabilitiesOption<TRuntimeConfig, WorkspaceName, CALL_OPTIONS, TCapabilities>, workspace?: never },
  ): AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, AgentCapabilitiesInvocationContextValues<TCapabilities>, TOutput>
}

function createWorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TOutput = unknown,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name, CALL_OPTIONS, TInvokerProfile, AgentInvocationContextValues, AgentCapabilitiesInput<TRuntimeConfig, Name, CALL_OPTIONS> | undefined, TOutput>,
): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS, TInvokerProfile, AgentInvocationContextValues, AgentCapabilitiesInput<TRuntimeConfig, Name, CALL_OPTIONS> | undefined, TOutput> {
  const workspaceDefinition = workspaceDefinitionFromOptions(options as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, Name>)
  if (Array.isArray(options.capabilities)) {
    validateAgentCapabilityComposition(options.capabilities, {
      hasBox: Boolean(options.box),
      hasWorkspace: true,
      workspaceMode: workspaceModeFromOptions(options as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, Name>),
    })
  }
  const definition = defineBaseAgent<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TOutput>({
    ...options,
    description: options.description,
    hooks: options.hooks,
    runtime: options.runtime,
    version: options.version,
    workspace: workspaceDefinition,
  } as never) as WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS, TInvokerProfile, AgentInvocationContextValues, AgentCapabilitiesInput<TRuntimeConfig, Name, CALL_OPTIONS> | undefined, TOutput>

  if (!definition.run) {
    definition.run = createSyntheticWorkspaceRun(definition)
  }

  Object.assign(definition, workspaceDefinition, {
    __vitehubWorkspaceAgent: true,
    __vitehubWorkspaceAgentOptions: options,
  })
  return definition
}

export const defineAgent: DefineAgent = ((options: unknown) => {
  const agentOptions = options as AgentSettings
  const channels = normalizeAgentChannels(agentOptions.channels)
  const normalizedOptions = channels === agentOptions.channels
    ? agentOptions
    : { ...agentOptions, channels }
  if (isWorkspaceAgentOptions(normalizedOptions)) {
    return createWorkspaceAgentDefinition(normalizedOptions)
  }
  return agentContributesWorkspace({
    capabilities: normalizedOptions.capabilities,
    channels,
  })
    ? createWorkspaceAgentDefinition({
        ...normalizedOptions,
        workspace: {
          mode: agentRequiresWritableWorkspace({
            capabilities: normalizedOptions.capabilities,
            channels,
          })
            ? "write"
            : "read",
        },
      })
    : defineBaseAgent(normalizedOptions as never)
}) as DefineAgent

export function agentWithColocatedInstructions<Agent>(agent: Agent, instructions?: string): Agent {
  if (!instructions || !hasAgentDefinition(agent)) return agent
  const settings = (agent as AgentDefinition & { __vitehubAgentSettings?: AgentSettings }).__vitehubAgentSettings
  if (!settings || settings.workspace) return agent
  const driver = normalizeAgentDriver(settings)
  if (driver.kind !== "model" || driver.instructions !== undefined) return agent
  const definition = defineAgent({
    ...settings,
    driver: {
      ...(settings.driver as AgentModelDriver),
      instructions,
    },
  } as never) as Agent
  const decorations = Object.getOwnPropertyDescriptors(agent as object)
  delete decorations.__vitehubAgentSettings
  Reflect.deleteProperty(decorations, baseAgentResolve)
  Reflect.deleteProperty(decorations, baseAgentModel)
  Reflect.deleteProperty(decorations, baseAgentDriverKind)
  Reflect.deleteProperty(decorations, baseAgentDefinitionResolve)
  if (
    (agent as AgentDefinition & { [baseAgentDefinitionResolve]?: unknown }).resolve
    === (agent as AgentDefinition & { [baseAgentDefinitionResolve]?: unknown })[baseAgentDefinitionResolve]
  ) {
    delete decorations.resolve
  }
  Object.setPrototypeOf(definition as object, Object.getPrototypeOf(agent as object))
  Object.defineProperties(definition as object, decorations)
  return definition
}

export async function resolveAgent<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  context: TContext,
): Promise<AgentAdapter> {
  if (hasAgentDefinition(agent)) {
    return await agent.resolve(context as never)
  }

  throw new TypeError("[vitehub] Invalid agent definition.")
}

async function resolveAgentForRun<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
): Promise<AgentAdapter<CALL_OPTIONS>> {
  if (hasAgentDefinition(agent)) {
    const resolver = (agent as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS>)[baseAgentResolve]
    if (resolver) return await resolver(context)
  }
  return await resolveAgent(agent, context) as AgentAdapter<CALL_OPTIONS>
}

export async function getAgentFromRegistry<TContext extends AgentRuntimeContext>(
  name: string,
  registry: AgentRegistry<TContext> = agentRegistry as AgentRegistry<TContext>,
): Promise<AgentInput<TContext>> {
  const loader = registry[name]
  if (!loader) {
    throw new Error(formatUnknownAgentMessage(name, Object.keys(registry).sort(), { prefix: true }))
  }

  const agent = resolveRegistryModule(await loader())
  if (!agent) {
    throw new Error(`[vitehub] Agent "${name}" did not export a valid default agent.`)
  }

  return agent
}

export async function resolveAgentTriggers<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
): Promise<Record<string, ResolvedAgentTriggerDefinition<TRuntimeConfig>>> {
  return await resolveAgentTriggersWithResolvedContext(agent, createResolvedRuntimeContext(context))
}

export async function resolveAgentTriggerInvocation<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TInput = unknown,
  CALL_OPTIONS = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  triggerId: string,
  input: TInput,
): Promise<ResolvedAgentTriggerInvocationResult<TRuntimeConfig, CALL_OPTIONS>> {
  return await resolveAgentTriggerInvocationWithResolvedContext<TRuntimeConfig, TInput, CALL_OPTIONS>(
    agent,
    createResolvedRuntimeContext(context),
    triggerId,
    input,
  )
}

export async function runAgentTrigger<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TInput = unknown,
  CALL_OPTIONS = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  triggerId: string,
  input: TInput,
): Promise<Response | AgentRunResult | unknown> {
  return await runAgentTriggerWith<TRuntimeConfig, TInput, CALL_OPTIONS>(runAgent, agent, createResolvedRuntimeContext(context), triggerId, input)
}

export async function streamAgentTrigger<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TInput = unknown,
  CALL_OPTIONS = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  triggerId: string,
  input: TInput,
  options: {
    onInvocation?: (invocation: ResolvedAgentTriggerInvocation<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void>
    output?: "events" | "ui-message-stream"
  } = {},
): Promise<Response | AsyncIterable<StreamEvent> | unknown> {
  return await streamAgentTriggerWith<TRuntimeConfig, TInput, CALL_OPTIONS>(streamAgent, agent, createResolvedRuntimeContext(context), triggerId, input, options)
}

function hasCustomRun<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): agent is AgentDefinition<TRuntimeConfig, any> & { run: NonNullable<AgentDefinition<TRuntimeConfig, CALL_OPTIONS>["run"]> } {
  return hasAgentDefinition(agent)
    && typeof agent.run === "function"
    && !(syntheticWorkspaceRun in agent.run)
}

interface RunAgentInlineOptions {
  output?: "raw" | "rendered"
}

type AgentInvocationContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
> = AgentRunContext<TRuntimeConfig, CALL_OPTIONS> & {
  box?: Box
  channels?: AgentChannels<TRuntimeConfig>
  close: () => Promise<void>
  deliveryEffectIntents: AgentChannelDeliveryEffectIntent[]
  toolStepReporter?: AgentRuntimeContext<TRuntimeConfig>["toolStepReporter"]
  driverContributions: AgentDriverContribution[]
  finalOutputRenderers: AgentCapabilityRegistries["finalOutputRenderers"]
  finishDeliveryEffectProviders: AgentChannelDeliveryFinishEffect[]
  finishExtensionProviders: ResolvedAgentFinishExtensionProvider[]
  errorHook?: (event: AgentErrorHookEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void | AgentChannelDeliveryFinishEffectResult>
  finishHook?: (event: AgentFinishHookEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void | AgentChannelDeliveryFinishEffectResult>
  hasCapabilityCleanup: boolean
  harnessSandboxProvider?: object
  harnessWorkDir?: string
  hooks?: AgentHookObserverHooks
  modelExecutionInstrumentation: AgentCapabilityRegistries["modelExecutionInstrumentation"]
  outputExtensionProviders: ResolvedAgentOutputExtensionProvider[]
  output?: AgentOutputDefinition
  outputRenderers: AgentCapabilityRegistries["outputRenderers"]
  runtimeContext: ResolvedAgentRuntimeContext<TRuntimeConfig>
  startTask?: Promise<void>
  instructions?: string
  startedAt: number
  actor: AgentInvoker
  invoker: AgentInvoker
  handledResponse?: Response
  workspace?: ReadonlyWorkspaceFacade<WorkspaceName> | WritableWorkspaceFacade<WorkspaceName>
  workspaceAutoCommit?: boolean | string
  workspaceDefinition?: WorkspaceDefinition
  workspaceInstructionBindings?: Record<string, unknown>
  workspaceMaterializationPaths: readonly string[]
  workspaceMode: AgentCapabilityMode
}

function toAgentAdapterRunContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS>,
): AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig> {
  return {
    ...context,
    box: context.box,
    instructions: context.instructions,
    modelExecutionInstrumentation: context.modelExecutionInstrumentation as never,
    runtime: context.runtimeContext,
    workspace: context.workspace as ReadonlyWorkspaceFacade<WorkspaceName> | undefined,
  }
}

async function resolveRegisteredAgentWorkspaceDefinition(name: string): Promise<WorkspaceDefinition | undefined> {
  try {
    return await (await import("@vite-hub/workspace")).resolveRegisteredWorkspaceDefinition(name)
  }
  catch (error) {
    if (getViteHubErrorShape(error)?.code === "WORKSPACE_NOT_FOUND") return undefined
    throw error
  }
}

function withBoxWorkspaceSessions<Name extends WorkspaceName>(
  workspace: WritableWorkspaceFacade<Name>,
  box: Box,
): WritableWorkspaceFacade<Name> {
  async function startBoxSession(target: WritableWorkspaceFacade<Name>, options?: WorkspaceSessionOptions): Promise<WorkspaceSession> {
    if (options?.host) return await target.startSession(options)
    const host = await box.open()
    try {
      const session = await target.startSession({
        ...options,
        attach: isHarnessBoxActive(box),
        host,
        target: options?.target || host.cwd,
      })
      let closePromise: Promise<void> | undefined
      return { ...session, async close() {
        closePromise ??= (async () => {
          let sessionError: unknown
          try { await session.close() }
          catch (error) { sessionError = error }
          try { await host.close() }
          catch (error) {
            if (sessionError) throw new AggregateError([sessionError, error], "[vitehub] Workspace and Box session cleanup failed.")
            throw error
          }
          if (sessionError) throw sessionError
        })()
        await closePromise
      } }
    }
    catch (error) {
      try { await host.close() }
      catch (closeError) { throw new AggregateError([error, closeError], "[vitehub] Workspace session setup and Box cleanup failed.") }
      throw error
    }
  }
  return {
    ...workspace,
    [Symbol.for("vitehub.workspace.start-box-session")]: startBoxSession,
    async startSession(options?: WorkspaceSessionOptions): Promise<WorkspaceSession> {
      return await startBoxSession(workspace, options)
    },
  }
}

function mergeWorkspaceSources(
  registered: WorkspaceDefinition["sources"] | undefined,
  configured: WorkspaceDefinition["sources"] | undefined,
): WorkspaceDefinition["sources"] | undefined {
  if (!registered && !configured) return undefined
  const sources = { ...registered }
  for (const [key, source] of Object.entries(configured || {})) {
    if (key in sources) {
      throw new Error(`[vitehub] Workspace source "${key}" is already defined.`)
    }
    sources[key] = source
  }
  return sources
}

function mergeAgentWorkspaceDefinition(
  name: string,
  registered: WorkspaceDefinition | undefined,
  configured: WorkspaceDefinition | undefined,
): WorkspaceDefinition | undefined {
  if (!registered && !configured) return undefined
  if (!registered) return configured ? { ...configured, name } : undefined
  if (!configured) return { ...registered, name: registered.name || name }

  const { name: _configuredName, sources: configuredSources, ...configuredFields } = configured as WorkspaceDefinition & { mode?: AgentCapabilityMode }
  const { mode: _mode, ...configuredDefinitionFields } = configuredFields
  if (!Object.keys(configuredDefinitionFields).length && !Object.keys(configuredSources || {}).length) {
    return registered
  }
  return {
    ...registered,
    ...configuredDefinitionFields,
    name: registered.name || name,
    sources: mergeWorkspaceSources(registered.sources, configuredSources),
  }
}

function hasWorkspaceDefinitionOverlay(definition: WorkspaceDefinition | undefined): boolean {
  if (!definition) return false
  const { name: _name, sources, mode: _mode, ...fields } = definition as WorkspaceDefinition & { mode?: AgentCapabilityMode }
  return Object.keys(fields).length > 0 || Object.keys(sources || {}).length > 0
}

async function registerResolvedAgentWorkspaceDefinition(name: string, definition: WorkspaceDefinition | undefined): Promise<void> {
  if (!definition) return
  const { name: _name, ...workspace } = definition
  const { registerWorkspace } = await import("@vite-hub/workspace/runtime")
  registerWorkspace(name, workspace)
}

async function createAgentInvocationContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
): Promise<AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS>> {
  const startedAt = Date.now()
  const resolvedContext = createResolvedRuntimeContext(context)
  const tracedRuntimeContext = resolvedContext.trace && resolvedContext.traceLog
    ? resolvedContext
    : {
        ...resolvedContext,
        trace: resolvedContext.trace || { id: createTraceId(context.run) },
        traceLog: resolvedContext.traceLog || createTraceEventLog(),
      }
  const boundRunEvents = bindAgentRunEvents(definition?.runEvents, tracedRuntimeContext)
  const runtimeContext = boundRunEvents
    ? { ...tracedRuntimeContext, runEvents: boundRunEvents }
    : tracedRuntimeContext
  const callbackContext = createAgentCallbackContext(runtimeContext)
  const invocationContext = createAgentInvocationContextStore(input.context)
  bindMessageChannelInstructions(
    invocationContext,
    activeAgentChannel(definition?.channels, invocationContext, context.run)?.channel,
  )
  invocationContext.set(scheduledAgentChannelIdsContextKey, Object.keys(definition?.channels || {}), { overwrite: true })
  invocationContext.set(scheduledAgentNameContextKey, context.agentIdentity?.name, { overwrite: true })
  const colocatedSkills = (definition as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS> | undefined)?.[colocatedAgentSkillsSymbol]
  invocationContext.set(colocatedAgentSkillsContextKey, colocatedSkills, { overwrite: true })
  let invoker = createFallbackAgentInvoker(context.run)
  try {
    invoker = await resolveAgentInvoker(
      definition?.invoker,
      callbackContext,
      invocationContext,
      input,
      context.run,
      invocationContext.get<boolean>(scheduledAgentTurnContextKey) === true,
    )
    const internalDefinition = definition as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS> | undefined
    const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig>> | undefined
    const workspaceOptions = workspaceDefinition?.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<AgentRuntimeConfig> | undefined
    const driverKind = internalDefinition?.[baseAgentDriverKind] || "model"
    const capabilitiesResolver = internalDefinition?.[baseAgentCapabilitiesResolver]
    const invocationResolvedCapabilities = capabilitiesResolver
      ? await resolveAgentCapabilityDefinitions(capabilitiesResolver, {
          ...agentInvocationCallbackContextValues(invocationContext),
          ...callbackContext,
          actor: invoker,
          context: invocationContext,
          driver: { kind: driverKind },
          input,
          invoker,
          run: context.run,
        })
      : []
    const activeChannel = activeAgentChannel(definition?.channels, invocationContext, context.run)?.channel
    const channelCapabilities = activeChannel?.capabilities || []
    const resolvedCapabilityDefinitions = normalizeCapabilities([
      ...invocationResolvedCapabilities,
      ...(definition?.capabilities || []),
      ...channelCapabilities,
    ]) as AgentCapabilityDefinition<TRuntimeConfig>[]
    const workspaceMode = workspaceOptions ? workspaceModeFromOptions(workspaceOptions) : "read"
    validateAgentCapabilityComposition(resolvedCapabilityDefinitions, {
      hasBox: Boolean(definition?.box),
      hasWorkspace: Boolean(workspaceOptions),
      ...(workspaceOptions ? { workspaceMode } : {}),
    })
    const boxDefinition = definition?.box
    if (boxDefinition && workspaceOptions && (boxDefinition.cwd !== undefined || boxDefinition.checkout !== undefined)) {
      throw new Error("[vitehub] defineAgent({ box, workspace }) cannot combine a Workspace with Box cwd or checkout because both own the same working tree. Remove cwd/checkout and let Workspace materialize into the Box.")
    }
    const box = boxDefinition
      ? shareBoxSessions(await (await import("@vite-hub/box")).resolveBox(boxDefinition, {
          ...callbackContext,
          actor: invoker,
          context: invocationContext,
          input,
          invoker,
          run: context.run,
        }, {
          requires: (definition as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS> | undefined)?.[baseAgentBoxRequirements],
        }))
      : undefined
    const harnessSandboxProvider = box
      ? (await import("./harness/box-sandbox.ts")).createBoxHarnessSandbox(box)
      : undefined
    const workspaceName = workspaceOptions
      ? workspaceNameFromOptions(workspaceOptions, {}, context.agentIdentity)
      : undefined
    const configuredWorkspaceDefinition = workspaceOptions && workspaceName
      ? { ...workspaceDefinitionFromOptions(workspaceOptions), name: workspaceName }
      : undefined
    const registeredWorkspaceDefinition = workspaceName
      ? await resolveRegisteredAgentWorkspaceDefinition(workspaceName)
      : undefined
    const ownsWorkspaceDefinition = workspaceDefinition ? workspaceAgentOwnsWorkspaceDefinition(workspaceDefinition) : false
    const configuredDefinitionForMerge = ownsWorkspaceDefinition && registeredWorkspaceDefinition
      ? undefined
      : configuredWorkspaceDefinition
    const baseResolvedWorkspaceDefinition = workspaceName
      ? mergeAgentWorkspaceDefinition(workspaceName, registeredWorkspaceDefinition, configuredDefinitionForMerge)
      : undefined
    const resolvedWorkspaceDefinition = baseResolvedWorkspaceDefinition
    if (workspaceName && ownsWorkspaceDefinition && configuredWorkspaceDefinition && !registeredWorkspaceDefinition) {
      await registerResolvedAgentWorkspaceDefinition(workspaceName, resolvedWorkspaceDefinition)
    }
    const workspaceUseOptions = !ownsWorkspaceDefinition && hasWorkspaceDefinitionOverlay(configuredDefinitionForMerge) && resolvedWorkspaceDefinition
      ? { definition: resolvedWorkspaceDefinition }
      : undefined
    const workspaceModule = workspaceName ? await import("@vite-hub/workspace") : undefined
    const baseWorkspace = workspaceName && workspaceModule
      ? workspaceMode === "write"
        ? workspaceModule.useWorkspace(workspaceName, workspaceUseOptions ? { ...workspaceUseOptions, mode: "write" } : { mode: "write" })
        : workspaceUseOptions ? workspaceModule.useWorkspace(workspaceName, { ...workspaceUseOptions, mode: "read" }) : workspaceModule.useWorkspace(workspaceName)
      : undefined
    const workspace = box && baseWorkspace && workspaceMode === "write"
      ? withBoxWorkspaceSessions(baseWorkspace as WritableWorkspaceFacade<WorkspaceName>, box)
      : baseWorkspace
    const capabilityOptions = resolvedCapabilityDefinitions.length
      ? { capabilities: resolvedCapabilityDefinitions, hooks: definition?.hooks as never }
      : undefined
    const agentModel = internalDefinition?.[baseAgentModel] as AgentModelResolver<TRuntimeConfig> | undefined
    const resolveCapabilityCli = resolveCapabilityCliRunSurface(definition)
    const capabilities = await resolveAgentCapabilities(capabilityOptions, runtimeContext, input, workspace as never, workspaceMode, {
      context: invocationContext,
      driverKind,
      invoker,
      model: agentModel as never,
      resolveCapabilityCli,
      workspaceDefinition: resolvedWorkspaceDefinition,
    })
    const inputHook = definition?.hooks?.["agent:input"]
    if (inputHook && !capabilities.response) {
      try {
        await runObservedAgentHook(definition?.hooks as AgentHookObserverHooks | undefined, {
          name: "agent:input",
          owner: "agent",
          phase: "input",
        }, () => inputHook({
          ...callbackContext,
          actor: invoker,
          context: invocationContext,
          input: capabilities.input as AgentRunInput<CALL_OPTIONS>,
          invoker,
          run: context.run,
        }))
      }
      catch (error) {
        try {
          await capabilities.close()
        }
        catch (closeError) {
          throw new AggregateError([error, closeError], "[vitehub] Agent input hook failed and cleanup also failed.")
        }
        throw error
      }
    }
    const transformedTools = resolveCapabilityCli ? capabilities.tools : await applyCapabilityToolTransforms(capabilities.tools, capabilities.toolTransforms)
    const tools = Object.keys(transformedTools || {}).length
      ? withAgentToolStepReporting(withJsonCompatibleToolOutputs(applyAgentToolPolicies(transformedTools) || {}), context.toolStepReporter)
      : undefined
    const activeWorkspace = capabilities.workspace || workspace
    const sourceResolvedWorkspaceDefinition = invocationContext.get<WorkspaceDefinition>("workspace.sourceResolution.definition")
    const activeWorkspaceDefinition = capabilities.workspaceDefinition || sourceResolvedWorkspaceDefinition || resolvedWorkspaceDefinition
    const configuredWorkspace = workspaceOptions?.workspace
    const workspaceAutoCommit = configuredWorkspace && typeof configuredWorkspace === "object" && !("name" in configuredWorkspace)
      ? configuredWorkspace.commit
      : undefined
    const instructions = workspaceOptions && activeWorkspace
      ? await resolveWorkspaceAgentDefaultInstructions(workspaceOptions, activeWorkspace as ReadonlyWorkspaceFacade)
      : undefined
    const workspaceInstructionBindings = activeWorkspaceDefinition
      ? await resolveWorkspaceInstructionBindings(activeWorkspaceDefinition, activeWorkspace as ReadonlyWorkspaceFacade | undefined)
      : undefined

    const invocation = {
      ...callbackContext,
      actor: invoker,
      box,
      channels: definition?.channels,
      close: capabilities.close,
      context: invocationContext,
      deliveryEffectIntents: capabilities.registries.deliveryEffectIntents,
      toolStepReporter: context.toolStepReporter,
      driverContributions: capabilities.driverContributions,
      finalOutputRenderers: capabilities.registries.finalOutputRenderers,
      finishDeliveryEffectProviders: capabilities.registries.finishDeliveryEffectProviders,
      finishExtensionProviders: capabilities.registries.finishExtensionProviders,
      errorHook: definition?.hooks?.["agent:error"] as never,
      finishHook: definition?.hooks?.["agent:finish"] as never,
      globalSkills: capabilities.globalSkills,
      hasCapabilityCleanup: capabilities.hasCloseCallbacks,
      handledResponse: capabilities.response,
      harnessSandboxProvider,
      hooks: definition?.hooks as AgentHookObserverHooks | undefined,
      input: capabilities.input as AgentRunInput<CALL_OPTIONS>,
      instructions,
      invoker,
      messages: capabilities.messages,
      modelExecutionInstrumentation: capabilities.registries.modelExecutionInstrumentation,
      outputExtensionProviders: capabilities.registries.outputExtensionProviders,
      output: internalDefinition?.[baseAgentOutput],
      outputRenderers: capabilities.registries.outputRenderers,
      prompt: typeof capabilities.input.prompt === "string" ? capabilities.input.prompt : undefined,
      providerTools: capabilities.registries.providerTools,
      run: context.run,
      runtimeContext,
      startTask: undefined as Promise<void> | undefined,
      startedAt,
      tools,
      workspace: activeWorkspace,
      workspaceAutoCommit,
      workspaceDefinition: activeWorkspaceDefinition,
      workspaceInstructionBindings,
      workspaceMaterializationSource: box ? activeWorkspace : undefined,
      workspaceMaterializationPaths: capabilities.workspaceMaterializationPaths,
      workspaceMode,
    }
    invocationContext.set("agent.errorHook", Boolean(invocation.errorHook), { overwrite: true })
    invocationContext.set("agent.finishHook", Boolean(invocation.finishHook), { overwrite: true })
    await traceAgentInvocationStart(toTraceContext(invocation))
    await applyChannelDeliveryEffectIntents(invocation, invocation.deliveryEffectIntents)
    const startCapabilities = capabilities.start
    if (!invocation.handledResponse && startCapabilities) {
      try {
        if (invocation.messages.some(message => message.role === "user") && hasTitleDeliveryEffectProvider(invocation.finishDeliveryEffectProviders)) {
          await setChannelDeliverySupportContext(invocation.channels, invocation.context, invocation.runtimeContext, invocation.input, invocation.run)
        }
        invocation.startTask = (async () => {
          await applyChannelDeliveryEffectIntents(invocation, await startCapabilities())
        })().catch(error => traceAgentInvocationError(toTraceContext(invocation), error))
        runtimeContext.waitUntil?.(invocation.startTask)
      }
      catch (error) {
        await traceAgentInvocationError(toTraceContext(invocation), error)
      }
    }
    return invocation
  }
  catch (error) {
    await traceAgentInvocationError({
      context: invocationContext,
      input,
      invoker,
      run: context.run,
      runtime: runtimeContext,
    }, error)
    throw error
  }
}

type InvocationRunContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
> = {
  channels?: AgentChannels<TRuntimeConfig>
  close: () => Promise<void>
  context: AgentInvocationContextStore
  deliveryEffectIntents?: readonly AgentChannelDeliveryEffectIntent[]
  finishDeliveryEffectProviders: AgentChannelDeliveryFinishEffect[]
  finishExtensionProviders: ResolvedAgentFinishExtensionProvider[]
  finalOutputRenderers: AgentCapabilityRegistries["finalOutputRenderers"]
  errorHook?: (event: AgentErrorHookEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void | AgentChannelDeliveryFinishEffectResult>
  finishHook?: (event: AgentFinishHookEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void | AgentChannelDeliveryFinishEffectResult>
  hooks?: AgentHookObserverHooks
  input: AgentRunInput<CALL_OPTIONS>
  output?: AgentOutputDefinition
  outputExtensionProviders: ResolvedAgentOutputExtensionProvider[]
  startTask?: Promise<void>
  actor: AgentInvoker
  invoker: AgentInvoker
  runtimeContext: ResolvedAgentRuntimeContext<TRuntimeConfig>
  run?: AgentRunContext<TRuntimeConfig, CALL_OPTIONS>["run"]
  startedAt: number
  workspace?: ReadonlyWorkspaceFacade | WritableWorkspaceFacade
  workspaceAutoCommit?: boolean | string
  workspaceDefinition?: WorkspaceDefinition
  workspaceMode: AgentCapabilityMode
}

function toTraceContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): AgentTraceContext<TRuntimeConfig> {
  return {
    context: context.context,
    input: context.input,
    invoker: context.invoker,
    run: context.run,
    runtime: context.runtimeContext,
  }
}

function maybeTraceAgentStream<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(stream: AsyncIterable<StreamEvent>, context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): AsyncIterable<StreamEvent> {
  return context.runtimeContext.traceLog ? traceAgentStreamEvents(stream, toTraceContext(context)) : stream
}

function withEagerStreamUsageExtensions<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  stream: AsyncIterable<unknown>,
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  result: unknown,
): AsyncIterable<unknown> {
  const providers = context.finishExtensionProviders.filter(provider => provider.eager)
  if (!providers.length) return stream
  return (async function* () {
    const toolNames = new Map<string, string>()
    const textPhases = new Map<string, AgentMessagePhase | "hidden">()
    for await (const chunk of stream) {
      const event = toAgentStreamEvent(chunk, toolNames, textPhases)
      const usageRecord = usageRecordFromStreamChunk(chunk, result)
      if (!usageRecord) {
        yield chunk
        continue
      }
      const usage = { ...usageRecord }
      const eventBase = {
        actor: context.actor,
        input: context.input,
        invoker: context.invoker,
        invocation: {
          durationMs: Date.now() - context.startedAt,
          ...(context.run ? { run: context.run } : {}),
          usage,
        },
        result,
        runtime: context.runtimeContext,
      } satisfies Omit<AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>, "extensions">
      await createAgentInvocationExtensions(eventBase as never, providers)
      if (chunk && typeof chunk === "object") {
        const prototype = Object.getPrototypeOf(chunk)
        if (prototype !== Object.prototype && prototype !== null) {
          if (Object.isExtensible(chunk)) {
            try {
              Object.defineProperty(chunk, "usageRecord", {
                configurable: true,
                enumerable: true,
                value: usage,
                writable: true,
              })
              yield chunk
              continue
            }
            catch {
              // Preserve the custom chunk and emit the canonical record separately.
            }
          }
          yield chunk
          yield { type: "usage", usageRecord: usage }
          continue
        }
        yield { ...chunk, usageRecord: usage }
        continue
      }
      yield { type: "usage", usageRecord: usage }
    }
  })()
}

function withEagerUiMessageStreamUsageExtensions<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  rendered: unknown,
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
): unknown {
  if (!isUIMessageStreamResult(rendered)) return rendered
  const toUIMessageStream = rendered.toUIMessageStream as (...args: unknown[]) => ReadableStream<unknown>
  return cloneWithPropertyDescriptors(rendered, {
    toUIMessageStream: {
      configurable: true,
      enumerable: false,
      value: (...args: unknown[]) => toReadableAsyncIterableStream(withEagerStreamUsageExtensions(
        toReadableAsyncIterableStream(toUIMessageStream.apply(rendered, args)),
        context,
        rendered,
      )),
    },
  })
}

function withStreamResultProperties<T extends AsyncIterable<StreamEvent>>(stream: T, result: unknown): T {
  if (typeof stream !== "object" || stream === null || typeof result !== "object" || result === null) return stream
  Object.defineProperties(stream, Object.fromEntries(["usage", "usageRecord"].map(key => [key, {
    configurable: true,
    enumerable: true,
    get: () => (result as Record<string, unknown>)[key],
  }])))
  return stream
}

function resultWithStreamedText(result: unknown, text: string): unknown {
  if (!text || typeof result === "string") return result
  if (result && typeof result === "object" && !(result instanceof Response)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, "text")
    const current = descriptor && "value" in descriptor ? descriptor.value : undefined
    if (typeof current === "string" && current) return result
    const prototype = Object.getPrototypeOf(result)
    if (prototype !== Object.prototype && prototype !== null && !Object.isExtensible(result)) return result
    return resultWithPreservedProperties(result, {
      text: {
        configurable: true,
        enumerable: true,
        value: text,
      },
    })
  }
  return { raw: result, text }
}

function resultWithUsageRecord(result: unknown, usageRecord: Extract<StreamEvent, { type: "usage" }>["usageRecord"] | undefined): unknown {
  if (!usageRecord || result instanceof Response) return result
  if (!result || typeof result !== "object") {
    return {
      raw: result,
      ...(typeof result === "string" && result ? { text: result } : {}),
      usage: usageRecord.usage,
      usageRecord,
    }
  }
  const record = result as { usage?: unknown, usageRecord?: unknown }
  record.usageRecord ??= usageRecord
  record.usage ??= usageRecord.usage
  return result
}

function resultWithResolvedUsageRecord(result: unknown, usageRecord: AgentUsageRecord | undefined): unknown {
  if (!usageRecord || result instanceof Response) return result
  if (!result || typeof result !== "object") return resultWithUsageRecord(result, usageRecord)
  const prototype = Object.getPrototypeOf(result)
  if (prototype !== Object.prototype && prototype !== null) {
    if (Object.isExtensible(result)) {
      try {
        Object.defineProperties(result, {
          ...(usageRecord.usage && !("usage" in result)
            ? {
                usage: {
                  configurable: true,
                  enumerable: true,
                  value: usageRecord.usage,
                  writable: true,
                },
              }
            : {}),
          usageRecord: {
            configurable: true,
            enumerable: true,
            value: usageRecord,
            writable: true,
          },
        })
        return result
      }
      catch {
        // Fall through to a wrapper when an existing property cannot be replaced.
      }
    }
    return {
      ...toAgentRunResult(result),
      raw: result,
      usage: usageRecord.usage,
      usageRecord,
    }
  }
  return cloneWithPropertyDescriptors(result, {
    ...(usageRecord.usage && !("usage" in result)
      ? {
          usage: {
            configurable: true,
            enumerable: true,
            value: usageRecord.usage,
            writable: true,
          },
        }
      : {}),
    usageRecord: {
      configurable: true,
      enumerable: true,
      value: usageRecord,
      writable: true,
    },
  })
}

function resultWithPreservedProperties(result: object, descriptors: PropertyDescriptorMap): object {
  const prototype = Object.getPrototypeOf(result)
  if (prototype !== Object.prototype && prototype !== null && Object.isExtensible(result)) {
    try {
      Object.defineProperties(result, descriptors)
      return result
    }
    catch {
      // Fall through to descriptor cloning for plain result objects and immutable properties.
    }
  }
  return cloneWithPropertyDescriptors(result, descriptors)
}

function resultWithStreamedTextAndUsage(
  result: unknown,
  text: string,
  usageRecord?: Extract<StreamEvent, { type: "usage" }>["usageRecord"],
  fallbackUsageRecord?: Extract<StreamEvent, { type: "usage" }>["usageRecord"],
): unknown {
  return resultWithUsageRecord(resultWithStreamedText(result, text), usageRecord ?? fallbackUsageRecord)
}

function withStreamedResult(
  stream: AsyncIterable<unknown>,
  result: unknown,
  fallbackUsageRecord?: Extract<StreamEvent, { type: "usage" }>["usageRecord"],
) {
  const toolNames = new Map<string, string>()
  const textPhases = new Map<string, AgentMessagePhase | "hidden">()
  let explicitTextPhaseSeen = false
  let finalText = ""
  let unphasedText = ""
  let usageRecord: Extract<StreamEvent, { type: "usage" }>["usageRecord"] | undefined
  return {
    finishResult(resultOverride: unknown = result) {
      return resultWithStreamedTextAndUsage(resultOverride, explicitTextPhaseSeen ? finalText : unphasedText, usageRecord, fallbackUsageRecord)
    },
    finishUsage() {
      return usageRecord ?? fallbackUsageRecord
    },
    stream: (async function* () {
      for await (const chunk of stream) {
        const event = toAgentStreamEvent(chunk, toolNames, textPhases)
        const explicitlyPhasedTextChunk = chunk && typeof chunk === "object"
          && "phase" in chunk && (chunk as { phase?: unknown }).phase !== undefined
          && "type" in chunk && ["text", "text-delta", "text-end", "text-start"].includes(String((chunk as { type?: unknown }).type))
        if (explicitlyPhasedTextChunk || (event?.type === "text-delta" && event.phase !== undefined)) {
          explicitTextPhaseSeen = true
          unphasedText = ""
        }
        if (event?.type === "text-delta" && event.text) {
          if (event.phase === "final") finalText += event.text
          else if (!explicitTextPhaseSeen && event.phase === undefined) unphasedText += event.text
        }
        const attachedUsageRecord = chunk && typeof chunk === "object" && "usageRecord" in chunk
          ? (chunk as { usageRecord?: AgentUsageRecord }).usageRecord
          : undefined
        usageRecord = event?.type === "usage"
          ? event.usageRecord
          : attachedUsageRecord ?? usageRecordFromStreamChunk(chunk, result) ?? usageRecord
        yield chunk
      }
    })(),
  }
}

async function finishStreamAgentInvocation<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  lifecycle: AgentInvocationLifecycle<AgentInvocationFinishOutcome>,
  result: unknown,
  outcome: AgentInvocationFinishOutcome,
  failureMessage: string,
  outputExtensions = new Map<string, unknown>(),
): Promise<void> {
  if (outcome.status === "error") {
    await lifecycle.finish(outcome)
    return
  }
  let finishResult: unknown
  let finishUsage: AgentUsageRecord | undefined
  try {
    const usageRecord = await resolveFinishUsageRecord(context, result)
    finishUsage = usageRecord
    const resolvedResult = resultWithResolvedUsageRecord(result, usageRecord)
    if (usageRecord && resolvedResult !== result && result && typeof result === "object" && Object.isExtensible(result)) {
      try {
        Object.defineProperty(result, "usageRecord", {
          configurable: true,
          enumerable: true,
          value: usageRecord,
          writable: true,
        })
      }
      catch {
        // The resolved wrapper still carries usage when the original result cannot.
      }
    }
    finishResult = await applyFinalOutputRenderers(resolvedResult, context, outputExtensions)
    finishResult = context.output
      ? await validateAgentOutput(context.output, await materializeAgentStructuredOutput(finishResult, context.input.abortSignal), { allowMaterializedObject: finishResult !== result })
      : resultWithUsageRecord(finishResult, usageRecord)
  }
  catch (finishError) {
    await lifecycle.fail({ error: finishError, status: "error" }, finishError, failureMessage)
  }
  await lifecycle.finish({ result: finishResult, status: "success", usage: finishUsage })
}

function traceUiMessageStream<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(stream: ReadableStream<unknown>, context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): ReadableStream<unknown> {
  const reader = stream.getReader()
  const toolNames = new Map<string, string>()
  const textPhases = new Map<string, AgentMessagePhase | "hidden">()
  let finished = false
  let released = false
  const release = () => {
    if (released) return
    released = true
    reader.releaseLock()
  }
  return new ReadableStream<unknown>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          if (!finished) await traceAgentStreamEvent(toTraceContext(context), { type: "finish" })
          release()
          controller.close()
          return
        }
        const event = toAgentStreamEvent(result.value, toolNames, textPhases)
        if (event) {
          if (event.type === "finish") finished = true
          await traceAgentStreamEvent(toTraceContext(context), event)
        }
        controller.enqueue(result.value)
      }
      catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      }
      finally {
        release()
      }
    },
  })
}

function maybeTraceUiMessageStreamResult<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(rendered: { toUIMessageStream: () => ReadableStream<unknown> }, context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>) {
  const toUIMessageStream = rendered.toUIMessageStream as (...args: unknown[]) => ReadableStream<unknown>
  return cloneWithPropertyDescriptors(rendered, {
    toUIMessageStream: {
      configurable: true,
      enumerable: false,
      value: (...args: unknown[]) => traceUiMessageStream(normalizeUiMessageStream(toUIMessageStream.apply(rendered, args)), context),
    },
  })
}

function maybeTraceUiMessageStreamOutput<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(rendered: unknown, context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): unknown {
  if (context.runtimeContext.traceLog) {
    if (isUIMessageStreamResult(rendered)) return maybeTraceUiMessageStreamResult(rendered, context)
    if (isAsyncIterable(rendered)) return maybeTraceAgentStream(rendered as AsyncIterable<StreamEvent>, context)
    if (!hasTraceableStreamResult(rendered)) return rendered
    return maybeTraceAgentStream(streamAgentOutputToEvents(rendered), context)
  }
  return isAsyncIterable(rendered) ? maybeTraceAgentStream(rendered as AsyncIterable<StreamEvent>, context) : rendered
}

function hasFinishConsumer<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): boolean {
  return Boolean(context.finishHook || context.finishDeliveryEffectProviders.length)
}

function hasFinishWork<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): boolean {
  return Boolean(context.errorHook) || hasFinishConsumer(context) || context.finishExtensionProviders.some(provider => provider.eager)
}

async function resolveFinishUsageRecord<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  result: unknown,
): Promise<Extract<StreamEvent, { type: "usage" }>["usageRecord"] | undefined> {
  if (hasFinishConsumer(context)) return await resolveAgentUsageRecord(result, context.run)
  if (!context.runtimeContext.traceLog && !context.finishExtensionProviders.some(provider => provider.eager)) return undefined
  try {
    return await resolveAgentUsageRecord(result, context.run)
  }
  catch {
    // Core tracing is best-effort and must not change Agent output.
    return undefined
  }
}

type AgentInvocationFinishOutcome =
  | { result?: unknown, status: "success", usage?: AgentUsageRecord, usageResolved?: boolean }
  | { error: unknown, status: "error" }

function finishOutcomeFromCleanup(outcome: { failed: false } | { error: unknown, failed: true }, result?: unknown): AgentInvocationFinishOutcome {
  return outcome.failed ? { error: outcome.error, status: "error" } : { result, status: "success" }
}

function isWritableWorkspaceFacade(workspace: unknown): workspace is WritableWorkspaceFacade {
  return Boolean(workspace && typeof workspace === "object" && "diff" in workspace && "snapshot" in workspace)
}

function hasWorkspaceAutoCommit<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): boolean {
  return context.workspaceMode === "write"
    && Boolean(context.workspaceDefinition && isWritableWorkspaceFacade(context.workspace))
}

function shouldDeferFinish<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS> & { hasCapabilityCleanup: boolean }): boolean {
  return context.hasCapabilityCleanup || hasFinishWork(context) || Boolean(context.finalOutputRenderers.length) || Boolean(context.output) || hasWorkspaceAutoCommit(context)
}

function shouldWrapInvocationOutput<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS> & { hasCapabilityCleanup: boolean }): boolean {
  return shouldDeferFinish(context) || Boolean(context.runtimeContext.traceLog)
}

async function commitWorkspaceChanges<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): Promise<void> {
  if (!context.workspaceDefinition || !isWritableWorkspaceFacade(context.workspace)) return

  const diff = await context.workspace.diff()
  const { resolveWorkspaceAutoCommit } = await import("@vite-hub/workspace")
  const commit = resolveWorkspaceAutoCommit(
    workspaceDefinitionWithAutoCommitRules(context.workspaceDefinition, context.workspaceAutoCommit),
    diff,
  )
  if (!commit) return
  await context.workspace.snapshot({ name: commit.message })
}

async function applyFinalOutputRenderers<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  result: unknown,
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  outputExtensions = new Map<string, unknown>(),
): Promise<unknown> {
  return await applyOutputRenderers(result, context.finalOutputRenderers, context.outputExtensionProviders, outputExtensions)
}

function assertDeliveryEffectIntent(value: unknown): asserts value is AgentChannelDeliveryEffectIntent {
  if (!value || typeof value !== "object" || typeof (value as { kind?: unknown }).kind !== "string" || !(value as { kind: string }).kind.trim()) {
    throw new TypeError("[vitehub] Channel finish delivery effect resolvers must return an effect intent with a non-empty kind.")
  }
}

function appendDeliveryEffectIntent(intents: AgentChannelDeliveryEffectIntent[], value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) appendDeliveryEffectIntent(intents, item)
    return
  }
  assertDeliveryEffectIntent(value)
  intents.push(value)
}

async function resolveFinishDeliveryEffectIntents<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  providers: readonly AgentChannelDeliveryFinishEffect[],
  event: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>,
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
): Promise<AgentChannelDeliveryEffectIntent[]> {
  const intents: AgentChannelDeliveryEffectIntent[] = []
  const finishContext = createFinishDeliveryEffectContext(event, context)
  for (const provider of providers) {
    const intent = typeof provider === "function" ? await provider(finishContext, event) : provider
    if (!intent) continue
    appendDeliveryEffectIntent(intents, intent)
  }
  return intents
}

function createFinishDeliveryEffectContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  event: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>,
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
): AgentChannelDeliveryFinishEffectContext<TRuntimeConfig, CALL_OPTIONS> {
  const result = event.result === undefined ? undefined : toAgentRunResult(event.result)
  const active = activeAgentChannel(context.channels, context.context, context.run)
  const reply: AgentChannelDeliveryFinishEffectContext<TRuntimeConfig, CALL_OPTIONS>["reply"] = (input, options = {}) => {
    const inputArtifacts = typeof input === "object" && input !== null && "artifacts" in input
      ? input.artifacts
      : undefined
    return createReplyDeliveryEffectIntent(input, {
      ...options,
      artifacts: options.artifacts ?? inputArtifacts ?? result?.artifacts,
    })
  }
  return {
    ...context.runtimeContext,
    actor: context.actor,
    ...(active ? { channel: active.channel } : {}),
    context: context.context,
    ...(event.error !== undefined ? { error: event.error } : {}),
    ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
    event,
    extensions: event.extensions,
    input: context.input,
    invocation: event.invocation,
    invoker: context.invoker,
    ...(event.result !== undefined ? { output: event.result } : {}),
    reaction: createReactionDeliveryEffectIntent,
    reply,
    ...(result !== undefined ? { result } : {}),
    request: context.runtimeContext.request,
    run: context.run,
    status: createStatusDeliveryEffectIntent,
    ...(event.text !== undefined ? { text: event.text } : {}),
    workspace: context.workspace,
  }
}

function createAgentFinishHookEvent<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  event: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>,
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
): AgentFinishHookEvent<TRuntimeConfig, CALL_OPTIONS> {
  const delivery = createFinishDeliveryEffectContext(event, context)
  const { error: _error, errorMessage: _errorMessage, ...finishEvent } = event
  return {
    ...finishEvent,
    reaction: delivery.reaction,
    reply: delivery.reply,
    status: delivery.status,
  }
}

function createAgentErrorHookEvent<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  event: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>,
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
): AgentErrorHookEvent<TRuntimeConfig, CALL_OPTIONS> {
  const delivery = createFinishDeliveryEffectContext(event, context)
  const { result: _result, text: _text, ...errorEvent } = event
  return {
    ...errorEvent,
    error: errorEvent.error,
    errorMessage: errorEvent.errorMessage ?? agentErrorDetails(errorEvent.error).message,
    reaction: delivery.reaction,
    reply: delivery.reply,
    status: delivery.status,
  }
}

function activeFinishDeliveryEffectProviders<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  event: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>,
): AgentChannelDeliveryFinishEffect[] {
  if (!context.finishDeliveryEffectProviders.length) return []
  const active = createFinishDeliveryEffectContext(event, context)
  return context.finishDeliveryEffectProviders.filter((provider) => {
    if (typeof provider !== "function" || !provider.active) return true
    return provider.active(active)
  })
}

function provisionalFinishEvent<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  eventBase: Omit<AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>, "extensions">,
): AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS> {
  return {
    ...eventBase,
    extensions: { get: () => undefined } as unknown as AgentFinishExtensions,
  } as AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>
}

function hasTitleDeliveryEffectProvider(providers: readonly AgentChannelDeliveryFinishEffect[]): boolean {
  return providers.some((provider) => {
    if (typeof provider === "function") return provider.kind === "title"
    const effects = Array.isArray(provider) ? provider : [provider]
    return effects.some(effect => effect.kind === "title")
  })
}

function hasDeferredFinishDeliveryEffectProvider(providers: readonly AgentChannelDeliveryFinishEffect[]): boolean {
  return providers.some(provider => typeof provider === "function" && (provider.kind === undefined || Boolean(provider.active)))
}

async function prepareProvisionalTitleDeliverySupport<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  eventBase: Omit<AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>, "extensions">,
): Promise<AgentChannelDeliveryFinishEffect[]> {
  const activeDeliveryProviders = activeFinishDeliveryEffectProviders(context, provisionalFinishEvent(context, eventBase))
  if (!hasTitleDeliveryEffectProvider(activeDeliveryProviders)) return activeDeliveryProviders
  await setChannelDeliverySupportContext(context.channels, context.context, context.runtimeContext, context.input, context.run)
  return activeFinishDeliveryEffectProviders(context, provisionalFinishEvent(context, eventBase))
}

async function finishAgentInvocation<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  outcome: AgentInvocationFinishOutcome,
): Promise<void> {
  const durationMs = Date.now() - context.startedAt
  const failed = outcome.status === "error"
  const error = failed ? outcome.error : undefined
  const result = outcome.status === "success" ? outcome.result : undefined
  const runResult = failed || result === undefined ? undefined : toAgentRunResult(result)
  const text = runResult?.text
  try {
    await context.startTask
    await context.close()
    let resultKind: string | undefined
    let usage = failed ? undefined : outcome.usage
    if (!failed) {
      try {
        resultKind = agentResultKind(result)
        if (!outcome.usageResolved) usage ??= await resolveAgentUsageRecord(result, context.run)
      }
      catch {
        // Invocation data must not change Agent output or mask the original failure.
      }
    }
    if (hasFinishWork(context)) {
      const details = failed ? agentErrorDetails(error) : undefined
      const eventBase = {
        ...(failed ? { error } : {}),
        ...(details ? { errorMessage: details.message } : {}),
        actor: context.actor,
        input: context.input,
        invoker: context.invoker,
        invocation: {
          durationMs,
          ...(resultKind !== undefined ? { resultKind } : {}),
          ...(context.run ? { run: context.run } : {}),
          ...(usage ? { usage } : {}),
        },
        ...(result !== undefined ? { result } : {}),
        runtime: context.runtimeContext,
        ...(text !== undefined ? { text } : {}),
      } satisfies Omit<AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>, "extensions">
      const provisionalActiveDeliveryProviders = await prepareProvisionalTitleDeliverySupport(context, eventBase)
      const outcomeHook = failed ? context.errorHook : context.finishHook
      const hookName = failed ? "agent:error" : "agent:finish"
      const hasOutcomeConsumer = Boolean(outcomeHook || provisionalActiveDeliveryProviders.length || hasDeferredFinishDeliveryEffectProvider(context.finishDeliveryEffectProviders))
      const finishExtensionProviders = hasOutcomeConsumer
        ? context.finishExtensionProviders
        : context.finishExtensionProviders.filter(provider => provider.eager)
      if (hasOutcomeConsumer || finishExtensionProviders.length) {
        const extensions = await createAgentInvocationExtensions(eventBase as never, finishExtensionProviders)
        const finishEvent = { ...eventBase, extensions }
        const activeDeliveryProviders = activeFinishDeliveryEffectProviders(context, finishEvent as never)
        await applyChannelDeliveryEffectIntents(context, await resolveFinishDeliveryEffectIntents(activeDeliveryProviders, finishEvent as never, context), finishEvent as never)
        let outcomeHookResult: void | AgentChannelDeliveryFinishEffectResult
        await runObservedAgentHook(context.hooks, {
          ids: { runId: context.run?.runId },
          name: hookName,
          owner: "agent",
          phase: failed ? "error" : "finish",
        }, async () => {
          outcomeHookResult = failed
            ? await context.errorHook?.(createAgentErrorHookEvent(finishEvent, context))
            : await context.finishHook?.(createAgentFinishHookEvent(finishEvent, context))
        })
        if (outcomeHookResult) {
          const outcomeHookIntents: AgentChannelDeliveryEffectIntent[] = []
          appendDeliveryEffectIntent(outcomeHookIntents, outcomeHookResult)
          await applyChannelDeliveryEffectIntents(context, outcomeHookIntents, finishEvent)
        }
      }
    }
    if (!failed) await commitWorkspaceChanges(context)
    if (!failed) {
      await traceAgentInvocationFinish(toTraceContext(context), {
        "invocation.durationMs": durationMs,
        "result.hasValue": result !== undefined,
        ...(resultKind !== undefined ? { "result.kind": resultKind } : {}),
        ...(usage ? { "usage.record": usage } : {}),
      })
    }
    else {
      await traceAgentInvocationError(toTraceContext(context), error)
    }
  }
  catch (finishError) {
    await traceAgentInvocationError(toTraceContext(context), failed ? error : finishError)
    throw finishError
  }
}

async function finalizeAgentInvocationResult<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TResult,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS> & { hasCapabilityCleanup: boolean },
  lifecycle: AgentInvocationLifecycle<AgentInvocationFinishOutcome>,
  result: unknown,
  finalizeObject: (result: unknown) => MaybePromise<{ deferFinish?: boolean, finishResult: unknown, finishUsage?: AgentUsageRecord, value: TResult }>,
  failureMessage: string,
  options: {
    finalizeResponse?: (response: Response) => MaybePromise<{ deferFinish?: boolean, finishResult: unknown, finishUsage?: AgentUsageRecord, value: Response | TResult } | undefined>
    finalizeRawStreams?: boolean
    holdOutput?: boolean
    outputExtensions?: Map<string, unknown>
    wrapStream?: (stream: AsyncIterable<unknown>) => AsyncIterable<unknown>
  } = {},
): Promise<Response | AsyncIterable<unknown> | TResult> {
  const shouldWrapOutput = options.holdOutput === true || shouldWrapInvocationOutput(context)
  try {
    if (result instanceof Response) {
      const finalized = await options.finalizeResponse?.(result)
      if (finalized) {
        if (!finalized.deferFinish) {
          await lifecycle.finish({ result: finalized.finishResult, status: "success", usage: finalized.finishUsage })
        }
        return finalized.value
      }
      const responseMediaType = result.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
      const responseIsText = responseMediaType !== "text/event-stream" && (responseMediaType?.startsWith("text/")
        || responseMediaType === "application/json"
        || responseMediaType?.endsWith("+json")
        || responseMediaType === "application/xml"
        || responseMediaType?.endsWith("+xml"))
      const responseDecoder = context.context.get<boolean>(responseTitleFallbackContextKey) === true && responseIsText
        ? new TextDecoder()
        : undefined
      let responseText = ""
      const response = shouldWrapOutput ? await withResponseCleanup(result, async (outcome) => {
        responseText += responseDecoder?.decode() ?? ""
        const finishResult = responseText && !outcome.failed
          ? { raw: result, text: responseText }
          : result
        if (!outcome.failed && !outcome.completed) {
          await lifecycle.finish({ result: finishResult, status: "success", usageResolved: true })
        }
        else {
          await lifecycle.finish(finishOutcomeFromCleanup(outcome, finishResult))
        }
      }, {
        abortSignal: context.input.abortSignal,
        onChunk: chunk => responseText += responseDecoder?.decode(chunk, { stream: true }) ?? "",
      }) : result
      return response
    }
    if (isAsyncIterable(result) && !hasTraceableStreamResult(result) && !options.finalizeRawStreams) {
      if (!shouldWrapOutput) {
        const enrichedStream = withEagerStreamUsageExtensions(result, context, result)
        return options.wrapStream?.(enrichedStream) || enrichedStream
      }
      const source = cancellableAsyncIterableSource(result)
      const enrichedStream = withEagerStreamUsageExtensions(source.stream, context, result)
      const stream = options.wrapStream?.(enrichedStream) || enrichedStream
      if (shouldWrapOutput) {
        const streamed = withStreamedResult(stream, result)
        if (!context.finalOutputRenderers.length && (!context.output || !options.finalizeRawStreams)) {
          const value = withCapabilityCleanup(streamed.stream, async (outcome) => {
            const finishOutcome = finishOutcomeFromCleanup(outcome, result)
            const usage = streamed.finishUsage()
            if (!outcome.failed && !outcome.completed) {
              return lifecycle.finish({
                result,
                status: "success",
                ...(usage ? { usage: await resolveAgentUsageRecord({ usageRecord: usage }, context.run) } : {}),
                usageResolved: true,
              })
            }
            return lifecycle.finish(finishOutcome.status === "success"
              ? { ...finishOutcome, usage: usage ? await resolveAgentUsageRecord({ usageRecord: usage }, context.run) : undefined }
              : finishOutcome)
          }, {
            abortSignal: context.input.abortSignal,
            cancelOnAbort: source.cancel,
          })
          return typeof (result as ReadableStream<unknown>).getReader === "function"
            ? toReadableAsyncIterableStream(value)
            : value
        }
        const value = withCapabilityCleanup(streamed.stream, outcome => finishStreamAgentInvocation(context, lifecycle, streamed.finishResult(), finishOutcomeFromCleanup(outcome), failureMessage, options.outputExtensions), {
          abortSignal: context.input.abortSignal,
          cancelOnAbort: source.cancel,
        })
        return typeof (result as ReadableStream<unknown>).getReader === "function"
          ? toReadableAsyncIterableStream(value)
          : value
      }
      return stream
    }
    const finalized = await finalizeObject(result)
    if (!finalized.deferFinish) {
      await lifecycle.finish({ result: finalized.finishResult, status: "success", usage: finalized.finishUsage })
    }
    return finalized.value
  }
  catch (error) {
    return await lifecycle.fail({ error, status: "error" }, error, failureMessage)
  }
}

async function materializeAgentStructuredOutput(
  result: unknown,
  abortSignal?: AbortSignal,
  onEvent?: AgentOutputEventObserver,
): Promise<unknown> {
  let streamResult = result
  const streamSources = new Map<AsyncIterable<unknown>, ReturnType<typeof cancellableAsyncIterableSource>>()
  if (!isAsyncIterable(streamResult)) {
    if (!streamResult || typeof streamResult !== "object") return result
    const descriptors: PropertyDescriptorMap = {}
    let hasStream = false
    try {
      for (const property of ["stream", "fullStream", "textStream"] as const) {
        let descriptor: PropertyDescriptor | undefined
        for (let owner: object | null = streamResult; owner && !descriptor; owner = Object.getPrototypeOf(owner))
          descriptor = Object.getOwnPropertyDescriptor(owner, property)
        if (!descriptor) continue
        if ("get" in descriptor && hasStream) continue
        const value = "get" in descriptor ? descriptor.get?.call(streamResult) : descriptor.value
        const source = isAsyncIterable(value)
          ? streamSources.get(value) ?? cancellableAsyncIterableSource(value)
          : undefined
        if (source) streamSources.set(value, source)
        descriptors[property] = {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          value: source?.stream ?? value,
          writable: true,
        }
        if (source) hasStream = true
      }
    }
    catch (error) {
      await Promise.allSettled([...streamSources.values()].map(({ cancel }) => cancel(error)))
      throw error
    }
    if (!hasStream) return result
    streamResult = cloneWithPropertyDescriptors(streamResult, descriptors)
  }
  if (toAgentRunResult(streamResult).text !== undefined) {
    await Promise.allSettled([...streamSources.values()].map(({ cancel }) => cancel()))
    return result
  }
  let text = ""
  let usageRecord: Extract<StreamEvent, { type: "usage" }>["usageRecord"] | undefined
  const source = cancellableAsyncIterableSource(streamAgentOutputToEvents(streamResult))
  const events = withCapabilityCleanup(source.stream, async (outcome) => {
    const cancellations = await Promise.allSettled([...streamSources.values()].map(({ cancel }) => cancel(outcome.failed ? outcome.error : undefined)))
    const rejected = cancellations.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (rejected) throw rejected.reason
  }, {
    abortSignal,
    cancelOnAbort: source.cancel,
  }) as AsyncIterable<StreamEvent>
  for await (const event of events) {
    onEvent?.(event)
    if (event.type === "error") throw new Error(event.error)
    if (event.type === "text-delta") text += event.text
    if (event.type === "usage") usageRecord = event.usageRecord
  }
  return resultWithUsageRecord(text, usageRecord)
}

type AgentInvocationExecutionOptions =
  & (
    | { kind: "run", renderOutput: boolean }
    | { kind: "stream", output: "events" | "ui-message-stream" }
  )
  & {
    holdCapacity?: boolean
    onCapacityBypass?: () => void
    onFinish?: (outcome: AgentInvocationFinishOutcome) => void
  }

async function closePreparedInvocationAfterFailure<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  preparedInvocation: AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS>,
  error: unknown,
  message: string,
): Promise<never> {
  const errors = [error]
  try {
    await preparedInvocation.startTask
  }
  catch (startError) {
    errors.push(startError)
  }
  try {
    await preparedInvocation.close()
  }
  catch (closeError) {
    errors.push(closeError)
  }
  if (errors.length > 1) throw new AggregateError(errors, message)
  throw error
}

function deferPreparedInvocationCloseAfterFailure<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  preparedInvocation: AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS>,
): void {
  const cleanupTask = (async () => {
    try {
      await preparedInvocation.startTask
    }
    finally {
      await preparedInvocation.close()
    }
  })()
  preparedInvocation.runtimeContext.waitUntil?.(cleanupTask)
  void cleanupTask.catch(() => {})
}

async function executeAgentInvocationWithCapacityLease<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOutput,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: AgentInvocationExecutionOptions,
  preparedInvocation?: AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS>,
): Promise<Response | AsyncIterable<StreamEvent> | unknown> {
  const customRun = hasCustomRun<TRuntimeConfig, CALL_OPTIONS>(agent)
  let adapter: AgentAdapter<CALL_OPTIONS> | undefined
  try {
    adapter = customRun ? undefined : await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(agent, context)
  }
  catch (error) {
    if (preparedInvocation) {
      return await closePreparedInvocationAfterFailure(preparedInvocation, error, "[vitehub] Agent Driver resolution and invocation cleanup failed.")
    }
    throw error
  }
  const definition = hasAgentDefinition(agent)
    ? agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, any, any, TOutput>
    : undefined
  const invocation = preparedInvocation ?? await createAgentInvocationContext(definition, context, input)
  const shouldHoldInvocationOutput = () => options.holdCapacity === true || shouldWrapInvocationOutput(invocation)
  const lifecycle = await openAgentInvocationLifecycle<AgentInvocationFinishOutcome>(
    async (outcome) => {
      try {
        await finishAgentInvocation(invocation, outcome)
        options.onFinish?.(outcome)
      }
      catch (error) {
        options.onFinish?.({ error, status: "error" })
        throw error
      }
    },
  )

  const runFailureMessage = "[vitehub] Agent run failed and finish lifecycle also failed."
  const streamFailureMessage = "[vitehub] Agent stream failed and finish lifecycle also failed."
  const handledFailureMessage = options.kind === "run" ? runFailureMessage : streamFailureMessage
  if (invocation.handledResponse) {
    options.onCapacityBypass?.()
    return await finalizeAgentInvocationResult(invocation, lifecycle, invocation.handledResponse, async result => ({ finishResult: result, value: result }), handledFailureMessage, {
      holdOutput: false,
    })
  }

  const executionFailureMessage = options.kind === "run" || customRun ? runFailureMessage : streamFailureMessage
  let result: unknown
  try {
    if (customRun) {
      result = await agent.run(invocation)
    }
    else if (options.kind === "stream"
      && adapter?.stream
      && (
        invocation.context.get<boolean>(finalChannelOutputContextKey) !== true
        || invocation.context.get<boolean>(progressSummaryOutputContextKey) === true
      )) {
      result = await adapter.stream(toAgentAdapterRunContext(invocation) as never)
    }
    else {
      result = await adapter!.generate(toAgentAdapterRunContext(invocation) as never)
    }
  }
  catch (error) {
    return await lifecycle.fail({ error, status: "error" }, error, executionFailureMessage)
  }

  if (options.kind === "run"
    && invocation.context.get<boolean>(finalChannelOutputContextKey) === true
    && !isAsyncIterable(result)
    && !hasTraceableStreamResult(result)) {
    const text = finalTextFromAgentOutput(result)
    if (text !== undefined && !(result instanceof Response)) {
      const synthesizedRaw = typeof result === "object" && result !== null
        && Object.getOwnPropertyDescriptor(result, synthesizedAgentOutputSymbol)?.value === true
        ? Object.getOwnPropertyDescriptor(result, "raw")?.value
        : undefined
      result = { raw: synthesizedRaw ?? result, text }
      Object.defineProperty(result, finalChannelOutputSelectedSymbol, { enumerable: true, value: true })
    }
  }

  const outputExtensions = new Map<string, unknown>()
  let renderedResult = false
  let rendererSource: ReturnType<typeof cancellableAsyncIterableSource> | undefined
  try {
    const shouldRenderStream = options.kind === "run"
      ? customRun && options.renderOutput && isAsyncIterable(result)
      : isAsyncIterable(result) && options.output !== "ui-message-stream" && !invocation.finalOutputRenderers.length
    if (shouldRenderStream) {
      rendererSource = shouldHoldInvocationOutput() && invocation.outputRenderers.length
        ? cancellableAsyncIterableSource(result as AsyncIterable<unknown>)
        : undefined
      result = await applyOutputRenderers(rendererSource?.stream ?? result, invocation.outputRenderers, invocation.outputExtensionProviders, outputExtensions)
      if (rendererSource && !isAsyncIterable(result) && !hasTraceableStreamResult(result) && !isUIMessageStreamResult(result)) {
        await rendererSource.cancel()
      }
      renderedResult = true
    }
  }
  catch (error) {
    await Promise.allSettled(rendererSource ? [rendererSource.cancel(error)] : [])
    return await lifecycle.fail({ error, status: "error" }, error, executionFailureMessage)
  }

  if (options.kind === "run") {
    return await finalizeAgentInvocationResult(invocation, lifecycle, result, async (result) => {
      const driverUsageRecord = hasTraceableStreamResult(result) || isUIMessageStreamResult(result)
        ? undefined
        : await resolveFinishUsageRecord(invocation, result)
      const rendered = options.renderOutput
        ? renderedResult ? result : await applyOutputRenderers(result, invocation.outputRenderers, invocation.outputExtensionProviders, outputExtensions)
        : result
      const shouldPreserveStreamResult = (hasTraceableStreamResult(rendered) || isUIMessageStreamResult(rendered))
        && !(options.renderOutput && invocation.output)
        && (options.holdCapacity === true || invocation.finishExtensionProviders.some(provider => provider.eager))
        && shouldHoldInvocationOutput()
      if (shouldPreserveStreamResult || (options.renderOutput
        && !invocation.output
        && invocation.context.get<boolean>(responseTitleFallbackContextKey) === true
        && rendered !== result
        && (isAsyncIterable((rendered as { stream?: unknown }).stream)
          || isAsyncIterable((rendered as { fullStream?: unknown }).fullStream)
          || isUIMessageStreamResult(rendered))
        && shouldHoldInvocationOutput())) {
        let textStreamDescriptor: PropertyDescriptor | undefined
        for (let owner: object | null = rendered as object; owner && !textStreamDescriptor; owner = Object.getPrototypeOf(owner))
          textStreamDescriptor = Object.getOwnPropertyDescriptor(owner, "textStream")
        const hasPrimaryStreamProperty = (["stream", "fullStream"] as const).some((property) => {
          let descriptor: PropertyDescriptor | undefined
          for (let owner: object | null = rendered as object; owner && !descriptor; owner = Object.getPrototypeOf(owner))
            descriptor = Object.getOwnPropertyDescriptor(owner, property)
          return descriptor !== undefined && ("get" in descriptor || isAsyncIterable(descriptor.value))
        })
        if (isUIMessageStreamResult(rendered)
          && !hasPrimaryStreamProperty
          && !textStreamDescriptor) {
          const toUIMessageStream = rendered.toUIMessageStream as (...args: unknown[]) => ReadableStream<unknown>
          let finishTask: Promise<void> | undefined
          let streamedText = ""
          let streamedUsageRecord: Extract<StreamEvent, { type: "usage" }>["usageRecord"] | undefined
          let preserved: object
          let uiMessageStreamCreated = false
          const finishPreserved = async (outcome: CapabilityCleanupOutcome) => {
            invocation.input.abortSignal?.removeEventListener("abort", onAbort)
            if (finishTask) return await finishTask
            const finishResult = resultWithStreamedTextAndUsage(preserved, streamedText, streamedUsageRecord, driverUsageRecord)
            finishTask = (async () => {
              if (!outcome.failed && !outcome.completed) {
                await lifecycle.finish({
                  result: finishResult,
                  status: "success",
                  ...(streamedUsageRecord
                    ? { usage: await resolveAgentUsageRecord({ usageRecord: streamedUsageRecord }, invocation.run) }
                    : {}),
                  usageResolved: true,
                })
              }
              else {
                await finishStreamAgentInvocation(invocation, lifecycle, finishResult, finishOutcomeFromCleanup(outcome), runFailureMessage, outputExtensions)
              }
              const usageRecord = finishResult && typeof finishResult === "object"
                ? (finishResult as { usageRecord?: AgentUsageRecord }).usageRecord
                : undefined
              if (usageRecord) resultWithUsageRecord(preserved, usageRecord)
            })()
            return await finishTask
          }
          const onAbort = () => {
            const reason = invocation.input.abortSignal?.reason ?? new DOMException("[vitehub] Agent Invocation stream aborted.", "AbortError")
            void finishPreserved({ error: reason, failed: true }).catch(() => {})
          }
          preserved = resultWithPreservedProperties(rendered, {
            toUIMessageStream: {
              configurable: true,
              enumerable: false,
              value: (...args: unknown[]) => {
                if (finishTask) throw new Error("[vitehub] Agent Invocation output has already finished.")
                if (uiMessageStreamCreated) throw new Error("[vitehub] Agent Invocation UI-message stream has already been created.")
                uiMessageStreamCreated = true
                invocation.input.abortSignal?.removeEventListener("abort", onAbort)
                let source: ReturnType<typeof cancellableAsyncIterableSource>
                try {
                  const renderedStream = toUIMessageStream.apply(rendered, args)
                  source = cancellableAsyncIterableSource(renderedStream)
                }
                catch (error) {
                  void finishPreserved({ error, failed: true }).catch(() => {})
                  throw error
                }
                return withReadableStreamCleanup(
                  toReadableAsyncIterableStream(withEagerStreamUsageExtensions(
                    toReadableAsyncIterableStream(normalizeUiMessageStream(toReadableAsyncIterableStream(source.stream))),
                    invocation,
                    rendered,
                  )),
                  finishPreserved,
                  {
                    abortSignal: invocation.input.abortSignal,
                    cancelOnAbort: source.cancel,
                    onChunk(chunk) {
                      streamedText += uiMessageTextDelta(chunk) || ""
                      streamedUsageRecord = usageRecordFromStreamChunk(chunk, rendered) ?? streamedUsageRecord
                    },
                  },
                )
              },
            },
          })
          if (invocation.input.abortSignal?.aborted) onAbort()
          else invocation.input.abortSignal?.addEventListener("abort", onAbort, { once: true })
          return {
            deferFinish: true,
            finishResult: preserved,
            value: preserved,
          }
        }
        const streamPropertyValues = new Map<"fullStream" | "stream", AsyncIterable<unknown>>()
        const lazyPrimaryDescriptors = new Map<"fullStream" | "stream", PropertyDescriptor>()
        const resolvedPrimaryProperties = new Map<"fullStream" | "stream", unknown>()
        const preservedSources = new Map<AsyncIterable<unknown>, ReturnType<typeof cancellableAsyncIterableSource>>()
        try {
          for (const property of ["stream", "fullStream"] as const) {
            let descriptor: PropertyDescriptor | undefined
            for (let owner: object | null = rendered as object; owner && !descriptor; owner = Object.getPrototypeOf(owner))
              descriptor = Object.getOwnPropertyDescriptor(owner, property)
            if (!descriptor) continue
            if ("get" in descriptor) {
              lazyPrimaryDescriptors.set(property, descriptor)
              continue
            }
            const value = descriptor.value
            resolvedPrimaryProperties.set(property, value)
            if (isAsyncIterable(value)) {
              streamPropertyValues.set(property, value)
              preservedSources.set(value, preservedSources.get(value) ?? cancellableAsyncIterableSource(value))
            }
          }
        }
        catch (error) {
          await Promise.allSettled(
            [...preservedSources.values()].map(({ cancel }) => cancel(error)),
          )
          throw error
        }
        const streamProperties = [...streamPropertyValues.keys()]
        let finishTask: Promise<void> | undefined
        let finishing = false
        let preserved: object
        const preservedStreams = new Map<AsyncIterable<unknown>, AsyncIterable<unknown>>()
        const cancelPreservedSources = async (outcome: CapabilityCleanupOutcome): Promise<CapabilityCleanupOutcome> => {
          if (options.holdCapacity !== true) return outcome
          const cancellations = await Promise.allSettled(
            [...preservedSources.values()].map(({ cancel }) => cancel(outcome.failed ? outcome.error : undefined)),
          )
          const rejected = cancellations.find((result): result is PromiseRejectedResult => result.status === "rejected")
          return rejected ? { error: rejected.reason, failed: true } : outcome
        }
        const onAbort = () => {
          if (preservedSources.size) return
          const reason = invocation.input.abortSignal?.reason ?? new DOMException("[vitehub] Agent Invocation stream aborted.", "AbortError")
          finishTask ||= finishStreamAgentInvocation(invocation, lifecycle, preserved, { error: reason, status: "error" }, runFailureMessage, outputExtensions)
          void finishTask.catch(() => {})
        }
        const preserveStream = (renderedStream: AsyncIterable<unknown>) => {
          const existing = preservedStreams.get(renderedStream)
          if (existing) return existing
          const source = preservedSources.get(renderedStream) ?? cancellableAsyncIterableSource(renderedStream)
          preservedSources.set(renderedStream, source)
          const enrichedStream = withEagerStreamUsageExtensions(source.stream, invocation, rendered)
          const streamed = withStreamedResult(enrichedStream, rendered, driverUsageRecord)
          const value = withCapabilityCleanup(streamed.stream, async (outcome) => {
            invocation.input.abortSignal?.removeEventListener("abort", onAbort)
            finishing = true
            const finalOutcome = await cancelPreservedSources(outcome)
            if (finishTask) return await finishTask
            const finishResult = streamed.finishResult(preserved)
            finishTask = (async () => {
              if (!finalOutcome.failed && !finalOutcome.completed) {
                await lifecycle.finish({
                  result: finishResult,
                  status: "success",
                  ...(streamed.finishUsage()
                    ? { usage: await resolveAgentUsageRecord({ usageRecord: streamed.finishUsage() }, invocation.run) }
                    : {}),
                  usageResolved: true,
                })
              }
              else {
                await finishStreamAgentInvocation(invocation, lifecycle, finishResult, finishOutcomeFromCleanup(finalOutcome), runFailureMessage, outputExtensions)
                const usageRecord = finishResult && typeof finishResult === "object"
                  ? (finishResult as { usageRecord?: AgentUsageRecord }).usageRecord
                  : undefined
                if (usageRecord) resultWithUsageRecord(preserved, usageRecord)
              }
            })()
            return await finishTask
          }, { abortSignal: invocation.input.abortSignal, cancelOnAbort: source.cancel })
          const preservedStream = typeof (renderedStream as ReadableStream<unknown>).pipeThrough === "function"
            ? toReadableAsyncIterableStream(value)
            : value
          preservedStreams.set(renderedStream, preservedStream)
          return preservedStream
        }
        const descriptors: PropertyDescriptorMap = {}
        try {
          for (const property of streamProperties) {
            descriptors[property] = {
              configurable: true,
              enumerable: true,
              value: preserveStream(streamPropertyValues.get(property)!),
              writable: true,
            }
          }
        }
        catch (error) {
          const unresolvedSources = [...new Set(streamPropertyValues.values())]
            .filter(stream => !preservedSources.has(stream))
          const [finalOutcome] = await Promise.all([
            cancelPreservedSources({ error, failed: true }),
            ...unresolvedSources.map(async (stream) => {
              try {
                await cancellableAsyncIterableSource(stream).cancel(error)
              }
              catch {}
            }),
          ])
          throw finalOutcome.failed ? finalOutcome.error : error
        }
        for (const [property, value] of resolvedPrimaryProperties) {
          if (!(property in descriptors)) {
            descriptors[property] = {
              configurable: true,
              enumerable: true,
              value,
              writable: true,
            }
          }
        }
        let unresolvedLazyStreamSurfaces = lazyPrimaryDescriptors.size
          + (textStreamDescriptor && "get" in textStreamDescriptor ? 1 : 0)
          + (isUIMessageStreamResult(rendered) ? 1 : 0)
        for (const [property, descriptor] of lazyPrimaryDescriptors) {
          let initialized = false
          let value: unknown
          descriptors[property] = {
            configurable: true,
            enumerable: descriptor.enumerable ?? false,
            get() {
              if (!initialized) {
                if (finishing || finishTask) throw new Error("[vitehub] Agent Invocation output has already finished.")
                try {
                  const resolved = descriptor.get?.call(rendered)
                  value = isAsyncIterable(resolved) ? preserveStream(resolved) : resolved
                  unresolvedLazyStreamSurfaces--
                  if (!isAsyncIterable(resolved) && !preservedSources.size && !unresolvedLazyStreamSurfaces) {
                    finishing = true
                    finishTask ||= lifecycle.finish({ result: preserved, status: "success", usageResolved: true })
                    void finishTask.catch(() => {})
                  }
                }
                catch (error) {
                  finishing = true
                  void (async () => {
                    const finalOutcome = await cancelPreservedSources({ error, failed: true })
                    finishTask ||= finishStreamAgentInvocation(invocation, lifecycle, preserved, finishOutcomeFromCleanup(finalOutcome), runFailureMessage, outputExtensions)
                    await finishTask
                  })().catch(() => {})
                  throw error
                }
                initialized = true
              }
              return value
            },
          }
        }
        if (isUIMessageStreamResult(rendered)) {
          const toUIMessageStream = rendered.toUIMessageStream as (...args: unknown[]) => ReadableStream<unknown>
          let uiMessageStreamResolved = false
          descriptors.toUIMessageStream = {
            configurable: true,
            enumerable: false,
            value: (...args: unknown[]) => {
              if (finishing || finishTask) throw new Error("[vitehub] Agent Invocation output has already finished.")
              try {
                const renderedStream = toUIMessageStream.apply(rendered, args)
                if (!uiMessageStreamResolved) {
                  uiMessageStreamResolved = true
                  unresolvedLazyStreamSurfaces--
                }
                const source = preservedSources.get(renderedStream) ?? cancellableAsyncIterableSource(renderedStream)
                preservedSources.set(renderedStream, source)
                return withReadableStreamCleanup(
                  normalizeUiMessageStream(toReadableAsyncIterableStream(source.stream)),
                  async (outcome) => {
                    finishing = true
                    const finalOutcome = await cancelPreservedSources(outcome)
                    if (finishTask) return await finishTask
                    finishTask = !finalOutcome.failed && !finalOutcome.completed
                      ? lifecycle.finish({ result: preserved, status: "success", usageResolved: true })
                      : finishStreamAgentInvocation(invocation, lifecycle, preserved, finishOutcomeFromCleanup(finalOutcome), runFailureMessage, outputExtensions)
                    return await finishTask
                  },
                  { abortSignal: invocation.input.abortSignal, cancelOnAbort: source.cancel },
                )
              }
              catch (error) {
                finishing = true
                void (async () => {
                  const finalOutcome = await cancelPreservedSources({ error, failed: true })
                  finishTask ||= finishStreamAgentInvocation(invocation, lifecycle, preserved, finishOutcomeFromCleanup(finalOutcome), runFailureMessage, outputExtensions)
                  await finishTask
                })().catch(() => {})
                throw error
              }
            },
          }
        }
        if (textStreamDescriptor) {
          const resolveTextStream = "get" in textStreamDescriptor
            ? () => textStreamDescriptor.get?.call(rendered)
            : () => textStreamDescriptor.value
          let preservedTextStream: unknown
          let initialized = false
          if (!("get" in textStreamDescriptor) && isAsyncIterable(textStreamDescriptor.value)) {
            try {
              preservedTextStream = preserveStream(textStreamDescriptor.value)
              initialized = true
            }
            catch (error) {
              const finalOutcome = await cancelPreservedSources({ error, failed: true })
              throw finalOutcome.failed ? finalOutcome.error : error
            }
          }
          descriptors.textStream = {
            configurable: true,
            enumerable: textStreamDescriptor.enumerable ?? false,
            get() {
              if (!initialized) {
                if (finishing || finishTask) throw new Error("[vitehub] Agent Invocation output has already finished.")
                try {
                  const textStream = resolveTextStream()
                  preservedTextStream = isAsyncIterable(textStream) ? preserveStream(textStream) : textStream
                  if ("get" in textStreamDescriptor) unresolvedLazyStreamSurfaces--
                  if (!isAsyncIterable(textStream) && !preservedSources.size && !unresolvedLazyStreamSurfaces) {
                    finishing = true
                    finishTask ||= lifecycle.finish({ result: preserved, status: "success", usageResolved: true })
                    void finishTask.catch(() => {})
                  }
                }
                catch (error) {
                  finishing = true
                  void (async () => {
                    const finalOutcome = await cancelPreservedSources({ error, failed: true })
                    finishTask ||= finishStreamAgentInvocation(invocation, lifecycle, preserved, finishOutcomeFromCleanup(finalOutcome), runFailureMessage, outputExtensions)
                    await finishTask
                  })().catch(() => {})
                  throw error
                }
                initialized = true
              }
              return preservedTextStream
            },
          }
        }
        preserved = resultWithPreservedProperties(rendered as object, descriptors)
        if (!streamProperties.length && !textStreamDescriptor && !isUIMessageStreamResult(rendered)) {
          return {
            finishResult: preserved,
            value: preserved,
          }
        }
        if (!streamProperties.length) {
          if (invocation.input.abortSignal?.aborted) onAbort()
          else invocation.input.abortSignal?.addEventListener("abort", onAbort, { once: true })
        }
        return {
          deferFinish: true,
          finishResult: preserved,
          value: preserved,
        }
      }
      const final = options.renderOutput ? await applyFinalOutputRenderers(rendered, invocation, outputExtensions) : rendered
      const structuredFinal = options.renderOutput && invocation.output
        ? await materializeAgentStructuredOutput(
            final,
            invocation.input.abortSignal,
            invocation.context.get<AgentOutputEventObserver>(agentOutputEventObserverContextKey),
          )
        : final
      const resolvedUsageRecord = options.renderOutput && invocation.output
        ? await resolveFinishUsageRecord(invocation, structuredFinal) ?? driverUsageRecord
        : driverUsageRecord
      const hasEagerFinishExtension = invocation.finishExtensionProviders.some(provider => provider.eager)
      const structuredUsageRecord = hasEagerFinishExtension && resolvedUsageRecord
        ? { ...resolvedUsageRecord }
        : resolvedUsageRecord
      const finishResult = invocation.output
        ? undefined
        : hasEagerFinishExtension
          ? resultWithResolvedUsageRecord(final, structuredUsageRecord)
          : hasFinishWork(invocation) ? resultWithUsageRecord(final, structuredUsageRecord) : final
      const value = options.renderOutput && invocation.output
        ? await validateAgentOutput(invocation.output, structuredFinal, {
            allowMaterializedObject: customRun
              ? structuredFinal === final
              : structuredFinal === final && final !== result,
          })
        : customRun
          ? hasEagerFinishExtension ? finishResult : final
          : options.renderOutput ? toAgentRunResult(finishResult) : final
      return {
        finishResult: invocation.output ? value : finishResult,
        finishUsage: structuredUsageRecord,
        value,
      }
    }, runFailureMessage, {
      finalizeRawStreams: options.renderOutput && Boolean(invocation.output),
      holdOutput: options.holdCapacity,
      outputExtensions,
      ...(customRun
        ? {
            wrapStream: (stream: AsyncIterable<unknown>) => maybeTraceAgentStream(stream as AsyncIterable<StreamEvent>, invocation),
          }
        : {}),
    })
  }

  return await finalizeAgentInvocationResult(invocation, lifecycle, result, async (result) => {
    const hasEagerFinishExtension = invocation.finishExtensionProviders.some(provider => provider.eager)
    const driverUsageRecord = hasEagerFinishExtension
      && (hasTraceableStreamResult(result) || isUIMessageStreamResult(result))
      ? undefined
      : await resolveFinishUsageRecord(invocation, result)
    const rendered = renderedResult ? result : await applyOutputRenderers(result, invocation.outputRenderers, invocation.outputExtensionProviders, outputExtensions)
    if (options.output === "ui-message-stream") {
      const projection = typeof definition?.uiMessageStream === "function"
        ? await definition.uiMessageStream(invocation)
        : definition?.uiMessageStream
      let uiMessageSource: ReturnType<typeof cancellableAsyncIterableSource> | undefined
      const uiMessageSources = new Map<AsyncIterable<unknown>, ReturnType<typeof cancellableAsyncIterableSource>>()
      let capacityRendered = rendered
      if (options.holdCapacity === true) {
        if (isUIMessageStreamResult(rendered)) {
          const toUIMessageStream = rendered.toUIMessageStream as (...args: unknown[]) => ReadableStream<unknown>
          try {
            for (const property of ["stream", "fullStream", "textStream"] as const) {
              let descriptor: PropertyDescriptor | undefined
              for (let owner: object | null = rendered; owner && !descriptor; owner = Object.getPrototypeOf(owner))
                descriptor = Object.getOwnPropertyDescriptor(owner, property)
              if (!descriptor) continue
              if ("get" in descriptor) continue
              const candidate = descriptor.value
              if (!isAsyncIterable(candidate)) continue
              uiMessageSources.set(candidate, uiMessageSources.get(candidate) ?? cancellableAsyncIterableSource(candidate))
            }
          }
          catch (error) {
            await Promise.allSettled([...uiMessageSources.values()].map(({ cancel }) => cancel(error)))
            throw error
          }
          capacityRendered = cloneWithPropertyDescriptors(rendered, {
            toUIMessageStream: {
              configurable: true,
              enumerable: false,
              value: (...args: unknown[]) => {
                try {
                  const stream = toUIMessageStream.apply(rendered, args)
                  uiMessageSource = uiMessageSources.get(stream) ?? cancellableAsyncIterableSource(stream)
                  uiMessageSources.set(stream, uiMessageSource)
                  return toReadableAsyncIterableStream(uiMessageSource.stream)
                }
                catch (error) {
                  return new ReadableStream({
                    async start(controller) {
                      await Promise.allSettled([...uiMessageSources.values()].map(({ cancel }) => cancel(error)))
                      controller.error(error)
                    },
                  })
                }
              },
            },
          })
        }
        else if (isAsyncIterable(rendered)) {
          uiMessageSource = cancellableAsyncIterableSource(rendered)
          uiMessageSources.set(rendered, uiMessageSource)
          capacityRendered = uiMessageSource.stream
        }
      }
      const enrichedRendered = isAsyncIterable(capacityRendered)
        ? withEagerStreamUsageExtensions(capacityRendered, invocation, rendered)
        : withEagerUiMessageStreamUsageExtensions(capacityRendered, invocation)
      return finalizeUiMessageStreamOutput(maybeTraceUiMessageStreamOutput(enrichedRendered, invocation), shouldHoldInvocationOutput(), async (outcome, streamedText, streamedUsageRecord) => {
        const cancellations = await Promise.allSettled([...uiMessageSources.values()].map(({ cancel }) => cancel(outcome.failed ? outcome.error : undefined)))
        const rejected = cancellations.find((result): result is PromiseRejectedResult => result.status === "rejected")
        if (rejected) outcome = { error: rejected.reason, failed: true }
        const finishResult = resultWithStreamedTextAndUsage(rendered, streamedText || "", streamedUsageRecord, driverUsageRecord)
        if (!outcome.failed && !outcome.completed) {
          await lifecycle.finish({
            result: finishResult,
            status: "success",
            ...(streamedUsageRecord
              ? { usage: await resolveAgentUsageRecord({ usageRecord: streamedUsageRecord }, invocation.run) }
              : {}),
            usageResolved: true,
          })
        }
        else {
          await finishStreamAgentInvocation(invocation, lifecycle, finishResult, finishOutcomeFromCleanup(outcome), streamFailureMessage, outputExtensions)
        }
      }, projection, invocation.input.abortSignal, options.holdCapacity === true
        ? async reason => { await Promise.allSettled([...uiMessageSources.values()].map(({ cancel }) => cancel(reason))) }
        : undefined)
    }

    let isStreamResult = hasTraceableStreamResult(rendered)
    let streamResult = rendered
    const eagerStreamSources = new Map<AsyncIterable<unknown>, ReturnType<typeof cancellableAsyncIterableSource>>()
    if (isStreamResult && options.holdCapacity === true && rendered && typeof rendered === "object") {
      const descriptors: PropertyDescriptorMap = {}
      let selectedStream = false
      try {
        for (const property of ["stream", "fullStream", "textStream"] as const) {
          let descriptor: PropertyDescriptor | undefined
          for (let owner: object | null = rendered; owner && !descriptor; owner = Object.getPrototypeOf(owner))
            descriptor = Object.getOwnPropertyDescriptor(owner, property)
          if (!descriptor) continue
          if ("get" in descriptor && selectedStream) continue
          const candidate = "get" in descriptor ? descriptor.get?.call(rendered) : descriptor.value
          const source = isAsyncIterable(candidate)
            ? eagerStreamSources.get(candidate) ?? cancellableAsyncIterableSource(candidate)
            : undefined
          if (source) eagerStreamSources.set(candidate, source)
          descriptors[property] = {
            configurable: true,
            enumerable: descriptor.enumerable ?? false,
            value: source?.stream ?? candidate,
            writable: true,
          }
          if (source) selectedStream = true
        }
        isStreamResult = selectedStream
        streamResult = cloneWithPropertyDescriptors(rendered, descriptors)
      }
      catch (error) {
        await Promise.allSettled([...eagerStreamSources.values()].map(({ cancel }) => cancel(error)))
        throw error
      }
    }
    if (customRun && !isAsyncIterable(rendered) && !isStreamResult) {
      const final = await applyFinalOutputRenderers(rendered, invocation, outputExtensions)
      const value = invocation.output
        ? await validateAgentOutput(invocation.output, final, { allowMaterializedObject: true })
        : final
      return {
        finishResult: value,
        finishUsage: driverUsageRecord,
        value,
      }
    }
    const stream = isStreamResult
      ? streamAgentOutputToEvents(streamResult)
      : customRun ? rendered as AsyncIterable<StreamEvent> : streamAgentOutputToEvents(rendered)
    const shouldWrapOutput = shouldHoldInvocationOutput()
    const source = shouldWrapOutput ? cancellableAsyncIterableSource(stream) : undefined
    const streamed = withStreamedResult(withEagerStreamUsageExtensions(source?.stream ?? stream, invocation, rendered), rendered, driverUsageRecord)
    const tracedStream = maybeTraceAgentStream(streamed.stream as AsyncIterable<StreamEvent>, invocation)
    const value = shouldWrapOutput
      ? withCapabilityCleanup(tracedStream, async (outcome) => {
          const cancellations = await Promise.allSettled([...eagerStreamSources.values()].map(({ cancel }) => cancel(outcome.failed ? outcome.error : undefined)))
          const rejected = cancellations.find((result): result is PromiseRejectedResult => result.status === "rejected")
          if (rejected) outcome = { error: rejected.reason, failed: true }
          const finishResult = streamed.finishResult()
          if (!outcome.failed && !outcome.completed) {
            await lifecycle.finish({
              result: finishResult,
              status: "success",
              ...(streamed.finishUsage()
                ? { usage: await resolveAgentUsageRecord({ usageRecord: streamed.finishUsage() }, invocation.run) }
                : {}),
              usageResolved: true,
            })
          }
          else {
            await finishStreamAgentInvocation(invocation, lifecycle, finishResult, finishOutcomeFromCleanup(outcome), streamFailureMessage, outputExtensions)
          }
        }, { abortSignal: invocation.input.abortSignal, cancelOnAbort: source?.cancel }) as AsyncIterable<StreamEvent>
      : tracedStream
    return {
      deferFinish: shouldWrapOutput,
      finishResult: rendered,
      value: customRun ? withStreamResultProperties(value, rendered) : value,
    }
  }, executionFailureMessage, {
    finalizeResponse: options.output === "ui-message-stream"
      ? async (response) => {
          if (!isUIMessageStreamResponse(response)) return
          const projection = typeof definition?.uiMessageStream === "function"
            ? await definition.uiMessageStream(invocation)
            : definition?.uiMessageStream
          const enrichedResponseStream = withEagerUiMessageStreamUsageExtensions({
            toUIMessageStream: () => uiMessageStreamFromResponse(response),
          }, invocation)
          const finalized = await finalizeUiMessageStreamOutput(enrichedResponseStream, shouldHoldInvocationOutput(), async (outcome, streamedText, streamedUsageRecord) => {
            if (!outcome.failed && !outcome.completed) {
              await lifecycle.finish({
                result: resultWithStreamedTextAndUsage(response, streamedText || "", streamedUsageRecord),
                status: "success",
                ...(streamedUsageRecord
                  ? { usage: await resolveAgentUsageRecord({ usageRecord: streamedUsageRecord }, invocation.run) }
                  : {}),
                usageResolved: true,
              })
            }
            else {
              const driverUsageRecord = await resolveFinishUsageRecord(invocation, response)
              await finishStreamAgentInvocation(invocation, lifecycle, resultWithStreamedTextAndUsage(response, streamedText || "", streamedUsageRecord, driverUsageRecord), finishOutcomeFromCleanup(outcome), streamFailureMessage, outputExtensions)
            }
          }, projection, invocation.input.abortSignal)
          const headers = new Headers(response.headers)
          headers.delete("content-encoding")
          headers.delete("content-length")
          return {
            ...finalized,
            finishResult: response,
            value: createAgentUIMessageStreamResponse({
              headers,
              status: response.status,
              statusText: response.statusText,
              stream: finalized.value,
            }),
          }
        }
      : undefined,
    finalizeRawStreams: options.output === "ui-message-stream" || Boolean(invocation.finalOutputRenderers.length) || Boolean(invocation.output),
    holdOutput: options.holdCapacity,
    outputExtensions,
    ...(customRun
      ? { wrapStream: (stream: AsyncIterable<unknown>) => maybeTraceAgentStream(stream as AsyncIterable<StreamEvent>, invocation) }
      : {}),
  })
}

async function executeAgentInvocation<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOutput,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: AgentInvocationExecutionOptions,
): Promise<Response | AsyncIterable<StreamEvent> | unknown> {
  const definition = hasAgentDefinition(agent) ? agent as object : undefined
  const preparedInvocation = definition && inspectAgentCapacity(definition)
    ? await createAgentInvocationContext(
        agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, any, any, TOutput>,
        context,
        input,
      )
    : undefined
  if (preparedInvocation?.handledResponse) {
    return await executeAgentInvocationWithCapacityLease(agent, context, input, options, preparedInvocation)
  }
  let release: (() => void) | undefined
  try {
    release = definition
      ? await acquireAgentCapacity(definition, input.abortSignal)
      : undefined
  }
  catch (error) {
    if (preparedInvocation) {
      deferPreparedInvocationCloseAfterFailure(preparedInvocation)
    }
    throw error
  }
  if (!release) {
    return await executeAgentInvocationWithCapacityLease(agent, context, input, options, preparedInvocation)
  }

  let released = false
  const releaseOnce = () => {
    if (released) return
    released = true
    release()
  }
  try {
    return await executeAgentInvocationWithCapacityLease(agent, context, input, {
      ...options,
      holdCapacity: true,
      onCapacityBypass: releaseOnce,
      onFinish(outcome) {
        try {
          options.onFinish?.(outcome)
        }
        finally {
          releaseOnce()
        }
      },
    }, preparedInvocation)
  }
  catch (error) {
    releaseOnce()
    throw error
  }
}

export function runAgentInline<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: { output: "raw" },
): Promise<unknown>
export function runAgentInline<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options?: RunAgentInlineOptions,
): Promise<TOutput | Response>
export async function runAgentInline<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: RunAgentInlineOptions = {},
): Promise<TOutput | Response> {
  context = withAgentIdentityOwner(agent, context)
  return await executeAgentInvocation(agent, context, input, {
    kind: "run",
    renderOutput: options.output !== "raw",
  }) as TOutput
}

function agentInvocationSnapshotFromWorkflow<TOutput>(
  run: AgentWorkflowRun<TOutput>,
): AgentInvocationSnapshot<TOutput> | undefined {
  const status = run.status === "queued"
    ? "pending"
    : run.status === "unknown"
      ? undefined
      : run.status
  if (!status) return undefined
  return {
    ...(run.status === "failed" && run.metadata !== undefined ? { error: run.metadata } : {}),
    id: run.id,
    ...(run.result !== undefined ? { output: run.result } : {}),
    status,
  }
}

function workflowOperationOutcome(error: unknown): "unsupported" | "unavailable" {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "WORKFLOW_OPERATION_UNSUPPORTED"
    ? "unsupported"
    : "unavailable"
}

function createWorkflowAgentInvocationController<CALL_OPTIONS, TOutput>(
  started: StartedAgentWorkflow<CALL_OPTIONS, TOutput>,
  parentAbortSignal?: AbortSignal,
): AgentInvocationController<TOutput | Response, CALL_OPTIONS> {
  const { handle, run } = started
  return createBackedAgentInvocationController<TOutput | Response, CALL_OPTIONS>({
    cancel: async () => agentInvocationSnapshotFromWorkflow(await handle.cancel(run.id) as AgentWorkflowRun<TOutput>),
    errorOutcome: workflowOperationOutcome,
    id: run.id,
    inspect: async () => agentInvocationSnapshotFromWorkflow(await handle.getRun(run.id) as AgentWorkflowRun<TOutput>),
    parentAbortSignal,
    result: Promise.resolve(run),
  })
}

function createInlineAgentInvocationController<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOutput,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  runId?: string,
): AgentInvocationController<TOutput | Response, CALL_OPTIONS> {
  return startLiveAgentInvocation<TOutput | Response, CALL_OPTIONS>({
    parentAbortSignal: input.abortSignal,
    sendInput: (id, nextInput, options) => sendAgentInvocationInput(id, nextInput, options),
    start: ({ abortSignal, id, onFinish }) => executeAgentInvocation(agent, {
      ...withAgentInvocationControlId(context, id),
      run: { ...context.run, runId: runId || id },
    }, { ...input, abortSignal }, {
      kind: "run",
      onFinish(outcome) {
        onFinish(outcome.status === "success"
          ? { ...(outcome.result !== undefined ? { output: outcome.result as TOutput | Response } : {}), status: "completed" }
          : { error: outcome.error, status: "failed" })
      },
      renderOutput: true,
    }),
    support: id => agentInvocationInputSupport(id),
  })
}

export async function startAgentInvocation<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: { runId?: string } = {},
): Promise<AgentInvocationController<TOutput | Response, CALL_OPTIONS>> {
  const invocationContext = withAgentIdentityOwner(agent, context)
  const workflow = await runAgentAsWorkflow<TRuntimeConfig, CALL_OPTIONS, TOutput>(
    agent,
    invocationContext,
    input,
    { fresh: true },
  )
  return workflow
    ? createWorkflowAgentInvocationController(workflow, input.abortSignal)
    : createInlineAgentInvocationController(agent, invocationContext, input, options.runId)
}

export async function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
): Promise<TOutput | Response | AgentWorkflowRun<TOutput>> {
  const invocationContext = withAgentIdentityOwner(agent, context)
  const workflow = await runAgentAsWorkflow<TRuntimeConfig, CALL_OPTIONS, TOutput>(agent, invocationContext, input)
  if (workflow) return workflow.run
  return await runAgentInline(agent, invocationContext, input)
}

export async function runScheduledAgent<CALL_OPTIONS = unknown>(
  agent: AgentInput<AgentRuntimeContext>,
  context: ScheduleRunContextLike,
  runtimeContext: Partial<ResolvedAgentRuntimeContext> = {},
  input: AgentRunInput<CALL_OPTIONS> = {},
): Promise<unknown> {
  const memoValues = new Map<string, unknown>()
  const runId = context.runId || context.id
  const turn = context.input && typeof context.input === "object" && (context.input as { kind?: unknown }).kind === "agent-turn"
    ? parseScheduledAgentTurnInput(context.input)
    : undefined
  const forwardedInput = { ...input }
  if (turn) {
    delete forwardedInput.message
    delete forwardedInput.messages
    delete forwardedInput.prompt
  }

  return await runAgent(agent, {
    ...runtimeContext,
    memo(key, create) {
      if (!memoValues.has(key)) memoValues.set(key, create())
      return memoValues.get(key) as never
    },
    run: { ...runtimeContext.run, ...turn?.delivery, runId },
    runtime: runtimeContext.runtime ?? "unknown",
    waitUntil: runtimeContext.waitUntil ?? context.waitUntil ?? (() => {}),
  }, {
    ...forwardedInput,
    context: {
      ...input.context,
      ...(turn
        ? {
            invoker: turn.invoker,
            [scheduledAgentTurnContextKey]: true,
          }
        : {}),
      schedule: {
        id: context.id,
        kind: "schedule",
        runId,
        scheduleId: context.scheduleId,
        scheduledAt: context.scheduledAt,
        target: context.target,
      },
    },
    ...(turn ? { prompt: turn.prompt } : {}),
  })
}

export async function streamAgentInline<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: { output?: "events" | "ui-message-stream" } = {},
): Promise<Response | AsyncIterable<StreamEvent> | unknown> {
  return await executeAgentInvocation(agent, context, input, {
    kind: "stream",
    output: options.output || "events",
  })
}

export async function streamAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: { output?: "events" | "ui-message-stream" } = {},
): Promise<Response | AsyncIterable<StreamEvent> | unknown> {
  return await streamAgentInline(agent, context, input, options)
}

export async function getAgent<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  context: TContext,
): Promise<AgentAdapter> {
  return await resolveAgent(agent, context)
}
