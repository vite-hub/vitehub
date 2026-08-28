import { asUnknownBoundary, hasRuntimeType, isCallableMember, isRuntimeObject } from "./internal/runtime-type.ts"
import agentRegistry from "#vitehub/agent/registry"
import { acquireAgentCapacity, configureAgentCapacity, inspectAgentCapacity } from "./internal/agent-capacity.ts"
import { normalizeAgentDriver } from "./internal/agent-driver.ts"
import { agentOutputEventObserverContextKey, progressSummaryOutputContextKey, type AgentOutputEventObserver } from "./internal/agent-output-events.ts"
import { openAgentInvocationLifecycle, type AgentInvocationLifecycle } from "./internal/invocation-lifecycle.ts"
import { cloneWithPropertyDescriptors, toReadableAsyncIterableStream } from "./internal/stream-result.ts"
import { validateAgentOutput } from "./internal/agent-structured-output.ts"
import { loadAgentWorkflowModule, loadAgentWorkflowRuntimeStateModule } from "./internal/workflow-runtime-loaders.ts"
import { cloneWorkflowJsonValue, workflowBytesToBase64 } from "./internal/workflow-portability.ts"
import { agentErrorDetails, agentErrorMessage, toAgentPublicError } from "./agent-error.ts"
import { agentChannelDeliveryOwnershipVerifier, agentChannelDeliveryTracker, agentChannelDeliveryWorkflowContextKey, isAgentChannelDeliveryWorkflowBinding } from "./internal/channel-delivery.ts"
import {
  createBackedAgentInvocationController,
  startLiveAgentInvocation,
} from "./agent-invocation.ts"
import { agentInvocationInputSupport, sendAgentInvocationInput } from "./internal/agent-invocation-control.ts"
import { withAgentInvocationResponseOwner } from "./internal/agent-invocation-response-owner.ts"
import {
  createReactionDeliveryEffectIntent,
  createReplyDeliveryEffectIntent,
  createStatusDeliveryEffectIntent,
} from "./delivery-effects.ts"
import { createTraceEventLog, deriveTraceRuns, getViteHubErrorShape, isTraceContentAttributeKey, normalizeRuntimeDiagnosticError, resolveRuntimeContext, traceEventsToOpenTelemetryLogRecords, traceEventsToOpenTelemetrySpans } from "@vite-hub/runtime"
import { agentTelemetryTask } from "./internal/telemetry-task.ts"
import { getAgentTelemetryConfiguration, safeAgentTelemetryMetadata, setAgentTelemetryConfiguration } from "./internal/agent-telemetry.ts"
import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { getAgentInvocationRecoveryWorkflowName } from "@vite-hub/internal/agent-workflow"
import { agentResultKind, agentStreamErrorSymbol, finalTextFromAgentOutput, hasTraceableStreamResult, isAsyncIterable, resolveAgentUsageRecord, streamAgentOutputToEvents, toAgentRunResult, toAgentStreamEvent, usageRecordFromStreamChunk } from "./agent-output.ts"
import { defineChatCapability, durableChatErrorFallbackTimeout, getAgentChatContext, getChatCapabilityOptions, isDurableChatErrorFallbackEffect, resolveDurableChatErrorFallbackIntents } from "./chat-trigger.ts"
import { agentWorkflowExecutionContextKey } from "./internal/workflow-execution.ts"
import { parsedAgentMessageMetaState, parseAgentMessageMeta, withParsedAgentMessageMeta } from "./internal/message-meta.ts"
import type { ParsedAgentMessageMetaState } from "./internal/message-meta.ts"
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
import { agentInvocationCallbackContextValues, agentInvocationConfigurationUpdatedContextKey, agentInvocationRunId, createAgentInvocationContextStore } from "./invocation-context.ts"
import { bindAgentRunEvents, type AgentRunEventPublisher } from "./run-events.ts"
import { bindAgentInvocations, type AgentInvocationJournal } from "./invocations.ts"
import { isAttachmentPart, materializeMessageAttachmentData, type AgentMessagePhase, type Message } from "./messages.ts"
import {
  createFallbackAgentInvoker,
  hasResolvedAgentInvokerInput,
  normalizeAgentInvokerOptions,
  portableResolvedAgentInvokerInput,
  resolveAgentInvoker,
} from "./invoker.ts"
import {
  parseScheduledAgentTurnInput,
  scheduledAgentChannelIdsContextKey,
  scheduledAgentNameContextKey,
  scheduledAgentTurnContextKey,
} from "./internal/scheduled-turn.ts"
import { finalChannelOutputContextKey, finalChannelOutputSelectedSymbol, hasOnlyPortableAgentWorkflowCapabilities, requireAgentWorkflowContextKey, responseTitleFallbackContextKey } from "./internal/final-channel-output.ts"
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
  createAgentStreamEventTracer,
  agentInvocationJournalContentTraceLogSymbol,
  agentInvocationJournalTraceLogSymbol,
  agentInvocationTraceIdContextKey,
  traceAgentInvocationError,
  traceAgentChannelDeliveryEffect,
  traceAgentInvocationFinish,
  traceAgentInvocationStart,
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
  workspaceAgentUsesRegisteredDefinition,
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
  BuiltInAgentDriver,
  BuiltInAgentDriverName,
  ClaudeCodeDriverOptions,
  CodexDriverOptions,
  AgentDriverContribution,
  AgentDriverKind,
  CustomAgentDriver,
  AgentErrorHookEvent,
  AgentFinishEvent,
  AgentFinishHookEvent,
  AgentFinishExtensions,
  AgentInput,
  AgentInspectionValue,
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
  IsTypedAgentStaticCapabilitiesList,
  AgentTelemetryContentOptions,
  AgentTelemetryConfiguration,
  AgentToolSet,
  AgentToolStepItem,
  AgentUsage,
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
} from "@vite-hub/workspace"
import type { WorkflowHandle } from "@vite-hub/workflow"
import type { OpenTelemetryLogRecordView, OpenTelemetrySpanView, TraceEventLogEntry } from "@vite-hub/runtime"

export type {
  AgentInvocationAnnotationValue,
  AgentInvocationListOptions,
  AgentInvocationListResult,
  AgentInvocationRecord,
  AgentInvocationRecordStatus,
  AgentInvocationSummary,
  AgentInvocations,
  AgentInvocationStore,
} from "./invocations.ts"

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
  AgentPublicError,
  AgentPublicErrorCode,
  AgentPublicErrorDetails,
} from "./agent-error.ts"

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
  AgentChannelDelivery,
  AgentChannelDeliveryEvent,
  AgentChannelDeliveryEventInput,
  AgentChannelDeliveryEventType,
  AgentChannelDeliveryInspection,
  AgentChannelDeliveryStatus,
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
  AgentInspectionCapabilityMetadata,
  AgentInspectionConfigMetadata,
  AgentInspectionConfigValue,
  AgentInspectionDriverMetadata,
  AgentInspectionFileTreeItem,
  AgentInspectionProviderMetadata,
  AgentInspectionMetadata,
  AgentInspectionModelExecutionMetadata,
  AgentInspectionModelMetadata,
  AgentInspectionToolDefinition,
  AgentInspectionValue,
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
  AgentProviderDriverOptions,
  AgentProviderPermissions,
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
  AgentTelemetry,
  AgentTelemetryContentOptions,
  AgentTelemetryExportContext,
  AgentTelemetryLogsExportContext,
  AgentTelemetryRegistration,
  AgentTelemetryTracesExportContext,
  AgentTriggerContext,
  AgentTriggerDefinition,
  AgentTriggerInvokeResult,
  AgentTriggerRunInvokeResult,
  AgentToolResolver,
  AgentToolSet,
  AgentToolStep,
  AgentWaitUntil,
  ClaudeCodeDriverOptions,
  CodexDriverOptions,
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
  AgentActivity,
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
  [baseAgentCapabilitiesResolver]?: AgentCapabilitiesResolver<TRuntimeConfig, WorkspaceName, CALL_OPTIONS>
  [baseAgentDriverKind]?: AgentDriverKind
  [baseAgentOutput]?: AgentOutputDefinition<TOutput>
  [baseAgentResolve]?: BaseAgentResolver<TRuntimeConfig, CALL_OPTIONS>
  [baseAgentModel]?: AgentModelResolver<TRuntimeConfig>
  [colocatedAgentSkillsSymbol]?: ColocatedAgentSkills
}
interface AgentWorkflowInvocationPayload<CALL_OPTIONS = unknown> {
  capabilities?: Record<string, false>
  input?: AgentRunInput<CALL_OPTIONS>
  invocationRecovery?: {
    agentName?: string
    runId: string
    sourceRunId: string
    workflowName: string
  }
  requestUrl?: string
  parsedMessageMeta?: ParsedAgentMessageMetaState
  resolvedInvoker?: boolean
  run?: Partial<AgentRunMetadata>
  trace?: AgentRuntimeContext["trace"]
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
type AgentWorkflowOutput<TOutput> = TOutput extends Response ? AgentRunResult : TOutput | AgentRunResult
interface StartedAgentWorkflow<CALL_OPTIONS = unknown, TOutput = unknown> {
  handle: WorkflowHandle<AgentWorkflowInvocationPayload<CALL_OPTIONS>, TOutput>
  invocationJournal?: AgentInvocationJournal
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
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  if (!context.agentIdentity || (context as AgentRuntimeContext & { [agentIdentityOwner]?: object })[agentIdentityOwner]) return context
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  return { ...context, [agentIdentityOwner]: agent as object } as AgentRuntimeContext<TRuntimeConfig>
}

function hasAgentDefinition(value: unknown): value is AgentDefinition {
  return hasRuntimeType(value, "object")
    && value !== null
    && "resolve" in value
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    && hasRuntimeType((value as { resolve?: unknown }).resolve, "function")
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

async function deferAgentWorkflowRecovery<TPayload, TResult>(
  handle: WorkflowHandle<TPayload, TResult>,
  payload: TPayload,
  options: { id?: string },
): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await handle.defer(payload, options)
      return
    }
    catch (error) {
      failure = error
    }
  }
  throw failure
}

async function getAgentWorkflowHandle<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOutput,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput, CALL_OPTIONS>,
  name: string,
  reuseRegistry: boolean,
  recovery = false,
): Promise<WorkflowHandle<AgentWorkflowInvocationPayload<CALL_OPTIONS>, AgentWorkflowOutput<TOutput>>> {
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const handles = agentWorkflowHandles.get(agent as object) || new Map<string, WorkflowHandle<AgentWorkflowInvocationPayload, unknown>>()
  const cacheKey = `${reuseRegistry ? "registry" : "inline"}:${name}`
  const existing = handles.get(cacheKey)
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  if (existing) return existing as WorkflowHandle<AgentWorkflowInvocationPayload<CALL_OPTIONS>, AgentWorkflowOutput<TOutput>>

  const { createWorkflow } = await loadAgentWorkflowModule()
  const { getInlineWorkflowDefinitions, getWorkflowRuntimeRegistry, loadWorkflowDefinition, registerInlineWorkflowDefinition } = await loadAgentWorkflowRuntimeStateModule()
  const registered = (reuseRegistry && getWorkflowRuntimeRegistry()?.[name]) || (agentWorkflowNames.has(name) && getInlineWorkflowDefinitions().has(name))
  if (registered) {
    const definition = await loadWorkflowDefinition(name)
    if (Boolean(definition?.internalAgentInvocationRecovery) !== recovery) {
      throw new Error(`Workflow name ${JSON.stringify(name)} conflicts with an Agent invocation recovery Workflow.`)
    }
  }
  if (!registered && recovery) {
    registerInlineWorkflowDefinition(name, {
      internalAgentInvocationRecovery: true,
      handler: async (workflowContext) => {
        const { runAgentWorkflowDefinition } = await import("./runtime/workflow.ts")
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        return await runAgentWorkflowDefinition(agent as never, workflowContext as never, runAgentInline as never) as AgentWorkflowOutput<TOutput>
      },
      options: { rootStep: false },
    })
  }
  const handle = registered || recovery
    // SAFETY: The Agent Workflow registry and recovery registration above own this exact payload and output contract.
    ? createWorkflow<AgentWorkflowInvocationPayload<CALL_OPTIONS>>(name) as WorkflowHandle<AgentWorkflowInvocationPayload<CALL_OPTIONS>, AgentWorkflowOutput<TOutput>>
    : createWorkflow<AgentWorkflowInvocationPayload<CALL_OPTIONS>, AgentWorkflowOutput<TOutput>>(name, async (workflowContext) => {
        const { runAgentWorkflowDefinition } = await import("./runtime/workflow.ts")
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        return await runAgentWorkflowDefinition(agent as never, workflowContext as never, runAgentInline as never) as AgentWorkflowOutput<TOutput>
      }, { rootStep: false })
  agentWorkflowNames.add(name)
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  handles.set(cacheKey, handle as WorkflowHandle<AgentWorkflowInvocationPayload, unknown>)
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  agentWorkflowHandles.set(agent as object, handles)
  return handle
}

async function portableAgentWorkflowRunId(runId: string): Promise<string> {
  const generatedPrefix = "vitehub-invalid-"
  if (/^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$/.test(runId) && !runId.startsWith(generatedPrefix)) return runId
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(runId))
  return `${generatedPrefix}${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`
}

function isAmbiguousWorkflowStartFailure(error: unknown): boolean {
  if (!error || !hasRuntimeType(error, "object") || !("code" in error) || !("details" in error)) return false
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const details = (error as { details?: unknown }).details
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  return (error as { code?: unknown }).code === "WORKFLOW_PROVIDER_OPERATION_FAILED"
    && Boolean(details && hasRuntimeType(details, "object")
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      && (details as { acknowledgement?: unknown }).acknowledgement === "unknown"
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      && (((details as { provider?: unknown }).provider === "cloudflare"
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        && (details as { operation?: unknown }).operation === "create")
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      || ((details as { provider?: unknown }).provider === "openworkflow"
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        && (details as { operation?: unknown }).operation === "run")))
}

async function portableWorkflowMessages(messages: Message[]): Promise<Message[]> {
  const materialized = await materializeMessageAttachmentData(messages)
  return await Promise.all(materialized.map(async message => ({
    ...message,
    parts: await Promise.all(message.parts.map(async (part) => {
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      if (!isAttachmentPart(part)) return cloneWorkflowJsonValue(part) as typeof part
      let data = part.data
      if (data instanceof Blob) data = await data.arrayBuffer()
      if (data instanceof ArrayBuffer) data = new Uint8Array(data)
      const portable = data instanceof Uint8Array
        ? { ...part, data: `data:${part.mediaType};base64,${workflowBytesToBase64(data)}` }
        : part
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      return cloneWorkflowJsonValue(portable) as typeof part
    })),
  })))
}

export async function portableAgentWorkflowInput<CALL_OPTIONS>(input: AgentRunInput<CALL_OPTIONS>): Promise<AgentRunInput<CALL_OPTIONS>> {
  const workflowInput = { ...portableResolvedAgentInvokerInput(input) }
  delete workflowInput.abortSignal
  if (input.context?.[requireAgentWorkflowContextKey] === true) delete workflowInput.timeout
  if (workflowInput.messages) workflowInput.messages = await portableWorkflowMessages(workflowInput.messages)
  if (workflowInput.message && !hasRuntimeType(workflowInput.message, "string")) [workflowInput.message] = await portableWorkflowMessages([workflowInput.message])
  if (Array.isArray(workflowInput.prompt)) workflowInput.prompt = await portableWorkflowMessages(workflowInput.prompt)
  // Validate and detach the complete payload before it crosses a durable State
  // or Workflow boundary. Materializing messages alone would still allow
  // context and call options to be silently coerced by JSON persistence.
  // SAFETY: cloneWorkflowJsonValue preserves the normalized AgentRunInput shape while rejecting non-JSON values.
  return cloneWorkflowJsonValue(workflowInput) as AgentRunInput<CALL_OPTIONS>
}

async function runAgentAsWorkflow<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOutput,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput, CALL_OPTIONS>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: { fresh?: boolean } = {},
): Promise<StartedAgentWorkflow<CALL_OPTIONS, AgentWorkflowOutput<TOutput>> | undefined> {
  const binding = resolveAgentWorkflowRuntimeBinding<TRuntimeConfig>(agent)
  const cloudflareEnv = context.cloudflare?.env || getCloudflareEnv(context)
  if (!binding || ("discoveryDefault" in binding && !context.agentIdentity)) return undefined
  const workflowRuntimeState = await loadAgentWorkflowRuntimeStateModule()
  let workflowConfig = workflowRuntimeState.getWorkflowRuntimeConfig()
  let activateCloudflareWorkflow = false
  if ("discoveryDefault" in binding && workflowConfig === undefined) {
    if (input.context?.[requireAgentWorkflowContextKey] !== true || !cloudflareEnv) return undefined
    workflowConfig = { provider: "cloudflare" }
    activateCloudflareWorkflow = true
  }
  if ("discoveryDefault" in binding && workflowConfig === false) return undefined
  if (input.context?.[requireAgentWorkflowContextKey] === true && workflowConfig && workflowConfig.provider === "cloudflare") {
    if (!cloudflareEnv) return undefined
    const workflowName = resolveAgentWorkflowName(agent, binding, context)
    const workflowBindingName = workflowConfig.binding || (await loadAgentWorkflowModule()).getCloudflareWorkflowBindingName(workflowName)
    if (!cloudflareEnv[workflowBindingName]) return undefined
  }
  if (activateCloudflareWorkflow) {
    workflowRuntimeState.setWorkflowRuntimeConfig(workflowConfig)
  }
  if ("discoveryDefault" in binding && context.agentIdentity) {
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const owner = (context as AgentRuntimeContext & { [agentIdentityOwner]?: object })[agentIdentityOwner]
    if (owner && owner !== agent) return undefined
  }
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const disabledCapabilities = Object.fromEntries(
    Object.entries(context.capabilities || {}).filter(([, capability]) => capability === false),
  ) as Record<string, false>
  const hasNonportableCapabilities = !await hasOnlyPortableAgentWorkflowCapabilities(context.capabilities)
  if (input.context?.[requireAgentWorkflowContextKey] === true && hasNonportableCapabilities) return undefined
  if ("discoveryDefault" in binding && hasNonportableCapabilities) return undefined

  const workflowName = resolveAgentWorkflowName(agent, binding, context)
  const handle = await getAgentWorkflowHandle<TRuntimeConfig, CALL_OPTIONS, TOutput>(agent, workflowName, Boolean(context.agentIdentity))
  const resolvedContext = createResolvedRuntimeContext(context)
  // ponytail: AbortSignal is live process state and cannot cross a durable Workflow payload.
  const parsedInput = hasAgentDefinition(agent)
    ? await withParsedAgentMessageMeta(agent, input, context.run)
    : input
  const workflowInput = await portableAgentWorkflowInput(parsedInput)
  const channelDeliveryBinding = input.context?.[agentChannelDeliveryWorkflowContextKey]
  const durableChannelDelivery = isAgentChannelDeliveryWorkflowBinding(channelDeliveryBinding)
  const inheritedRun = options.fresh && context.run && !durableChannelDelivery
    ? Object.fromEntries(Object.entries(context.run).filter(([key]) => key !== "runId"))
    : context.run
  // SAFETY: withParsedAgentMessageMeta preserves this invocation's call-options type.
  const parsedMessageMeta = parsedAgentMessageMetaState(agent, parsedInput as AgentRunInput<CALL_OPTIONS>, context.run)
  const payload: AgentWorkflowInvocationPayload<CALL_OPTIONS> = {
    ...(context.agentIdentity ? { agentIdentity: context.agentIdentity } : {}),
    ...(Object.keys(disabledCapabilities).length ? { capabilities: disabledCapabilities } : {}),
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    input: cloneWorkflowJsonValue(workflowInput) as AgentRunInput<CALL_OPTIONS>,
    // Headers and bodies may contain webhook credentials and remain process-local by design.
    ...(context.request ? { requestUrl: context.request.url } : {}),
    ...(parsedMessageMeta !== undefined ? { parsedMessageMeta } : {}),
    ...(hasResolvedAgentInvokerInput(input) ? { resolvedInvoker: true } : {}),
    runtime: context.runtime,
    runtimeConfig: resolvedContext.runtimeConfig,
    ...(inheritedRun ? { run: inheritedRun } : {}),
    ...(context.trace ? { trace: context.trace } : {}),
  }
  const workflowEvent = {
    ...(cloudflareEnv ? { env: cloudflareEnv } : {}),
    waitUntil: context.waitUntil,
    context: {
      ...(context.cloudflare ? { cloudflare: context.cloudflare } : {}),
      waitUntil: context.waitUntil,
    },
  }
  // Durable Channel recovery may be a fresh provider start while still owning
  // one persisted logical run. Initial starts remain stable by claim, while a
  // fresh recovery gets a new provider ID after a definitive rejection.
  const workflowProviderRunId = context.run?.runId && durableChannelDelivery && channelDeliveryBinding.steer
    ? `${context.run.runId}:${channelDeliveryBinding.steer.claimId}${options.fresh ? `:${crypto.randomUUID()}` : ""}`
    : context.run?.runId
  const workflowRunId = context.run?.runId && (!options.fresh || durableChannelDelivery)
    ? workflowConfig && workflowConfig.provider === "cloudflare"
      ? await portableAgentWorkflowRunId(workflowProviderRunId ?? context.run.runId)
      : workflowProviderRunId ?? context.run.runId
    : undefined
  const deferRecovery = async (runId: string, sourceRunId: string): Promise<boolean> => {
    if (!hasAgentDefinition(agent)) return false
    try {
      const recoveryId = await portableAgentWorkflowRunId(`${runId}-invocation-recovery`)
      const recoveryHandle = await getAgentWorkflowHandle<TRuntimeConfig, CALL_OPTIONS, TOutput>(
        agent,
        getAgentInvocationRecoveryWorkflowName(handle.name),
        Boolean(context.agentIdentity),
        true,
      )
      await workflowRuntimeState.runWithWorkflowRuntimeEvent(workflowEvent, () => deferAgentWorkflowRecovery(recoveryHandle, {
        invocationRecovery: {
          ...(agent.name || context.agentIdentity?.name ? { agentName: agent.name || context.agentIdentity?.name } : {}),
          runId,
          sourceRunId,
          workflowName,
        },
        ...(context.trace ? { trace: context.trace } : {}),
      }, { id: recoveryId }))
      return true
    }
    catch {
      return false
    }
  }
  let run: AgentWorkflowRun<AgentWorkflowOutput<TOutput>>
  try {
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    run = await workflowRuntimeState.runWithWorkflowRuntimeEvent(workflowEvent, () => handle.run(
      payload,
      workflowRunId ? { id: workflowRunId } : {},
    )) as AgentWorkflowRun<AgentWorkflowOutput<TOutput>>
  }
  catch (error) {
    const ambiguous = isAmbiguousWorkflowStartFailure(error)
    const failedRunId = !options.fresh && context.run?.runId
      ? context.run.runId
      : workflowRunId || (ambiguous ? undefined : createTraceId())
    if (hasAgentDefinition(agent) && failedRunId) {
      const recoveryAccepted = !ambiguous
        || !(workflowConfig && workflowConfig.provider === "cloudflare" && workflowRunId)
        || (Boolean(agent.invocations) && await deferRecovery(workflowRunId, failedRunId))
      if (recoveryAccepted) {
        const invocationJournal = await bindAgentInvocations(agent.invocations, {
          ...context,
          run: { ...context.run, runId: failedRunId },
        }, { agentName: agent.name || context.agentIdentity?.name, deferClaim: ambiguous, terminalTakeover: true })
        if (!ambiguous) await invocationJournal?.finish("failed", error)
      }
    }
    throw error
  }
  // Vercel's native Workflow owns durable suspension, but arbitrary Agent Definitions cannot
  // be compiled into that deterministic bundle. Its journal begins in the Agent worker instead.
  let invocationJournal: AgentInvocationJournal<TRuntimeConfig> | undefined
  if (hasAgentDefinition(agent) && agent.invocations && run.provider !== "vercel") {
    const snapshot = agentInvocationSnapshotFromWorkflow(run)
    if (!snapshot || (snapshot.status !== "cancelled" && snapshot.status !== "completed" && snapshot.status !== "failed")) {
      const sourceRunId = options.fresh && !durableChannelDelivery ? run.id : context.run?.runId ?? run.id
      if (!await deferRecovery(run.id, sourceRunId)) return { handle, run }
    }
    invocationJournal = await bindAgentInvocations(agent.invocations, {
      ...context,
      run: { ...context.run, runId: options.fresh && !durableChannelDelivery ? run.id : context.run?.runId ?? run.id },
    }, { agentName: agent.name || context.agentIdentity?.name, deferClaim: true, terminalTakeover: true })
    if (snapshot?.status === "cancelled" || snapshot?.status === "completed" || snapshot?.status === "failed") {
      await invocationJournal?.finish(snapshot.status, snapshot.error)
    }
  }
  return { handle, ...(invocationJournal ? { invocationJournal } : {}), run }
}

function resolveRegistryModule<TContext extends AgentRuntimeContext>(
  module: AgentRegistryModule<TContext>,
): AgentInput<TContext> | undefined {
  return hasRuntimeType(module, "object") && module !== null && "default" in module
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    ? module.default as AgentInput<TContext> | undefined
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    : module as AgentInput<TContext>
}

function createResolvedRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentRuntimeContext<TRuntimeConfig>,
): ResolvedAgentRuntimeContext<TRuntimeConfig> {
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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

function channelDeliveryEffectHandlers<TRuntimeConfig extends AgentRuntimeConfig>(
  channel: AgentChannelDefinition<TRuntimeConfig>,
  intent: AgentChannelDeliveryEffectIntent,
): readonly AgentChannelDeliveryEffectHandler<TRuntimeConfig>[] {
  const handlers = channel.effects?.[intent.kind]
  if (!handlers) return []
  return hasRuntimeType(handlers, "function") ? [handlers] : [...handlers]
}

function activeAgentChannel<TRuntimeConfig extends AgentRuntimeConfig>(
  channels: AgentChannels<TRuntimeConfig> | undefined,
  context: AgentInvocationContextStore,
  run?: AgentRunMetadata,
) {
  const trigger = context.get("agent.trigger")
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
  const delivery = agentChannelDeliveryTracker(context.runtimeContext)
  const verifyOwnership = agentChannelDeliveryOwnershipVerifier(context.runtimeContext)

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
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
      let handlerCompleted = false
      try {
        await verifyOwnership?.()
        try {
          await delivery?.event({ type: "outbound.started", runId: context.run?.runId })
        }
        catch {}
        await runObservedAgentHook(context.hooks, {
          ids: { channelId: active.channelId, runId: context.run?.runId },
          metadata,
          name: "channel:delivery-effect",
          owner: "channel",
          phase: "effect",
        }, async () => {
          await verifyOwnership?.()
          await handler({
            ...context.runtimeContext,
            channel: active.channel,
            context: context.context,
            effect: intent,
            // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
        handlerCompleted = true
      }
      catch (error) {
        delivered = false
        try {
          console.error(JSON.stringify({
            scope: "vitehub.channel.delivery",
            event: "outbound.failed",
            channelId: active.channelId.slice(0, 256),
            effect: intent.kind.slice(0, 256),
            intent: intent.intent?.slice(0, 256),
            runId: context.run?.runId.slice(0, 256),
            error: agentErrorMessage(error).slice(0, 2_000),
          }))
        }
        catch {}
        try {
          await delivery?.event({ error: agentErrorMessage(error), type: "outbound.failed", runId: context.run?.runId })
        }
        catch {}
        await traceAgentChannelDeliveryEffect(toTraceContext(context), intent, {
          ...metadata,
          "error.message": agentErrorMessage(error),
        })
      }
      if (handlerCompleted) {
        try {
          await delivery?.event({ type: "outbound.completed", runId: context.run?.runId })
        }
        catch {}
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
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const value = input as unknown
    if (hasRuntimeType(value, "object") && value && "kind" in value && hasRuntimeType(value.kind, "string")) continue
    const channel = hasRuntimeType(input, "function")
      ? input()
      : id === "discord"
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        ? builtInDiscord<TRuntimeConfig>(input as never)
        : id === "github"
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          ? builtInGitHub<TRuntimeConfig>(input as never)
          : id === "http"
            // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
            ? builtInHttp<TRuntimeConfig>(input as never)
            : id === "slack"
              // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
              ? builtInSlack<TRuntimeConfig>(input as never)
              : id === "teams"
                // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
                ? builtInTeams<TRuntimeConfig>(input as never)
                : id === "telegram"
                  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
                  ? builtInTelegram<TRuntimeConfig>(input as never)
                  : id === "webChat"
                    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
                    ? builtInWebChat<TRuntimeConfig>(input as never)
                    : undefined
    if (!channel || !hasRuntimeType(channel, "object") || !hasRuntimeType(channel.kind, "string")) {
      throw new TypeError(hasRuntimeType(input, "function")
        ? `[vitehub] Channel factory "${id}" must return an Agent Channel definition.`
        : `[vitehub] Channel "${id}" must be an Agent Channel definition or use a built-in Channel name.`)
    }
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    channels ||= { ...inputs } as AgentChannels<TRuntimeConfig>
    channels[id] = channel
  }
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
  const { capabilities, cli, description, hooks, invocations, messages, name, runtime = defaultAgentWorkflowRuntime(), runEvents, uiMessageStream, version, workspace } = options
  const channels = normalizeAgentChannels(options.channels)
  const run = driver.kind === "run" ? driver.run : undefined
  const capabilitiesResolver = hasRuntimeType(capabilities, "function")
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    ? capabilities as AgentCapabilitiesResolver<TRuntimeConfig, WorkspaceName, CALL_OPTIONS>
    : undefined
  const baseCapabilities = normalizeCapabilities(Array.isArray(capabilities) ? capabilities : undefined)
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const invoker = normalizeAgentInvokerOptions(options.invoker) as AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS> | undefined
  const channelChat = resolveAgentChannelChatOptions<TRuntimeConfig>(channels, messages)
  const chatCapability = getChatCapabilityOptions(baseCapabilities)
  if (chatCapability && channelChat) {
    throw new TypeError("[vitehub] defineAgent({ channels }) cannot be combined with the chat() capability. Move chat options to defineAgent({ messages, channels }).")
  }
  const chat = chatCapability || channelChat
  const normalizedCapabilities = channelChat
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    ? [...baseCapabilities, defineChatCapability(channelChat) as AgentCapabilityDefinition<TRuntimeConfig>]
    : baseCapabilities
  if (!workspace) validateAgentCapabilityComposition(normalizedCapabilities, {
    driverKind: driver.kind,
    hasWorkspace: false,
  })
  let providerAdapter: Promise<AgentAdapter<CALL_OPTIONS>> | undefined
  const resolveBaseAgent: BaseAgentResolver<TRuntimeConfig, CALL_OPTIONS> = async (context) => {
    const resolvedAdapter = driver.kind === "model"
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      ? (await import("./ai-sdk.ts")).createAiSdkAdapter({
          execution: driver.execution,
          instructions: driver.instructions,
          model: driver.model,
        } as never) as AgentAdapter<CALL_OPTIONS>
      : driver.kind === "provider"
        ? await (providerAdapter ??= import("./provider-agent.ts").then(module => module.createProviderAgentAdapter<CALL_OPTIONS, TRuntimeConfig>({
            env: driver.env,
            execution: driver.execution,
            instructions: driver.instructions,
            model: driver.model,
            permissions: driver.permissions,
            provider: driver.provider,
          })))
        : undefined
    if (!resolvedAdapter) {
      throw new Error("[vitehub] Agent Driver is required unless the agent uses driver.run.")
    }
    const resolvedContext = createResolvedRuntimeContext(context)
    return isCallableMember(resolvedAdapter)
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      ? await (resolvedAdapter as AgentAdapterFactory<TRuntimeConfig, CALL_OPTIONS>)(resolvedContext)
      : resolvedAdapter
  }

  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const definition = {
    ...(driver.kind === "model" ? { [baseAgentModel]: driver.model } : {}),
    [baseAgentDriverKind]: driver.kind,
    ...(driver.output ? { [baseAgentOutput]: driver.output } : {}),
    ...(capabilitiesResolver ? { [baseAgentCapabilitiesResolver]: capabilitiesResolver } : {}),
    [baseAgentResolve]: resolveBaseAgent,
    channels,
    chat,
    cli,
    description,
    hooks,
    invoker,
    invocations,
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
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      const adapter = await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(definition as never, context)
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      const invocationContext = await createAgentInvocationContext(definition as never, context as never, context.input)
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      const result = await adapter.generate(toAgentAdapterRunContext(invocationContext) as never)
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      const textOutput = hasRuntimeType(result, "object") && result && "text" in result && hasRuntimeType((result as { text?: unknown }).text, "string")
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        ? (result as { text: string }).text
        : undefined
      if (textOutput !== undefined && result && hasRuntimeType(result, "object")) {
        const eagerStreams: AsyncIterable<unknown>[] = []
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        return hasRuntimeType((output as ReadableStream<unknown>).getReader, "function")
          ? toReadableAsyncIterableStream(streamed)
          : streamed
      }
      if (output && hasRuntimeType(output, "object")) {
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
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          const preserved = hasRuntimeType((stream as ReadableStream<unknown>).getReader, "function")
            ? toReadableAsyncIterableStream(wrapped)
            : wrapped
          preservedStreams.set(stream, preserved)
          return preserved
        }
        const descriptors: PropertyDescriptorMap = {}
        let hasStreamSurface = false
        let unresolvedLazyStreamSurfaces = 0
        try {
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
            // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
> = (TCapabilities & ValidateStaticAgentCapabilities<TCapabilities>) | AgentCapabilitiesResolver<
  TRuntimeConfig,
  Name,
  CALL_OPTIONS,
  TCapabilities extends readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[]
    ? TCapabilities
    : readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[]
>

type ValidateStaticAgentCapability<TCapability> =
  TCapability extends AgentCapabilityDefinition
    ? TCapability
    : Extract<keyof TCapability, symbol> extends never
      ? never
      : TCapability[Extract<keyof TCapability, symbol>] extends true
        ? TCapability
        : never

type ValidateStaticAgentCapabilities<TCapabilities> =
  TCapabilities extends readonly unknown[]
    ? number extends TCapabilities["length"]
      ? IsTypedAgentStaticCapabilitiesList<TCapabilities> extends true
        ? TCapabilities
        : readonly ValidateStaticAgentCapability<TCapabilities[number]>[]
      : { readonly [TIndex in keyof TCapabilities]: ValidateStaticAgentCapability<TCapabilities[TIndex]> }
    : TCapabilities

type ProviderDriver<
  Name extends BuiltInAgentDriverName,
  TOutput,
> = Extract<BuiltInAgentDriver<unknown, TOutput>, { kind: Name }>

function providerDriver<Name extends BuiltInAgentDriverName, TOutput>(
  name: Name,
  options: CodexDriverOptions<TOutput> | ClaudeCodeDriverOptions<TOutput>,
): ProviderDriver<Name, TOutput> {
  // SAFETY: The discriminant is added here and the option union is selected by the public wrapper.
  return { ...options, kind: name } as ProviderDriver<Name, TOutput>
}

export function codexDriver<TOutput = unknown>(
  options: CodexDriverOptions<TOutput> = {},
): ProviderDriver<"codex", TOutput> {
  return providerDriver("codex", options)
}

export function claudeCodeDriver<TOutput = unknown>(
  options: ClaudeCodeDriverOptions<TOutput> = {},
): ProviderDriver<"claude-code", TOutput> {
  return providerDriver("claude-code", options)
}

type AgentInvokerProfileOf<TOptions> = "invoker" extends keyof TOptions
  ? NonNullable<TOptions["invoker"]> extends AgentInvokerOptions<any, any, infer TProfile, any>
    ? TProfile
    : AgentInvokerProfile
  : AgentInvokerProfile

export interface DefineAgent {
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    Name extends WorkspaceName = WorkspaceName,
    CALL_OPTIONS = unknown,
    const TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
    const TCapabilities extends AgentStaticCapabilitiesList<TRuntimeConfig, Name> | undefined = readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[] | undefined,
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
  ): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS, AgentInvokerProfileOf<TOptions>, AgentCapabilitiesInvocationContextValues<TCapabilities>, AgentCapabilitiesOption<TRuntimeConfig, Name, CALL_OPTIONS, TCapabilities>, TOutput>
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    Name extends WorkspaceName = WorkspaceName,
    CALL_OPTIONS = unknown,
    const TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
    const TCapabilities extends AgentStaticCapabilitiesList<TRuntimeConfig, Name> | undefined = readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[] | undefined,
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
  ): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS, AgentInvokerProfileOf<TOptions>, AgentCapabilitiesInvocationContextValues<TCapabilities>, AgentCapabilitiesOption<TRuntimeConfig, Name, CALL_OPTIONS, TCapabilities>, TOutput>
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    CALL_OPTIONS = unknown,
    const TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
    const TCapabilities extends AgentStaticCapabilitiesList<TRuntimeConfig> | undefined = readonly AgentCapabilityDefinition<TRuntimeConfig>[] | undefined,
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
    const TCapabilities extends AgentStaticCapabilitiesList<TRuntimeConfig> | undefined = readonly AgentCapabilityDefinition<TRuntimeConfig>[] | undefined,
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
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const workspaceDefinition = workspaceDefinitionFromOptions(asUnknownBoundary(options) as WorkspaceAgentOptions<AgentRuntimeConfig, Name>)
  if (Array.isArray(options.capabilities)) {
    validateAgentCapabilityComposition(options.capabilities, {
      driverKind: normalizeAgentDriver(options).kind,
      hasWorkspace: true,
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      workspaceMode: workspaceModeFromOptions(asUnknownBoundary(options) as WorkspaceAgentOptions<AgentRuntimeConfig, Name>),
    })
  }
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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

// SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
export const defineAgent: DefineAgent = ((options: unknown) => {
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const agentOptions = options as AgentSettings
  const channels = normalizeAgentChannels(agentOptions.channels)
  const name = agentOptions.name?.trim()
  if (name && name.length > 512) {
    throw new TypeError("[vitehub] Agent names cannot exceed 512 characters.")
  }
  let normalizedOptions = channels === agentOptions.channels
    ? agentOptions
    : { ...agentOptions, channels }
  if (name !== normalizedOptions.name) normalizedOptions = { ...normalizedOptions, name }
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
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    : defineBaseAgent(normalizedOptions as never)
}) as DefineAgent

export function agentWithColocatedInstructions<Agent>(agent: Agent, instructions?: string): Agent {
  if (!instructions || !hasAgentDefinition(agent)) return agent
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const settings = (agent as AgentDefinition & { __vitehubAgentSettings?: AgentSettings }).__vitehubAgentSettings
  if (!settings || settings.workspace) return agent
  const driver = normalizeAgentDriver(settings)
  if (driver.kind === "run" || driver.instructions !== undefined) return agent
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const definition = defineAgent({
    ...settings,
    driver: driver.kind === "model"
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      ? { ...(settings.driver as AgentModelDriver), instructions }
      : {
          capacity: driver.capacity,
          env: driver.env,
          execution: driver.execution,
          instructions,
          kind: driver.provider,
          model: driver.model,
          output: driver.output,
          permissions: driver.permissions,
        },
  } as never) as Agent
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const decorations = Object.getOwnPropertyDescriptors(agent as object)
  delete decorations.__vitehubAgentSettings
  Reflect.deleteProperty(decorations, baseAgentResolve)
  Reflect.deleteProperty(decorations, baseAgentModel)
  Reflect.deleteProperty(decorations, baseAgentDriverKind)
  Reflect.deleteProperty(decorations, baseAgentDefinitionResolve)
  if (
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    (agent as AgentDefinition & { [baseAgentDefinitionResolve]?: unknown }).resolve
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    === (agent as AgentDefinition & { [baseAgentDefinitionResolve]?: unknown })[baseAgentDefinitionResolve]
  ) {
    delete decorations.resolve
  }
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  Object.setPrototypeOf(definition as object, Object.getPrototypeOf(agent as object))
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  Object.defineProperties(definition as object, decorations)
  return definition
}

export async function resolveAgent<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  context: TContext,
): Promise<AgentAdapter> {
  if (hasAgentDefinition(agent)) {
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    return await agent.resolve(context as never)
  }

  throw new TypeError("[vitehub] Invalid agent definition.")
}

async function resolveAgentForRun<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, unknown, CALL_OPTIONS>,
  context: AgentRuntimeContext<TRuntimeConfig>,
): Promise<AgentAdapter<CALL_OPTIONS>> {
  if (hasAgentDefinition(agent)) {
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const resolver = (agent as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS>)[baseAgentResolve]
    if (resolver) return await resolver(context)
  }
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  return await resolveAgent(agent, context) as AgentAdapter<CALL_OPTIONS>
}

export async function getAgentFromRegistry<TContext extends AgentRuntimeContext>(
  name: string,
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, unknown, CALL_OPTIONS>,
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
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, unknown, CALL_OPTIONS>,
): agent is AgentDefinition<TRuntimeConfig, any> & { run: NonNullable<AgentDefinition<TRuntimeConfig, CALL_OPTIONS>["run"]> } {
  return hasAgentDefinition(agent)
    && hasRuntimeType(agent.run, "function")
    && !(syntheticWorkspaceRun in agent.run)
}

interface RunAgentInlineOptions {
  output?: "raw" | "rendered"
}

type AgentInvocationContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
> = AgentRunContext<TRuntimeConfig, CALL_OPTIONS> & {
  channels?: AgentChannels<TRuntimeConfig>
  close: () => Promise<void>
  deliveryEffectIntents: AgentChannelDeliveryEffectIntent[]
  toolStepReporter?: AgentRuntimeContext<TRuntimeConfig>["toolStepReporter"]
  toolResults: AgentToolStepItem[]
  driverContributions: AgentDriverContribution[]
  finalOutputRenderers: AgentCapabilityRegistries["finalOutputRenderers"]
  finishDeliveryEffectProviders: AgentChannelDeliveryFinishEffect[]
  finishExtensionProviders: ResolvedAgentFinishExtensionProvider[]
  errorHook?: (event: AgentErrorHookEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void | AgentChannelDeliveryFinishEffectResult>
  finishHook?: (event: AgentFinishHookEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void | AgentChannelDeliveryFinishEffectResult>
  hasCapabilityCleanup: boolean
  hooks?: AgentHookObserverHooks
  modelExecutionInstrumentation: AgentCapabilityRegistries["modelExecutionInstrumentation"]
  outputExtensionProviders: ResolvedAgentOutputExtensionProvider[]
  output?: AgentOutputDefinition
  outputRenderers: AgentCapabilityRegistries["outputRenderers"]
  runtimeContext: ResolvedAgentRuntimeContext<TRuntimeConfig>
  startTask?: Promise<void>
  telemetry: AgentCapabilityRegistries["telemetry"]
  telemetryAgent: { name?: string, version?: string }
  telemetryInvocationId: string
  telemetryScheduler: AgentTelemetryScheduler
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
  invocationJournal?: AgentInvocationJournal<TRuntimeConfig>
}

function toAgentAdapterRunContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS>,
): AgentAdapterRunContext<CALL_OPTIONS, TRuntimeConfig> {
  return {
    ...context,
    instructions: context.instructions,
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    modelExecutionInstrumentation: context.modelExecutionInstrumentation as never,
    nativeStructuredOutput: !context.outputRenderers.length && !context.finalOutputRenderers.length,
    runtime: context.runtimeContext,
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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

  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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

const ownedAgentWorkspaceDefinitions = new WeakMap<object, Map<string, WorkspaceDefinition>>()

function resolveOwnedAgentWorkspaceDefinition(
  agent: unknown,
  name: string,
  configured: WorkspaceDefinition | undefined,
): WorkspaceDefinition | undefined {
  const resolved = configured ? { ...configured, name } : undefined
  if (!hasRuntimeType(agent, "object") || agent === null) return resolved
  const definitions = ownedAgentWorkspaceDefinitions.get(agent) || new Map<string, WorkspaceDefinition>()
  const existing = definitions.get(name)
  if (existing) return existing
  if (resolved) setOwnedAgentWorkspaceDefinition(agent, name, resolved)
  return resolved
}

function ownedAgentWorkspaceKey(agent: unknown): object {
  if (!isRuntimeObject(agent)) throw new TypeError("[vitehub] Owned Agent Workspace state requires an object owner.")
  return agent
}

function setOwnedAgentWorkspaceDefinition(agent: unknown, name: string, definition: WorkspaceDefinition): void {
  const owner = ownedAgentWorkspaceKey(agent)
  const definitions = ownedAgentWorkspaceDefinitions.get(owner) || new Map<string, WorkspaceDefinition>()
  definitions.set(name, definition)
  ownedAgentWorkspaceDefinitions.set(owner, definitions)
}

function hasWorkspaceDefinitionOverlay(definition: WorkspaceDefinition | undefined): boolean {
  if (!definition) return false
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const { name: _name, sources, mode: _mode, ...fields } = definition as WorkspaceDefinition & { mode?: AgentCapabilityMode }
  return Object.keys(fields).length > 0 || Object.keys(sources || {}).length > 0
}

async function registerResolvedAgentWorkspaceDefinition(name: string, definition: WorkspaceDefinition | undefined): Promise<WorkspaceDefinition | undefined> {
  if (!definition) return
  const { name: _name, ...workspace } = definition
  const { registerWorkspace } = await import("@vite-hub/workspace/runtime")
  return registerWorkspace(name, workspace)
}

const ownedAgentWorkspaceRegistrations = new WeakMap<object, Map<string, Promise<WorkspaceDefinition | undefined>>>()

async function awaitOwnedAgentWorkspaceRegistration(agent: unknown, name: string): Promise<void> {
  await ownedAgentWorkspaceRegistrations.get(ownedAgentWorkspaceKey(agent))?.get(name)
}

async function registerOwnedAgentWorkspaceDefinition(
  agent: unknown,
  name: string,
  definition: WorkspaceDefinition,
): Promise<WorkspaceDefinition | undefined> {
  const owner = ownedAgentWorkspaceKey(agent)
  const registrations = ownedAgentWorkspaceRegistrations.get(owner) || new Map<string, Promise<WorkspaceDefinition | undefined>>()
  let registration = registrations.get(name)
  if (!registration) {
    registration = registerResolvedAgentWorkspaceDefinition(name, definition).then((registered) => {
      if (registered) setOwnedAgentWorkspaceDefinition(agent, name, registered)
      return registered
    })
    registrations.set(name, registration)
    ownedAgentWorkspaceRegistrations.set(owner, registrations)
    void registration.catch(() => {
      if (registrations.get(name) === registration) registrations.delete(name)
    })
  }
  return await registration
}

function registerAgentBackgroundTask(runtime: Pick<ResolvedAgentRuntimeContext, "waitUntil">, task: Promise<unknown>): void {
  void task.catch(() => {})
  try {
    runtime.waitUntil(task)
  }
  catch {}
}

function agentInvocationTraceLog(
  traceLog: NonNullable<ResolvedAgentRuntimeContext["traceLog"]>,
  invocationId: string,
  runId?: string,
  trace?: NonNullable<ResolvedAgentRuntimeContext["trace"]>,
  onAppend?: (entry: TraceEventLogEntry) => void,
): NonNullable<ResolvedAgentRuntimeContext["traceLog"]> {
  const invocationTraceLog = {
    async append(event: Parameters<typeof traceLog.append>[0]) {
      const entry = await traceLog.append(agentInvocationTraceEvent(event, invocationId, runId, trace))
      onAppend?.(entry)
      return entry
    },
    entries: () => traceLog.entries(),
  }
  if (agentInvocationJournalTraceLogSymbol in traceLog) {
    Object.defineProperty(invocationTraceLog, agentInvocationJournalTraceLogSymbol, { value: true })
  }
  if (agentInvocationJournalContentTraceLogSymbol in traceLog) {
    Object.defineProperty(invocationTraceLog, agentInvocationJournalContentTraceLogSymbol, { value: true })
  }
  if (agentTelemetryPendingEntriesSymbol in traceLog) {
    Object.defineProperty(invocationTraceLog, agentTelemetryPendingEntriesSymbol, {
      // SAFETY: The symbol presence check establishes the private pending-entry journal contract.
      value: (traceLog as typeof traceLog & {
        [agentTelemetryPendingEntriesSymbol]: {
          compact: () => void
          entries: () => TraceEventLogEntry[]
          release: (sequence: number) => void
        }
      })[agentTelemetryPendingEntriesSymbol],
    })
  }
  return invocationTraceLog
}

function agentInvocationTraceEvent(
  event: Parameters<NonNullable<ResolvedAgentRuntimeContext["traceLog"]>["append"]>[0],
  invocationId: string,
  runId?: string,
  trace?: NonNullable<ResolvedAgentRuntimeContext["trace"]>,
) {
  return {
    ...event,
    trace: event.trace || trace,
    attributes: {
      ...event.attributes,
      "agent.invocation.id": invocationId,
      ...(runId ? { "agent.run.id": runId } : {}),
    },
  }
}

function agentContentTraceLog(
  destination: ResolvedAgentRuntimeContext["traceLog"],
  invocationId: string,
  runId?: string,
  trace?: NonNullable<ResolvedAgentRuntimeContext["trace"]>,
): NonNullable<ResolvedAgentRuntimeContext["traceLog"]> {
  const maxEntries = 1024
  const firstEntries: TraceEventLogEntry[] = []
  const tailEntries: Array<TraceEventLogEntry | undefined> = Array.from({ length: maxEntries / 2 })
  let count = 0
  let failure: TraceEventLogEntry | undefined
  let terminal: TraceEventLogEntry | undefined
  const pendingEntries: TraceEventLogEntry[] = []
  const retainedEntries = () => {
    const tail = tailEntries.filter(entry => entry !== undefined).sort((left, right) => left.sequence - right.sequence)
    const evidence = [...new Map([failure, terminal].filter(entry => entry !== undefined).map(entry => [entry.sequence, entry])).values()]
    const evidenceSequences = new Set(evidence.map(entry => entry.sequence))
    const retainedTail = tail.filter(entry => !evidenceSequences.has(entry.sequence)).slice(-(tailEntries.length - evidence.length))
    const retained = count <= maxEntries ? [...firstEntries, ...tail] : [...firstEntries, ...retainedTail, ...evidence]
    return [...new Map(retained.map(entry => [entry.sequence, entry])).values()]
      .sort((left, right) => left.sequence - right.sequence)
  }
  const traceLog = {
    async append(event: Parameters<NonNullable<ResolvedAgentRuntimeContext["traceLog"]>["append"]>[0]) {
      const correlated = agentInvocationTraceEvent(event, invocationId, runId, trace)
      const normalized = await createTraceEventLog({ content: "content" }).append(correlated)
      const entry = { ...normalized, sequence: count + 1 }
      pendingEntries.push(entry)
      if (count < maxEntries / 2) firstEntries.push(entry)
      else tailEntries[(count - maxEntries / 2) % tailEntries.length] = entry
      const isFailure = entry.name === "run.error" || (entry.name === "agent.stream.error" && entry.attributes?.["error.recoverable"] !== true)
      if (isFailure) failure = entry
      if (entry.name === "agent.invocation.finish" || entry.name === "run.finish" || entry.name === "agent.invocation.error" || isFailure) terminal = entry
      count += 1
      await destination?.append(correlated)
      return entry
    },
    entries: retainedEntries,
  }
  Object.defineProperty(traceLog, agentTelemetryPendingEntriesSymbol, {
    value: {
      compact() {
        pendingEntries.splice(0, pendingEntries.length, ...retainedEntries())
      },
      entries: () => pendingEntries,
      release(sequence: number) {
        const retainedIndex = pendingEntries.findIndex(entry => entry.sequence > sequence)
        pendingEntries.splice(0, retainedIndex < 0 ? pendingEntries.length : retainedIndex)
      },
    },
  })
  if (destination && agentInvocationJournalTraceLogSymbol in destination) {
    Object.defineProperty(traceLog, agentInvocationJournalTraceLogSymbol, { value: true })
  }
  if (destination && agentInvocationJournalContentTraceLogSymbol in destination) {
    Object.defineProperty(traceLog, agentInvocationJournalContentTraceLogSymbol, { value: true })
  }
  return traceLog
}

const agentTelemetryPendingEntriesSymbol = Symbol("vitehub.agent.telemetry.pendingEntries")

function agentTelemetryTraceEvents(traceLog: NonNullable<ResolvedAgentRuntimeContext["traceLog"]>): TraceEventLogEntry[] {
  const retained = traceLog.entries()
  // SAFETY: Only agentContentTraceLog installs this private journal and owns both methods.
  const pending = (traceLog as typeof traceLog & {
    [agentTelemetryPendingEntriesSymbol]?: { entries: () => TraceEventLogEntry[] }
  })[agentTelemetryPendingEntriesSymbol]?.entries() || []
  return [...new Map([...retained, ...pending].map(entry => [entry.sequence, entry])).values()]
    .sort((left, right) => left.sequence - right.sequence)
}

function agentCapabilityTelemetry(
  capabilities: readonly AgentCapabilityDefinition[] | undefined,
): AgentCapabilityRegistries["telemetry"] {
  return normalizeCapabilities(capabilities || []).flatMap(capability => capability.telemetry
    ? [{ capabilityId: capability.id, registration: capability.telemetry }]
    : [])
}

function agentTelemetryUsesContent(registration: { content?: AgentTelemetryContentOptions }): boolean {
  return registration.content?.inputs === true
    || registration.content?.instructions === true
    || registration.content?.outputs === true
}



function allowedAgentTelemetryContent(key: string, content: AgentTelemetryContentOptions): boolean {
  if (!isTraceContentAttributeKey(key)) return false
  if (key === "input" || key.startsWith("input.") || key === "tool.input" || key === "approval.input") return content.inputs === true
  if (key === "output" || key.startsWith("output.") || key === "tool.output" || key === "result" || key.startsWith("result.") || key === "message.content" || key === "vitehub.activity.body") return content.outputs === true
  return false
}

type AgentTelemetryMessageContentClass = "inputs" | "instructions" | "outputs"

function agentTelemetryMessageContentClass(value: unknown): AgentTelemetryMessageContentClass | undefined {
  try {
    if (!value || !hasRuntimeType(value, "object")) return
    // SAFETY: The guarded record is read only to classify its finite public role contract.
    const role = (value as { role?: unknown }).role
    if (role === "user") return "inputs"
    if (role === "system") return "instructions"
    if (role === "assistant" || role === "tool") return "outputs"
  }
  catch {
    return undefined
  }
}

function agentTelemetryMessagesForContent(
  value: unknown,
  policy: AgentTelemetryContentOptions,
): unknown[] | undefined {
  if (!Array.isArray(value)) return
  const selected = value.filter((message) => {
    const contentClass = agentTelemetryMessageContentClass(message)
    return contentClass !== undefined && policy[contentClass] === true
  })
  return selected.length ? selected : undefined
}

function agentTelemetryAttributeForContent(
  key: string,
  value: unknown,
  policy: AgentTelemetryContentOptions,
): { selected: true, value: unknown } | undefined {
  if (key === "input.messages") {
    const messages = agentTelemetryMessagesForContent(value, policy)
    return messages ? { selected: true, value: messages } : undefined
  }
  if (key === "input.prompt" && Array.isArray(value)) {
    const messages = agentTelemetryMessagesForContent(value, policy)
    return messages ? { selected: true, value: messages } : undefined
  }
  if (key === "input.message" && !hasRuntimeType(value, "string")) {
    const contentClass = agentTelemetryMessageContentClass(value)
    return contentClass !== undefined && policy[contentClass] === true
      ? { selected: true, value }
      : undefined
  }
  return allowedAgentTelemetryContent(key, policy) ? { selected: true, value } : undefined
}

type AgentTelemetryContentClass = "ambiguous" | "inputs" | "instructions" | "outputs"

function agentTelemetryContentClass(path: string): AgentTelemetryContentClass | undefined {
  const parts = path
    .replace(/([a-z0-9])([A-Z])/g, "$1.$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (parts.some(part => part === "instruction" || part === "instructions")) return "instructions"
  if (parts.some(part => part === "input" || part === "inputs" || part === "prompt" || part === "prompts" || part === "request" || part === "args")) return "inputs"
  if (parts.some(part => part === "output" || part === "outputs" || part === "response" || part === "result" || part === "text" || part === "title")) return "outputs"
  return isTraceContentAttributeKey(path) ? "ambiguous" : undefined
}

function agentTelemetryMetadataForContent(
  value: AgentInspectionValue,
  policy: AgentTelemetryContentOptions,
  path = "",
): AgentInspectionValue | undefined {
  if (Array.isArray(value)) {
    return value.flatMap((child) => {
      const selected = agentTelemetryMetadataForContent(child, policy, path)
      return selected === undefined ? [] : [selected]
    })
  }
  if (!value || !hasRuntimeType(value, "object")) return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const childPath = path ? `${path}.${key}` : key
    const contentClass = agentTelemetryContentClass(childPath)
    if (contentClass === "instructions" && policy.instructions !== true) return []
    if (contentClass === "inputs" && policy.inputs !== true) return []
    if (contentClass === "outputs" && policy.outputs !== true) return []
    if (contentClass === "ambiguous" && (policy.inputs !== true || policy.outputs !== true)) return []
    const selected = agentTelemetryMetadataForContent(child, policy, childPath)
    return selected === undefined ? [] : [[key, selected]]
  }))
}

function agentTelemetryConfigurationForContent(
  configuration: AgentTelemetryConfiguration,
  policy: AgentTelemetryContentOptions,
): AgentTelemetryConfiguration {
  const { instructions, ...metadata } = configuration
  return {
    ...metadata,
    capabilities: configuration.capabilities?.map(capability => capability.metadata
      ? {
          ...capability,
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          metadata: agentTelemetryMetadataForContent(capability.metadata, policy) as Record<string, AgentInspectionValue>,
        }
      : capability),
    ...(policy.instructions === true && instructions ? { instructions } : {}),
  }
}

function withAgentTelemetryContentAttributes(
  safe: Record<string, unknown> | undefined,
  full: Record<string, unknown> | undefined,
  policy: AgentTelemetryContentOptions,
): Record<string, unknown> {
  const { "content.omitted": _omitted, ...safeAttributes } = safe || {}
  const allowedEntries = Object.entries(full || {}).flatMap(([key, value]) => {
    const selected = agentTelemetryAttributeForContent(key, value, policy)
    return selected ? [[key, selected.value] as const] : []
  })
  const allowedKeys = new Set(allowedEntries.map(([key]) => key))
  const omitted = Array.isArray(safe?.["content.omitted"])
    ? safe["content.omitted"].filter(key => !hasRuntimeType(key, "string") || !allowedKeys.has(key))
    : undefined
  return {
    ...safeAttributes,
    ...Object.fromEntries(allowedEntries),
    ...(omitted?.length ? { "content.omitted": omitted } : {}),
  }
}

function withAgentTelemetryContent(
  metadata: readonly OpenTelemetrySpanView[],
  content: readonly OpenTelemetrySpanView[],
  policy: AgentTelemetryContentOptions,
): OpenTelemetrySpanView[] {
  return metadata.map((span, index) => {
    const full = content[index]
    if (!full) return span
    return {
      ...span,
      attributes: withAgentTelemetryContentAttributes(span.attributes, full.attributes, policy),
      events: span.events?.map((event, eventIndex) => ({
        ...event,
        attributes: withAgentTelemetryContentAttributes(event.attributes, full.events?.[eventIndex]?.attributes, policy),
      })),
    }
  })
}


function withAgentTelemetryLogContent(
  metadata: readonly OpenTelemetryLogRecordView[],
  content: readonly OpenTelemetryLogRecordView[],
  policy: AgentTelemetryContentOptions,
): OpenTelemetryLogRecordView[] {
  return metadata.map((record, index) => ({
    ...record,
    attributes: withAgentTelemetryContentAttributes(record.attributes, content[index]?.attributes, policy),
  }))
}

function agentTelemetryConfigurationLogRecord(
  invocationId: string,
  configuration: AgentTelemetryConfiguration,
  correlation: OpenTelemetryLogRecordView,
): OpenTelemetryLogRecordView {
  return {
    attributes: {
      "agent.invocation.id": invocationId,
      "vitehub.agent.configuration": configuration,
      "vitehub.event.sequence": 0,
      "vitehub.event.type": "capability",
    },
    eventName: "vitehub.agent.configured",
    spanId: correlation.spanId,
    time: correlation.time,
    traceId: correlation.traceId,
  }
}

function agentTelemetryConfigurationValue(
  context: AgentInvocationContextStore,
  registration: AgentCapabilityRegistries["telemetry"][number]["registration"],
): AgentTelemetryConfiguration | undefined {
  const configuration = getAgentTelemetryConfiguration(context)?.value
  return configuration
    ? agentTelemetryConfigurationForContent(configuration, registration.content || {})
    : undefined
}

function agentTelemetryCorrelationRecord(
  events: readonly TraceEventLogEntry[],
  registration: AgentCapabilityRegistries["telemetry"][number]["registration"],
): OpenTelemetryLogRecordView | undefined {
  const first = events[0]
  const last = events.at(-1)
  if (!first || !last) return
  const correlationEvents = first === last ? [first] : [first, last]
  const metadataRecords = traceEventsToOpenTelemetryLogRecords(correlationEvents, { content: "metadata" })
  const records = registration.content?.inputs || registration.content?.outputs
    ? withAgentTelemetryLogContent(
        metadataRecords,
        traceEventsToOpenTelemetryLogRecords(correlationEvents, { content: "content" }),
        registration.content,
      )
    : metadataRecords
  return records.at(-1)
}

async function exportAgentTelemetryTraces<TRuntimeConfig extends AgentRuntimeConfig>(
  telemetry: AgentCapabilityRegistries["telemetry"],
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  context: AgentInvocationContextStore,
  agent: { name?: string, version?: string },
  invocationId: string,
  liveLogCursors?: Map<AgentCapabilityRegistries["telemetry"][number], number>,
  configurationDelivered?: Set<AgentCapabilityRegistries["telemetry"][number]>,
  incompleteLiveDelivery?: Set<AgentCapabilityRegistries["telemetry"][number]>,
): Promise<void> {
  if (!telemetry.length || !runtime.traceLog) return
  const events = agentTelemetryTraceEvents(runtime.traceLog).filter(event => event.attributes?.["agent.invocation.id"] === invocationId)
  const runs = deriveTraceRuns(events)
  const id = runtime.run?.runId || runtime.trace?.id
  const run = (id ? runs.find(candidate => candidate.id === id) : undefined) || (runs.length === 1 ? runs[0] : undefined)
  if (!run || run.status === "running") return
  const name = runtime.agentIdentity?.name || agent.name
  const configuration = getAgentTelemetryConfiguration(context)
  const model = configuration?.value.driver.model
  const provider = model?.provider || configuration?.value.driver.provider
  const metadataSpans = traceEventsToOpenTelemetrySpans(run.events, { content: "metadata" })
  let contentSpans: OpenTelemetrySpanView[] | undefined
  const terminalSequence = run.events.at(-1)!.sequence
  const exports = await Promise.allSettled(telemetry.map(async (item) => {
    const { capabilityId, registration } = item
    const selectedSpans = registration.content?.inputs || registration.content?.outputs
      ? withAgentTelemetryContent(
          metadataSpans,
          contentSpans ||= traceEventsToOpenTelemetrySpans(run.events, { content: "content" }),
          registration.content,
        )
      : metadataSpans
    const baseSpans = selectedSpans.map((span, index) => index
      ? span
      : {
          ...span,
          attributes: {
            ...span.attributes,
            "gen_ai.operation.name": "invoke_agent",
            ...(name ? { "gen_ai.agent.name": name, "vitehub.agent.name": name } : {}),
            ...(agent.version ? { "gen_ai.agent.version": agent.version, "vitehub.agent.version": agent.version } : {}),
            ...(provider ? { "gen_ai.provider.name": provider } : {}),
            ...(model?.id ? { "gen_ai.request.model": model.id } : {}),
            "vitehub.runtime.name": runtime.runtime,
          },
        })
    const configurationValue = agentTelemetryConfigurationValue(context, registration)
    const configuredSpans = configurationValue && baseSpans[0]
      ? baseSpans.map((span, index) => index
        ? span
        : {
            ...span,
            events: [
              {
                attributes: {
                  "vitehub.agent.configuration": configurationValue,
                },
                name: "vitehub.agent.configured",
                time: span.startTime,
              },
              ...(span.events || []),
            ],
          })
      : baseSpans
    const spans = registration.live
      && !incompleteLiveDelivery?.has(item)
      && (liveLogCursors?.get(item) || 0) >= terminalSequence
      ? configuredSpans.map((span, index) => ({
          ...span,
          events: !index && configurationValue && !configurationDelivered?.has(item)
            ? span.events?.slice(0, 1)
            : undefined,
        }))
      : configuredSpans
    try {
      await registration.exporter({ agent: { ...(name ? { name } : {}), ...(agent.version ? { version: agent.version } : {}) }, run: runtime.run, runtime, signal: "traces", spans })
    }
    catch (error) {
      throw new AgentTelemetryCapabilityError(capabilityId, error)
    }
  }))
  throwAgentTelemetryFailures(exports)
}

async function exportAgentTelemetryLogs<TRuntimeConfig extends AgentRuntimeConfig>(
  telemetry: AgentCapabilityRegistries["telemetry"],
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  context: AgentInvocationContextStore,
  agent: { name?: string, version?: string },
  invocationId: string,
  throughSequence: number,
  cursors: Map<AgentCapabilityRegistries["telemetry"][number], number>,
  configurationDelivered: Set<AgentCapabilityRegistries["telemetry"][number]>,
  incompleteDelivery: Set<AgentCapabilityRegistries["telemetry"][number]>,
  includeConfiguration = false,
): Promise<void> {
  if (!telemetry.length || !runtime.traceLog) return
  const name = runtime.agentIdentity?.name || agent.name
  const invocationEvents = agentTelemetryTraceEvents(runtime.traceLog).filter(event => event.sequence <= throughSequence
    && event.attributes?.["agent.invocation.id"] === invocationId)
  const exports = await Promise.allSettled(telemetry.map(async (item) => {
    const { capabilityId, registration } = item
    const configurationValue = agentTelemetryConfigurationValue(context, registration)
    let afterSequence = cursors.get(item) || 0
    while (true) {
      const nextIndex = invocationEvents.findIndex(event => event.sequence > afterSequence)
      if (nextIndex < 0) return
      const remainingCount = invocationEvents.length - nextIndex
      const needsConfiguration = includeConfiguration && configurationValue && !configurationDelivered.has(item)
      const reservesConfigurationSlot = needsConfiguration && remainingCount <= agentTelemetryMaxBatchSize
      const finalBatchIncludesConfiguration = needsConfiguration && remainingCount < agentTelemetryMaxBatchSize
      const eventLimit = reservesConfigurationSlot ? agentTelemetryMaxBatchSize - 1 : agentTelemetryMaxBatchSize
      const events = invocationEvents.slice(nextIndex, nextIndex + eventLimit)
      const anchor = invocationEvents[0]
      const conversionEvents = anchor && anchor.sequence <= afterSequence ? [anchor, ...events] : events
      const currentRecords = (records: OpenTelemetryLogRecordView[]) => records.filter(record => {
        const sequence = record.attributes?.["vitehub.event.sequence"]
        return hasRuntimeType(sequence, "number") && sequence > afterSequence
      })
      const metadataRecords = currentRecords(traceEventsToOpenTelemetryLogRecords(conversionEvents, { content: "metadata" }))
      const records = registration.content?.inputs || registration.content?.outputs
        ? withAgentTelemetryLogContent(
            metadataRecords,
            currentRecords(traceEventsToOpenTelemetryLogRecords(conversionEvents, { content: "content" })),
            registration.content,
          )
        : metadataRecords
      const configuredRecords = configurationValue && finalBatchIncludesConfiguration && records[0]
        ? [agentTelemetryConfigurationLogRecord(invocationId, configurationValue, records[0]), ...records]
        : records
      try {
        await registration.exporter({
          agent: { ...(name ? { name } : {}), ...(agent.version ? { version: agent.version } : {}) },
          records: configuredRecords,
          run: runtime.run,
          runtime,
          signal: "logs",
        })
      }
      catch (error) {
        throw new AgentTelemetryCapabilityError(capabilityId, error)
      }
      afterSequence = events.at(-1)!.sequence
      cursors.set(item, afterSequence)
      if (finalBatchIncludesConfiguration) configurationDelivered.add(item)
    }
  }))
  if (exports.some(result => result.status === "rejected")) {
    exports.forEach((result, index) => {
      if (result.status === "rejected") incompleteDelivery.add(telemetry[index]!)
    })
    // SAFETY: Only agentContentTraceLog installs this private journal and owns this method.
    const pending = (runtime.traceLog as typeof runtime.traceLog & {
      [agentTelemetryPendingEntriesSymbol]?: { compact: () => void }
    })[agentTelemetryPendingEntriesSymbol]
    pending?.compact()
  }
  throwAgentTelemetryFailures(exports)
  const deliveredThrough = Math.min(...telemetry.map(item => cursors.get(item) || 0))
  // SAFETY: Only agentContentTraceLog installs this private journal and owns both methods.
  const pending = (runtime.traceLog as typeof runtime.traceLog & {
    [agentTelemetryPendingEntriesSymbol]?: { release: (sequence: number) => void }
  })[agentTelemetryPendingEntriesSymbol]
  if (Number.isFinite(deliveredThrough)) pending?.release(deliveredThrough)
}

async function exportAgentTelemetryConfiguration<TRuntimeConfig extends AgentRuntimeConfig>(
  telemetry: AgentCapabilityRegistries["telemetry"],
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  context: AgentInvocationContextStore,
  agent: { name?: string, version?: string },
  invocationId: string,
  cursors: Map<AgentCapabilityRegistries["telemetry"][number], number>,
  configurationDelivered: Set<AgentCapabilityRegistries["telemetry"][number]>,
): Promise<void> {
  if (!telemetry.length || !runtime.traceLog) return
  const name = runtime.agentIdentity?.name || agent.name
  const events = runtime.traceLog.entries().filter(event => event.attributes?.["agent.invocation.id"] === invocationId)
  const terminalSequence = events.at(-1)?.sequence
  if (terminalSequence === undefined) return
  const exports = await Promise.allSettled(telemetry.map(async (item) => {
    if (configurationDelivered.has(item) || (cursors.get(item) || 0) < terminalSequence) return
    const { capabilityId, registration } = item
    const configuration = agentTelemetryConfigurationValue(context, registration)
    const correlation = agentTelemetryCorrelationRecord(events, registration)
    if (!configuration || !correlation) return
    try {
      await registration.exporter({
        agent: { ...(name ? { name } : {}), ...(agent.version ? { version: agent.version } : {}) },
        records: [agentTelemetryConfigurationLogRecord(invocationId, configuration, correlation)],
        run: runtime.run,
        runtime,
        signal: "logs",
      })
    }
    catch (error) {
      throw new AgentTelemetryCapabilityError(capabilityId, error)
    }
    configurationDelivered.add(item)
  }))
  throwAgentTelemetryFailures(exports)
}

function throwAgentTelemetryFailures(exports: PromiseSettledResult<void>[]): void {
  const failures = exports.flatMap(result => result.status === "rejected" ? [result.reason] : [])
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "Multiple Agent telemetry exports failed.")
}

class AgentTelemetryCapabilityError extends Error {
  readonly capabilityId: string

  constructor(capabilityId: string, cause: unknown) {
    super(`[vitehub] Capability "${capabilityId}" telemetry export failed.`, { cause })
    this.name = "AgentTelemetryCapabilityError"
    this.capabilityId = capabilityId
  }
}

function reportAgentTelemetryFailure<TRuntimeConfig extends AgentRuntimeConfig>(
  error: unknown,
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  agent: { name?: string, version?: string },
  invocationId: string,
  phase: "live" | "terminal",
): void {
  const failure = error instanceof AgentTelemetryCapabilityError ? error.cause : error
  const name = runtime.agentIdentity?.name || agent.name
  const capabilityIds = error instanceof AggregateError
    ? error.errors.flatMap(item => item instanceof AgentTelemetryCapabilityError ? [item.capabilityId] : [])
    : []
  console.error({
    agent: { ...(name ? { name } : {}), ...(agent.version ? { version: agent.version } : {}) },
    ...(error instanceof AgentTelemetryCapabilityError ? { capability_id: error.capabilityId } : {}),
    ...(capabilityIds.length ? { capability_ids: capabilityIds } : {}),
    component: "@vite-hub/agent",
    error: normalizeRuntimeDiagnosticError(failure, { includeStack: true }),
    event: "agent.telemetry.export.failed",
    invocation_id: invocationId,
    phase,
    ...(runtime.run?.runId ? { run_id: runtime.run.runId } : {}),
    runtime: runtime.runtime,
    timestamp: new Date().toISOString(),
  })
}

function scheduleAgentTelemetry<TRuntimeConfig extends AgentRuntimeConfig>(
  telemetry: AgentCapabilityRegistries["telemetry"],
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  context: AgentInvocationContextStore,
  agent: { name?: string, version?: string },
  invocationId: string,
): Promise<void> | undefined {
  if (!telemetry.length || !runtime.traceLog) return
  const task = Promise.resolve()
    .then(() => exportAgentTelemetryTraces(telemetry, runtime, context, agent, invocationId))
    .catch(error => reportAgentTelemetryFailure(error, runtime, agent, invocationId, "terminal"))
  Object.defineProperty(task, agentTelemetryTask, { value: true })
  registerAgentBackgroundTask(runtime, task)
  return task
}

interface AgentTelemetryScheduler {
  changed: (entry: TraceEventLogEntry) => void
  finish: () => void
}

const agentTelemetryBatchDelayMs = 5_000
const agentTelemetryMaxBatchSize = 512

function createAgentTelemetryScheduler<TRuntimeConfig extends AgentRuntimeConfig>(
  telemetry: AgentCapabilityRegistries["telemetry"],
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  context: AgentInvocationContextStore,
  agent: { name?: string, version?: string },
  invocationId: string,
): AgentTelemetryScheduler {
  const liveTelemetry = telemetry.filter(({ registration }) => registration.live === true)
  const cursors = new Map<AgentCapabilityRegistries["telemetry"][number], number>()
  const configurationDelivered = new Set<AgentCapabilityRegistries["telemetry"][number]>()
  const incompleteLiveDelivery = new Set<AgentCapabilityRegistries["telemetry"][number]>()
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let exports = Promise.resolve()
  let liveLogsQueued = false
  let pendingCount = 0
  let pendingThroughSequence: number | undefined
  const queue = (phase: "live" | "terminal", task: () => Promise<void>) => {
    exports = exports
      .then(task)
      .catch(error => reportAgentTelemetryFailure(error, runtime, agent, invocationId, phase))
    Object.defineProperty(exports, agentTelemetryTask, { value: true })
    registerAgentBackgroundTask(runtime, exports)
  }
  const flushLogs = () => {
    if (!liveTelemetry.length || pendingThroughSequence === undefined || liveLogsQueued) return
    liveLogsQueued = true
    queue("live", async () => {
      try {
        while (pendingThroughSequence !== undefined) {
          const throughSequence = pendingThroughSequence
          const phase = finished ? "terminal" : "live"
          pendingCount = 0
          pendingThroughSequence = undefined
          await exportAgentTelemetryLogs(liveTelemetry, runtime, context, agent, invocationId, throughSequence, cursors, configurationDelivered, incompleteLiveDelivery, finished)
            .catch(error => reportAgentTelemetryFailure(error, runtime, agent, invocationId, phase))
        }
      }
      finally {
        liveLogsQueued = false
        flushLogs()
      }
    })
  }
  return {
    changed(entry) {
      if (finished || !liveTelemetry.length) return
      pendingCount += 1
      pendingThroughSequence = Math.max(pendingThroughSequence || 0, entry.sequence)
      if (pendingCount >= agentTelemetryMaxBatchSize) {
        if (timer) clearTimeout(timer)
        timer = undefined
        flushLogs()
        return
      }
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        if (!finished) flushLogs()
      }, agentTelemetryBatchDelayMs)
      // SAFETY: Node timers expose unref while browser timers are numbers, so this optional method is feature-detected.
      const unref = (timer as { unref?: () => void }).unref
      if (unref) unref.call(timer)
    },
    finish() {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      timer = undefined
      flushLogs()
      if (liveTelemetry.length) queue("terminal", () => exportAgentTelemetryConfiguration(
        liveTelemetry,
        runtime,
        context,
        agent,
        invocationId,
        cursors,
        configurationDelivered,
      ))
      if (telemetry.length) queue("terminal", () => exportAgentTelemetryTraces(
        telemetry,
        runtime,
        context,
        agent,
        invocationId,
        cursors,
        configurationDelivered,
        incompleteLiveDelivery,
      ))
    },
  }
}


async function createAgentInvocationContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  invocationKind: "run" | "stream" = "run",
  invocationJournal?: AgentInvocationJournal<TRuntimeConfig>,
): Promise<AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS>> {
  const startedAt = Date.now()
  const resolvedContext = createResolvedRuntimeContext(context)
  const invocationContext = createAgentInvocationContextStore(input.context)
  await parseAgentMessageMeta(definition, invocationContext, context.run)
  input = { ...input, context: { ...input.context, ...invocationContext.toJSON() } }
  const telemetryInvocationId = createTraceId()
  let telemetryScheduler: AgentTelemetryScheduler | undefined
  const telemetryChanged = (entry: TraceEventLogEntry) => telemetryScheduler?.changed(entry)
  const toolResults: AgentToolStepItem[] = []
  const toolStepReporter: NonNullable<AgentRuntimeContext<TRuntimeConfig>["toolStepReporter"]> = async (step) => {
    if (step.toolResults?.length) {
      for (const result of step.toolResults) appendAgentToolResult(toolResults, result)
    }
    await context.toolStepReporter?.(step)
  }
  invocationContext.set(agentInvocationTraceIdContextKey, telemetryInvocationId, { overwrite: true })
  const tracedRuntimeContextBase = resolvedContext.trace && resolvedContext.traceLog
    ? resolvedContext
    : {
        ...resolvedContext,
        trace: resolvedContext.trace || { id: createTraceId(context.run) },
        traceLog: resolvedContext.traceLog || createTraceEventLog(),
  }
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const internalDefinition = definition as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS> | undefined
  const capabilitiesResolver = internalDefinition?.[baseAgentCapabilitiesResolver]
  const activeChannel = activeAgentChannel(definition?.channels, invocationContext, context.run)?.channel
  const channelCapabilities = activeChannel?.capabilities || []
  const initialTelemetry = agentCapabilityTelemetry([
    ...(definition?.capabilities || []),
    ...channelCapabilities,
  ])
  const initialTelemetryUsesContent = initialTelemetry.some(({ registration }) => agentTelemetryUsesContent(registration))
  const mayResolveContentTelemetry = capabilitiesResolver !== undefined
  const baseTraceLog = tracedRuntimeContextBase.traceLog || createTraceEventLog()
  const telemetryTraceLogWrapped = initialTelemetry.length > 0 || mayResolveContentTelemetry
  const correlatedTraceLog = telemetryTraceLogWrapped
    ? agentInvocationTraceLog(baseTraceLog, telemetryInvocationId, context.run?.runId, tracedRuntimeContextBase.trace, telemetryChanged)
    : baseTraceLog
  const initialTraceLog = initialTelemetryUsesContent || mayResolveContentTelemetry
    ? agentContentTraceLog(resolvedContext.traceLog, telemetryInvocationId, context.run?.runId, tracedRuntimeContextBase.trace)
    : correlatedTraceLog
  const tracedRuntimeContext = {
    ...tracedRuntimeContextBase,
    traceLog: initialTraceLog === correlatedTraceLog
      ? correlatedTraceLog
      : agentInvocationTraceLog(initialTraceLog, telemetryInvocationId, context.run?.runId, tracedRuntimeContextBase.trace, telemetryChanged),
  }
  let runtimeContext: ResolvedAgentRuntimeContext<TRuntimeConfig> & { runEvents?: AgentRunEventPublisher } = tracedRuntimeContext
  let invoker = createFallbackAgentInvoker(context.run)
  let failureTelemetry = initialTelemetry
  const telemetryContentTraceLogWrapped = initialTelemetryUsesContent || mayResolveContentTelemetry
  try {
    const boundRunEvents = bindAgentRunEvents(definition?.runEvents, tracedRuntimeContext)
    runtimeContext = boundRunEvents
      ? { ...tracedRuntimeContext, runEvents: boundRunEvents }
      : tracedRuntimeContext
    let callbackContext = createAgentCallbackContext(runtimeContext)
    bindMessageChannelInstructions(
      invocationContext,
      activeChannel,
    )
    invocationContext.set(scheduledAgentChannelIdsContextKey, Object.keys(definition?.channels || {}), { overwrite: true })
    invocationContext.set(scheduledAgentNameContextKey, context.agentIdentity?.name, { overwrite: true })
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const colocatedSkills = (definition as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS> | undefined)?.[colocatedAgentSkillsSymbol]
    invocationContext.set(colocatedAgentSkillsContextKey, colocatedSkills, { overwrite: true })
    invoker = await resolveAgentInvoker(
      definition?.invoker,
      callbackContext,
      invocationContext,
      input,
      context.run,
      invocationContext.get(scheduledAgentTurnContextKey) === true,
    )
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig>> | undefined
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const workspaceOptions = workspaceDefinition?.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<AgentRuntimeConfig> | undefined
    const driverKind = internalDefinition?.[baseAgentDriverKind] || "model"
    const invocationResolvedCapabilities = capabilitiesResolver
      ? await resolveAgentCapabilityDefinitions(capabilitiesResolver, {
          ...agentInvocationCallbackContextValues(invocationContext),
          ...callbackContext,
          abortSignal: input.abortSignal,
          actor: invoker,
          context: invocationContext,
          driver: { kind: driverKind },
          input,
          invoker,
          run: context.run,
        })
      : []
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const resolvedCapabilityDefinitions = normalizeCapabilities([
      ...invocationResolvedCapabilities,
      ...(definition?.capabilities || []),
      ...channelCapabilities,
    ]) as AgentCapabilityDefinition<TRuntimeConfig>[]
    failureTelemetry = agentCapabilityTelemetry(resolvedCapabilityDefinitions)
    const resolvedTelemetryUsesContent = failureTelemetry.some(({ registration }) => agentTelemetryUsesContent(registration))
    if (mayResolveContentTelemetry && !resolvedTelemetryUsesContent) {
      if (!resolvedContext.traceLog) {
        for (const entry of runtimeContext.traceLog?.entries() || []) {
          await correlatedTraceLog.append(entry)
        }
      }
      runtimeContext = { ...runtimeContext, traceLog: correlatedTraceLog }
    }
    const workspaceMode = workspaceOptions ? workspaceModeFromOptions(workspaceOptions) : "read"
    validateAgentCapabilityComposition(resolvedCapabilityDefinitions, {
      driverKind,
      hasWorkspace: Boolean(workspaceOptions),
      ...(workspaceOptions ? { workspaceMode } : {}),
    })
    const workspaceName = workspaceOptions
      ? workspaceNameFromOptions(workspaceOptions, {}, context.agentIdentity)
      : undefined
    const configuredWorkspaceDefinition = workspaceOptions && workspaceName
      ? { ...workspaceDefinitionFromOptions(workspaceOptions), name: workspaceName }
      : undefined
    const ownsWorkspaceDefinition = workspaceDefinition ? workspaceAgentOwnsWorkspaceDefinition(workspaceDefinition) : false
    const registeredWorkspaceDefinition = workspaceName
      ? await resolveRegisteredAgentWorkspaceDefinition(workspaceName)
      : undefined
    if (workspaceName && ownsWorkspaceDefinition && hasRuntimeType(workspaceDefinition, "object") && workspaceDefinition !== null) {
      await awaitOwnedAgentWorkspaceRegistration(workspaceDefinition, workspaceName)
    }
    const usesRegisteredOwnedDefinition = Boolean(
      workspaceName
      && ownsWorkspaceDefinition
      && registeredWorkspaceDefinition
      && workspaceAgentUsesRegisteredDefinition(workspaceDefinition, workspaceName),
    )
    const configuredDefinitionForMerge = ownsWorkspaceDefinition ? undefined : configuredWorkspaceDefinition
    let resolvedWorkspaceDefinition = workspaceName
      ? ownsWorkspaceDefinition
        ? usesRegisteredOwnedDefinition
          ? registeredWorkspaceDefinition
          : resolveOwnedAgentWorkspaceDefinition(workspaceDefinition, workspaceName, configuredWorkspaceDefinition)
        : mergeAgentWorkspaceDefinition(workspaceName, registeredWorkspaceDefinition, configuredDefinitionForMerge)
      : undefined
    if (workspaceName && ownsWorkspaceDefinition && resolvedWorkspaceDefinition && !registeredWorkspaceDefinition) {
      if (resolvedWorkspaceDefinition && hasRuntimeType(workspaceDefinition, "object") && workspaceDefinition !== null) {
        resolvedWorkspaceDefinition = await registerOwnedAgentWorkspaceDefinition(workspaceDefinition, workspaceName, resolvedWorkspaceDefinition)
      }
      else {
        resolvedWorkspaceDefinition = await registerResolvedAgentWorkspaceDefinition(workspaceName, resolvedWorkspaceDefinition)
      }
      if (resolvedWorkspaceDefinition && hasRuntimeType(workspaceDefinition, "object") && workspaceDefinition !== null) {
        setOwnedAgentWorkspaceDefinition(workspaceDefinition, workspaceName, resolvedWorkspaceDefinition)
      }
    }
    const workspaceUseOptions = resolvedWorkspaceDefinition && (
      ownsWorkspaceDefinition
        ? !usesRegisteredOwnedDefinition
        : hasWorkspaceDefinitionOverlay(configuredDefinitionForMerge)
    )
      ? { definition: resolvedWorkspaceDefinition }
      : undefined
    const workspaceModule = workspaceName ? await import("@vite-hub/workspace") : undefined
    const baseWorkspace = workspaceName && workspaceModule
      ? workspaceMode === "write"
        ? workspaceModule.useWorkspace(workspaceName, workspaceUseOptions ? { ...workspaceUseOptions, mode: "write" } : { mode: "write" })
        : workspaceUseOptions ? workspaceModule.useWorkspace(workspaceName, { ...workspaceUseOptions, mode: "read" }) : workspaceModule.useWorkspace(workspaceName)
      : undefined
    const workspace = baseWorkspace
    const capabilityOptions = resolvedCapabilityDefinitions.length
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      ? { capabilities: resolvedCapabilityDefinitions, hooks: definition?.hooks as never }
      : undefined
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const agentModel = internalDefinition?.[baseAgentModel] as AgentModelResolver<TRuntimeConfig> | undefined
    const resolveCapabilityCli = resolveCapabilityCliRunSurface(definition)
    if (!telemetryTraceLogWrapped && runtimeContext.traceLog && failureTelemetry.length) {
      runtimeContext = { ...runtimeContext, traceLog: agentInvocationTraceLog(runtimeContext.traceLog, telemetryInvocationId, context.run?.runId, runtimeContext.trace, telemetryChanged) }
    }
    if (!telemetryContentTraceLogWrapped && runtimeContext.traceLog && failureTelemetry.some(({ registration }) => agentTelemetryUsesContent(registration))) {
      runtimeContext = { ...runtimeContext, traceLog: agentContentTraceLog(runtimeContext.traceLog, telemetryInvocationId, context.run?.runId, runtimeContext.trace) }
    }
    callbackContext = createAgentCallbackContext(runtimeContext)
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const capabilities = await resolveAgentCapabilities(capabilityOptions, runtimeContext, input, workspace as never, workspaceMode, {
      context: invocationContext,
      driverKind,
      invocationKind,
      invoker,
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      model: agentModel as never,
      resolveCapabilityCli,
      workspaceDefinition: resolvedWorkspaceDefinition,
    })
    const inputHook = definition?.hooks?.["agent:input"]
    if (inputHook && !capabilities.response) {
      try {
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        await runObservedAgentHook(definition?.hooks as AgentHookObserverHooks | undefined, {
          name: "agent:input",
          owner: "agent",
          phase: "input",
        }, () => inputHook({
          ...callbackContext,
          actor: invoker,
          context: invocationContext,
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
    const preparedTools = withJsonCompatibleToolOutputs(applyAgentToolPolicies(transformedTools) || {})
    const tools = Object.keys(transformedTools || {}).length
      ? withAgentToolStepReporting(preparedTools, toolStepReporter)
      : undefined
    const activeWorkspace = capabilities.workspace || workspace
    const sourceResolvedWorkspaceDefinition = invocationContext.get("workspace.sourceResolution.definition")
    const activeWorkspaceDefinition = capabilities.workspaceDefinition || sourceResolvedWorkspaceDefinition || resolvedWorkspaceDefinition
    const configuredWorkspace = workspaceOptions?.workspace
    const workspaceAutoCommit = configuredWorkspace && hasRuntimeType(configuredWorkspace, "object") && !("name" in configuredWorkspace)
      ? configuredWorkspace.commit
      : undefined
    const instructions = workspaceOptions && activeWorkspace
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      ? await resolveWorkspaceAgentDefaultInstructions(workspaceOptions, activeWorkspace as ReadonlyWorkspaceFacade)
      : undefined
    const workspaceInstructionBindings = activeWorkspaceDefinition
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      ? await resolveWorkspaceInstructionBindings(activeWorkspaceDefinition, activeWorkspace as ReadonlyWorkspaceFacade | undefined)
      : undefined

    const capabilityTelemetryMetadata = new Map<string, Record<string, AgentInspectionValue>>()
    const addCapabilityTelemetryMetadata = (id: string, metadata: unknown) => {
      if (!capabilityTelemetryMetadata.has(id)) capabilityTelemetryMetadata.set(id, {})
      const safeMetadata = safeAgentTelemetryMetadata(metadata)
      if (!safeMetadata) return
      capabilityTelemetryMetadata.set(id, { ...capabilityTelemetryMetadata.get(id), ...safeMetadata })
    }
    for (const capability of resolvedCapabilityDefinitions) {
      addCapabilityTelemetryMetadata(capability.id, capability.metadata)
    }
    for (const contribution of capabilities.registries.telemetryMetadata) {
      addCapabilityTelemetryMetadata(contribution.capabilityId, contribution.metadata)
    }
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const settings = (definition as AgentDefinition & { __vitehubAgentSettings?: AgentSettings } | undefined)?.__vitehubAgentSettings
    const configuredDriver = settings ? normalizeAgentDriver(settings) : undefined
    if (capabilities.registries.telemetry.length || invocationJournal) setAgentTelemetryConfiguration(invocationContext, {
      agent: {
        ...(definition?.name ? { name: definition.name } : {}),
        ...(definition?.version ? { version: definition.version } : {}),
      },
      capabilities: [...capabilityTelemetryMetadata.entries()]
        .map(([id, metadata]) => ({ id, ...(Object.keys(metadata).length ? { metadata } : {}) }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      driver: {
        kind: driverKind,
        ...(configuredDriver?.kind === "provider" ? { provider: configuredDriver.provider } : {}),
      },
      ...(instructions ? { instructions: [instructions] } : {}),
      runtime: {
        name: runtimeContext.runtime,
      },
      ...(tools ? { tools: Object.keys(tools).sort().map(name => ({ name })) } : {}),
      ...(activeWorkspaceDefinition
        ? {
            workspace: {
              mode: workspaceMode,
              ...(activeWorkspaceDefinition.name ? { name: activeWorkspaceDefinition.name } : {}),
              ...(activeWorkspaceDefinition.sources ? { sources: Object.keys(activeWorkspaceDefinition.sources).sort() } : {}),
            },
          }
        : {}),
    })

    telemetryScheduler = createAgentTelemetryScheduler(
      capabilities.registries.telemetry,
      runtimeContext,
      invocationContext,
      { name: definition?.name, version: definition?.version },
      telemetryInvocationId,
    )

    const invocation = {
      ...callbackContext,
      actor: invoker,
      channels: definition?.channels,
      close: capabilities.close,
      context: invocationContext,
      deliveryEffectIntents: capabilities.registries.deliveryEffectIntents,
      durableErrorFallbackTimeout: (() => {
        const options = getChatCapabilityOptions(definition?.capabilities || [])
        return options ? durableChatErrorFallbackTimeout(options) : undefined
      })(),
      toolStepReporter,
      toolResults,
      driverContributions: capabilities.driverContributions,
      finalOutputRenderers: capabilities.registries.finalOutputRenderers,
      finishDeliveryEffectProviders: capabilities.registries.finishDeliveryEffectProviders,
      finishExtensionProviders: capabilities.registries.finishExtensionProviders,
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      errorHook: definition?.hooks?.["agent:error"] as never,
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      finishHook: definition?.hooks?.["agent:finish"] as never,
      hasCapabilityCleanup: capabilities.hasCloseCallbacks,
      handledResponse: capabilities.response,
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      hooks: definition?.hooks as AgentHookObserverHooks | undefined,
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      input: capabilities.input as AgentRunInput<CALL_OPTIONS>,
      instructions,
      invoker,
      invocationJournal,
      messages: capabilities.messages,
      modelExecutionInstrumentation: capabilities.registries.modelExecutionInstrumentation,
      outputExtensionProviders: capabilities.registries.outputExtensionProviders,
      output: internalDefinition?.[baseAgentOutput],
      outputRenderers: capabilities.registries.outputRenderers,
      prompt: hasRuntimeType(capabilities.input.prompt, "string") ? capabilities.input.prompt : undefined,
      providerTools: capabilities.registries.providerTools,
      run: context.run,
      runtimeContext,
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      startTask: undefined as Promise<void> | undefined,
      startedAt,
      telemetry: capabilities.registries.telemetry,
      telemetryAgent: { name: definition?.name, version: definition?.version },
      telemetryInvocationId,
      telemetryScheduler,
      tools,
      workspace: activeWorkspace,
      workspaceAutoCommit,
      workspaceDefinition: activeWorkspaceDefinition,
      workspaceInstructionBindings,
      workspaceMaterializationSource: activeWorkspace,
      workspaceMaterializationPaths: capabilities.workspaceMaterializationPaths,
      workspaceMode,
    }
    invocationContext.set("agent.errorHook", Boolean(invocation.errorHook), { overwrite: true })
    invocationContext.set("agent.finishHook", Boolean(invocation.finishHook), { overwrite: true })
    if (invocationJournal) {
      const traceConfiguration = async () => {
        const configuration = getAgentTelemetryConfiguration(invocationContext)?.value
        if (!configuration) return
        const journalTraceLog = invocationJournal.context.traceLog
        const persistedConfiguration = journalTraceLog
          && agentInvocationJournalContentTraceLogSymbol in journalTraceLog
          ? configuration
          : agentTelemetryConfigurationForContent(configuration, {})
        await runtimeContext.traceLog?.append({
          attributes: { "vitehub.agent.configuration": persistedConfiguration },
          name: "vitehub.agent.configured",
          ...(runtimeContext.trace ? { trace: { ...runtimeContext.trace } } : {}),
          type: "run",
        })
      }
      invocationContext.set(agentInvocationConfigurationUpdatedContextKey, traceConfiguration, { overwrite: true })
      await traceConfiguration()
    }
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
    scheduleAgentTelemetry(failureTelemetry, runtimeContext, invocationContext, { name: definition?.name, version: definition?.version }, telemetryInvocationId)
    throw error
  }
}

function appendAgentToolResult(results: AgentToolStepItem[], result: AgentToolStepItem): void {
  const id = result.toolCallId ?? result.id
  if (id !== undefined && results.some(candidate => (candidate.toolCallId ?? candidate.id) === id)) return
  results.push(result)
}

function agentToolResultStreamCollector(toolResults: AgentToolStepItem[]): (chunk: unknown) => void {
  const toolNames = new Map<string, string>()
  const textPhases = new Map<string, AgentMessagePhase | "hidden">()
  return (chunk) => {
    const event = toAgentStreamEvent(chunk, toolNames, textPhases)
    if (event?.type === "tool-result" && !event.error) {
      appendAgentToolResult(toolResults, {
        output: event.output,
        toolCallId: event.id,
        toolName: event.name,
      })
    }
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
  durableErrorFallbackTimeout?: number
  finishDeliveryEffectProviders: AgentChannelDeliveryFinishEffect[]
  finishExtensionProviders: ResolvedAgentFinishExtensionProvider[]
  finalOutputRenderers: AgentCapabilityRegistries["finalOutputRenderers"]
  errorHook?: (event: AgentErrorHookEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void | AgentChannelDeliveryFinishEffectResult>
  finishHook?: (event: AgentFinishHookEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void | AgentChannelDeliveryFinishEffectResult>
  hooks?: AgentHookObserverHooks
  input: AgentRunInput<CALL_OPTIONS>
  invocationJournal?: AgentInvocationJournal<TRuntimeConfig>
  output?: AgentOutputDefinition
  outputExtensionProviders: ResolvedAgentOutputExtensionProvider[]
  startTask?: Promise<void>
  actor: AgentInvoker
  invoker: AgentInvoker
  runtimeContext: ResolvedAgentRuntimeContext<TRuntimeConfig>
  run?: AgentRunContext<TRuntimeConfig, CALL_OPTIONS>["run"]
  startedAt: number
  telemetry: AgentCapabilityRegistries["telemetry"]
  telemetryAgent: { name?: string, version?: string }
  telemetryInvocationId: string
  telemetryScheduler: AgentTelemetryScheduler
  tools?: AgentToolSet
  toolResults: AgentToolStepItem[]
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

function agentToolActivities(tools: AgentToolSet | undefined) {
  return new Map(Object.entries(tools || {}).flatMap(([name, tool]) => tool.activity ? [[name, tool.activity]] : []))
}

function maybeTraceAgentStream<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(stream: AsyncIterable<StreamEvent>, context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): AsyncIterable<StreamEvent> {
  if (!context.runtimeContext.traceLog) return stream
  const toolNames = new Map<string, string>()
  const toolActivities = agentToolActivities(context.tools)
  const textPhases = new Map<string, AgentMessagePhase | "hidden">()
  const tracer = createAgentStreamEventTracer(toTraceContext(context))
  return (async function* () {
    try {
      for await (const event of stream) {
        const normalized = toAgentStreamEvent(event, toolNames, textPhases, toolActivities)
        if (normalized) await tracer.write(normalized)
        yield event
      }
    }
    finally {
      await tracer.flush()
    }
  })()
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
    for await (const chunk of stream) {
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
        toolResults: [...context.toolResults],
      } satisfies Omit<AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>, "extensions">
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      await createAgentInvocationExtensions(eventBase as never, providers)
      if (chunk && hasRuntimeType(chunk, "object")) {
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
  if (isUIMessageStreamResult(rendered)) {
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
  return isAsyncIterable(rendered)
    ? withEagerStreamUsageExtensions(rendered, context, rendered)
    : rendered
}

function withStreamResultProperties<T extends AsyncIterable<StreamEvent>>(stream: T, result: unknown): T {
  if (!hasRuntimeType(stream, "object") || stream === null || !hasRuntimeType(result, "object") || result === null) return stream
  Object.defineProperties(stream, Object.fromEntries(["usage", "usageRecord"].map(key => [key, {
    configurable: true,
    enumerable: true,
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    get: () => (result as Record<string, unknown>)[key],
  }])))
  return stream
}

function resultWithStreamedText(result: unknown, text: string): unknown {
  if (!text || hasRuntimeType(result, "string")) return result
  if (result && hasRuntimeType(result, "object") && !(result instanceof Response)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, "text")
    const current = descriptor && "value" in descriptor ? descriptor.value : undefined
    if (hasRuntimeType(current, "string") && current) return result
    if (!Object.isExtensible(result)) {
      return { ...toAgentRunResultWithInheritedProperties(result), raw: result, text }
    }
    if (isAsyncIterable(result)) {
      try {
        Object.defineProperty(result, "text", {
          configurable: true,
          enumerable: true,
          value: text,
        })
        return result
      }
      catch {
        return { ...toAgentRunResultWithInheritedProperties(result), raw: result, text }
      }
    }
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

function toAgentRunResultWithInheritedProperties(result: unknown): AgentRunResult {
  if (!result || !hasRuntimeType(result, "object")) return toAgentRunResult(result)
  let normalized: AgentRunResult
  try {
    normalized = toAgentRunResult(result)
  }
  catch {
    normalized = { raw: result }
  }
  for (const key of ["artifacts", "finishReason", "text", "usage", "usageRecord", "warnings"] as const) {
    if (normalized[key] !== undefined) continue
    try {
      if (!Reflect.has(result, key)) continue
      // SAFETY: The key list is limited to writable AgentRunResult properties.
      normalized[key] = Reflect.get(result, key) as never
    }
    catch {
      // Ignore provider getters that cannot be read during result normalization.
    }
  }
  return normalized
}

function resultWithUsageRecord(result: unknown, usageRecord: Extract<StreamEvent, { type: "usage" }>["usageRecord"] | undefined): unknown {
  if (!usageRecord || result instanceof Response) return result
  if (!result || !hasRuntimeType(result, "object")) {
    return {
      raw: result,
      ...(hasRuntimeType(result, "string") && result ? { text: result } : {}),
      usage: usageRecord.usage,
      usageRecord,
    }
  }
  if (Object.isExtensible(result)) {
    try {
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      const record = result as { usage?: unknown, usageRecord?: unknown }
      record.usageRecord ??= usageRecord
      record.usage ??= usageRecord.usage
      return result
    }
    catch {
      // Fall through to a wrapper when an existing property cannot be assigned.
    }
  }
  const normalized = toAgentRunResultWithInheritedProperties(result)
  return {
    ...normalized,
    raw: result,
    usage: normalized.usage ?? usageRecord.usage,
    usageRecord: normalized.usageRecord ?? usageRecord,
  }
}

function resultWithResolvedUsageRecord(result: unknown, usageRecord: AgentUsageRecord | undefined): unknown {
  if (!usageRecord || result instanceof Response) return result
  if (!result || !hasRuntimeType(result, "object")) return resultWithUsageRecord(result, usageRecord)
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

function resultWithPreservedProperties(result: unknown, descriptors: PropertyDescriptorMap): object {
  if (!isRuntimeObject(result)) throw new TypeError("[vitehub] Preserving Agent result properties requires an object result.")
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

function definedObjectProperties(value: unknown): Record<string, unknown> {
  if (!value || !hasRuntimeType(value, "object")) return {}
  try {
    return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value))
      .filter(([, descriptor]) => descriptor.enumerable && "value" in descriptor && descriptor.value !== undefined)
      .map(([key, descriptor]) => [key, descriptor.value]))
  }
  catch {
    return {}
  }
}

function definedObjectPropertiesWithInherited(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const properties = definedObjectProperties(value)
  if (!value || !hasRuntimeType(value, "object")) return properties
  for (const key of keys) {
    if (properties[key] !== undefined) continue
    try {
      if (!Reflect.has(value, key)) continue
      const property = Reflect.get(value, key)
      if (property !== undefined) properties[key] = property
    }
    catch {
      // Ignore provider getters that cannot be read during metadata normalization.
    }
  }
  return properties
}

function normalizedAgentUsage(value: unknown): AgentUsage | undefined {
  if (!value || !hasRuntimeType(value, "object")) return undefined
  try {
    if (hasRuntimeType(Reflect.get(value, "then"), "function")) return undefined
  }
  catch {
    // Ignore provider then getters that cannot be read during usage normalization.
  }
  const usage: Record<string, unknown> = { ...definedObjectProperties(value) }
  for (const key of [
    "completion_token_details",
    "completion_tokens",
    "completionTokenDetails",
    "completionTokens",
    "details",
    "input_token_details",
    "input_tokens",
    "inputTokenDetails",
    "inputTokens",
    "output_token_details",
    "output_tokens",
    "outputTokenDetails",
    "outputTokens",
    "prompt_token_details",
    "prompt_tokens",
    "promptTokenDetails",
    "promptTokens",
    "raw",
    "tokens",
    "total_tokens",
    "totalTokens",
  ] as const) {
    if (usage[key] !== undefined) continue
    try {
      if (!Reflect.has(value, key)) continue
      const property = Reflect.get(value, key)
      if (property !== undefined) usage[key] = property
    }
    catch {
      // Ignore provider getters that cannot be read during usage normalization.
    }
  }
  // SAFETY: The canonical keys above construct the AgentUsage contract while omitting unreadable metadata.
  return usage as AgentUsage
}

function mergedAgentUsageScalars(...values: (AgentUsage | undefined)[]): AgentUsage {
  const usage: AgentUsage = {}
  for (const value of values) {
    if (!value) continue
    for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
      const tokens = value[key]
      if (hasRuntimeType(tokens, "number") && Number.isFinite(tokens)) usage[key] = tokens
    }
    if (value.raw !== undefined) usage.raw = value.raw
  }
  return usage
}

function mergedFiniteNumberObjects(...values: unknown[]): Record<string, number> {
  const merged: Record<string, number> = {}
  for (const value of values) {
    for (const [key, item] of Object.entries(mergedReadableObjects(value))) {
      if (hasRuntimeType(item, "number") && Number.isFinite(item)) merged[key] = item
    }
  }
  return merged
}

function mergedReadableObjects(...values: unknown[]): Record<string, unknown> {
  return Object.assign({}, ...values.map((value) => {
    const properties = definedObjectProperties(value)
    if (!value || !hasRuntimeType(value, "object")) return properties
    let source: object | null = value
    while (source && source !== Object.prototype) {
      let descriptors: PropertyDescriptorMap
      try {
        descriptors = Object.getOwnPropertyDescriptors(source)
      }
      catch {
        descriptors = {}
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "constructor" || properties[key] !== undefined) continue
        if (!("get" in descriptor) && !(descriptor.enumerable && "value" in descriptor)) continue
        try {
          const property = Reflect.get(value, key)
          if (property !== undefined) properties[key] = property
        }
        catch {
          // Ignore provider detail getters that cannot be read during usage normalization.
        }
      }
      try {
        source = Object.getPrototypeOf(source)
      }
      catch {
        source = null
      }
    }
    return properties
  }))
}

function mergedUsageRecords(...values: unknown[]): Record<string, unknown> {
  const keys = ["calls", "cost", "credentialSource", "latency", "model", "raw", "response", "run", "transport", "usage"] as const
  return Object.assign({}, ...values.map(value => definedObjectPropertiesWithInherited(value, keys)))
}

function mergedUsageRecordMetadata(key: "credentialSource" | "latency" | "response" | "run", ...values: unknown[]): Record<string, unknown> {
  const keys = key === "credentialSource"
    ? ["label", "source"]
    : key === "latency"
      ? ["durationMs", "timeToFirstTokenMs", "tokensPerSecond"]
      : key === "response"
        ? ["finishReason", "id", "timestamp"]
        : ["annotations", "channelId", "messageId", "origin", "runId", "threadId"]
  const merged = Object.assign({}, ...values.map(value => definedObjectPropertiesWithInherited(value, keys)))
  if (key === "run") {
    const annotations = values.map(value => definedObjectPropertiesWithInherited(value, ["annotations"]).annotations)
    if (annotations.some(Boolean)) merged.annotations = mergedReadableObjects(...annotations)
  }
  return merged
}

async function resultWithStreamedTextAndUsage(
  result: unknown,
  text: string,
  usageRecord?: Extract<StreamEvent, { type: "usage" }>["usageRecord"],
  fallbackUsageRecord?: Extract<StreamEvent, { type: "usage" }>["usageRecord"],
  resolveUsage = true,
): Promise<unknown> {
  const streamedUsageRecord = usageRecord ?? fallbackUsageRecord
  if (hasRuntimeType(result, "object") && result !== null && (isAsyncIterable(result) || usageRecord !== undefined)) {
    const normalized = toAgentRunResultWithInheritedProperties(result)
    const sourceUsageRecord = definedObjectPropertiesWithInherited(result, ["usageRecord"]).usageRecord
    const sourceUsageRecordProperties = mergedUsageRecords(sourceUsageRecord)
    const fallbackUsageRecordProperties = mergedUsageRecords(fallbackUsageRecord)
    const streamedUsageRecordProperties = mergedUsageRecords(usageRecord)
    const normalizedUsageRecordProperties = mergedUsageRecords(normalized.usageRecord)
    const hasSourceUsageRecord = Object.keys(sourceUsageRecordProperties).length > 0
    const sourceUsage = normalizedAgentUsage(sourceUsageRecordProperties.usage)
    let resolvedUsage = normalized.usage
    if (resolvedUsage === undefined) {
      try {
        if (Reflect.has(result, "totalUsage")) resolvedUsage = Reflect.get(result, "totalUsage")
      }
      catch {
        // Ignore provider totalUsage getters that cannot be read during finalization.
      }
    }
    if (resolveUsage && resolvedUsage && hasRuntimeType(resolvedUsage, "object")) {
      let then: unknown
      try {
        then = Reflect.get(resolvedUsage, "then")
      }
      catch {
        // Keep normalizing readable usage fields when a provider exposes an unreadable then getter.
      }
      if (hasRuntimeType(then, "function")) {
        const pendingUsage = Symbol("pending usage")
        try {
          resolvedUsage = await Promise.race([
            Promise.resolve(resolvedUsage).catch(() => undefined),
            new Promise(resolve => setTimeout(resolve, 0, pendingUsage)),
          ])
          if (resolvedUsage === pendingUsage) resolvedUsage = undefined
        }
        catch {
          // Ignore provider thenables that reject while being observed during finalization.
          resolvedUsage = undefined
        }
      }
    }
    const normalizedUsage = normalizedAgentUsage(resolvedUsage)
    let canonicalUsageRecord: AgentUsageRecord | undefined
    if (normalizedUsage) {
      try {
        const metadataSource = Object.create(result)
        Object.defineProperty(metadataSource, "usage", {
          configurable: true,
          enumerable: true,
          value: normalizedUsage,
        })
        canonicalUsageRecord = await resolveAgentUsageRecord(metadataSource)
      }
      catch {
        canonicalUsageRecord = await resolveAgentUsageRecord({ usage: normalizedUsage })
      }
    }
    const canonicalUsage = canonicalUsageRecord?.usage
    const canonicalResolvedUsage = canonicalUsage
      ? {
          ...canonicalUsage,
          ...(normalizedUsage?.details ? { details: normalizedUsage.details } : {}),
          ...(normalizedUsage?.inputTokenDetails ? { inputTokenDetails: normalizedUsage.inputTokenDetails } : {}),
          ...(normalizedUsage?.outputTokenDetails ? { outputTokenDetails: normalizedUsage.outputTokenDetails } : {}),
          ...(normalizedUsage?.raw !== undefined ? { raw: normalizedUsage.raw } : {}),
        }
      : undefined
    const fallbackUsage = normalizedAgentUsage(fallbackUsageRecordProperties.usage)
    const streamedUsage = normalizedAgentUsage(streamedUsageRecordProperties.usage)
    const normalizedRecordUsage = normalizedAgentUsage(normalizedUsageRecordProperties.usage)
    const usageValues = [fallbackUsage, sourceUsage, normalizedRecordUsage, canonicalResolvedUsage, streamedUsage]
    const inputTokenDetails = mergedFiniteNumberObjects(...usageValues.map(value => value?.inputTokenDetails))
    const outputTokenDetails = mergedFiniteNumberObjects(...usageValues.map(value => value?.outputTokenDetails))
    const mergedUsage = usageValues.some(Boolean)
      ? {
          ...mergedAgentUsageScalars(...usageValues),
          ...(usageValues.some(value => value?.details)
            ? {
                details: {
                  ...mergedReadableObjects(...usageValues.map(value => value?.details)),
                },
              }
            : {}),
          ...(Object.keys(inputTokenDetails).length ? { inputTokenDetails } : {}),
          ...(Object.keys(outputTokenDetails).length ? { outputTokenDetails } : {}),
        }
      : undefined
    const canonicalUsageRecordProperties = mergedUsageRecords(canonicalUsageRecord)
    const usageRecordValues = [fallbackUsageRecordProperties, sourceUsageRecordProperties, normalizedUsageRecordProperties, canonicalUsageRecordProperties, streamedUsageRecordProperties]
    const mergedUsageRecord = mergedUsage || usageRecordValues.some(value => Object.keys(value).length > 0) || hasSourceUsageRecord
      ? {
          ...mergedUsageRecords(...usageRecordValues),
          ...(["credentialSource", "latency", "response", "run"] as const).reduce<Record<string, unknown>>((properties, key) => {
            const values = usageRecordValues.map(value => value[key])
            if (values.some(Boolean)) {
              properties[key] = mergedUsageRecordMetadata(key, ...values)
            }
            return properties
          }, {}),
          ...(mergedUsage ? { usage: mergedUsage } : {}),
        }
      : undefined
    const normalizedWithoutUsage = { ...normalized }
    delete normalizedWithoutUsage.usage
    const finishResult = {
      ...normalizedWithoutUsage,
      raw: result,
      ...(text ? { text: normalized.text || text } : {}),
      ...(mergedUsage ? { usage: mergedUsage } : {}),
      ...(mergedUsageRecord ? { usageRecord: mergedUsageRecord } : {}),
    }
    if (isAsyncIterable(result)) {
      Object.defineProperty(finishResult, Symbol.asyncIterator, {
        configurable: true,
        value: () => result[Symbol.asyncIterator](),
      })
    }
    return finishResult
  }
  return resultWithUsageRecord(resultWithStreamedText(result, text), streamedUsageRecord)
}

function withStreamedResult(
  stream: AsyncIterable<unknown>,
  result: unknown,
  fallbackUsageRecord?: Extract<StreamEvent, { type: "usage" }>["usageRecord"],
  toolResults?: AgentToolStepItem[],
  tools?: AgentToolSet,
) {
  const toolNames = new Map<string, string>()
  const toolActivities = agentToolActivities(tools)
  const textPhases = new Map<string, AgentMessagePhase | "hidden">()
  let explicitTextPhaseSeen = false
  let finalText = ""
  let unphasedText = ""
  let usageRecord: Extract<StreamEvent, { type: "usage" }>["usageRecord"] | undefined
  let finalizedUsageRecord: AgentUsageRecord | undefined
  return {
    async finishResult(resultOverride: unknown = result, resolveUsage = true) {
      const finishResult = await resultWithStreamedTextAndUsage(resultOverride, explicitTextPhaseSeen ? finalText : unphasedText, usageRecord, fallbackUsageRecord, resolveUsage)
      finalizedUsageRecord = finishResult && hasRuntimeType(finishResult, "object")
        ? toAgentRunResult(finishResult).usageRecord
        : undefined
      return finishResult
    },
    finishUsage() {
      return finalizedUsageRecord
    },
    stream: (async function* () {
      for await (const chunk of stream) {
        const event = toAgentStreamEvent(chunk, toolNames, textPhases, toolActivities)
        if (toolResults && event?.type === "tool-result" && !event.error) {
          appendAgentToolResult(toolResults, {
            output: event.output,
            toolCallId: event.id,
            toolName: event.name,
          })
        }
        const explicitlyPhasedTextChunk = chunk && hasRuntimeType(chunk, "object")
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          && "phase" in chunk && (chunk as { phase?: unknown }).phase !== undefined
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          && "type" in chunk && ["text", "text-delta", "text-end", "text-start"].includes(String((chunk as { type?: unknown }).type))
        if (explicitlyPhasedTextChunk || (event?.type === "text-delta" && event.phase !== undefined)) {
          explicitTextPhaseSeen = true
          unphasedText = ""
        }
        if (event?.type === "text-delta" && event.text) {
          if (event.phase === "final") finalText += event.text
          else if (!explicitTextPhaseSeen && event.phase === undefined) unphasedText += event.text
        }
        const attachedUsageRecord = chunk && hasRuntimeType(chunk, "object") && "usageRecord" in chunk
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
    const usageRecord = outcome.usageResolved
      ? outcome.usage && await resolveAgentUsageRecord({ usageRecord: outcome.usage }, context.run)
      : await resolveFinishUsageRecord(context, result)
    finishUsage = usageRecord
    const resolvedResult = resultWithResolvedUsageRecord(result, usageRecord)
    if (usageRecord && resolvedResult !== result && result && hasRuntimeType(result, "object") && Object.isExtensible(result)) {
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
      ? await validateAgentOutput(context.output, await materializeAgentStructuredOutput(finishResult, context.input.abortSignal, undefined, context.output), { allowMaterializedObject: finishResult !== result })
      : resultWithUsageRecord(finishResult, usageRecord)
  }
  catch (finishError) {
    await lifecycle.fail({ error: finishError, status: "error" }, finishError, failureMessage)
  }
  await lifecycle.finish({
    result: finishResult,
    status: "success",
    usage: finishUsage,
    ...(outcome.usageResolved ? { usageResolved: true } : {}),
  })
}

function traceUiMessageStream<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(stream: ReadableStream<unknown>, context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): ReadableStream<unknown> {
  const reader = stream.getReader()
  const toolNames = new Map<string, string>()
  const toolActivities = agentToolActivities(context.tools)
  const textPhases = new Map<string, AgentMessagePhase | "hidden">()
  const tracer = createAgentStreamEventTracer(toTraceContext(context))
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
          if (!finished) await tracer.write({ type: "finish" })
          await tracer.flush()
          release()
          controller.close()
          return
        }
        const event = toAgentStreamEvent(result.value, toolNames, textPhases, toolActivities)
        if (event) {
          if (event.type === "finish") finished = true
          await tracer.write(event)
        }
        controller.enqueue(result.value)
      }
      catch (error) {
        await tracer.flush()
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      }
      finally {
        await tracer.flush()
        release()
      }
    },
  })
}

function maybeTraceUiMessageStreamResult<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(rendered: { toUIMessageStream: () => ReadableStream<unknown> }, context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>) {
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    if (isAsyncIterable(rendered)) return maybeTraceAgentStream(rendered as AsyncIterable<StreamEvent>, context)
    if (!hasTraceableStreamResult(rendered)) return rendered
    return maybeTraceAgentStream(streamAgentOutputToEvents(rendered), context)
  }
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
  return Boolean(workspace && hasRuntimeType(workspace, "object") && "diff" in workspace && "snapshot" in workspace)
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
  const { isWorkspaceConflict, resolveWorkspaceAutoCommit } = await import("@vite-hub/workspace")
  const commit = resolveWorkspaceAutoCommit(
    workspaceDefinitionWithAutoCommitRules(context.workspaceDefinition, context.workspaceAutoCommit),
    diff,
  )
  if (!commit) return
  for (let attempt = 0; ; attempt++) {
    try {
      await context.workspace.snapshot({ name: commit.message })
      return
    }
    catch (error) {
      if (!isWorkspaceConflict(error) || attempt >= 2) throw error
      await context.workspace.history.rebase()
    }
  }
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
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  if (!value || !hasRuntimeType(value, "object") || !hasRuntimeType((value as { kind?: unknown }).kind, "string") || !(value as { kind: string }).kind.trim()) {
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
    const intent = hasRuntimeType(provider, "function") ? await provider(finishContext, event) : provider
    if (!intent) continue
    appendDeliveryEffectIntent(intents, intent)
  }
  return intents
}

interface DurableFailureDeadline {
  expiresAt: number
  timeout: number
}

function createDurableFailureDeadline(timeout: number): DurableFailureDeadline {
  return { expiresAt: Date.now() + timeout, timeout }
}

function durableFailureTimeoutError(timeout: number): Error & { isRetryable: false } {
  return Object.assign(
    new Error(`Durable chat error fallback delivery timed out after ${timeout}ms.`),
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    { isRetryable: false as const },
  )
}

async function runWithinDurableFailureDeadline<T>(
  deadline: DurableFailureDeadline,
  operation: (abortSignal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const abortSignal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal
  const task = operation(abortSignal)
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          const error = durableFailureTimeoutError(deadline.timeout)
          controller.abort(error)
          reject(error)
        }, Math.max(0, deadline.expiresAt - Date.now()))
      }),
    ])
  }
  finally {
    if (timeoutId) clearTimeout(timeoutId)
    void task.catch(() => undefined)
  }
}

async function applyDurableFailureDeliveryEffects<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  providers: readonly AgentChannelDeliveryFinishEffect[],
  event: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>,
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  deadline: DurableFailureDeadline,
): Promise<void> {
  const fallbackProviders = providers.filter(isDurableChatErrorFallbackEffect)
  const otherProviders = providers.filter(provider => !isDurableChatErrorFallbackEffect(provider))
  await runWithinDurableFailureDeadline(deadline, async (abortSignal) => {
    const deliveryContext = { ...context, input: { ...context.input, abortSignal } }
    for (const group of [fallbackProviders, otherProviders]) {
      const intents = await resolveFinishDeliveryEffectIntents(group, event, deliveryContext)
      for (const intent of intents) await applyChannelDeliveryEffectIntents(deliveryContext, [intent], event)
    }
  }, context.input.abortSignal)
}

async function resolveDurableFailureFinishExtensions<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  event: Omit<AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>, "extensions">,
  providers: ResolvedAgentFinishExtensionProvider[],
  deadline: DurableFailureDeadline,
): Promise<AgentFinishExtensions> {
  return await runWithinDurableFailureDeadline(
    deadline,
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    async () => await createAgentInvocationExtensions(event as never, providers),
  )
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
    const inputArtifacts = hasRuntimeType(input, "object") && input !== null && "artifacts" in input
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
    publicError: toAgentPublicError(errorEvent.error, "http"),
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
    if (!hasRuntimeType(provider, "function") || !provider.active) return true
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
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  return {
    ...eventBase,
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    extensions: asUnknownBoundary({ get: () => undefined }) as AgentFinishExtensions,
  } as AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>
}

function hasTitleDeliveryEffectProvider(providers: readonly AgentChannelDeliveryFinishEffect[]): boolean {
  return providers.some((provider) => {
    if (hasRuntimeType(provider, "function")) return provider.kind === "title"
    const effects = Array.isArray(provider) ? provider : [provider]
    return effects.some(effect => effect.kind === "title")
  })
}

function hasDeferredFinishDeliveryEffectProvider(providers: readonly AgentChannelDeliveryFinishEffect[]): boolean {
  return providers.some(provider => hasRuntimeType(provider, "function") && (provider.kind === undefined || Boolean(provider.active)))
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
  let failed = outcome.status === "error"
  let error = outcome.status === "error" ? outcome.error : undefined
  let result = outcome.status === "success" ? outcome.result : undefined
  let usage = outcome.status === "success" ? outcome.usage : undefined
  const usageResolved = outcome.status === "success" && outcome.usageResolved
  let runResult = failed || result === undefined ? undefined : toAgentRunResult(result)
  let text = runResult?.text
  let closeError: unknown
  try {
    await context.startTask
    try {
      await context.close()
    }
    catch (cleanupError) {
      closeError = cleanupError
      if (!failed) {
        failed = true
        result = undefined
        runResult = undefined
        text = undefined
        error = cleanupError
      }
    }
    let resultKind: string | undefined
    if (failed) usage = undefined
    if (!failed) {
      try {
        resultKind = agentResultKind(result)
        if (!usageResolved) usage ??= await resolveAgentUsageRecord(result, context.run)
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
        toolResults: [...context.toolResults],
      } satisfies Omit<AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>, "extensions">
      const provisionalEvent = provisionalFinishEvent(context, eventBase)
      const provisionallyActiveDeliveryProviders = activeFinishDeliveryEffectProviders(context, provisionalEvent)
      const hasDurableFailureDelivery = failed
        && context.durableErrorFallbackTimeout !== undefined
        && provisionallyActiveDeliveryProviders.some(isDurableChatErrorFallbackEffect)
      const durableFailureDeadline = hasDurableFailureDelivery
        ? createDurableFailureDeadline(context.durableErrorFallbackTimeout!)
        : undefined
      const provisionalActiveDeliveryProviders = hasDurableFailureDelivery
        ? provisionallyActiveDeliveryProviders
        : await prepareProvisionalTitleDeliverySupport(context, eventBase)
      const cleanupOnlyFailure = outcome.status === "success" && closeError !== undefined
      const outcomeHook = failed
        ? cleanupOnlyFailure ? undefined : context.errorHook
        : context.finishHook
      const hookName = failed ? "agent:error" : "agent:finish"
      const hasOutcomeConsumer = Boolean(outcomeHook || provisionalActiveDeliveryProviders.length || hasDeferredFinishDeliveryEffectProvider(context.finishDeliveryEffectProviders))
      const finishExtensionProviders = hasOutcomeConsumer
        ? context.finishExtensionProviders
        : context.finishExtensionProviders.filter(provider => provider.eager)
      if (hasOutcomeConsumer || finishExtensionProviders.length) {
        if (hasDurableFailureDelivery) {
          const fallbackEvent = provisionalFinishEvent(context, eventBase)
          const fallbackProviders = activeFinishDeliveryEffectProviders(context, fallbackEvent)
            .filter(isDurableChatErrorFallbackEffect)
          await applyDurableFailureDeliveryEffects(fallbackProviders, fallbackEvent, context, durableFailureDeadline!)
        }
        const extensions = hasDurableFailureDelivery
          ? await resolveDurableFailureFinishExtensions(eventBase, finishExtensionProviders, durableFailureDeadline!)
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          : await createAgentInvocationExtensions(eventBase as never, finishExtensionProviders)
        const finishEvent = { ...eventBase, extensions }
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        const activeDeliveryProviders = activeFinishDeliveryEffectProviders(context, finishEvent as never)
          .filter(provider => !hasDurableFailureDelivery || !isDurableChatErrorFallbackEffect(provider))
        if (hasDurableFailureDelivery) {
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          await applyDurableFailureDeliveryEffects(activeDeliveryProviders, finishEvent as never, context, durableFailureDeadline!)
        }
        else {
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          const finishIntents = await resolveFinishDeliveryEffectIntents(activeDeliveryProviders, finishEvent as never, context)
          for (const intent of finishIntents) {
            // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
            await applyChannelDeliveryEffectIntents(context, [intent], finishEvent as never)
          }
        }
        const runOutcomeHook = async (hookContext: typeof context) => {
          const hookFinishEvent = { ...finishEvent, input: hookContext.input }
          let outcomeHookResult: void | AgentChannelDeliveryFinishEffectResult
          await runObservedAgentHook(context.hooks, {
            ids: { runId: context.run?.runId },
            name: hookName,
            owner: "agent",
            phase: failed ? "error" : "finish",
          }, async () => {
            outcomeHookResult = failed
              // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
              ? await outcomeHook?.(createAgentErrorHookEvent(hookFinishEvent, hookContext) as never)
              // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
              : await outcomeHook?.(createAgentFinishHookEvent(hookFinishEvent, hookContext) as never)
          })
          if (outcomeHookResult && !hookContext.input.abortSignal?.aborted) {
            const outcomeHookIntents: AgentChannelDeliveryEffectIntent[] = []
            appendDeliveryEffectIntent(outcomeHookIntents, outcomeHookResult)
            await applyChannelDeliveryEffectIntents(hookContext, outcomeHookIntents, hookFinishEvent)
          }
        }
        if (durableFailureDeadline) {
          await runWithinDurableFailureDeadline(durableFailureDeadline, async (abortSignal) => {
            await runOutcomeHook({ ...context, input: { ...context.input, abortSignal } })
          }, context.input.abortSignal)
        }
        else {
          await runOutcomeHook(context)
        }
      }
    }
    if (!failed) await commitWorkspaceChanges(context)
    if (!failed) {
      await traceAgentInvocationFinish(toTraceContext(context), {
        "invocation.durationMs": durationMs,
        "result.hasValue": result !== undefined,
        "result.text": text,
        ...(resultKind !== undefined ? { "result.kind": resultKind } : {}),
        ...(usage ? { "usage.record": usage } : {}),
      })
    }
    else {
      await traceAgentInvocationError(toTraceContext(context), error)
    }
    await context.invocationJournal?.finish(
      failed && context.input.abortSignal?.aborted ? "cancelled" : failed ? "failed" : "completed",
      error,
    )
    if (closeError !== undefined) throw closeError
  }
  catch (finishError) {
    await traceAgentInvocationError(toTraceContext(context), failed ? error : finishError)
    await context.invocationJournal?.finish(
      failed && context.input.abortSignal?.aborted ? "cancelled" : "failed",
      failed ? error : finishError,
    )
    if (closeError !== undefined && finishError !== closeError) {
      throw new AggregateError([closeError, finishError], "[vitehub] Capability cleanup and Agent finish lifecycle both failed.")
    }
    throw finishError
  }
  finally {
    context.telemetryScheduler.finish()
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
    fallbackUsageRecord?: AgentUsageRecord
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
      const responseDecoder = context.context.get(responseTitleFallbackContextKey) === true && responseIsText
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
        const streamed = withStreamedResult(stream, result, options.fallbackUsageRecord, context.toolResults, context.tools)
        if (!context.finalOutputRenderers.length && (!context.output || !options.finalizeRawStreams)) {
          const value = withCapabilityCleanup(streamed.stream, async (outcome) => {
            const finishResult = await streamed.finishResult(result, !outcome.failed && outcome.completed === true)
            const finishOutcome = finishOutcomeFromCleanup(outcome, finishResult)
            const usage = streamed.finishUsage()
            if (!outcome.failed && !outcome.completed) {
              return lifecycle.finish({
                result: finishResult,
                status: "success",
                ...(usage ? { usage: await resolveAgentUsageRecord({ usageRecord: usage }, context.run) } : {}),
                usageResolved: true,
              })
            }
            return lifecycle.finish(finishOutcome.status === "success"
              ? {
                  ...finishOutcome,
                  usage: usage ? await resolveAgentUsageRecord({ usageRecord: usage }, context.run) : undefined,
                  usageResolved: true,
                }
              : finishOutcome)
          }, {
            abortSignal: context.input.abortSignal,
            cancelOnAbort: source.cancel,
          })
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          return hasRuntimeType((result as ReadableStream<unknown>).getReader, "function")
            ? toReadableAsyncIterableStream(value)
            : value
        }
        const value = withCapabilityCleanup(streamed.stream, async (outcome) => {
          const finishResult = await streamed.finishResult(result, !outcome.failed && outcome.completed === true)
          const finishOutcome = finishOutcomeFromCleanup(outcome, finishResult)
          return finishStreamAgentInvocation(context, lifecycle, finishResult, finishOutcome.status === "success"
            ? { ...finishOutcome, usage: streamed.finishUsage(), usageResolved: true }
            : finishOutcome, failureMessage, options.outputExtensions)
        }, {
          abortSignal: context.input.abortSignal,
          cancelOnAbort: source.cancel,
        })
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        return hasRuntimeType((result as ReadableStream<unknown>).getReader, "function")
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
  output?: AgentOutputDefinition,
): Promise<unknown> {
  let streamResult = result
  const streamSources = new Map<AsyncIterable<unknown>, ReturnType<typeof cancellableAsyncIterableSource>>()
  if (!isAsyncIterable(streamResult)) {
    if (!streamResult || !hasRuntimeType(streamResult, "object")) return result
    const descriptors: PropertyDescriptorMap = {}
    let hasStream = false
    try {
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
    if (event.type === "error") {
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      const streamError = (event as typeof event & { [agentStreamErrorSymbol]?: Error & { text?: unknown } })[agentStreamErrorSymbol]
      const rejectedText = hasRuntimeType(streamError?.text, "string") ? streamError.text : text
      if (output && rejectedText !== undefined && streamError?.name === "AI_NoObjectGeneratedError") await validateAgentOutput(output, rejectedText)
      throw streamError ?? new Error(event.error)
    }
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

async function finishPreparedInvocationFailure<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  preparedInvocation: AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS>,
  error: unknown,
  waitForFinish: boolean,
): Promise<void> {
  const finishTask = finishAgentInvocation(preparedInvocation, { error, status: "error" })
  if (!waitForFinish) {
    registerAgentBackgroundTask(preparedInvocation.runtimeContext, finishTask)
    return
  }
  try {
    await finishTask
  }
  catch (finishError) {
    throw new AggregateError([error, finishError], "[vitehub] Agent capacity acquisition and finish lifecycle both failed.")
  }
}

async function deliverUnpreparedWorkflowFailure<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  error: unknown,
): Promise<void> {
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  if (!(context as AgentRuntimeContext & { [agentWorkflowExecutionContextKey]?: boolean })[agentWorkflowExecutionContextKey]) return
  const options = getChatCapabilityOptions(definition?.capabilities || [])
  if (!options) return
  const invocationContext = createAgentInvocationContextStore(input.context)
  const chat = getAgentChatContext(invocationContext)
  const channel = invocationContext.get("channel")
  if (!chat && !channel) return
  const invoker = createFallbackAgentInvoker(context.run)
  const timeout = durableChatErrorFallbackTimeout(options)
  const deadline = createDurableFailureDeadline(timeout)
  await runWithinDurableFailureDeadline(deadline, async (abortSignal) => {
    const intents = await resolveDurableChatErrorFallbackIntents(options, {
      error,
      history: input.messages || [],
      message: chat?.message || channel?.message || { text: "" },
      publicError: toAgentPublicError(error, "http"),
      run: context.run,
      toolResults: [],
    }, async resolution => await resolution)
    if (abortSignal.aborted || !intents.length) return
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    await applyChannelDeliveryEffectIntents({
      actor: invoker,
      channels: definition?.channels,
      context: invocationContext,
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      hooks: definition?.hooks as AgentHookObserverHooks | undefined,
      input: { ...input, abortSignal },
      invoker,
      run: context.run,
      runtimeContext: createResolvedRuntimeContext(context),
    } as never, intents)
  }, input.abortSignal)
}

async function createAgentInvocationContextWithWorkflowFailureDelivery<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  kind: "run" | "stream",
  invocationJournal?: AgentInvocationJournal<TRuntimeConfig>,
): Promise<AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS>> {
  try {
    return await createAgentInvocationContext(definition, context, input, kind, invocationJournal)
  }
  catch (error) {
    try {
      await deliverUnpreparedWorkflowFailure(definition, context, input, error)
    }
    catch (deliveryError) {
      throw new AggregateError([error, deliveryError], "[vitehub] Agent setup failed and Workflow fallback delivery also failed.")
    }
    throw error
  }
}

async function executeAgentInvocationWithCapacityLease<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOutput,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput, CALL_OPTIONS>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: AgentInvocationExecutionOptions,
  preparedInvocation?: AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS>,
  invocationJournal?: AgentInvocationJournal<TRuntimeConfig>,
): Promise<Response | AsyncIterable<StreamEvent> | unknown> {
  const customRun = hasCustomRun<TRuntimeConfig, CALL_OPTIONS>(agent)
  const definition = hasAgentDefinition(agent)
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    ? asUnknownBoundary(agent) as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, any, any, TOutput>
    : undefined
  const invocation = preparedInvocation
    ?? await createAgentInvocationContextWithWorkflowFailureDelivery(definition, context, input, options.kind, invocationJournal)
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
  let adapter: AgentAdapter<CALL_OPTIONS> | undefined
  try {
    adapter = customRun ? undefined : await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(agent, invocation.runtimeContext)
  }
  catch (error) {
    return await lifecycle.fail({ error, status: "error" }, error, executionFailureMessage)
  }
  let result: unknown
  try {
    const adapterContext = toAgentAdapterRunContext(invocation)
    if (options.kind === "run" && !options.renderOutput) adapterContext.nativeStructuredOutput = false
    if (customRun) {
      result = await agent.run(invocation)
    }
    else if (options.kind === "stream"
      && adapter?.stream
      && (
        invocation.context.get(finalChannelOutputContextKey) !== true
        || invocation.context.get(progressSummaryOutputContextKey) === true
      )) {
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      result = await adapter.stream(adapterContext as never)
    }
    else {
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      result = await adapter!.generate(adapterContext as never)
    }
  }
  catch (error) {
    return await lifecycle.fail({ error, status: "error" }, error, executionFailureMessage)
  }

  if (options.kind === "run"
    && invocation.context.get(finalChannelOutputContextKey) === true
    && !isAsyncIterable(result)
    && !hasTraceableStreamResult(result)) {
    const text = finalTextFromAgentOutput(result)
    if (text !== undefined && !(result instanceof Response)) {
      const synthesizedRaw = hasRuntimeType(result, "object") && result !== null
        && Object.getOwnPropertyDescriptor(result, synthesizedAgentOutputSymbol)?.value === true
        ? Object.getOwnPropertyDescriptor(result, "raw")?.value
        : undefined
      result = { raw: synthesizedRaw ?? result, text }
      Object.defineProperty(result, finalChannelOutputSelectedSymbol, { enumerable: true, value: true })
    }
  }

  const outputExtensions = new Map<string, unknown>()
  const rawDriverUsageObserved = isAsyncIterable(result)
  const rawDriverUsageRecord = rawDriverUsageObserved
    ? toAgentRunResult(await resultWithStreamedTextAndUsage(result, "")).usageRecord
    : undefined
  let renderedResult = false
  let rendererSource: ReturnType<typeof cancellableAsyncIterableSource> | undefined
  try {
    const shouldRenderStream = options.kind === "run"
      ? customRun && options.renderOutput && isAsyncIterable(result)
      : isAsyncIterable(result) && options.output !== "ui-message-stream" && !invocation.finalOutputRenderers.length
    if (shouldRenderStream) {
      rendererSource = shouldHoldInvocationOutput() && invocation.outputRenderers.length
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
      const driverUsageRecord = rawDriverUsageObserved ? rawDriverUsageRecord : (hasTraceableStreamResult(result) || isUIMessageStreamResult(result)
        ? undefined
        : await resolveFinishUsageRecord(invocation, result)
      )
      const rendered = options.renderOutput
        ? renderedResult ? result : await applyOutputRenderers(result, invocation.outputRenderers, invocation.outputExtensionProviders, outputExtensions)
        : result
      const shouldPreserveStreamResult = (hasTraceableStreamResult(rendered) || isUIMessageStreamResult(rendered))
        && !(options.renderOutput && invocation.output)
        && (options.holdCapacity === true || invocation.finishExtensionProviders.some(provider => provider.eager))
        && shouldHoldInvocationOutput()
      if (shouldPreserveStreamResult || (options.renderOutput
        && !invocation.output
        && invocation.context.get(responseTitleFallbackContextKey) === true
        && rendered !== result
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        && (isAsyncIterable((rendered as { stream?: unknown }).stream)
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          || isAsyncIterable((rendered as { fullStream?: unknown }).fullStream)
          || isUIMessageStreamResult(rendered))
        && shouldHoldInvocationOutput())) {
        let textStreamDescriptor: PropertyDescriptor | undefined
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        for (let owner: object | null = rendered as object; owner && !textStreamDescriptor; owner = Object.getPrototypeOf(owner))
          textStreamDescriptor = Object.getOwnPropertyDescriptor(owner, "textStream")
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        const hasPrimaryStreamProperty = (["stream", "fullStream"] as const).some((property) => {
          let descriptor: PropertyDescriptor | undefined
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          for (let owner: object | null = rendered as object; owner && !descriptor; owner = Object.getPrototypeOf(owner))
            descriptor = Object.getOwnPropertyDescriptor(owner, property)
          return descriptor !== undefined && ("get" in descriptor || isAsyncIterable(descriptor.value))
        })
        if (isUIMessageStreamResult(rendered)
          && !hasPrimaryStreamProperty
          && !textStreamDescriptor) {
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          const toUIMessageStream = rendered.toUIMessageStream as (...args: unknown[]) => ReadableStream<unknown>
          let finishTask: Promise<void> | undefined
          let streamedText = ""
          let streamedUsageRecord: Extract<StreamEvent, { type: "usage" }>["usageRecord"] | undefined
          const collectToolResult = agentToolResultStreamCollector(invocation.toolResults)
          let preserved: object
          let uiMessageStreamCreated = false
          const finishPreserved = async (outcome: CapabilityCleanupOutcome) => {
            invocation.input.abortSignal?.removeEventListener("abort", onAbort)
            if (finishTask) return await finishTask
            const finishResult = await resultWithStreamedTextAndUsage(preserved, streamedText, streamedUsageRecord, driverUsageRecord, !outcome.failed && outcome.completed === true)
            finishTask = (async () => {
              const finishUsageRecord = finishResult && hasRuntimeType(finishResult, "object")
                // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
                ? (finishResult as { usageRecord?: AgentUsageRecord }).usageRecord
                : undefined
              if (!outcome.failed && !outcome.completed) {
                await lifecycle.finish({
                  result: finishResult,
                  status: "success",
                  ...(finishUsageRecord
                    ? { usage: await resolveAgentUsageRecord({ usageRecord: finishUsageRecord }, invocation.run) }
                    : {}),
                  usageResolved: true,
                })
              }
              else {
                await finishStreamAgentInvocation(invocation, lifecycle, finishResult, finishOutcomeFromCleanup(outcome), runFailureMessage, outputExtensions)
              }
              if (finishUsageRecord) resultWithUsageRecord(preserved, finishUsageRecord)
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
                  source = cancellableAsyncIterableSource(toUIMessageStream.apply(rendered, args))
                  const normalizedStream = normalizeUiMessageStream(toReadableAsyncIterableStream(source.stream))
                  const enrichedStream = withEagerStreamUsageExtensions(
                    toReadableAsyncIterableStream(normalizedStream),
                    invocation,
                    rendered,
                  )
                  const renderedStream = invocation.runtimeContext.traceLog
                    ? traceUiMessageStream(toReadableAsyncIterableStream(enrichedStream), invocation)
                    : enrichedStream
                  return withReadableStreamCleanup(
                    toReadableAsyncIterableStream(renderedStream),
                    finishPreserved,
                    {
                      abortSignal: invocation.input.abortSignal,
                      cancelOnAbort: source.cancel,
                      onChunk(chunk) {
                        collectToolResult(chunk)
                        streamedText += uiMessageTextDelta(chunk) || ""
                        streamedUsageRecord = usageRecordFromStreamChunk(chunk, rendered) ?? streamedUsageRecord
                      },
                    },
                  )
                }
                catch (error) {
                  void finishPreserved({ error, failed: true }).catch(() => {})
                  throw error
                }
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
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          for (const property of ["stream", "fullStream"] as const) {
            let descriptor: PropertyDescriptor | undefined
            // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
          const streamed = withStreamedResult(enrichedStream, rendered, driverUsageRecord, invocation.toolResults, invocation.tools)
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          const tracedStream = maybeTraceAgentStream(streamed.stream as AsyncIterable<StreamEvent>, invocation)
          const value = withCapabilityCleanup(tracedStream, async (outcome) => {
            invocation.input.abortSignal?.removeEventListener("abort", onAbort)
            finishing = true
            const finalOutcome = await cancelPreservedSources(outcome)
            if (finishTask) return await finishTask
            const finishResult = await streamed.finishResult(preserved, !finalOutcome.failed && finalOutcome.completed === true)
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
                const usageRecord = finishResult && hasRuntimeType(finishResult, "object")
                  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
                  ? (finishResult as { usageRecord?: AgentUsageRecord }).usageRecord
                  : undefined
                if (usageRecord) resultWithUsageRecord(preserved, usageRecord)
              }
            })()
            return await finishTask
          }, { abortSignal: invocation.input.abortSignal, cancelOnAbort: source.cancel })
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          const preservedStream = hasRuntimeType((renderedStream as ReadableStream<unknown>).pipeThrough, "function")
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
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
                const existingSource = preservedSources.get(renderedStream)
                const existingStream = preservedStreams.get(renderedStream)
                const normalizedStream = normalizeUiMessageStream(
                  toReadableAsyncIterableStream(existingStream ?? existingSource?.stream ?? renderedStream),
                )
                const enrichedStream = existingStream
                  ? normalizedStream
                  : withEagerStreamUsageExtensions(normalizedStream, invocation, rendered)
                const streamed = existingStream
                  ? undefined
                  : withStreamedResult(enrichedStream, rendered, driverUsageRecord, invocation.toolResults, invocation.tools)
                const tracedStream = existingStream
                  ? enrichedStream
                  : invocation.runtimeContext.traceLog
                  ? traceUiMessageStream(toReadableAsyncIterableStream(streamed!.stream), invocation)
                  : streamed!.stream
                const source = existingSource
                  ? { cancel: existingSource.cancel, stream: tracedStream }
                  : cancellableAsyncIterableSource(tracedStream)
                if (!existingSource) preservedSources.set(renderedStream, source)
                const stream = withReadableStreamCleanup(
                  toReadableAsyncIterableStream(source.stream),
                  async (outcome) => {
                    finishing = true
                    const finalOutcome = await cancelPreservedSources(outcome)
                    if (finishTask) return await finishTask
                    let finishResult = streamed ? await streamed.finishResult(preserved, !finalOutcome.failed && finalOutcome.completed === true) : preserved
                    if (finishResult !== preserved && Object.isExtensible(preserved)) {
                      const collectedDescriptors: PropertyDescriptorMap = {}
                      for (const key of ["text", "usage", "usageRecord"]) {
                        const descriptor = Object.getOwnPropertyDescriptor(finishResult, key)
                        if (descriptor) collectedDescriptors[key] = descriptor
                      }
                      Object.defineProperties(preserved, collectedDescriptors)
                      finishResult = preserved
                    }
                    finishTask = !finalOutcome.failed && !finalOutcome.completed
                      ? lifecycle.finish({
                          result: finishResult,
                          status: "success",
                          ...(streamed?.finishUsage()
                            ? { usage: await resolveAgentUsageRecord({ usageRecord: streamed.finishUsage() }, invocation.run) }
                            : {}),
                          usageResolved: true,
                        })
                      : finishStreamAgentInvocation(invocation, lifecycle, finishResult, finishOutcomeFromCleanup(finalOutcome), runFailureMessage, outputExtensions)
                    return await finishTask
                  },
                  { abortSignal: invocation.input.abortSignal, cancelOnAbort: source.cancel },
                )
                if (!existingStream) preservedStreams.set(renderedStream, stream)
                return stream
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
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
            invocation.context.get(agentOutputEventObserverContextKey),
            invocation.output,
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
      fallbackUsageRecord: rawDriverUsageRecord,
      ...(customRun
        ? {
            // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
            wrapStream: (stream: AsyncIterable<unknown>) => maybeTraceAgentStream(stream as AsyncIterable<StreamEvent>, invocation),
          }
        : {}),
    })
  }

  return await finalizeAgentInvocationResult(invocation, lifecycle, result, async (result) => {
    const driverUsageRecord = rawDriverUsageObserved ? rawDriverUsageRecord : (hasTraceableStreamResult(result) || isUIMessageStreamResult(result)
        ? undefined
        : await resolveFinishUsageRecord(invocation, result))
    const rendered = renderedResult ? result : await applyOutputRenderers(result, invocation.outputRenderers, invocation.outputExtensionProviders, outputExtensions)
    if (options.output === "ui-message-stream") {
      const projection = hasRuntimeType(definition?.uiMessageStream, "function")
        ? await definition.uiMessageStream(invocation)
        : definition?.uiMessageStream
      let uiMessageSource: ReturnType<typeof cancellableAsyncIterableSource> | undefined
      const uiMessageSources = new Map<AsyncIterable<unknown>, ReturnType<typeof cancellableAsyncIterableSource>>()
      let capacityRendered = rendered
      if (options.holdCapacity === true) {
        if (isUIMessageStreamResult(rendered)) {
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          const toUIMessageStream = rendered.toUIMessageStream as (...args: unknown[]) => ReadableStream<unknown>
          try {
            // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
      const enrichedRendered = isUIMessageStreamResult(capacityRendered)
        ? withEagerUiMessageStreamUsageExtensions(capacityRendered, invocation)
        : isAsyncIterable(capacityRendered)
          ? withEagerStreamUsageExtensions(capacityRendered, invocation, rendered)
          : capacityRendered
      const shouldWrapOutput = shouldHoldInvocationOutput()
      const collectToolResult = shouldWrapOutput ? agentToolResultStreamCollector(invocation.toolResults) : undefined
      return finalizeUiMessageStreamOutput(maybeTraceUiMessageStreamOutput(enrichedRendered, invocation), shouldWrapOutput, async (outcome, streamedText, streamedUsageRecord) => {
        const cancellations = await Promise.allSettled([...uiMessageSources.values()].map(({ cancel }) => cancel(outcome.failed ? outcome.error : undefined)))
        const rejected = cancellations.find((result): result is PromiseRejectedResult => result.status === "rejected")
        if (rejected) outcome = { error: rejected.reason, failed: true }
        const finishResult = await resultWithStreamedTextAndUsage(rendered, streamedText || "", streamedUsageRecord, driverUsageRecord, !outcome.failed && outcome.completed === true)
        if (!outcome.failed && !outcome.completed) {
          const usage = finishResult && hasRuntimeType(finishResult, "object")
            ? toAgentRunResult(finishResult).usageRecord
            : undefined
          await lifecycle.finish({
            result: finishResult,
            status: "success",
            ...(usage
              ? { usage: await resolveAgentUsageRecord({ usageRecord: usage }, invocation.run) }
              : {}),
            usageResolved: true,
          })
        }
        else {
          const finishOutcome = finishOutcomeFromCleanup(outcome)
          const usage = finishResult && hasRuntimeType(finishResult, "object")
            ? toAgentRunResult(finishResult).usageRecord
            : undefined
          await finishStreamAgentInvocation(invocation, lifecycle, finishResult, finishOutcome.status === "success"
            ? { ...finishOutcome, usage, usageResolved: true }
            : finishOutcome, streamFailureMessage, outputExtensions)
        }
      }, {
        abortSignal: invocation.input.abortSignal,
        cancelOnAbort: options.holdCapacity === true
          ? async reason => { await Promise.allSettled([...uiMessageSources.values()].map(({ cancel }) => cancel(reason))) }
          : undefined,
        ...(collectToolResult ? { onNormalizedChunk: collectToolResult } : {}),
        projection,
      })
    }

    let isStreamResult = hasTraceableStreamResult(rendered)
    let streamResult = rendered
    const eagerStreamSources = new Map<AsyncIterable<unknown>, ReturnType<typeof cancellableAsyncIterableSource>>()
    if (isStreamResult && options.holdCapacity === true && rendered && hasRuntimeType(rendered, "object")) {
      const descriptors: PropertyDescriptorMap = {}
      let selectedStream = false
      try {
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      : customRun ? rendered as AsyncIterable<StreamEvent> : streamAgentOutputToEvents(rendered)
    const shouldWrapOutput = shouldHoldInvocationOutput()
    const source = shouldWrapOutput ? cancellableAsyncIterableSource(stream) : undefined
    const streamed = withStreamedResult(withEagerStreamUsageExtensions(source?.stream ?? stream, invocation, rendered), rendered, driverUsageRecord, invocation.toolResults, invocation.tools)
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const tracedStream = maybeTraceAgentStream(streamed.stream as AsyncIterable<StreamEvent>, invocation)
    const value = shouldWrapOutput
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      ? withCapabilityCleanup(tracedStream, async (outcome) => {
          const cancellations = await Promise.allSettled([...eagerStreamSources.values()].map(({ cancel }) => cancel(outcome.failed ? outcome.error : undefined)))
          const rejected = cancellations.find((result): result is PromiseRejectedResult => result.status === "rejected")
          if (rejected) outcome = { error: rejected.reason, failed: true }
          const finishResult = await streamed.finishResult(rendered, !outcome.failed && outcome.completed === true)
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
            const finishOutcome = finishOutcomeFromCleanup(outcome)
            await finishStreamAgentInvocation(
              invocation,
              lifecycle,
              finishResult,
              finishOutcome.status === "success"
                ? { ...finishOutcome, usage: streamed.finishUsage(), usageResolved: true }
                : finishOutcome,
              streamFailureMessage,
              outputExtensions,
            )
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
          const projection = hasRuntimeType(definition?.uiMessageStream, "function")
            ? await definition.uiMessageStream(invocation)
            : definition?.uiMessageStream
          const renderedResponseStream = await applyOutputRenderers({
            toUIMessageStream: () => uiMessageStreamFromResponse(response),
          }, invocation.outputRenderers, invocation.outputExtensionProviders, outputExtensions, response)
          const enrichedResponseStream = withEagerUiMessageStreamUsageExtensions(renderedResponseStream, invocation)
          const tracedResponseStream = maybeTraceUiMessageStreamOutput(enrichedResponseStream, invocation)
          const shouldWrapOutput = shouldHoldInvocationOutput()
          const collectToolResult = shouldWrapOutput ? agentToolResultStreamCollector(invocation.toolResults) : undefined
          const finalized = await finalizeUiMessageStreamOutput(tracedResponseStream, shouldWrapOutput, async (outcome, streamedText, streamedUsageRecord) => {
            if (!outcome.failed && !outcome.completed) {
              await lifecycle.finish({
                result: await resultWithStreamedTextAndUsage(response, streamedText || "", streamedUsageRecord),
                status: "success",
                ...(streamedUsageRecord
                  ? { usage: await resolveAgentUsageRecord({ usageRecord: streamedUsageRecord }, invocation.run) }
                  : {}),
                usageResolved: true,
              })
            }
            else {
              const driverUsageRecord = await resolveFinishUsageRecord(invocation, response)
              await finishStreamAgentInvocation(invocation, lifecycle, await resultWithStreamedTextAndUsage(response, streamedText || "", streamedUsageRecord, driverUsageRecord, false), finishOutcomeFromCleanup(outcome), streamFailureMessage, outputExtensions)
            }
          }, {
            abortSignal: invocation.input.abortSignal,
            ...(collectToolResult ? { onNormalizedChunk: collectToolResult } : {}),
            projection,
          })
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
    fallbackUsageRecord: rawDriverUsageRecord,
    ...(customRun
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const definition = hasAgentDefinition(agent) ? agent as object : undefined
  const invocationJournal = definition
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    ? await bindAgentInvocations((definition as AgentDefinition).invocations, {
      ...context,
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      ...((context as AgentRuntimeContext & { [agentInvocationRunId]?: string })[agentInvocationRunId]
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        ? { run: { ...context.run, runId: (context as AgentRuntimeContext & { [agentInvocationRunId]: string })[agentInvocationRunId] } }
        : {}),
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    }, { agentName: (definition as AgentDefinition).name || context.agentIdentity?.name })
    : undefined
  if (invocationJournal) context = invocationJournal.context
  let preparedInvocation: AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS> | undefined
  let release: (() => void) | undefined
  try {
    if (definition && inspectAgentCapacity(definition)) {
      preparedInvocation = await createAgentInvocationContextWithWorkflowFailureDelivery(
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        asUnknownBoundary(agent) as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, any, any, TOutput>,
        context,
        input,
        options.kind,
        invocationJournal,
      )
    }
    if (preparedInvocation?.handledResponse) {
      await invocationJournal?.running()
      return await executeAgentInvocationWithCapacityLease(agent, context, input, options, preparedInvocation, invocationJournal)
    }
    release = definition
      ? await acquireAgentCapacity(definition, input.abortSignal)
      : undefined
  }
  catch (error) {
    if (preparedInvocation) {
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      const workflowExecution = Boolean((context as AgentRuntimeContext & { [agentWorkflowExecutionContextKey]?: boolean })[agentWorkflowExecutionContextKey])
      await finishPreparedInvocationFailure(preparedInvocation, error, workflowExecution)
    }
    await invocationJournal?.finish(input.abortSignal?.aborted ? "cancelled" : "failed", error)
    throw error
  }
  if (!release) {
    await invocationJournal?.running()
    try {
      return await executeAgentInvocationWithCapacityLease(agent, context, input, options, preparedInvocation, invocationJournal)
    }
    catch (error) {
      await invocationJournal?.finish(input.abortSignal?.aborted ? "cancelled" : "failed", error)
      throw error
    }
  }

  let released = false
  const releaseOnce = () => {
    if (released) return
    released = true
    release()
  }
  try {
    await invocationJournal?.running()
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
    }, preparedInvocation, invocationJournal)
  }
  catch (error) {
    await invocationJournal?.finish(input.abortSignal?.aborted ? "cancelled" : "failed", error)
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
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
  return hasRuntimeType(error, "object")
    && error !== null
    && "code" in error
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    && (error as { code?: unknown }).code === "WORKFLOW_OPERATION_UNSUPPORTED"
    ? "unsupported"
    : "unavailable"
}

function createWorkflowAgentInvocationController<CALL_OPTIONS, TOutput>(
  started: StartedAgentWorkflow<CALL_OPTIONS, TOutput>,
  parentAbortSignal?: AbortSignal,
): AgentInvocationController<TOutput | Response, CALL_OPTIONS> {
  const { handle, invocationJournal, run } = started
  const reconcileJournal = async (snapshot: AgentInvocationSnapshot<TOutput> | undefined) => {
    if (snapshot?.status === "cancelled" || snapshot?.status === "completed" || snapshot?.status === "failed") {
      await invocationJournal?.finish(snapshot.status, snapshot.error)
    }
    return snapshot
  }
  return createBackedAgentInvocationController<TOutput | Response, CALL_OPTIONS>({
    cancel: async () => {
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      const snapshot = agentInvocationSnapshotFromWorkflow(await handle.cancel(run.id) as AgentWorkflowRun<TOutput>)
      return await reconcileJournal(snapshot)
    },
    errorOutcome: workflowOperationOutcome,
    id: run.id,
    inspect: async () => await reconcileJournal(agentInvocationSnapshotFromWorkflow(
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      await handle.getRun(run.id) as AgentWorkflowRun<TOutput>,
    )),
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
      ...withAgentInvocationResponseOwner(context, id),
      run: { ...context.run, runId: runId || id },
    }, { ...input, abortSignal }, {
      kind: "run",
      onFinish(outcome) {
        onFinish(outcome.status === "success"
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
): Promise<AgentInvocationController<TOutput | Response | AgentRunResult, CALL_OPTIONS>> {
  const invocationContext = withAgentIdentityOwner(agent, context)
  const workflow = await runAgentAsWorkflow<TRuntimeConfig, CALL_OPTIONS, TOutput>(
    agent,
    invocationContext,
    input,
    { fresh: true },
  )
  if (workflow) {
    return createWorkflowAgentInvocationController(workflow, input.abortSignal)
  }
  return createInlineAgentInvocationController(agent, invocationContext, input, options.runId)
}

export async function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
): Promise<TOutput | Response | AgentWorkflowRun<AgentWorkflowOutput<TOutput>>> {
  const invocationContext = withAgentIdentityOwner(agent, context)
  const workflow = await runAgentAsWorkflow<TRuntimeConfig, CALL_OPTIONS, TOutput>(agent, invocationContext, input)
  if (workflow) {
    return workflow.run
  }
  if (input.context?.[requireAgentWorkflowContextKey] === true) {
    throw new Error("[vitehub] Durable Channel delivery requires this Agent invocation to start a Workflow. Disable durable delivery or remove nonportable Capabilities and configure a Workflow provider.")
  }
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
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  const turn = context.input && hasRuntimeType(context.input, "object") && (context.input as { kind?: unknown }).kind === "agent-turn"
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
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
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
