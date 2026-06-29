import agentRegistry from "#vitehub/agent/registry"
import { normalizeAgentDriver } from "./internal/agent-driver.ts"
import { cloneWithPropertyDescriptors } from "./internal/stream-result.ts"
import { agentErrorDetails, agentErrorMessage } from "./agent-error.ts"
import { getMessageText } from "./messages.ts"
import { resolveRuntimeContext } from "@vite-hub/runtime"
import { isAsyncIterable, streamAgentOutputToEvents, toAgentRunResult, toAgentStreamEvent } from "./agent-output.ts"
import { chat as defineChatCapability, getChatCapabilityOptions } from "./chat-trigger.ts"
import { resolveAgentChannelChatOptions } from "./internal/channels.ts"
import { createAgentInvocationContextStore } from "./invocation-context.ts"
import {
  createFallbackAgentInvoker,
  normalizeAgentInvokerOptions,
  resolveAgentInvoker,
} from "./invoker.ts"

import {
  applyCapabilityToolTransforms,
  applyOutputRenderers,
  createAgentInvocationExtensions,
  defineCapability,
  normalizeCapabilities,
  normalizeMode,
  optionalWorkspaceCapabilitySymbol,
  resolveAgentCapabilities,
  resolveStaticCapabilityTools,
  withCapabilityCleanup,
  withResponseCleanup,
} from "./capability-runtime.ts"
import type { AgentCapabilityRegistries, ResolvedAgentFinishExtensionProvider, ResolvedAgentOutputExtensionProvider } from "./capability-runtime.ts"
import { formatUnknownAgentMessage } from "./registry-error.ts"
import { finalizeUiMessageStreamOutput, isUIMessageStreamResult } from "./stream-output.ts"
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
  workspaceModeFromOptions,
  workspaceNameFromOptions,
} from "./workspace-agent.ts"
import { workspaceSourceScopeNames } from "./workspace-source-metadata.ts"

import type {
  AgentAdapter,
  AgentAdapterFactory,
  AgentAdapterMetadataContext,
  AgentAdapterRunContext,
  AgentAdapterResult,
  AgentCapabilitiesList,
  AgentChannelDefinition,
  AgentChannelTriggerContext,
  AgentChannels,
  AgentCapabilityHooks,
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityInput,
  AgentCapabilityMode,
  AgentCapabilityTypeContract,
  AgentChannelDeliveryEffectHandler,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryFinishEffect,
  AgentChannelDeliveryFinishEffectContext,
  AgentDeliveryArtifact,
  AgentDeliveryArtifactPlacement,
  AgentDefinition,
  AgentDriverContribution,
  AgentDriverKind,
  AgentFinishEvent,
  AgentChatOptions,
  AgentHandlerOptions,
  AgentInput,
  AgentInputHook,
  AgentInvocationContextStore,
  AgentInvocationContextValues,
  AgentHookObserverHooks,
  AgentInvoker,
  AgentInvokerOptions,
  AgentInvokerProfile,
  AgentMessageChannelSettings,
  AgentMessageConcurrency,
  AgentMessageLockScope,
  AgentModelResolver,
  AgentRegistry,
  AgentRegistryModule,
  AgentRunContext,
  AgentRunHandler,
  AgentRunInput,
  AgentRunInputContextValues,
  AgentRunMetadata,
  AgentRunResult,
  AgentRuntimeBinding,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentSettings,
  AgentUsageCost,
  AgentWorkflowRuntimeBinding,
  AgentToolDefinition,
  MaybePromise,
  PublishedAgentDeliveryArtifact,
  ResolvedAgentTriggerDefinition,
  ResolvedAgentRuntimeContext,
} from "./types.ts"
import type { Message, StreamEvent } from "./messages.ts"
import type { AgentTraceContext } from "./trace.ts"
import type { ResolvedAgentTriggerInvocation, ResolvedAgentTriggerInvocationResult } from "./trigger-runtime.ts"
import type {
  WorkspaceAgentDefinition,
  WorkspaceAgentDefaults,
  WorkspaceAgentOptions,
} from "./workspace-agent.ts"
import type {
  ReadonlyWorkspaceFacade,
  WritableWorkspaceFacade,
  WorkspaceDefinition,
  WorkspaceName,
} from "@vite-hub/workspace"
import type { WorkflowHandle } from "@vite-hub/workflow"

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
  AgentCapabilitiesList,
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
  AgentChannelDeliveryEffectKind,
  AgentChannelDeliveryEffects,
  AgentChannelDeliveryFinishEffectContext,
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
  AgentChannelDefinition,
  AgentChannelTriggerContext,
  AgentChannels,
  AgentDeliveryArtifact,
  AgentDeliveryArtifactPlacement,
  AgentDefinition,
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
  AgentFinishHook,
  AgentHandlerOptions,
  AgentHarnessCredentialSource,
  AgentHarnessDriver,
  AgentHarnessDriverInput,
  AgentHarnessSandboxInput,
  AgentHarnessSessionKey,
  AgentInput,
  AgentInputHook,
  AgentIntegrationOption,
  AgentHookObserver,
  AgentHookObserverEvent,
  AgentHookObserverHooks,
  AgentHookOutcome,
  AgentHookOwner,
  AgentInvocationExtensions,
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
  AgentChatContext,
  AgentChatRunContext,
} from "./chat-trigger.ts"

const syntheticWorkspaceRun = Symbol.for("vitehub.syntheticWorkspaceRun")
const capabilityCliRunSurface = Symbol.for("vitehub.capabilityCliRunSurface")
const baseAgentResolve = Symbol("vitehub.baseAgentResolve")
const baseAgentModel = Symbol("vitehub.baseAgentModel")
const baseAgentDriverKind = Symbol("vitehub.baseAgentDriverKind")
const workflowSpecifier = "@vite-hub/workflow"
const workflowRuntimeStateSpecifier = "@vite-hub/workflow/runtime/state"

type NormalizedCapability = AgentCapabilityDefinition & { mode?: AgentCapabilityMode }
type WorkspaceSourceNames<TWorkspace> =
  TWorkspace extends { sources: infer TSources }
    ? Extract<keyof NonNullable<TSources>, string>
    : string
type WorkspaceSourceScopeOptionNames<TSource> =
  TSource extends { __vitehubWorkspaceSourceScopeNames?: infer TScopes }
    ? NonNullable<TScopes> extends readonly (infer TScope)[]
      ? string extends TScope ? never : Extract<TScope, string>
      : never
    : "scopes" extends keyof TSource
    ? TSource extends { scopes?: infer TScopes }
      ? NonNullable<TScopes> extends readonly (infer TScope)[]
        ? string extends TScope ? never : Extract<TScope, string>
        : never
      : never
    : never
type WorkspaceSourceInputScopeNames<TSource> =
  TSource extends { source: infer TInnerSource }
    ? "scopes" extends keyof TSource
      ? WorkspaceSourceScopeOptionNames<TSource>
      : WorkspaceSourceInputScopeNames<TInnerSource>
    : WorkspaceSourceScopeOptionNames<TSource>
type WorkspaceSourceScopeNames<TWorkspace> =
  TWorkspace extends { sources: infer TSources }
    ? { [Key in keyof NonNullable<TSources>]: WorkspaceSourceInputScopeNames<NonNullable<TSources>[Key]> }[keyof NonNullable<TSources>]
    : never
type InvalidWorkspaceSourceGrant<TSourceName> = {
  readonly __vitehubInvalidWorkspaceSourceGrant: TSourceName
}
type InvalidWorkspaceSourceScope<TScopeName> = {
  readonly __vitehubInvalidWorkspaceSourceScope: TScopeName
}
type ValidateCapabilityWorkspaceSources<
  TSourceName,
  TWorkspace,
  TCapability,
> =
  [TSourceName] extends [never]
    ? TCapability
    : TSourceName extends string
    ? string extends TSourceName
      ? TCapability
      : Exclude<TSourceName, WorkspaceSourceNames<TWorkspace>> extends never
        ? TCapability
        : TCapability & InvalidWorkspaceSourceGrant<Exclude<TSourceName, WorkspaceSourceNames<TWorkspace>>>
    : TCapability
type ValidateAgentCapability<TCapability, TWorkspace> =
  TCapability extends AgentCapabilityDefinition<any, any, infer TTypeContract>
    ? TTypeContract extends { workspaceSources: infer TSourceName }
      ? ValidateCapabilityWorkspaceSources<TSourceName, TWorkspace, TCapability>
      : TCapability
    : TCapability
type ValidateAgentCapabilities<TCapabilities, TWorkspace> =
  TCapabilities extends readonly [unknown, ...unknown[]] | readonly []
    ? { [Index in keyof TCapabilities]: ValidateAgentCapability<TCapabilities[Index], TWorkspace> }
    : TCapabilities extends readonly (infer TCapability)[]
      ? ValidateAgentCapability<TCapability, TWorkspace>[]
      : TCapabilities
type CapabilityWorkspaceScopeNames<TCapability> =
  TCapability extends AgentCapabilityDefinition<any, any, infer TTypeContract>
    ? (TTypeContract extends { workspaceScopes: infer TScopeName }
          ? Extract<TScopeName, string>
          : never)
        | (TCapability extends { capabilities: infer TNestedCapabilities }
            ? AgentCapabilitiesWorkspaceScopeNames<TNestedCapabilities>
            : never)
    : never
type AgentCapabilitiesWorkspaceScopeNames<TCapabilities> =
  TCapabilities extends readonly [unknown, ...unknown[]] | readonly []
    ? CapabilityWorkspaceScopeNames<TCapabilities[number]>
  : TCapabilities extends readonly (infer TCapability)[]
    ? AgentCapabilityDefinition extends TCapability ? string : CapabilityWorkspaceScopeNames<TCapability>
    : never
type ValidateWorkspaceSourceScopes<TCapabilities, TWorkspace> =
  [WorkspaceSourceScopeNames<TWorkspace>] extends [never]
    ? unknown
    : Exclude<WorkspaceSourceScopeNames<TWorkspace>, AgentCapabilitiesWorkspaceScopeNames<TCapabilities>> extends never
        ? unknown
        : InvalidWorkspaceSourceScope<Exclude<WorkspaceSourceScopeNames<TWorkspace>, AgentCapabilitiesWorkspaceScopeNames<TCapabilities>>>

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
    TCapabilities extends readonly [unknown, ...unknown[]] | readonly []
      ? CapabilityInvocationContextValues<TCapabilities[number]>
      : TCapabilities extends readonly (infer TCapability)[]
        ? CapabilityInvocationContextValues<TCapability>
        : unknown
  >
type ValidateWorkspaceAgentOptions<TOptions> =
  TOptions extends { capabilities?: infer TCapabilities, workspace: infer TWorkspace }
    ? { capabilities?: ValidateAgentCapabilities<TCapabilities, TWorkspace> } & ValidateWorkspaceSourceScopes<TCapabilities, TWorkspace>
    : unknown
type BaseAgentResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig, CALL_OPTIONS = unknown> =
  (context: AgentRuntimeContext<TRuntimeConfig>) => Promise<AgentAdapter<CALL_OPTIONS>>
type AgentDefinitionWithBaseResolve<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = AgentDefinition<TRuntimeConfig, CALL_OPTIONS> & {
  [baseAgentDriverKind]?: AgentDriverKind
  [baseAgentResolve]?: BaseAgentResolver<TRuntimeConfig, CALL_OPTIONS>
  [baseAgentModel]?: AgentModelResolver<TRuntimeConfig>
}
interface AgentWorkflowInvocationPayload<CALL_OPTIONS = unknown> {
  input: AgentRunInput<CALL_OPTIONS>
  run?: AgentRunMetadata
  runtime?: AgentRuntimeContext["runtime"]
  runtimeConfig?: AgentRuntimeConfig
}
interface ScheduleRunContextLike {
  attemptId?: string
  id: string
  runId?: string
  scheduleId?: string
  scheduledAt: Date
  target?: string
}

const agentWorkflowHandles = new WeakMap<object, Map<string, WorkflowHandle<AgentWorkflowInvocationPayload, unknown>>>()
const agentWorkflowNames = new Set<string>()

function hasAgentMethods(value: unknown): value is AgentAdapter {
  return typeof value === "object"
    && value !== null
    && "generate" in value
    && typeof (value as { generate?: unknown }).generate === "function"
}

function toLegacyCallInput(context: {
  input: AgentRunInput
  messages: Message[]
  prompt?: string
}) {
  return {
    abortSignal: context.input.abortSignal,
    ...(context.messages.length ? { messages: context.messages.map(message => ({ content: getMessageText(message), role: message.role })) } : {}),
    ...(context.prompt ? { prompt: context.prompt } : {}),
    timeout: context.input.timeout,
  }
}

function normalizeDirectAgent<CALL_OPTIONS>(agent: AgentAdapter<CALL_OPTIONS> & { tools?: unknown }): AgentAdapter<CALL_OPTIONS> {
  if (agent.name) return agent
  return {
    async generate(context) {
      return await agent.generate(toLegacyCallInput(context) as never)
    },
    name: "custom",
    async stream(context) {
      return await agent.stream?.(toLegacyCallInput(context) as never)
    },
    ...(agent.tools ? { tools: agent.tools } : {}),
  }
}

function hasAgentDefinition(value: unknown): value is AgentDefinition {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

function resolveAgentWorkflowRuntimeBinding<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): AgentWorkflowRuntimeBinding | undefined {
  if (!hasAgentDefinition(agent)) return undefined
  return agent.runtime?.kind === "workflow" ? agent.runtime : undefined
}

function resolveAgentWorkflowName(binding: AgentWorkflowRuntimeBinding): string {
  if (binding.name) return binding.name
  throw new Error("[vitehub] Agent runtime workflow() requires a name when invoked directly. A stable Workflow Definition target requires workflow(\"name\").")
}

async function getAgentWorkflowHandle<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  name: string,
): Promise<WorkflowHandle<AgentWorkflowInvocationPayload<CALL_OPTIONS>, unknown>> {
  const handles = agentWorkflowHandles.get(agent as object) || new Map<string, WorkflowHandle<AgentWorkflowInvocationPayload, unknown>>()
  const existing = handles.get(name)
  if (existing) return existing as WorkflowHandle<AgentWorkflowInvocationPayload<CALL_OPTIONS>, unknown>

  const { createWorkflow } = await import(/* @vite-ignore */ workflowSpecifier) as typeof import("@vite-hub/workflow")
  const { getInlineWorkflowDefinitions } = await import(/* @vite-ignore */ workflowRuntimeStateSpecifier) as typeof import("@vite-hub/workflow/runtime/state")
  const handle = agentWorkflowNames.has(name) && getInlineWorkflowDefinitions().has(name)
    ? createWorkflow<AgentWorkflowInvocationPayload<CALL_OPTIONS>, unknown>(name)
    : createWorkflow<AgentWorkflowInvocationPayload<CALL_OPTIONS>, unknown>(name, async (workflowContext) => {
        const { runAgentWorkflowDefinition } = await import("./runtime/workflow.ts")
        return await runAgentWorkflowDefinition(agent as never, workflowContext as never, runAgentInline as never)
      })
  agentWorkflowNames.add(name)
  handles.set(name, handle as WorkflowHandle<AgentWorkflowInvocationPayload, unknown>)
  agentWorkflowHandles.set(agent as object, handles)
  return handle
}

async function runAgentAsWorkflow<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
) {
  const binding = resolveAgentWorkflowRuntimeBinding<TRuntimeConfig, CALL_OPTIONS>(agent)
  if (!binding) return undefined

  const handle = await getAgentWorkflowHandle<TRuntimeConfig, CALL_OPTIONS>(agent, resolveAgentWorkflowName(binding))
  const resolvedContext = createResolvedRuntimeContext(context)
  const payload: AgentWorkflowInvocationPayload<CALL_OPTIONS> = {
    input,
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
  const { runWithWorkflowRuntimeEvent } = await import(/* @vite-ignore */ workflowRuntimeStateSpecifier) as typeof import("@vite-hub/workflow/runtime/state")
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

function activeDeliveryChannel<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  channels: AgentChannels<TRuntimeConfig> | undefined,
  context: AgentInvocationContextStore,
  run?: AgentRunMetadata,
) {
  const trigger = context.get<AgentTriggerContextValue>("agent.trigger")
  const channelId = run?.channelId || trigger?.channelId
  const channel = channelId ? channels?.[channelId] : undefined
  return channel && channelId ? { channel, channelId, trigger } : undefined
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
  const active = activeDeliveryChannel(context.channels, context.context, context.run)

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
            effect: intent,
            ...(finish ? { finish: finish as never } : {}),
            input: context.input,
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
        await traceAgentChannelDeliveryEffect(toTraceContext(context), intent, {
          ...metadata,
          "error.message": agentErrorMessage(error),
        })
      }
    }
  }
}

function once<TArgs extends unknown[]>(callback: (...args: TArgs) => Promise<void>): (...args: TArgs) => Promise<void> {
  let called = false
  return async (...args) => {
    if (called) return
    called = true
    await callback(...args)
  }
}

export { applyAgentToolPolicies, withAgentToolStepReporting } from "./tool-runtime.ts"
export { defineCapability } from "./capability-runtime.ts"
export { isResolvedAgentTriggerHandledInvocation, verifyAgentWebhookRequest } from "./trigger-runtime.ts"
export type { AgentWebhookVerificationResult, ResolvedAgentTriggerHandledInvocation, ResolvedAgentTriggerInvocation, ResolvedAgentTriggerInvocationResult } from "./trigger-runtime.ts"
export * from "./messages.ts"
export {
  agentInvocationStreamRoute,
  createAgentInvocationStreamResponse,
  readAgentInvocationStream,
} from "./invocation-stream.ts"
export type { AgentInvocationStreamEvent } from "./invocation-stream.ts"

function validateSandboxCommands(commands: unknown): string[] {
  if (!Array.isArray(commands) || !commands.length) {
    throw new TypeError("[vitehub] sandbox({ commands }) requires at least one executable name.")
  }
  for (const command of commands) {
    if (typeof command !== "string" || !/^[A-Za-z0-9_.-]+$/.test(command)) {
      throw new TypeError("[vitehub] sandbox({ commands }) accepts executable names only, not shell command strings.")
    }
  }
  return commands
}

function validateWorkspaceCapabilities<Name extends WorkspaceName>(options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>, workspaceDefinition: Pick<WorkspaceDefinition, "sources">): void {
  const capabilities = normalizeCapabilities(options.capabilities)
  const workspaceMode = workspaceModeFromOptions(options)
  if (workspaceSourceScopeNames(workspaceDefinition.sources).length && !capabilities.some(accessCapabilityRequiresWorkspace)) {
    throw new Error("[vitehub] Workspace Source scopes require access({ workspace }).")
  }
  for (const capability of capabilities) {
    if (capability.id === "workspace-shell") {
      const metadata = capability.metadata as { commands?: unknown } | undefined
      const requiresWritableSession = Array.isArray(metadata?.commands)
      if (requiresWritableSession && workspaceMode !== "write") {
        throw new Error("[vitehub] workspaceShell({ commands }) requires workspace.mode: \"write\".")
      }
      if (!requiresWritableSession && normalizeMode(capability.mode, "Workspace Shell") === "write" && workspaceMode !== "write") {
        throw new Error("[vitehub] workspaceShell({ mode: \"write\" }) requires workspace.mode: \"write\".")
      }
    }
    if (capability.id === "sandbox") {
      validateSandboxCommands((capability.metadata as { commands?: unknown } | undefined)?.commands)
    }
  }
}

function accessCapabilityRequiresWorkspace(capability: NormalizedCapability): boolean {
  if (capability.id !== "access") return false
  const metadata = capability.metadata
  return typeof metadata === "object"
    && metadata !== null
    && (metadata as { workspace?: unknown }).workspace === true
}

function capabilityWorkspaceIsOptional(capability: NormalizedCapability): boolean {
  const metadata = capability.metadata
  return typeof metadata === "object"
    && metadata !== null
    && (metadata as { [optionalWorkspaceCapabilitySymbol]?: unknown })[optionalWorkspaceCapabilitySymbol] === true
}

function validateNonWorkspaceCapabilities(capabilities: NormalizedCapability[], hasWorkspace: boolean): void {
  if (hasWorkspace) return
  for (const capability of capabilities) {
    if (capability.workspace && !capabilityWorkspaceIsOptional(capability) || capability.id === "workspace-shell" || capability.id === "sandbox" || accessCapabilityRequiresWorkspace(capability)) {
      const name = capability.id === "workspace-shell" ? "workspaceShell" : capability.id
      throw new Error(`[vitehub] ${name}() requires an explicit workspace.`)
    }
  }
}

function defineBaseAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(
  options: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile>,
): AgentDefinition<TRuntimeConfig, CALL_OPTIONS> {
  const driver = normalizeAgentDriver(options)
  const { capabilities, channels, description, hooks, messages, runtime, version, workspace } = options
  const run = driver.kind === "run" ? driver.run : undefined
  const baseCapabilities = normalizeCapabilities(capabilities as AgentCapabilitiesList | undefined)
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
  validateNonWorkspaceCapabilities(normalizedCapabilities, !!workspace)
  const resolveBaseAgent: BaseAgentResolver<TRuntimeConfig, CALL_OPTIONS> = async (context) => {
    const resolvedAdapter = driver.kind === "model"
      ? (await import("./ai-sdk.ts")).createAiSdkAdapter({
          execution: driver.execution,
          instructions: driver.instructions,
          model: driver.model,
        } as never) as AgentAdapter<CALL_OPTIONS>
      : driver.kind === "harness"
        ? (await import("./harness-agent.ts")).createHarnessAgentAdapter<CALL_OPTIONS>(driver as never)
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
    ...(driver.kind === "model" ? { [baseAgentModel]: driver.model } : {}),
    [baseAgentDriverKind]: driver.kind,
    [baseAgentResolve]: resolveBaseAgent,
    channels,
    chat,
    description,
    hooks,
    invoker,
    messages,
    runtime,
    run,
    version,
    workspace,
    ...(normalizedCapabilities.length ? { capabilities: normalizedCapabilities } : {}),
    async resolve(context) {
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
  } as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS>
  Object.defineProperty(definition, "__vitehubAgentSettings", { value: options })
  return definition
}

export function workflow(name?: string): AgentWorkflowRuntimeBinding {
  return {
    kind: "workflow",
    ...(name ? { name } : {}),
  }
}

function withAgentWorkflowRuntimeName(runtime: AgentRuntimeBinding | undefined, name: string | undefined): AgentRuntimeBinding | undefined {
  if (!name || runtime?.kind !== "workflow" || runtime.name) return runtime
  return { ...runtime, name }
}

function createSyntheticWorkspaceRun<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS>,
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

function cloneAgentDefinitionWithDefaults<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  defaults: WorkspaceAgentDefaults | undefined,
  runtime: AgentRuntimeBinding | undefined,
): AgentInput<TContext> {
  const clone = Object.create(Object.getPrototypeOf(agent)) as AgentDefinition
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(agent))
  if (defaults) {
    (clone as Partial<WorkspaceAgentDefinition>).__vitehubWorkspaceAgentDefaults = defaults
  }
  if (runtime) {
    clone.runtime = runtime
  }
  if (clone.run && syntheticWorkspaceRun in clone.run) {
    clone.run = createSyntheticWorkspaceRun(clone as never) as typeof clone.run
  }
  return clone as AgentInput<TContext>
}

export function withAgentDefaults<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  options?: AgentHandlerOptions<TContext>,
): AgentInput<TContext>
export function withAgentDefaults<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext> | undefined,
  options?: AgentHandlerOptions<TContext>,
): AgentInput<TContext> | undefined
export function withAgentDefaults<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext> | undefined,
  options: AgentHandlerOptions<TContext> = {},
): AgentInput<TContext> | undefined {
  if (!agent || !hasAgentDefinition(agent)) return agent
  const workspaceDefinition = agent as Partial<WorkspaceAgentDefinition>
  const existingWorkspaceDefaults = workspaceDefinition.__vitehubWorkspaceAgentDefaults
  const workspaceDefaults = workspaceDefinition.__vitehubWorkspaceAgent && (options.inferredName || options.workspace)
    ? {
        ...existingWorkspaceDefaults,
        ...(options.inferredName ? { name: options.inferredName } : {}),
        ...(options.workspace ? { workspace: options.workspace } : {}),
      }
    : undefined
  const runtime = withAgentWorkflowRuntimeName(agent.runtime, options.inferredName)
  return !workspaceDefaults && (!runtime || runtime === agent.runtime)
    ? agent
    : cloneAgentDefinitionWithDefaults(agent, workspaceDefaults, runtime === agent.runtime ? undefined : runtime)
}

export interface DefineAgent {
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    Name extends WorkspaceName = WorkspaceName,
    CALL_OPTIONS = unknown,
    const TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
    const TCapabilities extends readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[] | undefined = AgentCapabilityDefinition<TRuntimeConfig, Name>[] | undefined,
    const TOptions extends WorkspaceAgentOptions<
      TRuntimeConfig,
      Name,
      CALL_OPTIONS,
      TInvokerProfile,
      AgentCapabilitiesInvocationContextValues<TCapabilities>,
      TCapabilities
    > = WorkspaceAgentOptions<
      TRuntimeConfig,
      Name,
      CALL_OPTIONS,
      TInvokerProfile,
      AgentCapabilitiesInvocationContextValues<TCapabilities>,
      TCapabilities
    >,
  >(
    options: TOptions & { capabilities?: TCapabilities } & ValidateWorkspaceAgentOptions<TOptions>,
  ): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS, TInvokerProfile, AgentCapabilitiesInvocationContextValues<TCapabilities>, TCapabilities>
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    CALL_OPTIONS = unknown,
    const TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
    const TCapabilities extends readonly AgentCapabilityDefinition<TRuntimeConfig>[] | undefined = AgentCapabilityDefinition<TRuntimeConfig>[] | undefined,
  >(
    options: AgentSettings<
      TRuntimeConfig,
      CALL_OPTIONS,
      TInvokerProfile,
      AgentCapabilitiesInvocationContextValues<TCapabilities>,
      TCapabilities
    > & { capabilities?: TCapabilities, workspace?: never },
  ): AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, AgentCapabilitiesInvocationContextValues<TCapabilities>>
}

function createWorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name, CALL_OPTIONS, TInvokerProfile>,
  defaults: WorkspaceAgentDefaults<Name> = {},
): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS> {
  const workspaceDefinition = workspaceDefinitionFromOptions(options as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, Name>)
  validateWorkspaceCapabilities(options as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, Name>, workspaceDefinition)
  const definition = defineBaseAgent<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile>({
    ...options,
    description: options.description,
    hooks: options.hooks,
    runtime: withAgentWorkflowRuntimeName(options.runtime, defaults.name),
    version: options.version,
    workspace: workspaceDefinition,
  } as never) as WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS>

  if (!definition.run) {
    definition.run = createSyntheticWorkspaceRun(definition)
  }

  Object.assign(definition, workspaceDefinition, {
    __vitehubWorkspaceAgent: true,
    __vitehubWorkspaceAgentDefaults: defaults,
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
  if (hasAgentMethods(agent)) {
    return normalizeDirectAgent(agent as never)
  }

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
  context: TContext,
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

  return withAgentDefaults(agent, { inferredName: name }) as AgentInput<TContext>
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
  channels?: AgentChannels<TRuntimeConfig>
  close: () => Promise<void>
  deliveryEffectIntents: AgentChannelDeliveryEffectIntent[]
  devtools?: AgentRuntimeContext<TRuntimeConfig>["devtools"]
  driverContributions: AgentDriverContribution[]
  finalOutputRenderers: AgentCapabilityRegistries["finalOutputRenderers"]
  finishDeliveryEffectProviders: AgentChannelDeliveryFinishEffect[]
  finishExtensionProviders: ResolvedAgentFinishExtensionProvider[]
  finishHook?: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS> extends infer TEvent ? (event: TEvent) => MaybePromise<void> : never
  hasCapabilityCleanup: boolean
  harnessWorkspacePaths: readonly string[]
  hooks?: AgentHookObserverHooks
  modelExecutionInstrumentation: AgentCapabilityRegistries["modelExecutionInstrumentation"]
  outputExtensionProviders: ResolvedAgentOutputExtensionProvider[]
  outputRenderers: AgentCapabilityRegistries["outputRenderers"]
  runtimeContext: ResolvedAgentRuntimeContext<TRuntimeConfig>
  instructions?: string
  startedAt: number
  actor: AgentInvoker
  invoker: AgentInvoker
  handledResponse?: Response
  workspace?: ReadonlyWorkspaceFacade<WorkspaceName> | WritableWorkspaceFacade<WorkspaceName>
  workspaceDefinition?: WorkspaceDefinition
  workspaceInstructionBindings?: Record<string, unknown>
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
  const runtimeContext = resolvedContext.trace || !resolvedContext.traceLog ? resolvedContext : { ...resolvedContext, trace: { id: createTraceId(context.run) } }
  const callbackContext = createAgentCallbackContext(runtimeContext)
  const invocationContext = createAgentInvocationContextStore(input.context)
  let invoker = createFallbackAgentInvoker(context.run)
  try {
    invoker = await resolveAgentInvoker(definition?.invoker, callbackContext, invocationContext, input, context.run)
    const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig>> | undefined
    const workspaceOptions = workspaceDefinition?.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<AgentRuntimeConfig> | undefined
    const workspaceName = workspaceOptions
      ? workspaceNameFromOptions(workspaceOptions, workspaceDefinition?.__vitehubWorkspaceAgentDefaults)
      : workspaceDefinition?.__vitehubWorkspaceAgentDefaults?.workspace
    const workspaceMode = workspaceOptions ? workspaceModeFromOptions(workspaceOptions) : "read"
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
    const resolvedWorkspaceDefinition = workspaceName
      ? mergeAgentWorkspaceDefinition(workspaceName, registeredWorkspaceDefinition, configuredDefinitionForMerge)
      : undefined
    if (workspaceName && ownsWorkspaceDefinition && configuredWorkspaceDefinition && !registeredWorkspaceDefinition) {
      await registerResolvedAgentWorkspaceDefinition(workspaceName, resolvedWorkspaceDefinition)
    }
    const workspaceUseOptions = !ownsWorkspaceDefinition && hasWorkspaceDefinitionOverlay(configuredDefinitionForMerge) && resolvedWorkspaceDefinition
      ? { definition: resolvedWorkspaceDefinition }
      : undefined
    const workspaceModule = workspaceName ? await import("@vite-hub/workspace") : undefined
    const workspace = workspaceName && workspaceModule
      ? workspaceMode === "write"
        ? workspaceModule.useWorkspace(workspaceName, workspaceUseOptions ? { ...workspaceUseOptions, mode: "write" } : { mode: "write" })
        : workspaceUseOptions ? workspaceModule.useWorkspace(workspaceName, { ...workspaceUseOptions, mode: "read" }) : workspaceModule.useWorkspace(workspaceName)
      : undefined
    const capabilityOptions = definition?.capabilities?.length
      ? { capabilities: definition.capabilities as AgentCapabilityDefinition<TRuntimeConfig>[], hooks: definition.hooks as never }
      : workspaceOptions && workspace
        ? { capabilities: workspaceOptions.capabilities as AgentCapabilityDefinition<TRuntimeConfig>[], hooks: workspaceOptions.hooks as never }
        : undefined
    const agentModel = (definition as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS> | undefined)?.[baseAgentModel] as AgentModelResolver<TRuntimeConfig> | undefined
    const driverKind = (definition as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS> | undefined)?.[baseAgentDriverKind]
    const resolveCapabilityCli = (definition as Record<PropertyKey, unknown> | undefined)?.[capabilityCliRunSurface] === true
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
    const instructions = workspaceOptions && activeWorkspace
      ? await resolveWorkspaceAgentDefaultInstructions(workspaceOptions, activeWorkspace as ReadonlyWorkspaceFacade)
      : undefined
    const workspaceInstructionBindings = activeWorkspaceDefinition
      ? await resolveWorkspaceInstructionBindings(activeWorkspaceDefinition, activeWorkspace as ReadonlyWorkspaceFacade | undefined)
      : undefined

    const invocation = {
      ...callbackContext,
      actor: invoker,
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
      hasCapabilityCleanup: capabilities.hasCloseCallbacks,
      harnessWorkspacePaths: capabilities.harnessWorkspacePaths,
      handledResponse: capabilities.response,
      hooks: definition?.hooks as AgentHookObserverHooks | undefined,
      input: capabilities.input as AgentRunInput<CALL_OPTIONS>,
      instructions,
      invoker,
      messages: capabilities.messages,
      modelExecutionInstrumentation: capabilities.registries.modelExecutionInstrumentation,
      outputExtensionProviders: capabilities.registries.outputExtensionProviders,
      outputRenderers: capabilities.registries.outputRenderers,
      prompt: typeof capabilities.input.prompt === "string" ? capabilities.input.prompt : undefined,
      providerTools: capabilities.registries.providerTools,
      run: context.run,
      runtimeContext,
      startedAt,
      tools,
      workspace: activeWorkspace,
      workspaceDefinition: activeWorkspaceDefinition,
      workspaceInstructionBindings,
      workspaceMode,
    }
    await traceAgentInvocationStart(toTraceContext(invocation))
    await applyChannelDeliveryEffectIntents(invocation, invocation.deliveryEffectIntents)
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
  finishHook?: (event: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void>
  hooks?: AgentHookObserverHooks
  input: AgentRunInput<CALL_OPTIONS>
  outputExtensionProviders: ResolvedAgentOutputExtensionProvider[]
  actor: AgentInvoker
  invoker: AgentInvoker
  runtimeContext: ResolvedAgentRuntimeContext<TRuntimeConfig>
  run?: AgentRunContext<TRuntimeConfig, CALL_OPTIONS>["run"]
  startedAt: number
  workspace?: ReadonlyWorkspaceFacade | WritableWorkspaceFacade
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

function hasTraceableStreamResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const result = value as { fullStream?: unknown, stream?: unknown, textStream?: unknown }
  return isAsyncIterable(result.fullStream) || isAsyncIterable(result.stream) || isAsyncIterable(result.textStream)
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
    const current = (result as { text?: unknown }).text
    return typeof current === "string" && current ? result : { ...result, text }
  }
  return { raw: result, text }
}

function withStreamedResult(stream: AsyncIterable<unknown>, result: unknown) {
  const toolNames = new Map<string, string>()
  let streamedText = ""
  let usageRecord: Extract<StreamEvent, { type: "usage" }>["usageRecord"] | undefined
  return {
    finishResult() {
      const output = resultWithStreamedText(result, streamedText)
      if (usageRecord && output && typeof output === "object" && !(output instanceof Response)) {
        const record = output as { usage?: unknown, usageRecord?: unknown }
        record.usageRecord ??= usageRecord
        record.usage ??= usageRecord.usage
      }
      return output
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
  result: unknown,
  outcome: AgentInvocationFinishOutcome,
  failureMessage: string,
  outputExtensions = new Map<string, unknown>(),
): Promise<void> {
  if (outcome.status === "error") {
    await finishAgentInvocation(context, outcome)
    return
  }
  let finishResult: unknown
  try {
    finishResult = await applyFinalOutputRenderers(result, context, outputExtensions)
  }
  catch (finishError) {
    await finishFailedAgentInvocation(context, finishError, failureMessage)
  }
  await finishAgentInvocation(context, { result: finishResult, status: "success" })
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
      value: (...args: unknown[]) => traceUiMessageStream(toUIMessageStream.apply(rendered, args), context),
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

type AgentInvocationFinishOutcome =
  | { result?: unknown, status: "success" }
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
  return context.hasCapabilityCleanup || hasFinishWork(context) || Boolean(context.finalOutputRenderers.length) || hasWorkspaceAutoCommit(context)
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
  const commit = resolveWorkspaceAutoCommit(context.workspaceDefinition, diff)
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
  event: AgentFinishEvent,
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
): Promise<AgentChannelDeliveryEffectIntent[]> {
  const intents: AgentChannelDeliveryEffectIntent[] = []
  const finishContext = {
    ...context.runtimeContext,
    input: context.input,
    run: context.run,
    workspace: context.workspace,
  }
  for (const provider of providers) {
    const intent = typeof provider === "function" ? await provider(event, finishContext) : provider
    if (!intent) continue
    appendDeliveryEffectIntent(intents, intent)
  }
  return intents
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
  try {
    await context.close()
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
          ...(context.run ? { run: context.run } : {}),
        },
        ...(result !== undefined ? { result } : {}),
        runtime: context.runtimeContext,
      } satisfies Omit<AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>, "extensions">
      const extensions = await createAgentInvocationExtensions(eventBase as never, context.finishExtensionProviders)
      const finishEvent = { ...eventBase, extensions }
      await applyChannelDeliveryEffectIntents(context, await resolveFinishDeliveryEffectIntents(context.finishDeliveryEffectProviders, finishEvent as never, context), finishEvent as never)
      await runObservedAgentHook(context.hooks, {
        ids: { runId: context.run?.runId },
        name: "agent:finish",
        owner: "agent",
        phase: "finish",
      }, async () => {
        await context.finishHook?.(finishEvent)
      })
    }
    if (!failed) await commitWorkspaceChanges(context)
    if (!failed) {
      await traceAgentInvocationFinish(toTraceContext(context), {
        "invocation.durationMs": durationMs,
        "result.hasValue": result !== undefined,
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

async function finishFailedAgentInvocation<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  error: unknown,
  message: string,
): Promise<never> {
  try {
    await finishAgentInvocation(context, { error, status: "error" })
  }
  catch (finishError) {
    throw new AggregateError([error, finishError], message)
  }
  throw error
}

async function finalizeAgentInvocationResult<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TResult,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS> & { hasCapabilityCleanup: boolean },
  result: unknown,
  finalizeObject: (result: unknown) => MaybePromise<{ deferFinish?: boolean, finishResult: unknown, value: TResult }>,
  failureMessage: string,
  options: {
    finalizeRawStreams?: boolean
    outputExtensions?: Map<string, unknown>
    wrapStream?: (stream: AsyncIterable<unknown>) => AsyncIterable<unknown>
  } = {},
): Promise<Response | AsyncIterable<unknown> | TResult> {
  const shouldWrapOutput = shouldWrapInvocationOutput(context)
  let finishLifecycleStarted = false
  try {
    if (result instanceof Response) {
      const response = shouldWrapOutput ? await withResponseCleanup(result, outcome => finishAgentInvocation(context, finishOutcomeFromCleanup(outcome, result))) : result
      finishLifecycleStarted = shouldWrapOutput
      return response
    }
    if (isAsyncIterable(result) && !hasTraceableStreamResult(result) && !options.finalizeRawStreams) {
      finishLifecycleStarted = shouldWrapOutput
      const stream = options.wrapStream?.(result) || result
      if (shouldWrapOutput && context.finalOutputRenderers.length) {
        const streamed = withStreamedResult(stream, result)
        return withCapabilityCleanup(streamed.stream, outcome => finishStreamAgentInvocation(context, streamed.finishResult(), finishOutcomeFromCleanup(outcome), failureMessage, options.outputExtensions), { abortSignal: context.input.abortSignal })
      }
      return shouldWrapOutput ? withCapabilityCleanup(stream, outcome => finishAgentInvocation(context, finishOutcomeFromCleanup(outcome, result)), { abortSignal: context.input.abortSignal }) : stream
    }
    const finalized = await finalizeObject(result)
    finishLifecycleStarted = true
    if (!finalized.deferFinish) {
      await finishAgentInvocation(context, { result: finalized.finishResult, status: "success" })
    }
    return finalized.value
  }
  catch (error) {
    if (finishLifecycleStarted) throw error
    return await finishFailedAgentInvocation(context, error, failureMessage)
  }
}

export async function runAgentInline<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options: RunAgentInlineOptions = {},
): Promise<Response | AgentRunResult | unknown> {
  const renderOutput = options.output !== "raw"
  if (hasCustomRun<TRuntimeConfig, CALL_OPTIONS>(agent)) {
    const runContext = await createAgentInvocationContext(agent, context, input)
    runContext.close = once(runContext.close)
    if (runContext.handledResponse) {
      return await finalizeAgentInvocationResult(runContext, runContext.handledResponse, async result => ({ finishResult: result, value: result }), "[vitehub] Agent run failed and finish lifecycle also failed.")
    }
    let result: unknown
    try {
      result = await agent.run(runContext)
    }
    catch (error) {
      return await finishFailedAgentInvocation(runContext, error, "[vitehub] Agent run failed and finish lifecycle also failed.")
    }
    const outputExtensions = new Map<string, unknown>()
    let renderedResult = false
    try {
      if (renderOutput && isAsyncIterable(result)) {
        result = await applyOutputRenderers(result, runContext.outputRenderers, runContext.outputExtensionProviders, outputExtensions)
        renderedResult = true
      }
    }
    catch (error) {
      return await finishFailedAgentInvocation(runContext, error, "[vitehub] Agent run failed and finish lifecycle also failed.")
    }
    return await finalizeAgentInvocationResult(runContext, result, async (result) => {
      const rendered = renderOutput
        ? renderedResult ? result : await applyOutputRenderers(result, runContext.outputRenderers, runContext.outputExtensionProviders, outputExtensions)
        : result
      const final = renderOutput ? await applyFinalOutputRenderers(rendered, runContext, outputExtensions) : rendered
      return { finishResult: final, value: final }
    }, "[vitehub] Agent run failed and finish lifecycle also failed.", {
      outputExtensions,
      wrapStream: stream => maybeTraceAgentStream(stream as AsyncIterable<StreamEvent>, runContext),
    })
  }

  const resolved = await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(agent, context)
  const definition = hasAgentDefinition(agent) ? agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS> : undefined
  const adapterContext = await createAgentInvocationContext(definition, context, input)
  adapterContext.close = once(adapterContext.close)
  if (adapterContext.handledResponse) {
    return await finalizeAgentInvocationResult(adapterContext, adapterContext.handledResponse, async result => ({ finishResult: result, value: result }), "[vitehub] Agent run failed and finish lifecycle also failed.")
  }
  let result: unknown
  try {
    result = await resolved.generate(toAgentAdapterRunContext(adapterContext) as never)
  }
  catch (error) {
    return await finishFailedAgentInvocation(adapterContext, error, "[vitehub] Agent run failed and finish lifecycle also failed.")
  }
  return await finalizeAgentInvocationResult(adapterContext, result, async (result) => {
    const outputExtensions = new Map<string, unknown>()
    const rendered = renderOutput ? await applyOutputRenderers(result, adapterContext.outputRenderers, adapterContext.outputExtensionProviders, outputExtensions) : result
    const final = renderOutput ? await applyFinalOutputRenderers(rendered, adapterContext, outputExtensions) : rendered
    const runResult = renderOutput ? toAgentRunResult(final) : final
    return { finishResult: final, value: runResult }
  }, "[vitehub] Agent run failed and finish lifecycle also failed.")
}

export async function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
): Promise<Response | AgentRunResult | unknown> {
  const workflowRun = await runAgentAsWorkflow(agent, context, input)
  if (workflowRun) return workflowRun
  return await runAgentInline(agent, context, input)
}

export async function runScheduledAgent(
  agent: AgentInput<AgentRuntimeContext>,
  context: ScheduleRunContextLike,
  runtimeContext: Partial<ResolvedAgentRuntimeContext> = {},
): Promise<unknown> {
  const memoValues = new Map<string, unknown>()
  const runId = context.runId || context.id

  return await runAgent(agent, {
    ...runtimeContext,
    memo(key, create) {
      if (!memoValues.has(key)) memoValues.set(key, create())
      return memoValues.get(key) as never
    },
    run: { ...runtimeContext.run, runId },
    runtime: runtimeContext.runtime ?? "unknown",
    waitUntil: runtimeContext.waitUntil ?? (() => {}),
  }, {
    context: {
      schedule: {
        id: context.id,
        kind: "schedule",
        runId,
        scheduleId: context.scheduleId,
        scheduledAt: context.scheduledAt,
        target: context.target,
      },
    },
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
  const output = options.output || "events"
  if (hasCustomRun<TRuntimeConfig, CALL_OPTIONS>(agent)) {
    const runContext = await createAgentInvocationContext(agent, context, input)
    runContext.close = once(runContext.close)
    if (runContext.handledResponse) {
      return await finalizeAgentInvocationResult(runContext, runContext.handledResponse, async result => ({ finishResult: result, value: result }), "[vitehub] Agent stream failed and finish lifecycle also failed.")
    }
    let result: unknown
    try {
      result = await agent.run(runContext)
    }
    catch (error) {
      return await finishFailedAgentInvocation(runContext, error, "[vitehub] Agent run failed and finish lifecycle also failed.")
    }
    const outputExtensions = new Map<string, unknown>()
    let renderedResult = false
    try {
      if (isAsyncIterable(result) && output !== "ui-message-stream" && !runContext.finalOutputRenderers.length) {
        result = await applyOutputRenderers(result, runContext.outputRenderers, runContext.outputExtensionProviders, outputExtensions)
        renderedResult = true
      }
    }
    catch (error) {
      return await finishFailedAgentInvocation(runContext, error, "[vitehub] Agent run failed and finish lifecycle also failed.")
    }
    return await finalizeAgentInvocationResult(runContext, result, async (result) => {
      const rendered = renderedResult ? result : await applyOutputRenderers(result, runContext.outputRenderers, runContext.outputExtensionProviders, outputExtensions)
      if (output === "ui-message-stream") {
        return finalizeUiMessageStreamOutput(maybeTraceUiMessageStreamOutput(rendered, runContext), shouldWrapInvocationOutput(runContext), async (outcome, streamedText) => {
          await finishStreamAgentInvocation(runContext, resultWithStreamedText(rendered, streamedText || ""), finishOutcomeFromCleanup(outcome), "[vitehub] Agent stream failed and finish lifecycle also failed.", outputExtensions)
        })
      }
      const isStreamResult = hasTraceableStreamResult(rendered)
      const isStream = isAsyncIterable(rendered) || isStreamResult
      if (!isStream) {
        const final = await applyFinalOutputRenderers(rendered, runContext, outputExtensions)
        return { finishResult: final, value: final }
      }
      const stream = isStreamResult
        ? streamAgentOutputToEvents(rendered)
        : rendered as AsyncIterable<StreamEvent>
      const shouldWrapOutput = shouldWrapInvocationOutput(runContext)
      const streamed = withStreamedResult(stream, rendered)
      const tracedStream = maybeTraceAgentStream(streamed.stream as AsyncIterable<StreamEvent>, runContext)
      return {
        deferFinish: isStream && shouldWrapOutput,
        finishResult: rendered,
        value: isStream
          ? withStreamResultProperties(shouldWrapOutput
            ? withCapabilityCleanup(tracedStream, async (outcome) => {
                await finishStreamAgentInvocation(runContext, streamed.finishResult(), finishOutcomeFromCleanup(outcome), "[vitehub] Agent stream failed and finish lifecycle also failed.", outputExtensions)
              }, { abortSignal: runContext.input.abortSignal }) as AsyncIterable<StreamEvent>
            : tracedStream, rendered)
          : rendered,
      }
    }, "[vitehub] Agent run failed and finish lifecycle also failed.", {
      finalizeRawStreams: output === "ui-message-stream" || Boolean(runContext.finalOutputRenderers.length),
      outputExtensions,
      wrapStream: stream => maybeTraceAgentStream(stream as AsyncIterable<StreamEvent>, runContext),
    })
  }

  const resolved = await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(agent, context)
  const definition = hasAgentDefinition(agent) ? agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS> : undefined
  const adapterContext = await createAgentInvocationContext(definition, context, input)
  adapterContext.close = once(adapterContext.close)
  if (adapterContext.handledResponse) {
    return await finalizeAgentInvocationResult(adapterContext, adapterContext.handledResponse, async result => ({ finishResult: result, value: result }), "[vitehub] Agent stream failed and finish lifecycle also failed.")
  }
  let result: unknown
  try {
    result = resolved.stream
      ? await resolved.stream(toAgentAdapterRunContext(adapterContext) as never)
      : await resolved.generate(toAgentAdapterRunContext(adapterContext) as never)
  }
  catch (error) {
    return await finishFailedAgentInvocation(adapterContext, error, "[vitehub] Agent stream failed and finish lifecycle also failed.")
  }
  const outputExtensions = new Map<string, unknown>()
  let renderedResult = false
  try {
    if (isAsyncIterable(result) && output !== "ui-message-stream" && !adapterContext.finalOutputRenderers.length) {
      result = await applyOutputRenderers(result, adapterContext.outputRenderers, adapterContext.outputExtensionProviders, outputExtensions)
      renderedResult = true
    }
  }
  catch (error) {
    return await finishFailedAgentInvocation(adapterContext, error, "[vitehub] Agent stream failed and finish lifecycle also failed.")
  }
  return await finalizeAgentInvocationResult(adapterContext, result, async (result) => {
    const rendered = renderedResult ? result : await applyOutputRenderers(result, adapterContext.outputRenderers, adapterContext.outputExtensionProviders, outputExtensions)
    if (output === "ui-message-stream") {
      return finalizeUiMessageStreamOutput(maybeTraceUiMessageStreamOutput(rendered, adapterContext), shouldWrapInvocationOutput(adapterContext), async (outcome, streamedText) => {
        await finishStreamAgentInvocation(adapterContext, resultWithStreamedText(rendered, streamedText || ""), finishOutcomeFromCleanup(outcome), "[vitehub] Agent stream failed and finish lifecycle also failed.", outputExtensions)
      })
    }
    const events = streamAgentOutputToEvents(rendered)
    const streamed = withStreamedResult(events, rendered)
    const tracedEvents = maybeTraceAgentStream(streamed.stream as AsyncIterable<StreamEvent>, adapterContext)
    const shouldWrapOutput = shouldWrapInvocationOutput(adapterContext)
    return {
      deferFinish: shouldWrapOutput,
      finishResult: rendered,
      value: shouldWrapOutput ? withCapabilityCleanup(tracedEvents, async (outcome) => {
        await finishStreamAgentInvocation(adapterContext, streamed.finishResult(), finishOutcomeFromCleanup(outcome), "[vitehub] Agent stream failed and finish lifecycle also failed.", outputExtensions)
      }, { abortSignal: adapterContext.input.abortSignal }) : tracedEvents,
    }
  }, "[vitehub] Agent stream failed and finish lifecycle also failed.", {
    finalizeRawStreams: output === "ui-message-stream" || Boolean(adapterContext.finalOutputRenderers.length),
    outputExtensions,
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
