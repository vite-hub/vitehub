Warning: truncated output (original token count: 106790)
Total output lines: 8814

import { agentEnvIdentity, createAgentEnvIdentity } from "./internal/env-identity.ts"
import { readWorkflowJournalName } from "./internal/workflow-journal-name.ts"
import type { AgentPresetConfig, AgentPresetOptions, ConfiguredAgentDefinition } from "./agent-presets.ts"
export type { AgentPresetConfig, AgentPresetOptions, ConfiguredAgentDefinition } from "./agent-presets.ts"
import { invocationUsageWithAuxiliaryCalls } from "./internal/auxiliary-usage.ts"
import { agentLayerMetadata, createConfiguredAgentDefinition, rememberAgentLayerOptions, resolveAgentLayerOptions } from "./agent-layers.ts"
import { readDiscoveredAgentName } from "./internal/discovered-agent-name.ts"
import { agentDefinitionSourceSymbol } from "./internal/agent-definition-source.ts"
import { asUnknownBoundary, hasRuntimeType, isCallableMember, isRuntimeObject, isRuntimeRecord } from "./internal/runtime-type.ts"
import { Diagnostic } from "nostics"
import agentRegistry from "#vitehub/agent/registry"
import { acquireAgentCapacity, configureAgentCapacity, inspectAgentCapacity } from "./internal/agent-capacity.ts"
import { normalizeAgentDriver, normalizeAgentDriverCapacity } from "./internal/agent-driver.ts"
import { createAgentHealthHandler } from "./health.ts"
import { agentOutputEventObserverContextKey, progressSummaryOutputContextKey, type AgentOutputEventObserver } from "./internal/agent-output-events.ts"
import { openAgentInvocationLifecycle, type AgentInvocationLifecycle } from "./internal/invocation-lifecycle.ts"
import { cloneWithPropertyDescriptors, toReadableAsyncIterableStream } from "./internal/stream-result.ts"
import { createBoundedTextAccumulator } from "./internal/bounded-text.ts"
import { validateAgentOutput } from "./internal/agent-structured-output.ts"
import { loadAgentWorkflowModule, loadAgentWorkflowRuntimeStateModule } from "./internal/workflow-runtime-loaders.ts"
import { cloneWorkflowJsonValue, portableWorkflowCapabilityMask, workflowBytesToBase64 } from "./internal/workflow-portability.ts"
import { agentErrorDetails, agentErrorMessage, isError, toAgentPublicError } from "./agent-error.ts"
import { agentChannelDeliveryOwnershipVerifier, agentChannelDeliveryTracker, agentChannelDeliveryWorkflowContextKey, isAgentChannelDeliveryWorkflowBinding } from "./internal/channel-delivery.ts"
import { channelDeliveryHandlers, channelMessageContextKey } from "./internal/channel-delivery-handlers.ts"
import {
  createBackedAgentInvocationController,
  startLiveAgentInvocation,
} from "./agent-invocation.ts"
import { agentInvocationInputSupport, sendAgentInvocationInput } from "./internal/agent-invocation-control.ts"
import { agentInvocationCancellationDriver, isAgentInvocationAbortError, markAgentInvocationCancellationFailure } from "./internal/invocation-cancellation.ts"
import type { AgentInvocationCancellationDriver } from "./internal/invocation-cancellation.ts"
import { withAgentInvocationResponseOwner } from "./internal/agent-invocation-response-owner.ts"
import {
  createReactionDeliveryEffectIntent,
  defineFinishEffect,
  createReplyDeliveryEffectIntent,
  createStatusDeliveryEffectIntent,
} from "./delivery-effects.ts"

export { defineFinishEffect } from "./delivery-effects.ts"
import { createExecutionContext, createRuntimeContext, createTraceEventLog, deriveTraceRuns, getViteHubErrorShape, isTraceContentAttributeKey, normalizeRuntimeDiagnosticError, traceEventsToOpenTelemetryLogRecords, traceEventsToOpenTelemetrySpans } from "@vite-hub/runtime"
import { isAmbiguousAgentWorkflowStartFailure } from "./internal/workflow-start.ts"
import { agentTelemetryWorkspaceSources, getAgentTelemetryConfiguration, safeAgentTelemetryMetadata, setAgentTelemetryConfiguration } from "./internal/agent-telemetry.ts"
import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { getAgentInvocationRecoveryWorkflowName } from "@vite-hub/internal/agent-workflow"
import { parseStandardSchema } from "@vite-hub/internal/http-request"
import { agentResultKind, agentStreamErrorSymbol, agentToolStreamDefaults, appendLatestFinalText, finalTextFromAgentOutput, hasTraceableStreamResult, isAsyncIterable, resolveAgentUsageRecord, streamAgentOutputToEvents, toAgentRunResult, toAgentStreamEvent, usageRecordFromStreamChunk } from "./agent-output.ts"
import { defineChatCapability, durableChatErrorFallbackTimeout, getAgentChatContext, getChatCapabilityOptions, isDurableChatErrorFallbackEffect, resolveChatMessageContextInstructions, resolveChatMessageRunMetadata, resolveDurableChatErrorFallbackIntents } from "./chat-trigger.ts"
import { createAgentBudgetCapability } from "./capabilities/budget.ts"
import { agentWorkflowExecutionContextKey } from "./internal/workflow-execution.ts"
import { consumeParsedAgentWorkflowInput } from "./internal/workflow-parsed-input.ts"
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
  messageChannelDeliveredReplyBody,
  messageChannelReplyBody,
  messageChannelTitleSupportContextKey,
  slack as builtInSlack,
  teams as builtInTeams,
  telegram as builtInTelegram,
  webChat as builtInWebChat,
  githubChannelIdentity,
} from "./channels.ts"
import { registerMessageChannelDeferredReplyTrace, setChatFinalReplyText, setChatFinishDirectReplyTrace, setChatFinishPrimaryReplyTrace } from "./internal/chat-finish-delivery.ts"
import { agentInvocationCallbackContextValues, agentInvocationConfigurationUpdatedContextKey, agentInvocationRunId, agentInvocationWorkflowBinding, createAgentInvocationContextStore } from "./invocation-context.ts"
import { agentInvocationCallerAbortSignal, copyAgentInvocationCallerAbortSignal, markAgentInvocationCallerAbortSignal } from "./internal/invocation-input.ts"
import { bindAgentRunEvents, type AgentRunEventPublisher } from "./run-events.ts"
import { AgentInvocationClaimConflict, bindAgentInvocations, exclusiveAgentInvocation, inheritedAgentInvocationClaim, pendingAgentInvocationAnnotation, pendingAgentInvocationAnnotations, type AgentInvocationJournal, type AgentInvocationWorkflowBinding } from "./invocations.ts"
import { createMessage, isAttachmentPart, materializeMessageAttachmentData, type AgentMessagePhase, type Message } from "./messages.ts"
import {
  createFallbackAgentInvoker,
  hasUnreplayableAgentInputContext,
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
import type { AgentCapabilityRegistries, AgentFinishDeliveryReminder, CapabilityCleanupOutcome, ResolvedAgentFinishExtensionProvider, ResolvedAgentOutputExtensionProvider } from "./capability-runtime.ts"
import { agentDiagnostics } from "./agent-diagnostics.ts"
import { cancellableAsyncIterableSource, createAgentUIMessageStreamResponse, finalizeUiMessageStreamOutput, isUIMessageStreamResponse, isUIMessageStreamResult, normalizeUiMessageStream, uiMessageStreamFromResponse, uiMessageTextDelta, withReadableStreamCleanup } from "./stream-output.ts"
import {
  applyAgentToolPolicies,
  withAgentToolStepReporting,
  withJsonCompatibleToolOutputs,
} from "./tool-runtime.ts"
import { inspectAgentTools } from "./tool-inspection.ts"
import { withAgentToolJsonSchemas } from "./tool-schema.ts"
import {
  createAgentStreamEventTracer,
  agentInvocationJournalContentTraceLogSymbol,
  agentInvocationJournalTraceLogSymbol,
  agentInvocationTraceIdContextKey,
  traceAgentInvocationCancelled,
  traceAgentInvocationError,
  traceAgentChannelDeliveryEffect,
  traceAgentChannelDeliveryReminder,
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
  workspaceAutoCommitDisabled,
  workspaceDefinitionWithAutoCommitRules,
  workspaceModeFromOptions,
  workspaceNameFromOptions,
} from "./workspace-agent.ts"

import type {
  AgentActivityStatus,
  AgentActivityTarget,
  AgentActivityTask,
  AgentActivityUpdate,
  AgentAdapter,
  AgentAdapterFactory,
  AgentAdapterRunContext,
  AgentCapabilitiesInput,
  AgentCapabilitiesResolver,
  AgentChannelDefinition,
  AgentChannelInputs,
  AgentChannelMessage,
  AgentChannelMessageContext,
  AgentChannelMessageOf,
  AgentChannels,
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentCapabilityTypeContract,
  AgentChannelDeliveryEffectHandler,
  AgentChannelMessageMethod,
  AgentDefinitionHooks,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryFinishEffect,
  AgentChannelDeliveryFinishEffectResult,
  AgentChannelDeliveryFinishEffectContext,
  AgentDataCarrier,
  AgentDataOutputCarrier,
  AgentBudgetOptions,
  AgentRunInputContextValues,
  AgentInterceptHandler,
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
  WorkspaceAgentWorkspaceConfig,
  AgentStaticCapabilitiesList,
  IsTypedAgentStaticCapabilitiesList,
  AgentTelemetryContentOptions,
  AgentTelemetryConfiguration,
  AgentToolDefinition,
  AgentToolExecutionContext,
  AgentToolSchema,
  AgentToolSet,
  AgentToolStandardSchema,
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
  BackedAgentInvocationOptions,
} from "./agent-invocation.ts"
import type { StreamEvent } from "./messages.ts"
import type { StandardSchemaV1 } from "@standard-schema/spec"
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
import type { OpenTelemetryLogRecordView, OpenTelemetrySpanView, TraceActivityContext, TraceEventLogEntry } from "@vite-hub/runtime"

export { agentInvocationId, agentInvocationRerunInput } from "./invocations.ts"

export type {
  AgentInvocationAnnotationValue,
  AgentInvocationCancelResult,
  AgentInvocationDeleteOutcome,
  AgentInvocationListOptions,
  AgentInvocationListResult,
  AgentInvocationObservationOptions,
  AgentInvocationPruneOptions,
  AgentInvocationPruneResult,
  AgentInvocationRecord,
  AgentInvocationRecordStatus,
  AgentInvocationRerunInput,
  AgentInvocationRerunUnavailableReason,
  AgentInvocationRetentionOptions,
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
  AgentInstructionsContent,
  AgentAdapterMetadataContext,
  AgentAdapterResult,
  AgentAdapterRunContext,
  AgentActor,
  AgentCapabilities,
  AgentCapabilitiesInput,
  AgentCapabilitiesList,
  AgentCapabilitiesResolver,
  AgentCapabilitiesResolverContext,
  AgentCallbackContext,
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
  AgentCapabilityInspection,
  AgentCapabilityInspectionDefinition,
  AgentCapabilityInspectionBinding,
  AgentCapabilityInspectionElement,
  AgentCapabilityInspectionView,
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
  AgentChannelDeliveryFinishEffect,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryEffectIntentOptions,
  AgentChannelDeliveryEffectPayload,
  AgentChannelDeliveryEffectKind,
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
  AgentChannelHistory,
  AgentChannelHistoryCollection,
  AgentChannelHistoryQuery,
  AgentChannelInputs,
  AgentChannelMessage,
  AgentChannelMessageCalls,
  AgentChannelMessageContext,
  AgentChannelMessageDefinition,
  AgentChannelMessageMethod,
  AgentChannelMessageMethodHandler,
  AgentChannelMessageMethods,
  AgentChannelMessageOf,
  AgentChannelReplyCalls,
  AgentChannelTriggerContext,
  AgentDefinitionHooks,
  AgentGitHubMessageCalls,
  AgentChannels,
  AgentDeliveryArtifact,
  AgentDeliveryArtifactPlacement,
  AgentDataCarrier,
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
  AgentAskDriver,
  AgentAskQuestions,
  AgentAskQuestionsResolver,
  AgentDriver,
  AgentDriverAdaptiveCapacityOptions,
  AgentDriverCapacityOptions,
  AgentDriverCapacityQueueOptions,
  AgentDriverCapacitySample,
  AgentDriverCapacitySampleContext,
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
  AgentInterceptContext,
  AgentInterceptHandler,
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
  AgentInvocationReference,
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
  AgentBoxDefinition,
  AgentGitHub,
  AgentGitHubAccess,
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
  AgentSourceProvenance,
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
  AgentToolInspection,
  AgentTriggerContext,
  AgentTriggerDefinition,
  AgentTriggerFailedEvent,
  AgentTriggerInvokeResult,
  AgentTriggerRunInvokeResult,
  AgentToolResolver,
  AgentToolSet,
  AgentToolStep,
  AgentWaitUntil,
  AgentProviderCredentialContext,
  AgentProviderStatus,
  AgentProviderUsageLimits,
  AgentProviderCredentialResolver,
  AgentProviderCredentialValue,
  AgentProviderEnvironment,
  AgentProviderEnvironmentResolver,
  AgentProviderExitContext,
  AgentProviderLaunchCommand,
  AgentProviderLaunchContext,
  AgentProviderLaunchResolver,
  AgentProviderSealedCredential,
  AgentProviderWorkingDirectoryResolver,
  ClaudeCodeDriverOptions,
  CodexDriverOptions,
  CodexReasoningEffort,
  CodexReasoningSummary,
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
const baseAgentDriver = Symbol.for("vitehub.baseAgentDriver")
const baseAgentDefinitionResolve = Symbol.for("vitehub.baseAgentDefinitionResolve")
const baseAgentDefinitionHealth = Symbol.for("vitehub.baseAgentDefinitionHealth")
const baseAgentDefinitionStatus = Symbol.for("vitehub.baseAgentDefinitionStatus")
const baseAgentOutput = Symbol.for("vitehub.baseAgentOutput")
const baseAgentData = Symbol.for("vitehub.baseAgentData")
const baseAgentIntercept = Symbol.for("vitehub.baseAgentIntercept")
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
  [baseAgentDriver]?: unknown
  [baseAgentOutput]?: AgentOutputDefinition<TOutput>
  [baseAgentData]?: StandardSchemaV1
  [baseAgentIntercept]?: AgentInterceptHandler<TRuntimeConfig, CALL_OPTIONS>
  [baseAgentResolve]?: BaseAgentResolver<TRuntimeConfig, CALL_OPTIONS>
  [baseAgentModel]?: AgentModelResolver<TRuntimeConfig>
  [colocatedAgentSkillsSymbol]?: ColocatedAgentSkills
}
interface AgentWorkflowInvocationPayload<CALL_OPTIONS = unknown> {
  agentIdentity?: AgentRuntimeContext["agentIdentity"]
  journalAgentName?: string
  invocationClaimToken?: string
  capabilities?: Record<string, boolean>
  input?: AgentRunInput<CALL_OPTIONS>
  callerAbortSignal?: boolean
  parsedInputData?: boolean
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
type AgentDrainedOutput<TOutput> = TOutput extends Response ? AgentRunResult : TOutput | AgentRunResult
interface StartedAgentWorkflow<CALL_OPTIONS = unknown, TOutput = unknown> {
  activity?: ActiveAgentActivity
  handle: WorkflowHandle<AgentWorkflowInvocationPayload<CALL_OPTIONS>, TOutput>
  invocationJournal?: AgentInvocationJournal
  run: AgentWorkflowRun<TOutput>
  settled?: Promise<void>
}
export interface ScheduleRunContextLike {
  attemptId?: string
  id: string
  input?: unknown
  runId?: string
  scheduleId?: string
  scheduledAt: Date
  target?: string
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

/** Options supplied by trusted invocation code; callable tools are never persisted as input. */
export interface RunAgentOptions<TTools extends Record<string, AgentToolDefinition<any, any>> = Record<string, AgentToolDefinition<any, any>>> {
  tools?: TTools
  schedule?: ScheduleRunContextLike
  /** Consume streamed output and finish its lifecycle before resolving. */
  output?: "drained"
}

type InvocationToolSchemaOutput<TSchema> = TSchema extends StandardSchemaV1<unknown, infer TOutput> ? TOutput : unknown
type SchemaOwnedInvocationTools<TSchemas extends Record<string, AgentToolSchema>> = {
  [Key in keyof TSchemas]: Omit<AgentToolDefinition<any, any>, "execute" | "inputSchema"> & {
    inputSchema: TSchemas[Key]
    execute?: (input: InvocationToolSchemaOutput<TSchemas[Key]>, context?: AgentToolExecutionContext) => MaybePromise<unknown>
  }
}
type CheckedInvocationTools<TTools> = {
  [Key in keyof TTools]: TTools[Key] extends { inputSchema: infer TSchema }
    ? TSchema extends StandardSchemaV1<unknown, infer TInput>
      ? { execute?: (input: TInput, context?: AgentToolExecutionContext) => MaybePromise<unknown> }
      : unknown
    : unknown
}


const agentWorkflowHandles = new WeakMap<object, Map<string, WorkflowHandle<AgentWorkflowInvocationPayload, unknown>>>()
const agentWorkflowNames = new Set<string>()
const agentIdentityOwner = Symbol("vitehub.agentIdentityOwner")
const agentWorkflowDiscovery = Symbol("vitehub.agentWorkflowDiscovery")
type IdentityRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> = AgentRuntimeContext<TRuntimeConfig> & {
  [agentIdentityOwner]?: object
  [agentWorkflowDiscovery]?: boolean
  [agentEnvIdentity]?: AgentRuntimeContext["agentIdentity"]
}

// Name journal records like the Console lists them: explicit name, host identity, then discovered file name.
function agentInvocationName(agent: { name?: string }, context: Pick<AgentRuntimeContext, "agentIdentity">): string | undefined {
  return agent.name || context.agentIdentity?.name || readWorkflowJournalName(context, agent) || readDiscoveredAgentName(agent)
}

interface DefaultAgentWorkflowRuntimeBinding extends AgentWorkflowRuntimeBinding {
  discoveryDefault: true
}

function withAgentIdentityOwner<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: IdentityRuntimeContext<TRuntimeConfig>,
): IdentityRuntimeContext<TRuntimeConfig> {
  if (agent.github && !context.githubIdentity) context = { ...context, githubIdentity: agent.github }
  // Only reuse identity for the same Definition. An unnamed child cannot inherit its parent's grants.
  const owner = context[agentIdentityOwner]
  if (owner === agent) return context
  // Keep host discovery separate from the identity minted for Connection access.
  const discovered = context[agentWorkflowDiscovery] ?? Boolean(context.agentIdentity)
  context = { ...context, [agentWorkflowDiscovery]: discovered }
  const name = agent.name || readDiscoveredAgentName(agent)
  if (!name) return { ...context, agentIdentity: !owner ? context.agentIdentity : undefined, [agentIdentityOwner]: agent, [agentEnvIdentity]: undefined }
  const envIdentity = createAgentEnvIdentity({ ...(!owner ? context.agentIdentity : {}), name })
  return {
    ...context,
    // Host identity controls routing and attribution; Env authority belongs to the Definition.
    agentIdentity: !owner && context.agentIdentity
      ? createAgentEnvIdentity(context.agentIdentity, name)
      : agent.name ? envIdentity : undefined,
    [agentEnvIdentity]: envIdentity,
    [agentIdentityOwner]: agent,
  }
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

function canDispatchAgentWorkflow(
  binding: AgentWorkflowRuntimeBinding | undefined,
  context: IdentityRuntimeContext,
): binding is AgentWorkflowRuntimeBinding {
  const discovered = context[agentWorkflowDiscovery] ?? Boolean(context.agentIdentity)
  return Boolean(binding && (!("discoveryDefault" in binding) || (discovered && context.agentIdentity)))
}

function resolveAgentWorkflowName<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  binding: AgentWorkflowRuntimeBinding,
  context: AgentRuntimeContext<TRuntimeConfig>,
): string {
  const definition = hasAgentDefinition(agent) ? agent : undefined
  const name = binding.name || ("discoveryDefault" in binding ? context.agentIdentity?.name : definition?.name || context.agentIdentity?.name)
  if (name) return name
  throw agentDiagnostics.AGENT_R0421({ message: "[vitehub] Agent runtime workflow() requires a name when invoked directly. A stable Workflow Definition target requires workflow(\"name\")." })
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
      throw agentDiagnostics.AGENT_R0422({ message: `Workflow name ${JSON.stringify(name)} conflicts with an Agent invocation recovery Workflow.` })
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

function isPortableWorkflowArrayBuffer(value: unknown): value is ArrayBuffer {
  try {
    const getter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get
    if (!getter) return false
    getter.call(value)
    return true
  }
  catch {
    return false
  }
}

function isPortableWorkflowUint8Array(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value)) return false
  try {
    const getter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(Uint8Array.prototype),
      Symbol.toStringTag,
    )?.get
    return getter?.call(value) === "Uint8Array"
  }
  catch {
    return false
  }
}

function isPortableWorkflowBlob(value: unknown): value is Blob {
  try {
    const getter = Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get
    if (!getter) return false
    getter.call(value)
    return true
  }
  catch {
    return false
  }
}

async function portableWorkflowMessages(messages: Message[]): Promise<Message[]> {
  const materialized = await materializeMessageAttachmentData(messages)
  return await Promise.all(materialized.map(async message => ({
    ...message,
    parts: await Promise.all(message.parts.map(async (part) => {
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      if (!isAttachmentPart(part)) return cloneWorkflowJsonValue(part) as typeof part
      let data = part.data
      if (isPortableWorkflowBlob(data)) data = await data.arrayBuffer()
      if (isPortableWorkflowArrayBuffer(data)) data = new Uint8Array(data)
      const portable = isPortableWorkflowUint8Array(data)
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
  const delivery = workflowInput.context?.[agentChannelDeliveryWorkflowContextKey]
  if (isAgentChannelDeliveryWorkflowBinding(delivery) && isRuntimeObject(delivery.steer) && isRuntimeObject(delivery.steer.lock)) {
    const { lock } = delivery.steer
    // State adapters may return RPC objects; only the lock fields cross runtimes.
    workflowInput.context = {
      ...workflowInput.context,
      [agentChannelDeliveryWorkflowContextKey]: {
        ...delivery,
        steer: {
          ...delivery.steer,
          lock: { expiresAt: lock.expiresAt, threadId: lock.threadId, token: lock.token },
        },
      },
    }
  }
  // Validate and detach the complete payload before it crosses a durable State
  // or Workflow boundary. Materializing messages alone would still allow
  // context and call options to be silently coerced by JSON persistence.
  // SAFETY: cloneWorkflowJsonValue preserves the normalized AgentRunInput shape while rejecting non-JSON values.
  return cloneWorkflowJsonValue(workflowInput) as AgentRunInput<CALL_OPTIONS>
}

export async function reserveAgentChannelItem<TRuntimeConfig extends AgentRuntimeConfig>(agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>, context: AgentRuntimeContext<TRuntimeConfig>): Promise<AgentInvocationJournal<TRuntimeConfig> | undefined> {
  if (!agent.invocations) return
  const journal = await bindAgentInvocations(agent.invocations, { ...context, run: { ...context.run, runId: context.run?.runId || createTraceId(), annotations: pendingAgentInvocationAnnotations(context.run?.annotations) } }, { agentName: agentInvocationName(agent, context), recoverPending: true })
  if (journal?.claimStatus !== "owned") {
    if (journal?.claimStatus === "conflict") throw new AgentInvocationClaimConflict()
    throw new Error("Could not acquire the Invocation execution claim.")
  }
  const binding = resolveAgentWorkflowRuntimeBinding<TRuntimeConfig>(agent)
  if (!journal.createdNew) {
    try {
      const stableId = context.run?.runId || ""
      const stored = await agent.invocations.getByRunId(stableId, agentInvocationName(agent, context))
      const dispatch = stored?.workflow
      // An existing discovery-default reservation needs its Agent identity
      // even when legacy metadata cannot show whether dispatch was accepted.
      if (!canDispatchAgentWorkflow(binding, context)) {
        if (binding || dispatch) {
          if (dispatch && await journal.confirmWorkflowDispatch(dispatch)) throw new AgentInvocationClaimConflict()
          throw new AgentInvocationClaimConflict()
        }
        return journal
      }
      const workflowName = resolveAgentWorkflowName(agent, binding, context)
      const recoveryConfig = (await loadAgentWorkflowRuntimeStateModule()).getWorkflowRuntimeConfig()
      // Discovery-default agents fall back to inline execution when Workflow
      // is disabled. There is no provider run to inspect in this case, so keep
      // the claimed reservation for the inline retry path.
      if (recoveryConfig === false && "discoveryDefault" in binding) return journal
      const handle = await getAgentWorkflowHandle<TRuntimeConfig, unknown, unknown>(agent, workflowName, Boolean(context.agentIdentity))
      // Legacy reservations lack dispatch intent and may already have been accepted.
      if (!dispatch && recoveryConfig && recoveryConfig.provider === "vercel") throw new AgentInvocationClaimConflict()
      if (dispatch && (dispatch.provider !== (recoveryConfig && recoveryConfig.provider) || dispatch.name !== workflowName)) {
        throw new Error("Workflow dispatch identity changed; replay cannot safely submit this Invocation again.")
      }
      if ((recoveryConfig && recoveryConfig.provider) === "vercel" && dispatch) {
        if (!dispatch.id) {
          throw new Error("Workflow dispatch acknowledgement is unknown; replay cannot safely submit this Invocation again.")
        }
      }
      const providerId = (recoveryConfig && recoveryConfig.provider) === "vercel" && dispatch?.id ? dispatch.id : recoveryConfig && recoveryConfig.provider === "cloudflare" ? await portableAgentWorkflowRunId(stableId) : stableId
      const accepted = await handle.getRun(providerId)
      if (accepted.status !== "unknown") {
        if (!await journal.confirmWorkflowDispatch()) throw new Error("Could not confirm the accepted Workflow Invocation.")
        throw new AgentInvocationClaimConflict()
      }
      // A missing marker is ambiguous for legacy reservations. Only an explicit
      // false means the provider call was never attempted; an attempted or
      // unknown marker must stay pending until the provider can be reconciled.
      if (await journal.getWorkflowDispatchAttempted() !== false) {
        throw new Error("Workflow dispatch acknowledgement is unknown; replay cannot safely submit this Invocation again.")
      }
      if ((recoveryConfig && recoveryConfig.provider) === "vercel" && dispatch) {
        throw new Error("The acknowledged Workflow run is unavailable; replay cannot safely submit this Invocation again.")
      }
    } catch (error) {
      await journal.releaseClaim()
      throw error
    }
  }
  return journal
}

async function runAgentAsWorkflow<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOutput,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput, CALL_OPTIONS>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: { fresh?: boolean, onInputHandoff?: () => void } = {},
): Promise<StartedAgentWorkflow<CALL_OPTIONS, AgentWorkflowOutput<TOutput>> | undefined> {
  const binding = resolveAgentWorkflowRuntimeBinding<TRuntimeConfig>(agent)
  const cloudflareEnv = context.cloudflare?.env || getCloudflareEnv(context)
  if (!canDispatchAgentWorkflow(binding, context)) return undefined
  // SAFETY: Replay sets this private boolean marker on its runtime; other runtimes may omit it.
  const exclusive = (context as AgentRuntimeContext & { [exclusiveAgentInvocation]?: boolean })[exclusiveAgentInvocation] === true
  let activity = exclusive ? undefined : hasAgentDefinition(agent) ? createActiveAgentActivity(agent, context) : undefined
  let replayReserved = false
  let replayJournal: AgentInvocationJournal<TRuntimeConfig> | undefined
  const ensureActivity = async () => {
    if (!exclusive || replayReserved) return
    const journal = hasAgentDefinition(agent)
      ? await bindAgentInvocations(agent.invocations, { ...context, run: { ...context.run, runId: context.run?.runId || createTraceId(), annotations: pendingAgentInvocationAnnotations(context.run?.annotations) } }, { agentName: agentInvocationName(agent, context), recoverPending: true,
          // SAFETY: Channel dispatch installs the trusted private handoff token before running its Agent.
          replaceClaimToken: (context as AgentRuntimeContext & { [inheritedAgentInvocationClaim]?: string })[inheritedAgentInvocationClaim],
        })
      : undefined
    if (journal?.claimStatus !== "owned") {
      if (journal?.claimStatus === "conflict") throw new AgentInvocationClaimConflict()
      throw new Error("Could not acquire the Invocation execution claim.")
    }
    replayJournal = journal
    replayReserved = true
    activity = hasAgentDefinition(agent) ? createActiveAgentActivity(agent, context) : undefined
  }
  // Preparation failures happen before a provider run can create its journal.
  const recordPreparationFailure = async (error: unknown) => {
    const status = invocationFailureWasCancelled(error, input.abortSignal) || invocationFailureWasCancelled(error, replayJournal?.abortSignal) ? "cancelled" : "failed"
    await activity?.update(status, error)
    if (!hasAgentDefinition(agent)) return
    const preservesDeliveryRun = isAgentChannelDeliveryWorkflowBinding(input.context?.[agentChannelDeliveryWorkflowContextKey])
    const runId = (!options.fresh || preservesDeliveryRun) && context.run?.runId ? context.run.runId : createTraceId()
    try {
      const journal = replayJournal || await bindAgentInvocations(agent.invocations, {
        ...context,
        run: { ...context.run, runId },
      }, { agentName: agentInvocationName(agent, context), terminalTakeover: true })
      await journal?.finish(status, error)
    }
    catch (journalError) {
      console.error(new AggregateError([error, journalError], "[vitehub] Agent Workflow preparation and invocation journaling failed."))
    }
  }
  let workflowRuntimeState: Awaited<ReturnType<typeof loadAgentWorkflowRuntimeStateModule>>
  try {
    workflowRuntimeState = await loadAgentWorkflowRuntimeStateModule()
  }
  catch (error) {
    await ensureActivity()
    await activity?.update("queued")
    await recordPreparationFailure(error)
    throw error
  }
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
    if (!exclusive) await activity?.update("queued")
    try {
      const workflowName = resolveAgentWorkflowName(agent, binding, context)
      const workflowBindingName = workflowConfig.binding || (await loadAgentWorkflowModule()).getCloudflareWorkflowBindingName(workflowName)
      if (!cloudflareEnv[workflowBindingName]) return undefined
    }
    catch (error) {
      await recordPreparationFailure(error)
      throw error
    }
  }
  if (activateCloudflareWorkflow) {
    workflowRuntimeState.setWorkflowRuntimeConfig(workflowConfig)
  }
  if ("discoveryDefault" in binding && context.agentIdentity) {
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const owner = (context as AgentRuntimeContext & { [agentIdentityOwner]?: object })[agentIdentityOwner]
    if (owner && owner !== agent) return undefined
  }
  const workflowCapabilities = portableWorkflowCapabilityMask(context.capabilities)
  const hasNonportableCapabilities = !await hasOnlyPortableAgentWorkflowCapabilities(context.capabilities)
  if (input.context?.[requireAgentWorkflowContextKey] === true && hasNonportableCapabilities) return undefined
  if ("discoveryDefault" in binding && hasNonportableCapabilities) return undefined

  await ensureActivity()
  if (exclusive || !(input.context?.[requireAgentWorkflowContextKey] === true && workflowConfig && workflowConfig.provider === "cloudflare")) {
    await activity?.update("queued")
  }
  let workflowName: string
  let handle: WorkflowHandle<AgentWorkflowInvocationPayload<CALL_OPTIONS>, AgentWorkflowOutput<TOutput>>
  let parsedInput: AgentRunInput<CALL_OPTIONS>
  let workflowInput: AgentRunInput<CALL_OPTIONS>
  let parsedInputData = false
  try {
    workflowName = resolveAgentWorkflowName(agent, binding, context)
    handle = await getAgentWorkflowHandle<TRuntimeConfig, CALL_OPTIONS, TOutput>(agent, workflowName, Boolean(context.agentIdentity))
    // ponytail: AbortSignal is live process state and cannot cross a durable Workflow payload.
    parsedInput = hasAgentDefinition(agent)
      ? await withParsedAgentMessageMeta<TRuntimeConfig, CALL_OPTIONS>(agent, input, context.run)
      : input
    if (hasAgentDefinition(agent)) {
      const validatedInput = await parseAgentInputData({ [baseAgentData]: Reflect.get(agent, baseAgentData) }, parsedInput)
      try {
        cloneWorkflowJsonValue({ data: validatedInput.data }, { omitUndefinedObjectProperties: false })
        parsedInput = validatedInput
        parsedInputData = true
      }
      catch {
        parsedInputData = false
      }
    }
    workflowInput = await portableAgentWorkflowInput(parsedInput)
  }
  catch (error) {
    await recordPreparationFailure(error)
    throw error
  }
  const resolvedContext = createResolvedRuntimeContext(context)
  const channelDeliveryBinding = input.context?.[agentChannelDeliveryWorkflowContextKey]
  const durableChannelDelivery = isAgentChannelDeliveryWorkflowBinding(channelDeliveryBinding)
  const inheritedRun = options.fresh && context.run && !durableChannelDelivery
    ? Object.fromEntries(Object.entries(context.run).filter(([key]) => key !== "runId"))
    : context.run
  // SAFETY: withParsedAgentMessageMeta preserves this invocation's call-options type.
  const parsedMessageMeta = parsedAgentMessageMetaState(agent, parsedInput as AgentRunInput<CALL_OPTIONS>, context.run)
  const invocationName = agentInvocationName(agent, context)
  const payload: AgentWorkflowInvocationPayload<CALL_OPTIONS> = {
    ...(parsedInputData ? { parsedInputData: true } : {}),
    ...(context.agentIdentity ? { agentIdentity: context.agentIdentity } : {}),
    ...(invocationName ? { journalAgentName: invocationName } : {}),
    ...(Object.keys(workflowCapabilities).length ? { capabilities: workflowCapabilities } : {}),
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    input: cloneWorkflowJsonValue(workflowInput) as AgentRunInput<CALL_OPTIONS>,
    callerAbortSignal: agentInvocationCallerAbortSignal(input),
    // Headers and bodies may contain webhook credentials and remain process-local by design.
    ...(context.request ? { requestUrl: context.request.url } : {}),
    ...(parsedMessageMeta !== undefined ? { parsedMessageMeta } : {}),
    ...(hasResolvedAgentInvokerInput(input) ? { resolvedInvoker: true } : {}),
    runtime: context.runtime,
    runtimeConfig: resolvedContext.runtimeConfig,
    ...(inheritedRun ? { run: inheritedRun } : {}),
    ...(context.trace ? { trace: context.trace } : {}),
  }
  const workflowSettlementTasks: Promise<unknown>[] = []
  const observeSettlement = (promise: PromiseLike<unknown>) => {
    workflowSettlementTasks.push(Promise.resolve(promise))
  }
  const waitUntil = (promise: PromiseLike<unknown>) => {
    const task = Promise.resolve(promise)
    workflowSettlementTasks.push(task)
    context.waitUntil?.(task)
  }
  let inputHandedOff = false
  const workflowEvent = {
    ...(cloudflareEnv ? { env: cloudflareEnv } : {}),
    onDispatch() {
      if (inputHandedOff) return
      options.onInputHandoff?.()
      inputHandedOff = true
    },
    settled: observeSettlement,
    waitUntil,
    context: {
      ...(context.cloudflare ? { cloudflare: context.cloudflare } : {}),
      settled: observeSettlement,
      waitUntil,
    },
  }
  // Durable Channel recovery may be a fresh provider start while still owning
  // one persisted logical run. Initial starts remain stable by claim, while a
  // fresh recovery gets a new provider ID after a definitive rejection.
  const workflowProviderRunId = context.run?.runId && durableChannelDelivery && channelDeliveryBinding.steer
    ? `${context.run.runId}:${channelDeliveryBinding.steer.claimId}${options.fresh ? `:${crypto.randomUUID()}` : ""}`
    : context.run?.runId
  const workflowRunId = context.run?.runId && (!options.fresh || durableChannelDelivery)
    ? exclusive && (workflowConfig && workflowConfig.provider) === "vercel"
      ? undefined
      : workflowConfig && workflowConfig.provider === "cloudflare"
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
          ...(agentInvocationName(agent, context) ? { agentName: agentInvocationName(agent, context) } : {}),
          runId,
          sourceRunId,
          workflowName,
        },
        ...(context.trace ? { trace: context.trace } : {}),
      }, (workflowConfig && workflowConfig.provider) === "vercel" ? {} : { id: recoveryId }))
      return true
    }
    catch {
      return false
    }
  }
  let run: AgentWorkflowRun<AgentWorkflowOutput<TOutput>>
  if (replayJournal) {
    // A replay can be cancelled after reserving the journal but before the
    // provider accepts the Workflow run. Observe the durable request before
    // handing the claim to the provider.
    try {
      await replayJournal.watchCancellation(invocationCancellationDriver(agent))
      replayJournal.abortSignal.throwIfAborted()
      if (!await replayJournal.prepareWorkflowDispatch({ name: workflowName, provider: (workflowConfig && workflowConfig.provider) || "unknown" })) {
        throw new Error("Could not persist the Workflow dispatch intent.")
      }
      payload.invocationClaimToken = await replayJournal.handoffClaim({ workflowDispatch: true })
      if (!payload.invocationClaimToken) throw new Error("Could not transfer the Invocation execution claim.")
    }
    catch (error) {
      await recordPreparationFailure(error)
      throw error
    }
  }
  try {
    // Storage handoff can yield after cancellation was requested. Check the
    // journal signal at the last possible point before accepting the run.
    replayJournal?.abortSignal.throwIfAborted()
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    run = await workflowRuntimeState.runWithWorkflowRuntimeEvent(workflowEvent, () => handle.run(
      payload,
      workflowRunId ? { id: workflowRunId } : {},
    )) as AgentWorkflowRun<AgentWorkflowOutput<TOutput>>
  }
  catch (error) {
    const status = invocationFailureWasCancelled(error, input.abortSignal) || invocationFailureWasCancelled(error, replayJournal?.abortSignal) ? "cancelled" : "failed"
    await activity?.update(status, error)
    const ambiguous = Boolean(replayJournal && (workflowConfig && workflowConfig.provider) === "vercel" && inputHandedOff)
      || isAmbiguousAgentWorkflowStartFailure(error)
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
        }, { agentName: agentInvocationName(agent, context), deferClaim: ambiguous, terminalTakeover: true })
        if (!ambiguous) await invocationJournal?.finish(status, error)
      }
    }
    throw error
  }
  const dispatchConfirmed = replayJournal
    ? await replayJournal.confirmWorkflowDispatch({ name: workflowName, provider: run.provider, id: run.id })
    : true
  if (replayJournal && run.provider !== "vercel" && !dispatchConfirmed) {
    const record = context.run?.runId && agent.invocations
      ? await agent.invocations.getByRunId(context.run.runId, agentInvocationName(agent, context))
      : undefined
    if (record?.annotations?.[pendingAgentInvocationAnnotation] !== false) {
      throw new Error("Could not confirm the Workflow Invocation dispatch.")
    }
  }
  if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") {
    await activity?.update(
      run.status,
      run.status === "failed" ? run.metadata : undefined,
      run.status === "completed" ? finalTextFromAgentOutput(run.result) : undefined,
    )
  }
  const settled = run.status === "cancelled" || run.status === "completed" || run.status === "failed"
    ? Promise.resolve()
    : workflowSettlementTasks.length
      ? Promise.allSettled(workflowSettlementTasks).then(() => undefined)
      : undefined
  const started: StartedAgentWorkflow<CALL_OPTIONS, AgentWorkflowOutput<TOutput>> = { activity, handle, run }
  if (settled) started.settled = settled
  // Vercel's native Workflow owns durable suspension, but arbitrary Agent Definitions cannot
  // be compiled into that deterministic bundle. Its journal begins in the Agent worker instead.
  let invocationJournal: AgentInvocationJournal<TRuntimeConfig> | undefined
  if (hasAgentDefinition(agent) && agent.invocations && (run.provider !== "vercel" || replayJournal)) {
    const snapshot = agentInvocationSnapshotFromWorkflow(run)
    if (!snapshot || (snapshot.status !== "cancelled" && snapshot.status !== "completed" && snapshot.status !== "failed")) {
      const sourceRunId = options.fresh && !durableChannelDelivery ? run.id : context.run?.runId ?? run.id
      if (!await deferRecovery(run.id, sourceRunId)) return started
    }
    invocationJournal = await bindAgentInvocations(agent.invocations, {
      ...context,
      run: { ...context.run, runId: options.fresh && !durableChannelDelivery ? run.id : context.run?.runId ?? run.id },
    }, { agentName: agentInvocationName(agent, context), deferClaim: true, terminalTakeover: true })
    if (snapshot?.status === "cancelled" || snapshot?.status === "completed" || snapshot?.status === "failed") {
      await invocationJournal?.finish(snapshot.status, snapshot.error)
    }
  }
  if (invocationJournal) started.invocationJournal = invocationJournal
  return started
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
  return createExecutionContext(context) as ResolvedAgentRuntimeContext<TRuntimeConfig>
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
  intent: Pick<AgentChannelDeliveryEffectIntent, "kind">,
): readonly AgentChannelDeliveryEffectHandler<TRuntimeConfig>[] {
  // A Channel message method also handles delivery intents of the same name, such as `event.reply()`.
  const method = channel.message?.methods?.[intent.kind]
  if (method) {
    return [async ({ effect, finish: _finish, ...context }) => {
      const message = await channelMessageData(
        channel,
        context.trigger?.channelId || channel.kind,
        context.context,
        context.context.get("agent.trigger") !== undefined,
      )
      await channelMessageMethodHandler(method)({ ...context, message }, channelMessageIntentInput(effect))
    }]
  }
  const handlers = channel[channelDeliveryHandlers]?.[intent.kind]
  if (!handlers) return []
  return hasRuntimeType(handlers, "function") ? [handlers] : [...handlers]
}

/** Read the trigger's message data and validate it with the Channel's `message.data` schema. */
async function channelMessageData<TRuntimeConfig extends AgentRuntimeConfig>(
  channel: AgentChannelDefinition<TRuntimeConfig>,
  channelId: string,
  context: AgentInvocationContextStore,
  validateMissing = true,
): Promise<unknown> {
  const stored = context.get(channelMessageContextKey)
  const schema = channel.message?.data
  // Direct runAgent() delivery has no inbound Channel message to validate. The
  // delivery method still handles event.reply(), while event.message remains undefined.
  if (stored === undefined && !validateMissing) return
  return schema
    ? await parseStandardSchema(schema, stored, `Channel "${channelId}" message data`)
    : stored
}

function channelMessageMethodHandler<TRuntimeConfig extends AgentRuntimeConfig>(
  method: AgentChannelMessageMethod<TRuntimeConfig>,
): (context: AgentChannelMessageContext<TRuntimeConfig>, ...args: unknown[]) => unknown {
  // SAFETY: Message method arguments come from the typed handle or from a delivery intent for the same method name.
  return (hasRuntimeType(method, "function") ? method : method.handler) as (context: AgentChannelMessageContext<TRuntimeConfig>, ...args: unknown[]) => unknown
}

/** Restore reply artifacts that intent creation moved out of the reply input. */
function channelMessageIntentInput(intent: AgentChannelDeliveryEffectIntent): unknown {
  if (intent.kind !== "reply" || !intent.artifacts?.length || isAsyncIterable(intent.payload)) return intent.payload
  if (hasRuntimeType(intent.payload, "string")) return { artifacts: intent.artifacts, markdown: intent.payload }
  const input = isRuntimeRecord(intent.payload) ? { ...intent.payload } : {}
  input.artifacts = intent.artifacts
  return input
}

/** Readable call text for the trace, such as `label({"add":["Receipts"]})`. */
function channelMessageCallContent(name: string, args: readonly unknown[]): string {
  const text = args.map((arg) => {
    try {
      return JSON.stringify(arg) ?? String(arg)
    }
    catch {
      return String(arg)
    }
  }).join(", ")
  return `${name}(${text})`
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

type ActiveAgentActivity = {
  event(event: StreamEvent): Promise<void>
  update(status: AgentActivityStatus, error?: unknown, summary?: string): Promise<void>
}

function agentActivityTasks(value: unknown): AgentActivityTask[] | undefined {
  if (!isRuntimeRecord(value) || !Array.isArray(value.plan)) return
  return value.plan.flatMap((item) => {
    if (!isRuntimeRecord(item)) return []
    const title = [item.step, item.title, item.description].find(value => hasRuntimeType(value, "string") && value.trim())
    if (!hasRuntimeType(title, "string")) return []
    const rawStatus = hasRuntimeType(item.status, "string") ? item.status.replaceAll(/[^a-z]/gi, "").toLowerCase() : "pending"
    const status = rawStatus === "completed" || rawStatus === "complete" || rawStatus === "done"
      ? "completed"
      : rawStatus === "inprogress" || rawStatus === "running" || rawStatus === "active"
        ? "in-progress"
        : "pending"
    return [{ status, title: title.trim() } satisfies AgentActivityTask]
  })
}

function createActiveAgentActivity<TRuntimeConfig extends AgentRuntimeConfig>(
  definition: AgentDefinition<TRuntimeConfig> | undefined,
  context: AgentRuntimeContext<TRuntimeConfig>,
): ActiveAgentActivity | undefined {
  const run = context.run
  const channel = run?.channelId ? definition?.channels?.[run.channelId] : undefined
  if (!run?.activity || !channel?.activity) return
  const initialStatus: AgentActivityStatus = "queued"
  const initialTasks: AgentActivityTask[] = []
  let state: {
    agentName?: string
    links: AgentActivityUpdate["links"]
    runId: string
    status: AgentActivityStatus
    startedAt?: string
    summary: string
    tasks: AgentActivityTask[]
  } = {
    agentName: definition?.name || context.agentIdentity?.name,
    links: [...run.activity.links || []],
    runId: run.activity.runId || run.runId,
    status: initialStatus,
    summary: "",
    tasks: initialTasks,
  }
  let delivery = Promise.resolve()
  let lastSnapshot: string | undefined
  const pendingInputRequests = new Set<string>()
  const publish = async (status: AgentActivityStatus, error?: unknown, summary?: string) => {
    if (summary) state.summary = summary.slice(-12_000)
    if (status === "running" && !state.startedAt) state.startedAt = new Date().toISOString()
    state = { ...state, status }
    const snapshot = {
      ...state,
      ...(error === undefined ? {} : { error: agentErrorMessage(error) }),
      ...(state.summary ? { summary: state.summary } : {}),
      tasks: [...state.tasks],
    }
    const fingerprint = JSON.stringify(snapshot)
    if (fingerprint === lastSnapshot) return
    lastSnapshot = fingerprint
    delivery = delivery.catch(() => {}).then(async () => {
      try {
        await channel.activity!.update({
          ...createAgentCallbackContext(context),
          activity: { ...snapshot, updatedAt: new Date().toISOString() },
          channel,
          target: run.activity!.target,
        })
      }
      catch (deliveryError) {
        if (lastSnapshot === fingerprint) lastSnapshot = undefined
        console.error(agentDiagnostics.AGENT_R0423({ message: "[vitehub] Agent activity delivery failed.", cause: deliveryError }))
      }
    })
    try {
      context.waitUntil?.(delivery)
    }
    catch (waitUntilError) {
      console.error(agentDiagnostics.AGENT_R0424({ message: "[vitehub] Agent activity delivery could not be retained.", cause: waitUntilError }))
    }
  }
  return {
    async event(event) {
      if (event.type === "text-delta" && event.phase !== "commentary" && event.role !== "user") {
        state.summary = `${state.summary}${event.text}`.slice(-12_000)
        return
      }
      if (event.type === "data-agent-plan") {
        const tasks = agentActivityTasks(event.data)
        if (tasks) state.tasks = tasks
        await publish(state.status === "waiting" ? "waiting" : "running")
        return
      }
      if (event.type === "approval-request") {
        pendingInputRequests.add(`approval:${event.id}`)
        await publish("waiting")
      }
      else if (event.type === "data-agent-input" && isRuntimeRecord(event.data) && event.data.status === "requested") {
        const requestId = hasRuntimeType(event.data.requestId, "string") ? event.data.requestId : undefined
        if (requestId) pendingInputRequests.add(`input:${requestId}`)
        await publish("waiting")
      }
      else if (event.type === "approval-decision") {
        pendingInputRequests.delete(`approval:${event.id}`)
        await publish(pendingInputRequests.size ? "waiting" : "running")
      }
      else if (event.type === "data-agent-input" && isRuntimeRecord(event.data) && event.data.status === "resolved") {
        const requestId = hasRuntimeType(event.data.requestId, "string") ? event.data.requestId : undefined
        if (requestId) pendingInputRequests.delete(`input:${requestId}`)
        await publish(pendingInputRequests.size ? "waiting" : "running")
      }
    },
    update: publish,
  }
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
      ...(active?.channelId ? { "channel.effect.channel": active.channelId } : {}),
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

    if (context.input.dryRun) {
      const recorded = await dryRunDeliveryIntent(intent)
      const traceMetadata: Record<string, unknown> = { ...metadata }
      if (recorded.kind !== "reply") {
        traceMetadata["channel.effect.content"] = channelMessageCallContent(recorded.kind, recorded.payload === undefined ? [] : [recorded.payload])
      }
      await traceAgentChannelDeliveryEffect(toTraceContext(context), recorded, {
        ...traceMetadata,
        "channel.effect.skipped": "dry-run",
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
      let streamedReplyContent = ""
      let streamedReplyContentTruncated = false
      const deliveredIntent = intent.kind === "reply" && isAsyncIterable(intent.payload)
        ? {
            ...intent,
            payload: {
              [Symbol.asyncIterator]() {
                // SAFETY: isAsyncIterable establishes the asserted stream contract above.
                const iterator = (intent.payload as AsyncIterable<string>)[Symbol.asyncIterator]()
                return {
                  async next() {
                    const result = await iterator.next()
                    if (result.done) return result
                    const chunk = result.value
                    if (streamedReplyContent.length < 16 * 1024) {
                      const remaining = 16 * 1024 - streamedReplyContent.length
                      streamedReplyContent += chunk.slice(0, remaining)
                      if (chunk.length > remaining) streamedReplyContentTruncated = true
                    }
                    else if (chunk.length > 0) streamedReplyContentTruncated = true
                    return result
                  },
                  async return() {
                    return await iterator.return?.() ?? { done: true, value: undefined }
                  },
                  async throw(error?: unknown) {
                    if (iterator.throw) return await iterator.throw(error)
                    throw error
                  },
                }
              },
            } satisfies AsyncIterable<string>,
          }
        : intent
      let handlerCompleted = false
      const deliveryEffectContext = {
        ...context.runtimeContext,
        channel: active.channel,
        context: context.context,
        effect: deliveredIntent,
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
      }
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
          await handler(deliveryEffectContext)
          const deliveredContent = messageChannelDeliveredReplyBody(deliveryEffectContext)
            ?? (intent.kind === "reply" ? streamedReplyContent || messageChannelReplyBody({ effect: deliveredIntent }) : undefined)
          const deliveredContentTruncated = streamedReplyContentTruncated
            || (deliveredContent !== undefined && deliveredContent.length > 16 * 1024)
          const deferredTrace = intent.kind === "reply" && registerMessageChannelDeferredReplyTrace(deliveryEffectContext, async (capture) => {
            await traceAgentChannelDeliveryEffect(toTraceContext(context), deliveredIntent, {
              ...metadata,
              "channel.effect.content": capture.content,
              ...(capture.error ? { "error.message": capture.error } : {}),
              ...(capture.skipped ? { "channel.effect.skipped": capture.skipped } : {}),
              ...(capture.truncated ? { "vitehub.observation.truncated": true } : {}),
            })
          })
          if (!deferredTrace) {
            await traceAgentChannelDeliveryEffect(toTraceContext(context), deliveredIntent, {
              ...metadata,
              ...(deliveredContent !== undefined ? { "channel.effect.content": deliveredContent.slice(0, 16 * 1024) } : {}),
              ...(deliveredContentTruncated ? { "vitehub.observation.truncated": true } : {}),
            })
          }
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
        const deliveredContent = messageChannelDeliveredReplyBody(deliveryEffectContext)
          ?? (intent.kind === "reply" ? streamedReplyContent || messageChannelReplyBody({ effect: deliveredIntent }) : undefined)
        await traceAgentChannelDeliveryEffect(toTraceContext(context), deliveredIntent, {
          ...metadata,
          "error.message": agentErrorMessage(error),
          ...(deliveredContent !== undefined ? { "channel.effect.content": deliveredContent.slice(0, 16 * 1024) } : {}),
          ...(streamedReplyContentTruncated || (deliveredContent !== undefined && deliveredContent.length > 16 * 1024)
            ? { "vitehub.observation.truncated": true }
            : {}),
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

/** A dry run reads a streamed reply so the trace can show the text that was not sent. */
async function dryRunDeliveryIntent(intent: AgentChannelDeliveryEffectIntent): Promise<AgentChannelDeliveryEffectIntent> {
  if (!isAsyncIterable(intent.payload)) return intent
  let text = ""
  for await (const chunk of intent.payload) {
    if (hasRuntimeType(chunk, "string") && text.length < 16 * 1024) text += chunk.slice(0, 16 * 1024 - text.length)
  }
  return { ...intent, payload: text }
}

async function createChannelMessageHandle<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  finish: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>,
): Promise<AgentChannelMessage | undefined> {
  const trigger = context.context.get("agent.trigger")
  if (!trigger?.channelId && context.context.get(channelMessageContextKey) === undefined) return
  const active = activeAgentChannel(context.channels, context.context, trigger?.channelId ? undefined : context.run)
  if (!active) return
  const data = await channelMessageData(active.channel, active.channelId, context.context)
  const delivery = createFinishDeliveryEffectContext(finish, context)
  const builtIn: Record<string, (input: never) => AgentChannelDeliveryEffectIntent> = {
    reaction: delivery.reaction,
    reply: delivery.reply,
    status: delivery.status,
  }
  const calls: Record<string, (...args: unknown[]) => Promise<unknown>> = Object.create(null)
  for (const [name, create] of Object.entries(builtIn)) {
    if (!active.channel[channelDeliveryHandlers]?.[name]) continue
    calls[name] = async (input) => {
      // SAFETY: The typed handle passes the built-in method input for this intent kind.
      await applyChannelDeliveryEffectIntents(context, [create(input as never)], finish)
    }
  }
  for (const [name, method] of Object.entries(active.channel.message?.methods || {})) {
    calls[name] = async (...args) => await callChannelMessageMethod(context, active, name, method, data, args)
  }
  return Object.freeze({
    ...calls,
    channel: active.channelId,
    data,
    kind: active.channel.kind,
  })
}

async function callChannelMessageMethod<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  active: { channel: AgentChannelDefinition<TRuntimeConfig>, channelId: string, trigger?: { id?: string, name?: string } },
  name: string,
  method: AgentChannelMessageMethod<TRuntimeConfig>,
  data: unknown,
  args: unknown[],
): Promise<unknown> {
  const read = !hasRuntimeType(method, "function")
  const traceIntent: AgentChannelDeliveryEffectIntent = { kind: name }
  const metadata = {
    "channel.effect.content": channelMessageCallContent(name, args),
    "channel.effect.kind": name,
    "channel.effect.supported": true,
    "channel.effect.read": read,
  }
  if (!read && context.input.dryRun) {
    await traceAgentChannelDeliveryEffect(toTraceContext(context), traceIntent, {
      ...metadata,
      "channel.effect.skipped": "dry-run",
    })
    return undefined
  }
  const { runtimeConfig: _runtimeConfig, ...callbackContext } = context.runtimeContext
  const messageContext: AgentChannelMessageContext<TRuntimeConfig> = {
    ...callbackContext,
    channel: active.channel,
    context: context.context,
    input: context.input,
    message: data,
    request: context.runtimeContext.request,
    run: context.run,
    trigger: {
      channelId: active.channelId,
      ...(active.trigger?.id ? { id: active.trigger.id } : {}),
      ...(active.trigger?.name ? { name: active.trigger.name } : {}),
    },
    workspace: context.workspace,
  }
  try {
    const result = await runObservedAgentHook(context.hooks, {
      ids: { channelId: active.channelId, runId: context.run?.runId },
      metadata: { "channel.effect.kind": name, "channel.effect.read": read },
      name: "channel:message",
      owner: "channel",
      phase: "message",
    }, async () => {
      if (!read) await agentChannelDeliveryOwnershipVerifier(context.runtimeContext)?.()
      return await channelMessageMethodHandler(method)(messageContext, ...args)
    })
    await traceAgentChannelDeliveryEffect(toTraceContext(context), traceIntent, metadata)
    return result
  }
  catch (error) {
    await traceAgentChannelDeliveryEffect(toTraceContext(context), traceIntent, {
      ...metadata,
      "error.message": agentErrorMessage(error),
    })
    throw error
  }
}

export { applyAgentToolPolicies, withAgentToolStepReporting } from "./tool-runtime.ts"
export { inspectAgentTools } from "./tool-inspection.ts"
export { defineCapability } from "./capability-runtime.ts"
export { agentWithSkills } from "./internal/colocated-agent-skills.ts"
export { isResolvedAgentTriggerHandledInvocation, verifyAgentWebhookRequest } from "./trigger-runtime.ts"
export type { AgentWebhookVerificationResult, ResolvedAgentTriggerHandledInvocation, ResolvedAgentTriggerInvocation, ResolvedAgentTriggerInvocationResult } from "./trigger-runtime.ts"
export * from "./messages.ts"
export { ask } from "./ask.ts"
export type {
  AskAnswer,
  AskAnswers,
  AskChanceAnswer,
  AskChanceCriteria,
  AskChanceQuestion,
  AskChoiceAnswer,
  AskChoiceCriteria,
  AskChoiceLabels,
  AskChoiceQuestion,
  AskEntry,
  AskIfQuestion,
  AskJson,
  AskQuestion,
  AskQuestions,
  AskScoreAnswer,
  AskScoreCriteria,
  AskScoreQuestion,
  AskSwitchQuestion,
} from "./ask.ts"
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
      ? (() => {
          const resolved = input()
          if (resolved && hasRuntimeType(resolved, "object") && "kind" in resolved) return resolved
          // SAFETY: Each built-in constructor validates the callback configuration selected by its channel key.
          return id === "discord" ? builtInDiscord<TRuntimeConfig>(resolved as never)
            // SAFETY: The constructor validates the GitHub callback configuration.
            : id === "github" ? builtInGitHub<TRuntimeConfig>(resolved as never)
              // SAFETY: The constructor validates the HTTP callback configuration.
              : id === "http" ? builtInHttp<TRuntimeConfig>(resolved as never)
                // SAFETY: The constructor validates the Slack callback configuration.
                : id === "slack" ? builtInSlack<TRuntimeConfig>(resolved as never)
                  // SAFETY: The constructor validates the Teams callback configuration.
                  : id === "teams" ? builtInTeams<TRuntimeConfig>(resolved as never)
                    // SAFETY: The constructor validates the Telegram callback configuration.
                    : id === "telegram" ? builtInTelegram<TRuntimeConfig>(resolved as never)
                      // SAFETY: The constructor validates the web chat callback configuration.
                      : id === "webChat" ? builtInWebChat<TRuntimeConfig>(resolved as never)
                        : undefined
        })()
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
      throw agentDiagnostics.AGENT_R0425({ message: hasRuntimeType(input, "function")
        ? `[vitehub] Channel factory "${id}" must return an Agent Channel definition.`
        : `[vitehub] Channel "${id}" must be an Agent Channel definition or use a built-in Channel name.` })
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

/** Check Agent Box combinations that cannot run the provider inside the Box. */
function validateAgentBox(
  box: unknown,
  driver: { readonly credentialProfile?: unknown, readonly credentials?: unknown, readonly kind: string, readonly launch?: unknown, readonly toolchain?: unknown },
  options: { hasWorkspace: boolean },
) {
  if (!hasRuntimeType(box, "object") || box === null || !("runtime" in box) || box.runtime === undefined) {
    throw agentDiagnostics.AGENT_R0954({ message: "[vitehub] defineAgent({ box }) requires a Box definition with a runtime." })
  }
  if (driver.kind !== "provider") {
    throw agentDiagnostics.AGENT_R0955({ message: "[vitehub] defineAgent({ box }) requires a built-in provider Driver such as { kind: \"codex\" } or { kind: \"claude-code\" }." })
  }
  if (driver.launch !== undefined) {
    throw agentDiagnostics.AGENT_R0956({ message: "[vitehub] defineAgent({ box }) cannot be combined with driver.launch. The Box starts the provider." })
  }
  if (driver.credentials !== undefined || driver.credentialProfile !== undefined) {
    throw agentDiagnostics.AGENT_R0957({ message: "[vitehub] defineAgent({ box }) cannot be combined with driver.credentials or driver.credentialProfile. Write provider credentials with box.home.files or box.env." })
  }
  if (driver.toolchain !== undefined) {
    throw agentDiagnostics.AGENT_R0972({ message: "[vitehub] defineAgent({ box }) cannot be combined with driver.toolchain. Declare box.toolchain so the Box provisions it." })
  }
  if (options.hasWorkspace) {
    throw agentDiagnostics.AGENT_R…56790 tokens truncated…izeRawStreams)) {
          const value = withCapabilityCleanup(streamed.stream, async (outcome) => {
            const finishResult = await streamed.finishResult(result, !outcome.failed && outcome.completed === true)
            const finishOutcome = finishOutcomeFromCleanup(outcome, finishResult)
            const usage = streamed.finishUsage()
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
      throw streamError ?? agentDiagnostics.AGENT_R0438({ message: event.error })
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
    tools?: AgentToolSet
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
  invocationTools?: AgentToolSet,
): Promise<AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS>> {
  try {
    return await createAgentInvocationContext(definition, context, input, kind, invocationJournal, invocationTools)
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
  activity?: ActiveAgentActivity,
): Promise<Response | AsyncIterable<StreamEvent> | unknown> {
  const customRun = hasCustomRun<TRuntimeConfig, CALL_OPTIONS>(agent)
  const definition = hasAgentDefinition(agent)
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    ? asUnknownBoundary(agent) as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, any, any, TOutput>
    : undefined
  const invocation = preparedInvocation
    ?? await createAgentInvocationContextWithWorkflowFailureDelivery(definition, context, input, options.kind, invocationJournal, options.tools)
  invocation.activity = activity
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
  if (invocation.handledResponse || invocation.intercepted) {
    options.onCapacityBypass?.()
    const handled = invocation.intercepted ? invocation.intercepted.value : invocation.handledResponse
    return await finalizeAgentInvocationResult(invocation, lifecycle, handled, async result => ({ finishResult: result, value: result }), handledFailureMessage, {
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
    await invocationJournal?.watchCancellation(invocationCancellationDriver(definition))
    invocation.input.abortSignal?.throwIfAborted()
    invocationJournal?.driverStarted()
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

  // A required delivery Capability can ask for bounded reminder turns before
  // the finish lifecycle checks delivery. The Capability owns the check and
  // the turn budget; this loop runs the same Driver again.
  if (options.kind === "run" && invocation.finishDeliveryReminderProviders.length) {
    try {
      let transcript: Message[] | undefined
      for (const provider of invocation.finishDeliveryReminderProviders) {
        while (isSettledAgentResult(result)) {
          const reminder = provider.next(invocation.context)
          if (!reminder) break
          invocation.input.abortSignal?.throwIfAborted()
          const previousText = finalTextFromAgentOutput(result)?.trim() || undefined
          transcript = deliveryReminderTranscript(invocation, transcript, previousText, reminder.instruction)
          await traceAgentChannelDeliveryReminder(toTraceContext(invocation), {
            "capability.id": provider.capabilityId,
            "channel.delivery.reminder.previous.textLength": previousText?.length ?? 0,
            "channel.delivery.reminder.tool": provider.tool,
            "channel.delivery.reminder.turn": reminder.turn,
            "channel.delivery.reminder.turns": reminder.turns,
            ...deliveryReminderUsageAttributes(result),
          })
          const input = { ...invocation.input, messages: transcript, prompt: transcript }
          if (customRun) {
            const original = { input: invocation.input, messages: invocation.messages, prompt: invocation.prompt }
            invocation.input = input
            invocation.messages = transcript
            invocation.prompt = undefined
            try {
              result = await agent.run(invocation)
            }
            finally {
              invocation.input = original.input
              invocation.messages = original.messages
              invocation.prompt = original.prompt
            }
          }
          else {
            const reminderContext = toAgentAdapterRunContext(invocation)
            reminderContext.input = input
            reminderContext.messages = transcript
            reminderContext.prompt = undefined
            if (!options.renderOutput) reminderContext.nativeStructuredOutput = false
            // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
            result = await adapter!.generate(reminderContext as never)
          }
        }
      }
    }
    catch (error) {
      return await lifecycle.fail({ error, status: "error" }, error, executionFailureMessage)
    }
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
  const rawDriverResult = result
  const rawDriverUsageObserved = isAsyncIterable(result)
  const rawDriverHasDeferredUsage = rawDriverUsageObserved && hasRuntimeType(rawDriverResult, "object") && rawDriverResult !== null && ["usage", "totalUsage"].some((property) => {
    try {
      const usage = Reflect.get(rawDriverResult, property)
      if (!isRuntimeObject(usage)) return false
      if (!hasRuntimeType(Reflect.get(usage, "then"), "function")) return false
      void Promise.resolve(usage).catch(() => {})
      return true
    }
    catch {
      return false
    }
  })
  let rawDriverUsageRecord = rawDriverUsageObserved
    ? toAgentRunResult(await resultWithStreamedTextAndUsage(result, "")).usageRecord
    : undefined
  let renderedResult = false
  let rendererSource: ReturnType<typeof nonBlockingPendingAsyncIterableSource> | undefined
  const resolveRawDriverUsageRecord = async (resolveUsage: boolean) => {
    rawDriverUsageRecord = toAgentRunResult(await resultWithStreamedTextAndUsage(
      rawDriverResult,
      "",
      undefined,
      rawDriverUsageRecord,
      resolveUsage,
    )).usageRecord
    return rawDriverUsageRecord
  }
  try {
    const shouldRenderStream = options.kind === "run"
      ? customRun && options.renderOutput && isAsyncIterable(result)
      : isAsyncIterable(result) && !invocation.finalOutputRenderers.length
    if (shouldRenderStream) {
      rendererSource = shouldHoldInvocationOutput() && invocation.outputRenderers.length && !isUIMessageStreamResult(result)
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        ? nonBlockingPendingAsyncIterableSource(result as AsyncIterable<unknown>)
        : undefined
      result = await applyOutputRenderers(rendererSource?.stream ?? result, invocation.outputRenderers, invocation.outputExtensionProviders, outputExtensions)
      if (rendererSource && !isAsyncIterable(result) && !hasTraceableStreamResult(result) && !isUIMessageStreamResult(result)) {
        await rendererSource.settleCancellation()
      }
      renderedResult = true
      if (rendererSource?.completed) {
        await resolveRawDriverUsageRecord(true)
      }
    }
  }
  catch (error) {
    await Promise.allSettled(rendererSource ? [rendererSource.settleCancellation(error)] : [])
    return await lifecycle.fail({ error, status: "error" }, error, executionFailureMessage)
  }

  if (options.kind === "run") {
    return await finalizeAgentInvocationResult(invocation, lifecycle, result, async (result) => {
      const driverUsageRecord = rawDriverUsageObserved ? rawDriverUsageRecord : (hasTraceableStreamResult(result) || isUIMessageStreamResult(result)
        ? undefined
        : await resolveFinishUsageRecord(invocation, result)
      )
      const driverUsageFallback = rawDriverUsageObserved ? resolveRawDriverUsageRecord : driverUsageRecord
      const rendered = options.renderOutput
        ? renderedResult ? result : await applyOutputRenderers(result, invocation.outputRenderers, invocation.outputExtensionProviders, outputExtensions)
        : result
      const shouldPreserveStreamResult = (hasTraceableStreamResult(rendered) || isUIMessageStreamResult(rendered))
        && !(options.renderOutput && invocation.output)
        && (options.holdCapacity === true
          || (hasFinishConsumer(invocation)
            && rendered !== rawDriverResult
            && (rawDriverHasDeferredUsage || isUIMessageStreamResult(rendered)))
          || (invocation.finishHook
            && !invocation.finishDeliveryEffectProviders.length
            && !invocation.finishExtensionProviders.length
            && rendered === rawDriverResult)
          || invocation.finishExtensionProviders.some(provider => provider.eager))
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
            finishTask = (async () => {
              const resolveUsage = !outcome.failed && outcome.completed === true
              const resolvedDriverUsageRecord = hasRuntimeType(driverUsageFallback, "function")
                ? await driverUsageFallback(resolveUsage)
                : driverUsageFallback
              const finishResult = await resultWithStreamedTextAndUsage(preserved, streamedText, streamedUsageRecord, resolvedDriverUsageRecord, resolveUsage)
              const finishUsageRecord = finishResult && hasRuntimeType(finishResult, "object")
                // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
                ? (finishResult as { usageRecord?: AgentUsageRecord }).usageRecord
                : undefined
              if (!outcome.failed && !outcome.completed) {
                const lifecycleOutcome: Parameters<typeof lifecycle.finish>[0] = {
                  result: finishResult,
                  status: "cancelled",
                  usageResolved: true,
                }
                if (finishUsageRecord) {
                  lifecycleOutcome.usage = await resolveAgentUsageRecord({ usageRecord: finishUsageRecord }, invocation.run)
                }
                await lifecycle.finish(lifecycleOutcome)
              }
              else {
                await finishStreamAgentInvocation(invocation, lifecycle, finishResult, finishOutcomeFromCleanup(outcome), runFailureMessage, outputExtensions)
              }
              const finalizedUsageRecord = finishResult && hasRuntimeType(finishResult, "object")
                ? toAgentRunResult(finishResult).usageRecord
                : finishUsageRecord
              assignResolvedUsageRecord(preserved, finalizedUsageRecord)
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
                if (finishTask) throw agentDiagnostics.AGENT_R0439({ message: "[vitehub] Agent Invocation output has already finished." })
                if (uiMessageStreamCreated) throw agentDiagnostics.AGENT_R0440({ message: "[vitehub] Agent Invocation UI-message stream has already been created." })
                uiMessageStreamCreated = true
                invocation.input.abortSignal?.removeEventListener("abort", onAbort)
                let source: ReturnType<typeof nonBlockingPendingAsyncIterableSource>
                try {
                  source = nonBlockingPendingAsyncIterableSource(toUIMessageStream.apply(rendered, args))
                  const normalizedStream = normalizeUiMessageStream(toReadableAsyncIterableStream(source.stream))
                  const enrichedStream = withEagerStreamUsageExtensions(
                    toReadableAsyncIterableStream(normalizedStream),
                    invocation,
                    rendered,
                  )
                  const renderedStream = invocation.runtimeContext.traceLog || invocation.activity
                    ? traceUiMessageStream(toReadableAsyncIterableStream(enrichedStream), invocation)
                    : enrichedStream
                  return withReadableStreamCleanup(
                    toReadableAsyncIterableStream(renderedStream),
                    async (outcome) => {
                      if (!outcome.failed && !outcome.completed) {
                        const cancellationTask = Promise.all([
                          source.settleCancellation(),
                          ...(rendererSource ? [rendererSource.settleCancellation()] : []),
                        ]).then(
                          async () => await finishPreserved(outcome),
                          async error => await finishPreserved({ error, failed: true }),
                        )
                        const settled = await Promise.race([
                          cancellationTask.then(() => true, () => true),
                          new Promise<false>(resolve => setTimeout(() => resolve(false), 0)),
                        ])
                        if (settled) await cancellationTask
                        else void cancellationTask.catch(() => {})
                        return
                      }
                      try {
                        if (outcome.failed) await source.settleCancellation(outcome.error)
                      }
                      finally {
                        await finishPreserved(outcome)
                      }
                    },
                    {
                      abortSignal: invocation.input.abortSignal,
                      detachPendingReaderCancellation: true,
                      cancelOnAbort: async reason => {
                        await Promise.allSettled([
                          source.cancel(reason),
                          ...(rendererSource ? [rendererSource.cancel(reason)] : []),
                        ])
                      },
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
        const preservedSources = new Map<AsyncIterable<unknown>, ReturnType<typeof cancellableAsyncIterableSource> | undefined>()
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
            }
          }
        }
        catch (error) {
          await Promise.allSettled(
            [...preservedSources.values()].flatMap(source => source ? [source.cancel(error)] : []),
          )
          throw error
        }
        if (streamPropertyValues.size) {
          try {
            for (const stream of new Set(streamPropertyValues.values())) {
              preservedSources.set(stream, textStreamDescriptor || isUIMessageStreamResult(rendered)
                ? undefined
                : cancellableAsyncIterableSource(stream))
            }
          }
          catch (error) {
            await Promise.allSettled(
              [...preservedSources.values()].flatMap(source => source ? [source.cancel(error)] : []),
            )
            throw error
          }
        }
        const streamProperties = [...streamPropertyValues.keys()]
        let finishTask: Promise<void> | undefined
        let finishing = false
        let preserved: object
        const preservedStreams = new Map<AsyncIterable<unknown>, AsyncIterable<unknown>>()
        const preservedSource = (stream: AsyncIterable<unknown>) => {
          const existing = preservedSources.get(stream)
          if (existing) return existing
          const source = cancellableAsyncIterableSource(stream)
          preservedSources.set(stream, source)
          return source
        }
        const cancelPreservedSources = async (outcome: CapabilityCleanupOutcome): Promise<CapabilityCleanupOutcome> => {
          const reason = outcome.failed ? outcome.error : undefined
          const cancellations = await Promise.allSettled(options.holdCapacity === true
            ? [...preservedSources.keys()].map(async stream => await preservedSource(stream).cancel(reason))
            : [...preservedSources.values()].flatMap(source => source ? [source.cancel(reason)] : []))
          if (!cancellations.length) return outcome
          const rejected = cancellations.find((result): result is PromiseRejectedResult => result.status === "rejected")
          return rejected ? { error: rejected.reason, failed: true } : outcome
        }
        const onAbort = () => {
          const reason = invocation.input.abortSignal?.reason ?? new DOMException("[vitehub] Agent Invocation stream aborted.", "AbortError")
          finishing = true
          finishTask ||= (async () => {
            const outcome = await cancelPreservedSources({ error: reason, failed: true })
            await finishStreamAgentInvocation(invocation, lifecycle, preserved, finishOutcomeFromCleanup(outcome), runFailureMessage, outputExtensions)
          })()
          void finishTask.catch(() => {})
        }
        const preserveStream = (renderedStream: AsyncIterable<unknown>) => {
          const existing = preservedStreams.get(renderedStream)
          if (existing) return existing
          const source = preservedSource(renderedStream)
          const enrichedStream = withEagerStreamUsageExtensions(source.stream, invocation, rendered)
          const streamed = withStreamedResult(enrichedStream, rendered, driverUsageFallback, invocation.toolResults, invocation.tools)
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          const tracedStream = maybeTraceAgentStream(streamed.stream as AsyncIterable<StreamEvent>, invocation)
          const value = withCapabilityCleanup(tracedStream, async (outcome) => {
            invocation.input.abortSignal?.removeEventListener("abort", onAbort)
            finishing = true
            const finalOutcome = await cancelPreservedSources(outcome)
            const cancellationFailed = finalOutcome.failed && !outcome.failed
            if (finishTask) return await finishTask
            const finishResult = await streamed.finishResult(preserved, !finalOutcome.failed && finalOutcome.completed === true)
            finishTask = (async () => {
              const finishUsageRecord = streamed.finishUsage()
              if (!finalOutcome.failed && !finalOutcome.completed) {
                const lifecycleOutcome: AgentInvocationFinishOutcome = {
                  result: finishResult,
                  status: "cancelled",
                  usageResolved: true,
                }
                if (finishUsageRecord) {
                  lifecycleOutcome.usage = await resolveAgentUsageRecord({ usageRecord: finishUsageRecord }, invocation.run)
                }
                await finishStreamAgentInvocation(invocation, lifecycle, finishResult, lifecycleOutcome, runFailureMessage, outputExtensions)
              }
              else {
                await finishStreamAgentInvocation(invocation, lifecycle, finishResult, finishOutcomeFromCleanup(finalOutcome), runFailureMessage, outputExtensions)
              }
              assignResolvedUsageRecord(preserved, finishUsageRecord)
              if (cancellationFailed) throw finalOutcome.error
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
            let preservedStream: AsyncIterable<unknown> | undefined
            descriptors[property] = {
              configurable: true,
              enumerable: true,
              get: () => {
                preservedStream ??= preserveStream(streamPropertyValues.get(property)!)
                return preservedStream
              },
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
                if (finishing || finishTask) throw agentDiagnostics.AGENT_R0441({ message: "[vitehub] Agent Invocation output has already finished." })
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
              if (finishing || finishTask) throw agentDiagnostics.AGENT_R0442({ message: "[vitehub] Agent Invocation output has already finished." })
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
                  : withStreamedResult(enrichedStream, rendered, driverUsageFallback, invocation.toolResults, invocation.tools)
                const tracedStream = existingStream
                  ? enrichedStream
                  : invocation.runtimeContext.traceLog || invocation.activity
                  ? traceUiMessageStream(toReadableAsyncIterableStream(streamed!.stream), invocation)
                  : streamed!.stream
                const source = existingSource
                  ? {
                      cancel: existingSource.cancel,
                      get completed() {
                        return existingSource.completed
                      },
                      stream: tracedStream,
                    }
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
                      ? finishStreamAgentInvocation(invocation, lifecycle, finishResult, {
                          result: finishResult,
                          status: "cancelled",
                          ...(streamed?.finishUsage()
                            ? { usage: await resolveAgentUsageRecord({ usageRecord: streamed.finishUsage() }, invocation.run) }
                            : {}),
                          usageResolved: true,
                        }, runFailureMessage, outputExtensions)
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
                if (finishing || finishTask) throw agentDiagnostics.AGENT_R0443({ message: "[vitehub] Agent Invocation output has already finished." })
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
        if (invocation.input.abortSignal?.aborted) onAbort()
        else invocation.input.abortSignal?.addEventListener("abort", onAbort, { once: true })
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
      fallbackUsageRecord: rawDriverUsageObserved ? resolveRawDriverUsageRecord : undefined,
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
    const driverUsageFallback = rawDriverUsageObserved ? resolveRawDriverUsageRecord : driverUsageRecord
    const rendered = renderedResult ? result : await applyOutputRenderers(result, invocation.outputRenderers, invocation.outputExtensionProviders, outputExtensions)
    if (options.output === "ui-message-stream") {
      const projection = hasRuntimeType(definition?.uiMessageStream, "function")
        ? await definition.uiMessageStream(invocation)
        : definition?.uiMessageStream
      let uiMessageSource: ReturnType<typeof nonBlockingPendingAsyncIterableSource> | undefined
      const uiMessageSources = new Map<AsyncIterable<unknown>, ReturnType<typeof nonBlockingPendingAsyncIterableSource>>()
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
              uiMessageSources.set(candidate, uiMessageSources.get(candidate) ?? nonBlockingPendingAsyncIterableSource(candidate))
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
                  uiMessageSource = uiMessageSources.get(stream) ?? nonBlockingPendingAsyncIterableSource(stream)
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
          uiMessageSource = nonBlockingPendingAsyncIterableSource(rendered)
          uiMessageSources.set(rendered, uiMessageSource)
          capacityRendered = uiMessageSource.stream
        }
      }
      else if (isUIMessageStreamResult(rendered)) {
        // SAFETY: Agent definition normalization establishes the asserted UI-message stream result contract.
        const toUIMessageStream = rendered.toUIMessageStream as (...args: unknown[]) => ReadableStream<unknown>
        capacityRendered = cloneWithPropertyDescriptors(rendered, {
          toUIMessageStream: {
            configurable: true,
            enumerable: false,
            value: (...args: unknown[]) => {
              const stream = toUIMessageStream.apply(rendered, args)
              uiMessageSource = uiMessageSources.get(stream) ?? nonBlockingPendingAsyncIterableSource(stream)
              uiMessageSources.set(stream, uiMessageSource)
              return toReadableAsyncIterableStream(uiMessageSource.stream)
            },
          },
        })
      }
      const enrichedRendered = isUIMessageStreamResult(capacityRendered)
        ? withEagerUiMessageStreamUsageExtensions(capacityRendered, invocation)
        : isAsyncIterable(capacityRendered)
          ? withEagerStreamUsageExtensions(capacityRendered, invocation, rendered)
          : capacityRendered
      const shouldWrapOutput = shouldHoldInvocationOutput()
      const collectToolResult = shouldWrapOutput ? agentToolResultStreamCollector(invocation.toolResults) : undefined
      const finishUiMessageStream = async (outcome: CapabilityCleanupOutcome, streamedText?: string, streamedUsageRecord?: AgentUsageRecord) => {
        const reason = outcome.failed ? outcome.error : undefined
        const uiSources = [...uiMessageSources.values()]
        await Promise.allSettled(uiSources.map(source => source.cancel(reason)))
        const settleUiSources = outcome.failed || outcome.completed || options.holdCapacity === true || !rendererSource
        const cancellations = await Promise.allSettled([
          ...(rendererSource ? [rendererSource.settleCancellation(reason)] : []),
          ...(settleUiSources ? uiSources.map(source => source.settleCancellation(reason)) : []),
        ])
        const rejected = cancellations.find((result): result is PromiseRejectedResult => result.status === "rejected")
        if (rejected) outcome = { error: rejected.reason, failed: true }
        const resolveUsage = !outcome.failed && outcome.completed === true
        const resolvedDriverUsageRecord = hasRuntimeType(driverUsageFallback, "function")
          ? await driverUsageFallback(resolveUsage)
          : driverUsageFallback
        const finishResult = await resultWithStreamedTextAndUsage(rendered, streamedText || "", streamedUsageRecord, resolvedDriverUsageRecord, resolveUsage)
        if (!outcome.failed && !outcome.completed) {
          const usage = finishResult && hasRuntimeType(finishResult, "object")
            ? toAgentRunResult(finishResult).usageRecord
            : undefined
          await finishStreamAgentInvocation(invocation, lifecycle, finishResult, {
            result: finishResult,
            status: "cancelled",
            usage,
            usageResolved: true,
          }, streamFailureMessage, outputExtensions)
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
      }
      const finalizationOptions: NonNullable<Parameters<typeof finalizeUiMessageStreamOutput>[3]> = {
        abortSignal: invocation.input.abortSignal,
        detachPendingReaderCancellation: options.holdCapacity !== true,
        cancelOnAbort: options.holdCapacity === true || rendererSource
          ? async reason => {
              await Promise.allSettled([
                ...(options.holdCapacity === true
                  ? [...uiMessageSources.values()].map(({ cancel }) => cancel(reason))
                  : []),
                ...(rendererSource ? [rendererSource.cancel(reason)] : []),
              ])
            }
          : undefined,
        projection,
      }
      if (collectToolResult) finalizationOptions.onNormalizedChunk = collectToolResult
      return finalizeUiMessageStreamOutput(maybeTraceUiMessageStreamOutput(enrichedRendered, invocation), shouldWrapOutput, async (outcome, streamedText, streamedUsageRecord) => {
        const finishTask = finishUiMessageStream(outcome, streamedText, streamedUsageRecord)
        if (!outcome.failed && !outcome.completed && options.holdCapacity !== true) {
          const settled = await Promise.race([
            finishTask.then(() => true, () => true),
            new Promise<false>(resolve => setTimeout(() => resolve(false), 0)),
          ])
          if (settled) await finishTask
          else void finishTask.catch(() => {})
          return
        }
        await finishTask
      }, finalizationOptions)
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
    const streamed = withStreamedResult(withEagerStreamUsageExtensions(source?.stream ?? stream, invocation, rendered), rendered, driverUsageFallback, invocation.toolResults, invocation.tools)
    // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
    const tracedStream = maybeTraceAgentStream(streamed.stream as AsyncIterable<StreamEvent>, invocation)
    const value = shouldWrapOutput
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      ? withCapabilityCleanup(tracedStream, async (outcome) => {
          const cancellations = await Promise.allSettled([...eagerStreamSources.values()].map(({ cancel }) => cancel(outcome.failed ? outcome.error : undefined)))
          const rejected = cancellations.find((result): result is PromiseRejectedResult => result.status === "rejected")
          if (rejected) outcome = { error: rejected.reason, failed: true }
          const finishResult = await streamed.finishResult(rendered, !outcome.failed && outcome.completed === true)
          const finishUsageRecord = streamed.finishUsage()
          if (!outcome.failed && !outcome.completed) {
            const usage = finishUsageRecord
              ? await resolveAgentUsageRecord({ usageRecord: finishUsageRecord }, invocation.run)
              : undefined
            await finishStreamAgentInvocation(invocation, lifecycle, finishResult, {
              result: finishResult,
              status: "cancelled",
              usage,
              usageResolved: true,
            }, streamFailureMessage, outputExtensions)
          }
          else {
            const finishOutcome = finishOutcomeFromCleanup(outcome)
            await finishStreamAgentInvocation(
              invocation,
              lifecycle,
              finishResult,
              finishOutcome.status === "success"
                ? {
                    ...finishOutcome,
                    usage: finishUsageRecord
                      ? await resolveAgentUsageRecord({ usageRecord: finishUsageRecord }, invocation.run)
                      : undefined,
                    usageResolved: true,
                  }
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
              const usage = streamedUsageRecord
                ? await resolveAgentUsageRecord({ usageRecord: streamedUsageRecord }, invocation.run)
                : undefined
              await finishStreamAgentInvocation(invocation, lifecycle, response, {
                result: response,
                status: "cancelled",
                usage,
                usageResolved: true,
              }, streamFailureMessage, outputExtensions)
            }
            else {
              const finishOutcome = finishOutcomeFromCleanup(outcome)
              const usage = streamedUsageRecord
                ? await resolveAgentUsageRecord({ usageRecord: streamedUsageRecord }, invocation.run)
                : undefined
              await finishStreamAgentInvocation(
                invocation,
                lifecycle,
                response,
                finishOutcome.status === "success"
                  ? { ...finishOutcome, usage, usageResolved: true }
                  : finishOutcome,
                streamFailureMessage,
                outputExtensions,
              )
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
    fallbackUsageRecord: rawDriverUsageObserved ? resolveRawDriverUsageRecord : undefined,
    ...(customRun
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      ? { wrapStream: (stream: AsyncIterable<unknown>) => maybeTraceAgentStream(stream as AsyncIterable<StreamEvent>, invocation) }
      : {}),
  })
}

function invocationCancellationDriver(definition: unknown): AgentInvocationCancellationDriver {
  // SAFETY: Agent definition normalization stores the Driver kind and normalized Driver under these internal symbols.
  const internal = definition as { [baseAgentDriver]?: unknown, [baseAgentDriverKind]?: AgentDriverKind } | undefined
  const driver = internal?.[baseAgentDriver]
  const provider = isRuntimeRecord(driver) && hasRuntimeType(driver.provider, "string") ? driver.provider : undefined
  const kind = internal?.[baseAgentDriverKind] ?? "model"
  const cancellationDriver: { kind: "model" | "provider" | "run", provider?: string } = { kind: kind === "ask" ? "run" : kind }
  if (provider) cancellationDriver.provider = provider
  return agentInvocationCancellationDriver(cancellationDriver)
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
  // SAFETY: Replay sets this private boolean marker on its runtime; other runtimes may omit it.
  const exclusive = (context as AgentRuntimeContext & { [exclusiveAgentInvocation]?: boolean })[exclusiveAgentInvocation] === true
  // SAFETY: Only the trusted Workflow worker installs this private claim token.
  const inheritedClaim = (context as AgentRuntimeContext & { [inheritedAgentInvocationClaim]?: string })[inheritedAgentInvocationClaim]
  // SAFETY: hasAgentDefinition validated the object before this internal contract assertion.
  let activity = exclusive || inheritedClaim ? undefined : createActiveAgentActivity(definition as AgentDefinition<TRuntimeConfig> | undefined, context)
  await activity?.update("queued")
  let invocationJournal: AgentInvocationJournal<TRuntimeConfig> | undefined
  try {
    invocationJournal = definition
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      ? await bindAgentInvocations((definition as AgentDefinition).invocations, {
        ...context,
        ...(exclusive ? { run: { ...context.run, runId: context.run?.runId || createTraceId(), annotations: pendingAgentInvocationAnnotations(context.run?.annotations) } } : {}),
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        ...((context as AgentRuntimeContext & { [agentInvocationRunId]?: string })[agentInvocationRunId]
          // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
          ? {
            run: {
              ...context.run,
              // SAFETY: The preceding truthy lookup proves this optional runtime marker is a string.
              runId: (context as AgentRuntimeContext & { [agentInvocationRunId]: string })[agentInvocationRunId],
            },
          }
          : {}),
      // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
      }, {
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        agentName: agentInvocationName(definition as AgentDefinition, context),
        cancellationDriver: invocationCancellationDriver(definition),
        ...(inheritedClaim ? { replaceClaimToken: inheritedClaim } : {}),
      })
      : undefined
    if ((exclusive || inheritedClaim) && invocationJournal?.claimStatus !== "owned") {
      if (invocationJournal?.claimStatus === "conflict") throw new AgentInvocationClaimConflict()
      throw new Error("Could not acquire the Invocation execution claim.")
    }
    // SAFETY: Workflow execution installs this private binding on the runtime context before handing off the claimed Invocation.
    if (inheritedClaim && !await invocationJournal?.confirmWorkflowDispatch((context as AgentRuntimeContext & { [agentInvocationWorkflowBinding]?: AgentInvocationWorkflowBinding })[agentInvocationWorkflowBinding])) {
      await invocationJournal?.releaseClaim()
      throw new Error("Could not confirm the Workflow Invocation handoff.")
    }
  }
  catch (error) {
    await activity?.update(invocationFailureWasCancelled(error, input.abortSignal) ? "cancelled" : "failed", error)
    throw error
  }
  if (invocationJournal) {
    context = invocationJournal.context
    const callerAbortSignal = agentInvocationCallerAbortSignal(input)
    // A cancellation request aborts the capacity wait, the Driver run, and tool calls through the run abort signal.
    input = {
      ...input,
      abortSignal: input.abortSignal ? AbortSignal.any([input.abortSignal, invocationJournal.abortSignal]) : invocationJournal.abortSignal,
    }
    markAgentInvocationCallerAbortSignal(input, callerAbortSignal)
  }
  let preparedInvocation: AgentInvocationContext<TRuntimeConfig, CALL_OPTIONS> | undefined
  let release: (() => void) | undefined
  try {
    await invocationJournal?.watchCancellation(invocationCancellationDriver(definition))
    input.abortSignal?.throwIfAborted()
    if (definition && inspectAgentCapacity(definition)) {
      preparedInvocation = await createAgentInvocationContextWithWorkflowFailureDelivery(
        // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
        asUnknownBoundary(agent) as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, any, any, TOutput>,
        context,
        input,
        options.kind,
        invocationJournal,
        options.tools,
      )
    }
    if (preparedInvocation?.handledResponse) {
      const runningPersisted = await invocationJournal?.running()
      input.abortSignal?.throwIfAborted()
      if (invocationJournal && !runningPersisted && !invocationJournal.reusedTerminal) throw new Error("Could not persist the Invocation running state.")
      await activity?.update("running")
      return await executeAgentInvocationWithCapacityLease(agent, context, input, options, preparedInvocation, invocationJournal, activity)
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
    const status = invocationFailureWasCancelled(error, input.abortSignal) ? "cancelled" : "failed"
    await invocationJournal?.finish(status, error)
    await activity?.update(status, error)
    throw error
  }
  if (!release) {
    try {
      const runningPersisted = await invocationJournal?.running()
      input.abortSignal?.throwIfAborted()
      if (invocationJournal && !runningPersisted && !invocationJournal.reusedTerminal) throw new Error("Could not persist the Invocation running state.")
      await activity?.update("running")
      input.abortSignal?.throwIfAborted()
      return await executeAgentInvocationWithCapacityLease(agent, context, input, options, preparedInvocation, invocationJournal, activity)
    }
    catch (error) {
      const status = invocationFailureWasCancelled(error, input.abortSignal) ? "cancelled" : "failed"
      await invocationJournal?.finish(status, error)
      await activity?.update(status, error)
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
    const runningPersisted = await invocationJournal?.running()
    input.abortSignal?.throwIfAborted()
    if (invocationJournal && !runningPersisted && !invocationJournal.reusedTerminal) throw new Error("Could not persist the Invocation running state.")
    await activity?.update("running")
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
    }, preparedInvocation, invocationJournal, activity)
  }
  catch (error) {
    const status = invocationFailureWasCancelled(error, input.abortSignal) ? "cancelled" : "failed"
    await invocationJournal?.finish(status, error)
    await activity?.update(status, error)
    releaseOnce()
    throw error
  }
}

export function runAgentInline<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options: { output: "raw" },
): Promise<unknown>
export function runAgentInline<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options?: RunAgentInlineOptions,
): Promise<TOutput | Response>
export async function runAgentInline<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options: RunAgentInlineOptions = {},
): Promise<TOutput | Response> {
  context = withAgentIdentityOwner(agent, context)
  // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
  return await executeAgentInvocation(agent, context, input, {
    kind: "run",
    renderOutput: options.output !== "raw",
    tools: options.tools,
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
  const { activity, handle, invocationJournal, run, settled } = started
  const reconcileJournal = async (snapshot: AgentInvocationSnapshot<TOutput> | undefined) => {
    if (snapshot?.status === "cancelled" || snapshot?.status === "completed" || snapshot?.status === "failed") {
      await activity?.update(
        snapshot.status,
        snapshot.status === "failed" ? snapshot.error : undefined,
        snapshot.status === "completed" ? finalTextFromAgentOutput(snapshot.output) : undefined,
      )
      await invocationJournal?.finish(snapshot.status, snapshot.error)
    }
    return snapshot
  }
  const controllerOptions: BackedAgentInvocationOptions<TOutput | Response> = {
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
    result: Promise.resolve(run),
  }
  if (settled) {
    controllerOptions.settled = settled
    if (parentAbortSignal) controllerOptions.parentAbortSignal = parentAbortSignal
  }
  return createBackedAgentInvocationController(controllerOptions)
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
    start: ({ abortSignal, id, onFinish }) => {
      const invocationInput = { ...input, abortSignal }
      markAgentInvocationCallerAbortSignal(invocationInput, agentInvocationCallerAbortSignal(input))
      return executeAgentInvocation(agent, {
        ...withAgentInvocationResponseOwner(context, id),
        run: { ...context.run, runId: runId || id },
      }, invocationInput, {
        kind: "run",
        onFinish(outcome) {
          onFinish(outcome.status === "cancelled"
            ? { status: "cancelled" }
            : outcome.status === "success"
            // SAFETY: Agent definition normalization establishes the asserted internal Agent contract.
              ? { ...(outcome.result !== undefined ? { output: outcome.result as TOutput | Response } : {}), status: "completed" }
              : { error: outcome.error, status: "failed" })
        },
        renderOutput: true,
      })
    },
    support: id => agentInvocationInputSupport(id),
  })
}

export async function startAgentInvocation<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options: {
    runId?: string
    /** Called before a runtime can retain input. A later rejection does not prove the input is unowned. */
    onInputHandoff?: () => void
  } = {},
): Promise<AgentInvocationController<TOutput | Response | AgentRunResult, CALL_OPTIONS>> {
  const invocationContext = withAgentIdentityOwner(agent, context)
  const workflowContext = invocationContext.run?.activity && !invocationContext.run.activity.runId
    ? {
        ...invocationContext,
        run: {
          ...invocationContext.run,
          activity: { ...invocationContext.run.activity, runId: invocationContext.run.runId },
        },
      }
    : invocationContext
  const workflow = await runAgentAsWorkflow<TRuntimeConfig, CALL_OPTIONS, TOutput>(
    agent,
    workflowContext,
    input,
    { fresh: true, onInputHandoff: options.onInputHandoff },
  )
  if (workflow) {
    return createWorkflowAgentInvocationController(workflow, input.abortSignal)
  }
  options.onInputHandoff?.()
  return createInlineAgentInvocationController(agent, invocationContext, input, options.runId)
}

export function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
): Promise<[Error, null] | [null, TOutput | Response | AgentWorkflowRun<AgentWorkflowOutput<TOutput>>]>
export function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
  const TSchemas extends Record<string, AgentToolSchema> = Record<string, AgentToolSchema>,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options: RunAgentOptions<SchemaOwnedInvocationTools<TSchemas>> & { output: "drained", tools: SchemaOwnedInvocationTools<TSchemas> },
): Promise<[Error, null] | [null, string]>
export function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
  const TTools extends Record<string, AgentToolDefinition<any, any>> = Record<string, AgentToolDefinition<any, any>>,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options: RunAgentOptions<TTools> & { output: "drained", tools?: TTools & CheckedInvocationTools<TTools> },
): Promise<[Error, null] | [null, string]>
export function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
  const TSchemas extends Record<string, AgentToolSchema> = Record<string, AgentToolSchema>,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options: RunAgentOptions<SchemaOwnedInvocationTools<TSchemas>> & { output: "drained", tools: SchemaOwnedInvocationTools<TSchemas> },
): Promise<AgentDrainedOutput<TOutput> | AgentWorkflowRun<AgentWorkflowOutput<TOutput>>>
export function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
  const TTools extends Record<string, AgentToolDefinition<any, any>> = Record<string, AgentToolDefinition<any, any>>,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options: RunAgentOptions<TTools> & { output: "drained", tools?: TTools & CheckedInvocationTools<TTools> },
): Promise<AgentDrainedOutput<TOutput> | AgentWorkflowRun<AgentWorkflowOutput<TOutput>>>
export function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
  const TSchemas extends Record<string, AgentToolSchema> = Record<string, AgentToolSchema>,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options: RunAgentOptions<SchemaOwnedInvocationTools<TSchemas>> & { tools: SchemaOwnedInvocationTools<TSchemas> },
): Promise<TOutput | Response | AgentWorkflowRun<AgentWorkflowOutput<TOutput>>>
export function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
  const TTools extends Record<string, AgentToolDefinition<any, any>> = Record<string, AgentToolDefinition<any, any>>,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options: RunAgentOptions<TTools> & { tools?: TTools & CheckedInvocationTools<TTools> },
): Promise<TOutput | Response | AgentWorkflowRun<AgentWorkflowOutput<TOutput>>>
export function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options: Omit<RunAgentOptions, "tools"> & { output: "drained", tools?: Record<string, never> },
): Promise<AgentDrainedOutput<TOutput> | AgentWorkflowRun<AgentWorkflowOutput<TOutput>>>
export function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options?: Omit<RunAgentOptions, "tools"> & { tools?: Record<string, never> },
): Promise<TOutput | Response | AgentWorkflowRun<AgentWorkflowOutput<TOutput>>>
export async function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
  TData = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  contextOrInput: AgentRuntimeContext<TRuntimeConfig> | AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  inputOrOptions?: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>> | RunAgentOptions,
  options: RunAgentOptions = {},
): Promise<TOutput | Response | AgentWorkflowRun<AgentWorkflowOutput<TOutput>> | [Error, null] | [null, string | TOutput | Response | AgentWorkflowRun<AgentWorkflowOutput<TOutput>>]> {
  const standaloneDrainedOptions = inputOrOptions !== undefined
    && hasRuntimeType(inputOrOptions, "object")
    && "output" in inputOrOptions
    && inputOrOptions.output === "drained"
  const runtimeContextShape = hasRuntimeType(contextOrInput, "object")
    && "runtime" in contextOrInput
    && "memo" in contextOrInput
    && "waitUntil" in contextOrInput
  const hasContext = arguments.length === 4
    || (inputOrOptions !== undefined && (
      runtimeContextShape
      || !standaloneDrainedOptions
    ))
  if (hasContext) {
    // SAFETY: The three-argument overload requires a Runtime Context as its second argument.
    return runAgentWithContext(agent, contextOrInput as AgentRuntimeContext<TRuntimeConfig>, inputOrOptions as AgentRunInput<CALL_OPTIONS>, options)
  }
  // SAFETY: The Runtime Context overload returned above; the remaining third argument contains invocation options.
  const standaloneOptions = inputOrOptions as RunAgentOptions | undefined
  const schedule = standaloneOptions?.schedule
  const runtime = createRuntimeContext({ runtime: "unknown", run: { runId: schedule?.runId || schedule?.id || createTraceId() } })
  const context: AgentRuntimeContext<TRuntimeConfig> = {
    memo: runtime.memo,
    run: runtime.run,
    runtime: runtime.runtime,
    waitUntil: schedule?.waitUntil ?? runtime.waitUntil,
  }
  try {
    const binding = resolveAgentWorkflowRuntimeBinding(agent)
    const hasInvocationTools = Object.keys(standaloneOptions?.tools || {}).length > 0
    if (binding && "discoveryDefault" in binding && !hasInvocationTools) {
      throw agentDiagnostics.AGENT_R0421({ message: "[vitehub] Standalone runAgent() cannot discover an Agent Workflow without a host context. Set runtime: false for inline execution, configure an explicit workflow(\"name\") binding, or use runAgent(agent, runtimeContext, input)." })
    }
    if (binding && standaloneOptions?.output === "drained" && !hasInvocationTools) {
      throw new Error("[vitehub] Drained output requires inline execution; a Workflow returns a run handle.")
    }
    // SAFETY: The two-argument overload requires invocation input as its second argument.
    const result = await runAgentWithContext(agent, context, contextOrInput as AgentRunInput<CALL_OPTIONS>, standaloneOptions)
    await runtime.flushWaitUntil()
    return [null, standaloneOptions?.output === "drained" ? toAgentRunResult(result).text ?? "" : result]
  }
  catch (error) {
    // Finish owned background work without replacing the invocation's original failure.
    await runtime.flushWaitUntil().catch(() => {})
    return [isError(error) ? error : new Error(agentErrorMessage(error), { cause: error }), null]
  }
}

async function runAgentWithContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: RunAgentOptions = {},
): Promise<TOutput | Response | AgentWorkflowRun<AgentWorkflowOutput<TOutput>>> {
  if (options.schedule) {
    const schedule = options.schedule
    const runId = schedule.runId || schedule.id
    // SAFETY: The object check narrows schedule input before reading its optional discriminator.
    const turn = schedule.input && hasRuntimeType(schedule.input, "object") && (schedule.input as { kind?: unknown }).kind === "agent-turn"
      ? parseScheduledAgentTurnInput(schedule.input)
      : undefined
    const forwardedInput = copyAgentInvocationCallerAbortSignal(input, { ...input })
    if (turn) {
      delete forwardedInput.message
      delete forwardedInput.messages
      delete forwardedInput.prompt
    }
    const memoValues = new Map<string, unknown>()
    context = {
      ...context,
      memo(key, create) {
        if (!memoValues.has(key)) memoValues.set(key, create())
        // SAFETY: This value was created for the same memo key by the caller's factory.
        return memoValues.get(key) as never
      },
      run: { ...context.run, ...turn?.delivery, runId },
      waitUntil: context.waitUntil ?? schedule.waitUntil ?? (() => {}),
    }
    input = copyAgentInvocationCallerAbortSignal(input, {
      ...forwardedInput,
      context: {
        ...input.context,
        ...(turn ? { invoker: turn.invoker, [scheduledAgentTurnContextKey]: true } : {}),
        schedule: {
          id: schedule.id,
          kind: "schedule",
          runId,
          scheduleId: schedule.scheduleId,
          scheduledAt: schedule.scheduledAt,
          target: schedule.target,
        },
      },
      ...(turn ? { prompt: turn.prompt } : {}),
    })
  }
  const invocationContext = withAgentIdentityOwner(agent, context)
  const binding = resolveAgentWorkflowRuntimeBinding(agent)
  const hasInvocationTools = Object.keys(options.tools || {}).length > 0
  if (hasInvocationTools && binding && !("discoveryDefault" in binding)) {
    throw new Error("[vitehub] Invocation tools cannot be used with an explicit Agent Workflow. Callable tools require inline execution.")
  }
  // Discovered Workflows are optional host defaults. Invocation-scoped functions
  // require an inline run because they cannot be serialized into Workflow input.
  const workflow = hasInvocationTools ? undefined : await runAgentAsWorkflow<TRuntimeConfig, CALL_OPTIONS, TOutput>(agent, invocationContext, input)
  if (workflow) {
    return workflow.run
  }
  if (input.context?.[requireAgentWorkflowContextKey] === true) {
    const error = agentDiagnostics.AGENT_R0444({ message: "[vitehub] Durable Channel delivery requires this Agent invocation to start a Workflow. Disable durable delivery or remove nonportable Capabilities and configure a Workflow provider." })
    const activity = hasAgentDefinition(agent) ? createActiveAgentActivity(agent, invocationContext) : undefined
    await activity?.update("queued")
    await activity?.update(invocationFailureWasCancelled(error, input.abortSignal) ? "cancelled" : "failed", error)
    throw error
  }
  const result = await runAgentInline(agent, invocationContext, input, { tools: hasInvocationTools ? options.tools : undefined })
  // SAFETY: The caller requested the rendered output contract, including a collected stream result.
  return options.output === "drained" ? await drainAgentRunOutput(result) as TOutput : result
}

async function drainAgentRunOutput(result: unknown): Promise<unknown> {
  // Draining gives callers the final result only after stream-driven lifecycle
  // work and capacity release complete.
  if (result instanceof Response) {
    return { raw: result, text: await result.text() }
  }
  if (isAsyncIterable(result) || hasTraceableStreamResult(result) || isUIMessageStreamResult(result)) {
    const stream = isAsyncIterable(result)
      ? result
      : !hasTraceableStreamResult(result) && isUIMessageStreamResult(result)
          ? result.toUIMessageStream()
          : streamAgentOutputToEvents(result)
    const collected = withStreamedResult(stream, result)
    for await (const _event of collected.stream) { /* lifecycle effects run while consuming */ }
    return await collected.finishResult()
  }
  return result

}

export async function streamAgentInline<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TData = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>> & AgentDataCarrier<TData>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
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
  TData = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>> & AgentDataCarrier<TData>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
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

/** Publish a scheduler wait or progress update without creating an invocation. */
export async function publishAgentActivity(
  agent: Pick<AgentDefinition, 'name' | 'channels'>,
  options: { channelId: string, target: AgentActivityTarget, activity: AgentActivityUpdate, abortSignal?: AbortSignal },
): Promise<void> {
  const channel = agent.channels?.[options.channelId]
  if (!channel?.activity) throw new Error(`Agent channel ${options.channelId} does not support activity.`)
  const pending: Promise<unknown>[] = []
  const memoized = new Map<string, unknown>()
  await channel.activity.update({
    runtime: 'unknown',
    capabilities: {},
    memo<T>(key: string, create: () => T): T {
      if (!memoized.has(key)) memoized.set(key, create())
      // SAFETY: Each memo key is populated by its caller-supplied factory of T.
      return memoized.get(key) as T
    },
    waitUntil: work => { pending.push(Promise.resolve(work)) },
    channel,
    target: options.target,
    activity: { agentName: agent.name, ...options.activity },
    abortSignal: options.abortSignal,
  })
  await Promise.all(pending)
}
