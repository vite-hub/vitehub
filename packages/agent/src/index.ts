import agentRegistry from "#vitehub/agent/registry"
import { normalizeAgentDriver } from "./internal/agent-driver.ts"
import { openAgentInvocationLifecycle, type AgentInvocationLifecycle } from "./internal/invocation-lifecycle.ts"
import { cloneWithPropertyDescriptors } from "./internal/stream-result.ts"
import { AgentOutputValidationError, validateAgentOutput } from "./internal/agent-structured-output.ts"
import { loadAgentWorkflowModule, loadAgentWorkflowRuntimeStateModule } from "./internal/workflow-runtime-loaders.ts"
import { agentErrorDetails, agentErrorMessage } from "./agent-error.ts"
import {
  createReactionDeliveryEffectIntent,
  createReplyDeliveryEffectIntent,
  createStatusDeliveryEffectIntent,
} from "./delivery-effects.ts"
import { createTraceEventLog, resolveRuntimeContext } from "@vite-hub/runtime"
import { agentResultKind, finalTextFromAgentOutput, hasTraceableStreamResult, isAsyncIterable, resolveAgentUsageRecord, streamAgentOutputToEvents, toAgentRunResult, toAgentStreamEvent } from "./agent-output.ts"
import { defineChatCapability, getChatCapabilityOptions } from "./chat-trigger.ts"
import {
  finishMessageChannelTitleDelivery,
  isMessageChannelTitleEffectIntent,
  messageChannelTitleDeliveredContextKey,
  prepareMessageChannelTitleDelivery,
  resolveAgentChannelChatOptions,
} from "./internal/channels.ts"
import type { MessageChannelTitleDeliveryAttempt } from "./internal/channels.ts"
import {
  channelHasCustomTitleEffect,
  messageChannelSupportsTitleEffect,
  messageChannelTitleSupportContextKey,
} from "./channels.ts"
import { agentInvocationCallbackContextValues, createAgentInvocationContextStore } from "./invocation-context.ts"
import { bindAgentRunEvents } from "./run-events.ts"
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
import type { AgentCapabilityRegistries, ResolvedAgentFinishExtensionProvider, ResolvedAgentOutputExtensionProvider } from "./capability-runtime.ts"
import { formatUnknownAgentMessage } from "./registry-error.ts"
import { finalizeUiMessageStreamOutput, isUIMessageStreamResult, normalizeUiMessageStream } from "./stream-output.ts"
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
  AgentDriverContribution,
  AgentDriverKind,
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
  AgentUsageRecord,
  AgentWorkflowRuntimeBinding,
  MaybePromise,
  ResolvedAgentTriggerDefinition,
  ResolvedAgentRuntimeContext,
} from "./types.ts"
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
  AgentDevtoolsConfigMetadata,
  AgentDevtoolsConfigValue,
  AgentDevtoolsDriverMetadata,
  AgentDevtoolsFileTreeItem,
  AgentDevtoolsHarnessMetadata,
  AgentDevtoolsMetadata,
  AgentDevtoolsModelExecutionMetadata,
  AgentDevtoolsModelMetadata,
  AgentDevtoolsToolDefinition,
  AgentDriver,
  AgentDriverContribution,
  AgentDriverContributionKind,
  AgentDriverKind,
  AgentExecution,
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
  AgentMessageLockScope,
  AgentOutputDefinition,
  AgentModelInput,
  AgentModelDriver,
  AgentModelExecutionInstrumentation,
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

export { AgentOutputValidationError }
export type { AgentOutputValidationErrorCode, AgentOutputValidationErrorOptions } from "./internal/agent-structured-output.ts"

export {
  createAgentDevtoolsMetadata,
  materializeAgentDevtoolsSourceMetadata,
  resolveAgentDevtoolsMetadata,
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
        : unknown
      : unknown
    : unknown
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
  [baseAgentResolve]?: BaseAgentResolver<TRuntimeConfig, CALL_OPTIONS>
  [baseAgentModel]?: AgentModelResolver<TRuntimeConfig>
  [colocatedAgentSkillsSymbol]?: ColocatedAgentSkills
}
interface AgentWorkflowInvocationPayload<CALL_OPTIONS = unknown> {
  input: AgentRunInput<CALL_OPTIONS>
  run?: AgentRunMetadata
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
) {
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
  const capabilityNames = Object.keys(context.capabilities || {})
  // ponytail: Host capability handles and registries cannot cross a Workflow payload without losing identity.
  if ("discoveryDefault" in binding && capabilityNames.length) return undefined

  const handle = await getAgentWorkflowHandle<TRuntimeConfig, CALL_OPTIONS, TOutput>(agent, resolveAgentWorkflowName(agent, binding, context), Boolean(context.agentIdentity))
  const resolvedContext = createResolvedRuntimeContext(context)
  const workflowInput = { ...input }
  // ponytail: AbortSignal is live process state and cannot cross a durable Workflow payload.
  delete workflowInput.abortSignal
  const payload: AgentWorkflowInvocationPayload<CALL_OPTIONS> = {
    ...(context.agentIdentity ? { agentIdentity: context.agentIdentity } : {}),
    input: workflowInput,
    runtime: context.runtime,
    runtimeConfig: resolvedContext.runtimeConfig,
    ...(context.run ? { run: context.run } : {}),
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
  return await runWithWorkflowRuntimeEvent(workflowEvent, () => handle.run(payload, context.run?.runId ? { id: context.run.runId } : {}))
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
    if (typeof input !== "function") continue
    const channel = input()
    if (!channel || typeof channel !== "object" || typeof channel.kind !== "string") {
      throw new TypeError(`[vitehub] Channel factory "${id}" must return an Agent Channel definition.`)
    }
    channels ||= { ...inputs } as AgentChannels<TRuntimeConfig>
    channels[id] = channel
  }
  return channels || (inputs as AgentChannels<TRuntimeConfig>)
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
  const { box, capabilities, cli, description, hooks, messages, name, output, runtime = defaultAgentWorkflowRuntime(), runEvents, version, workspace } = options
  const channels = normalizeAgentChannels(options.channels)
  if (box && driver.kind !== "harness") {
    throw new Error("[vitehub] defineAgent({ box }) currently requires a harness Agent Driver.")
  }
  if (box && driver.kind === "harness" && (driver.sandbox !== undefined || driver.workDir !== undefined)) {
    throw new Error("[vitehub] defineAgent({ box }) owns harness execution. Move driver.sandbox and driver.workDir to the Box.")
  }
  const run = driver.kind === "run" ? driver.run : undefined
  const capabilitiesResolver = typeof capabilities === "function"
    ? capabilities as AgentCapabilitiesResolver<TRuntimeConfig, WorkspaceName, CALL_OPTIONS>
    : undefined
  const baseCapabilities = normalizeCapabilities(Array.isArray(capabilities) ? capabilities : undefined)
  const invoker = normalizeAgentInvokerOptions(options.invoker) as AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS> | undefined
  const harnessDriver = driver.kind === "harness" ? driver : undefined
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
        ? (await import("./harness-agent.ts")).createHarnessAgentAdapter<CALL_OPTIONS>(harnessDriver as never)
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
    output,
    runtime,
    runEvents,
    run,
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
        ? withAgentToolStepReporting(withJsonCompatibleToolOutputs(applyAgentToolPolicies(resolvedTools) || {}), context.devtools?.reportToolStep)
        : undefined
      return capabilityTools
        ? { ...adapterInstance, tools: capabilityTools }
        : adapterInstance
    },
  } as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS, TOutput>
  Object.defineProperty(definition, "__vitehubAgentSettings", {
    value: channels === options.channels ? options : { ...options, channels },
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
    const adapter = await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(definition as never, context)
    const invocationContext = await createAgentInvocationContext(definition as never, context as never, context.input)
    const result = await adapter.generate(toAgentAdapterRunContext(invocationContext) as never)
    return typeof result === "object" && result && "text" in result && typeof (result as { text?: unknown }).text === "string"
      ? (result as { text: string }).text
      : result
  }
  return Object.assign(run, { [syntheticWorkspaceRun]: true })
}

type AgentCapabilitiesOption<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
  CALL_OPTIONS,
  TCapabilities extends readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[] | undefined,
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
    const TCapabilities extends readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[] | undefined = readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[] | undefined,
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
    options: TOptions & { capabilities?: AgentCapabilitiesOption<TRuntimeConfig, Name, CALL_OPTIONS, TCapabilities>, output?: AgentOutputDefinition<TOutput> } & ValidateWorkspaceAgentOptions<TOptions>,
  ): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS, TInvokerProfile, AgentCapabilitiesInvocationContextValues<TCapabilities>, AgentCapabilitiesOption<TRuntimeConfig, Name, CALL_OPTIONS, TCapabilities>, TOutput>
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    CALL_OPTIONS = unknown,
    const TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
    const TCapabilities extends readonly AgentCapabilityDefinition<TRuntimeConfig>[] | undefined = readonly AgentCapabilityDefinition<TRuntimeConfig>[] | undefined,
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
  return isWorkspaceAgentOptions(options)
    ? createWorkspaceAgentDefinition(options)
    : defineBaseAgent(options as never)
}) as DefineAgent

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
  devtools?: AgentRuntimeContext<TRuntimeConfig>["devtools"]
  driverContributions: AgentDriverContribution[]
  finalOutputRenderers: AgentCapabilityRegistries["finalOutputRenderers"]
  finishDeliveryEffectProviders: AgentChannelDeliveryFinishEffect[]
  finishExtensionProviders: ResolvedAgentFinishExtensionProvider[]
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
    if (error instanceof Error && error.name === "WorkspaceNotFoundError") return undefined
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
    const channelCapabilities = activeAgentChannel(definition?.channels, invocationContext, context.run)?.channel.capabilities || []
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
      ? withAgentToolStepReporting(withJsonCompatibleToolOutputs(applyAgentToolPolicies(transformedTools) || {}), context.devtools?.reportToolStep)
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
      devtools: context.devtools,
      driverContributions: capabilities.driverContributions,
      finalOutputRenderers: capabilities.registries.finalOutputRenderers,
      finishDeliveryEffectProviders: capabilities.registries.finishDeliveryEffectProviders,
      finishExtensionProviders: capabilities.registries.finishExtensionProviders,
      finishHook: definition?.hooks?.["agent:finish"] as never,
      globalSkills: capabilities.globalSkills,
      hasCapabilityCleanup: capabilities.hasCloseCallbacks,
      handledResponse: capabilities.response,
      harnessSandboxProvider,
      harnessWorkDir: box ? "." : undefined,
      hooks: definition?.hooks as AgentHookObserverHooks | undefined,
      input: capabilities.input as AgentRunInput<CALL_OPTIONS>,
      instructions,
      invoker,
      messages: capabilities.messages,
      modelExecutionInstrumentation: capabilities.registries.modelExecutionInstrumentation,
      outputExtensionProviders: capabilities.registries.outputExtensionProviders,
      output: definition?.output,
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
    return typeof current === "string" && current ? result : cloneWithPropertyDescriptors(result, {
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
  let streamedText = ""
  let usageRecord: Extract<StreamEvent, { type: "usage" }>["usageRecord"] | undefined
  return {
    finishResult() {
      return resultWithStreamedTextAndUsage(result, streamedText, usageRecord, fallbackUsageRecord)
    },
    finishUsage() {
      return usageRecord ?? fallbackUsageRecord
    },
    stream: (async function* () {
      for await (const chunk of stream) {
        const event = toAgentStreamEvent(chunk, toolNames)
        if (event?.type === "text-delta" && event.text) streamedText += event.text
        if (event?.type === "usage") usageRecord = event.usageRecord
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
    finishResult = await applyFinalOutputRenderers(result, context, outputExtensions)
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
        const event = toAgentStreamEvent(result.value, toolNames)
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

function hasFinishWork<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): boolean {
  return Boolean(context.finishHook || context.finishDeliveryEffectProviders.length)
}

async function resolveFinishUsageRecord<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  result: unknown,
): Promise<Extract<StreamEvent, { type: "usage" }>["usageRecord"] | undefined> {
  if (hasFinishWork(context)) return await resolveAgentUsageRecord(result, context.run)
  if (!context.runtimeContext.traceLog) return undefined
  try {
    return await resolveAgentUsageRecord(result, context.run)
  }
  catch {
    // Core tracing is best-effort and must not change Agent output.
    return undefined
  }
}

type AgentInvocationFinishOutcome =
  | { result?: unknown, status: "success", usage?: AgentUsageRecord }
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
    const inputArtifacts = typeof input === "object" && input !== null ? input.artifacts : undefined
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
  return {
    ...event,
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
        usage ??= await resolveAgentUsageRecord(result, context.run)
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
      if (context.finishHook || provisionalActiveDeliveryProviders.length || hasDeferredFinishDeliveryEffectProvider(context.finishDeliveryEffectProviders)) {
        const extensions = await createAgentInvocationExtensions(eventBase as never, context.finishExtensionProviders)
        const finishEvent = { ...eventBase, extensions }
        const activeDeliveryProviders = activeFinishDeliveryEffectProviders(context, finishEvent as never)
        await applyChannelDeliveryEffectIntents(context, await resolveFinishDeliveryEffectIntents(activeDeliveryProviders, finishEvent as never, context), finishEvent as never)
        let finishHookResult: void | AgentChannelDeliveryFinishEffectResult
        await runObservedAgentHook(context.hooks, {
          ids: { runId: context.run?.runId },
          name: "agent:finish",
          owner: "agent",
          phase: "finish",
        }, async () => {
          finishHookResult = await context.finishHook?.(createAgentFinishHookEvent(finishEvent, context))
        })
        if (finishHookResult) {
          const finishHookIntents: AgentChannelDeliveryEffectIntent[] = []
          appendDeliveryEffectIntent(finishHookIntents, finishHookResult)
          await applyChannelDeliveryEffectIntents(context, finishHookIntents, finishEvent)
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
    finalizeRawStreams?: boolean
    outputExtensions?: Map<string, unknown>
    wrapStream?: (stream: AsyncIterable<unknown>) => AsyncIterable<unknown>
  } = {},
): Promise<Response | AsyncIterable<unknown> | TResult> {
  const shouldWrapOutput = shouldWrapInvocationOutput(context)
  try {
    if (result instanceof Response) {
      const responseDecoder = context.context.get<boolean>(responseTitleFallbackContextKey) === true
        ? new TextDecoder()
        : undefined
      let responseText = ""
      const response = shouldWrapOutput ? await withResponseCleanup(result, async (outcome) => {
        responseText += responseDecoder?.decode() ?? ""
        const finishResult = responseText && !outcome.failed
          ? { raw: result, text: responseText }
          : result
        await lifecycle.finish(finishOutcomeFromCleanup(outcome, finishResult))
      }, {
        onChunk: chunk => responseText += responseDecoder?.decode(chunk, { stream: true }) ?? "",
      }) : result
      return response
    }
    if (isAsyncIterable(result) && !hasTraceableStreamResult(result) && !options.finalizeRawStreams) {
      const stream = options.wrapStream?.(result) || result
      if (shouldWrapOutput) {
        const streamed = withStreamedResult(stream, result)
        if (!context.finalOutputRenderers.length && (!context.output || !options.finalizeRawStreams)) {
          return withCapabilityCleanup(streamed.stream, async (outcome) => {
            const finishOutcome = finishOutcomeFromCleanup(outcome, result)
            const usage = streamed.finishUsage()
            return lifecycle.finish(finishOutcome.status === "success"
              ? { ...finishOutcome, usage: usage ? await resolveAgentUsageRecord({ usageRecord: usage }, context.run) : undefined }
              : finishOutcome)
          }, { abortSignal: context.input.abortSignal })
        }
        return withCapabilityCleanup(streamed.stream, outcome => finishStreamAgentInvocation(context, lifecycle, streamed.finishResult(), finishOutcomeFromCleanup(outcome), failureMessage, options.outputExtensions), { abortSignal: context.input.abortSignal })
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

async function materializeAgentStructuredOutput(result: unknown, abortSignal?: AbortSignal): Promise<unknown> {
  if (!isAsyncIterable(result) && !hasTraceableStreamResult(result)) return result
  if (toAgentRunResult(result).text !== undefined) return result
  let text = ""
  let usageRecord: Extract<StreamEvent, { type: "usage" }>["usageRecord"] | undefined
  const events = withCapabilityCleanup(streamAgentOutputToEvents(result), async () => {}, { abortSignal }) as AsyncIterable<StreamEvent>
  for await (const event of events) {
    if (event.type === "error") throw new Error(event.error)
    if (event.type === "text-delta") text += event.text
    if (event.type === "usage") usageRecord = event.usageRecord
  }
  return resultWithUsageRecord(text, usageRecord)
}

type AgentInvocationExecutionOptions =
  | { kind: "run", renderOutput: boolean }
  | { kind: "stream", output: "events" | "ui-message-stream" }

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
  const customRun = hasCustomRun<TRuntimeConfig, CALL_OPTIONS>(agent)
  const adapter = customRun ? undefined : await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(agent, context)
  const definition = hasAgentDefinition(agent)
    ? agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, any, any, TOutput>
    : undefined
  const invocation = await createAgentInvocationContext(definition, context, input)
  const lifecycle = await openAgentInvocationLifecycle<AgentInvocationFinishOutcome>(
    outcome => finishAgentInvocation(invocation, outcome),
  )

  const runFailureMessage = "[vitehub] Agent run failed and finish lifecycle also failed."
  const streamFailureMessage = "[vitehub] Agent stream failed and finish lifecycle also failed."
  const handledFailureMessage = options.kind === "run" ? runFailureMessage : streamFailureMessage
  if (invocation.handledResponse) {
    return await finalizeAgentInvocationResult(invocation, lifecycle, invocation.handledResponse, async result => ({ finishResult: result, value: result }), handledFailureMessage)
  }

  const executionFailureMessage = options.kind === "run" || customRun ? runFailureMessage : streamFailureMessage
  let result: unknown
  try {
    if (customRun) {
      result = await agent.run(invocation)
    }
    else if (options.kind === "stream" && adapter?.stream) {
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
  try {
    const shouldRenderStream = options.kind === "run"
      ? customRun && options.renderOutput && isAsyncIterable(result)
      : isAsyncIterable(result) && options.output !== "ui-message-stream" && !invocation.finalOutputRenderers.length
    if (shouldRenderStream) {
      result = await applyOutputRenderers(result, invocation.outputRenderers, invocation.outputExtensionProviders, outputExtensions)
      renderedResult = true
    }
  }
  catch (error) {
    return await lifecycle.fail({ error, status: "error" }, error, executionFailureMessage)
  }

  if (options.kind === "run") {
    return await finalizeAgentInvocationResult(invocation, lifecycle, result, async (result) => {
      const driverUsageRecord = await resolveFinishUsageRecord(invocation, result)
      const rendered = options.renderOutput
        ? renderedResult ? result : await applyOutputRenderers(result, invocation.outputRenderers, invocation.outputExtensionProviders, outputExtensions)
        : result
      if (options.renderOutput
        && !invocation.output
        && invocation.context.get<boolean>(responseTitleFallbackContextKey) === true
        && rendered !== result
        && (isAsyncIterable((rendered as { stream?: unknown }).stream) || isAsyncIterable((rendered as { fullStream?: unknown }).fullStream))
        && shouldWrapInvocationOutput(invocation)) {
        const streamed = withStreamedResult(streamAgentOutputToEvents(rendered), rendered, driverUsageRecord)
        const value = withCapabilityCleanup(streamed.stream, async (outcome) => {
          await finishStreamAgentInvocation(invocation, lifecycle, streamed.finishResult(), finishOutcomeFromCleanup(outcome), runFailureMessage, outputExtensions)
        }, { abortSignal: invocation.input.abortSignal })
        return {
          deferFinish: true,
          finishResult: value,
          value,
        }
      }
      const final = options.renderOutput ? await applyFinalOutputRenderers(rendered, invocation, outputExtensions) : rendered
      const structuredFinal = options.renderOutput && invocation.output ? await materializeAgentStructuredOutput(final, invocation.input.abortSignal) : final
      const structuredUsageRecord = options.renderOutput && invocation.output
        ? await resolveFinishUsageRecord(invocation, structuredFinal) ?? driverUsageRecord
        : driverUsageRecord
      const value = options.renderOutput && invocation.output
        ? await validateAgentOutput(invocation.output, structuredFinal, {
            allowMaterializedObject: customRun
              ? structuredFinal === final
              : structuredFinal === final && final !== result,
          })
        : customRun ? final : options.renderOutput ? toAgentRunResult(final) : final
      return {
        finishResult: invocation.output ? value : hasFinishWork(invocation) ? resultWithUsageRecord(final, driverUsageRecord) : final,
        finishUsage: structuredUsageRecord,
        value,
      }
    }, runFailureMessage, {
      finalizeRawStreams: options.renderOutput && Boolean(invocation.output),
      outputExtensions,
      ...(customRun
        ? { wrapStream: (stream: AsyncIterable<unknown>) => maybeTraceAgentStream(stream as AsyncIterable<StreamEvent>, invocation) }
        : {}),
    })
  }

  return await finalizeAgentInvocationResult(invocation, lifecycle, result, async (result) => {
    const driverUsageRecord = await resolveFinishUsageRecord(invocation, result)
    const rendered = renderedResult ? result : await applyOutputRenderers(result, invocation.outputRenderers, invocation.outputExtensionProviders, outputExtensions)
    if (options.output === "ui-message-stream") {
      return finalizeUiMessageStreamOutput(maybeTraceUiMessageStreamOutput(rendered, invocation), shouldWrapInvocationOutput(invocation), async (outcome, streamedText, streamedUsageRecord) => {
        await finishStreamAgentInvocation(invocation, lifecycle, resultWithStreamedTextAndUsage(rendered, streamedText || "", streamedUsageRecord, driverUsageRecord), finishOutcomeFromCleanup(outcome), streamFailureMessage, outputExtensions)
      })
    }

    const isStreamResult = hasTraceableStreamResult(rendered)
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
      ? streamAgentOutputToEvents(rendered)
      : customRun ? rendered as AsyncIterable<StreamEvent> : streamAgentOutputToEvents(rendered)
    const streamed = withStreamedResult(stream, rendered, driverUsageRecord)
    const tracedStream = maybeTraceAgentStream(streamed.stream as AsyncIterable<StreamEvent>, invocation)
    const shouldWrapOutput = shouldWrapInvocationOutput(invocation)
    const value = shouldWrapOutput
      ? withCapabilityCleanup(tracedStream, async (outcome) => {
          await finishStreamAgentInvocation(invocation, lifecycle, streamed.finishResult(), finishOutcomeFromCleanup(outcome), streamFailureMessage, outputExtensions)
        }, { abortSignal: invocation.input.abortSignal }) as AsyncIterable<StreamEvent>
      : tracedStream
    return {
      deferFinish: shouldWrapOutput,
      finishResult: rendered,
      value: customRun ? withStreamResultProperties(value, rendered) : value,
    }
  }, executionFailureMessage, {
    finalizeRawStreams: options.output === "ui-message-stream" || Boolean(invocation.finalOutputRenderers.length) || Boolean(invocation.output),
    outputExtensions,
    ...(customRun
      ? { wrapStream: (stream: AsyncIterable<unknown>) => maybeTraceAgentStream(stream as AsyncIterable<StreamEvent>, invocation) }
      : {}),
  })
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
  const workflowRun = await runAgentAsWorkflow<TRuntimeConfig, CALL_OPTIONS, TOutput>(agent, invocationContext, input)
  if (workflowRun) return workflowRun
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
