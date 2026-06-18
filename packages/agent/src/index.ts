import agentRegistry from "#vitehub/agent/registry"
import { normalizeAgentDriver } from "./internal/agent-driver.ts"
import { getMessageText } from "./messages.ts"
import { resolveRuntimeContext } from "@vite-hub/runtime"
import { isAsyncIterable, streamAgentOutputToEvents, toAgentRunResult, toAgentStreamEvent } from "./agent-output.ts"
import { getChatCapabilityOptions } from "./chat-trigger.ts"
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
  resolveAgentCapabilities,
  resolveStaticCapabilityTools,
  withCapabilityCleanup,
  withResponseCleanup,
} from "./capability-runtime.ts"
import type { ResolvedAgentFinishExtensionProvider } from "./capability-runtime.ts"
import { formatUnknownAgentMessage } from "./registry-error.ts"
import { finalizeUiMessageStreamOutput, isUIMessageStreamResult } from "./stream-output.ts"
import { createHarnessAgentAdapter } from "./harness-agent.ts"
import {
  applyAgentToolPolicies,
  withAgentToolStepReporting,
} from "./tool-runtime.ts"
import {
  traceAgentInvocationError,
  traceAgentInvocationFinish,
  traceAgentInvocationStart,
  traceAgentStreamEvent,
  traceAgentStreamEvents,
} from "./trace.ts"
import {
  resolveAgentTriggerInvocation as resolveAgentTriggerInvocationWithResolvedContext,
  resolveAgentTriggers as resolveAgentTriggersWithResolvedContext,
  runAgentTriggerWith,
  streamAgentTriggerWith,
} from "./trigger-runtime.ts"
import {
  isWorkspaceAgentOptions,
  resolveWorkspaceSourceInstructionBlock,
  workspaceDefinitionFromOptions,
  workspaceModeFromOptions,
  workspaceNameFromOptions,
} from "./workspace-agent.ts"

import type {
  AgentAdapter,
  AgentAdapterFactory,
  AgentAdapterMetadataContext,
  AgentAdapterRunContext,
  AgentAdapterResult,
  AgentCapabilitiesList,
  AgentCapabilityHooks,
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityInput,
  AgentCapabilityMode,
  AgentCapabilityTypeContract,
  AgentDefinition,
  AgentFinishEvent,
  AgentChatOptions,
  AgentHandlerOptions,
  AgentInput,
  AgentInstructionBlock,
  AgentInvocationHooks,
  AgentInvocationContextStore,
  AgentInvocationContextValues,
  AgentInvoker,
  AgentInvokerOptions,
  AgentInvokerProfile,
  AgentModelResolver,
  AgentRegistry,
  AgentRegistryModule,
  AgentRequestBody,
  AgentRunContext,
  AgentRunHandler,
  AgentRunInput,
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
  ResolvedAgentTriggerDefinition,
  ResolvedAgentRuntimeContext,
} from "./types.ts"
import type { Message, StreamEvent } from "./messages.ts"
import type { AgentTraceContext } from "./trace.ts"
import type { ResolvedAgentTriggerInvocation } from "./trigger-runtime.ts"
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
  AgentCapabilities,
  AgentCapabilitiesList,
  AgentCallSettingsInstrumentation,
  AgentCallSettingsInstrumentationContext,
  AgentCapabilityHandle,
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityHookName,
  AgentCapabilityHooks,
  AgentCapabilityInput,
  AgentCapabilityMode,
  AgentCapabilityPhase,
  AgentCapabilityRuntimeContext,
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
  AgentRequestBody,
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
  AgentInstructionBlock,
  AgentIntegrationOption,
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
  AgentModelInput,
  AgentModelDriver,
  AgentModelExecutionInstrumentation,
  AgentModelExecutionOptions,
  AgentModelInstrumentation,
  AgentModelResolver,
  AgentModelInstrumentationContext,
  AgentModuleOptions,
  AgentProvidersOptions,
  AgentRegistryHandlerOptions,
  AgentRegistry,
  AgentRegistryModule,
  AgentRunContext,
  AgentRunCallbackContext,
  AgentRunDriver,
  AgentRunHandler,
  AgentRunInput,
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
  AgentChatWebhookRegistrationDefinition,
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
  AgentToolResolver,
  AgentToolStep,
  AgentWaitUntil,
  CloudflareExportedHandlerFetchHandler,
  DiscoveredAgentDefinition,
  MaybePromise,
  MaybeResolvable,
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

const syntheticWorkspaceRun = Symbol("vitehub.syntheticWorkspaceRun")
const baseAgentResolve = Symbol("vitehub.baseAgentResolve")
const baseAgentModel = Symbol("vitehub.baseAgentModel")

type NormalizedCapability = AgentCapabilityDefinition & { mode?: AgentCapabilityMode }
type WorkspaceSourceNames<TWorkspace> =
  TWorkspace extends { sources: infer TSources }
    ? Extract<keyof NonNullable<TSources>, string>
    : string
type InvalidWorkspaceSourceGrant<TSourceName> = {
  readonly __vitehubInvalidWorkspaceSourceGrant: TSourceName
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
    ? TTypeContract extends AgentCapabilityTypeContract
      ? ValidateCapabilityWorkspaceSources<TTypeContract["workspaceSources"], TWorkspace, TCapability>
      : TCapability
    : TCapability
type ValidateAgentCapabilities<TCapabilities, TWorkspace> =
  TCapabilities extends readonly [unknown, ...unknown[]] | readonly []
    ? { [Index in keyof TCapabilities]: ValidateAgentCapability<TCapabilities[Index], TWorkspace> }
    : TCapabilities extends readonly (infer TCapability)[]
      ? ValidateAgentCapability<TCapability, TWorkspace>[]
      : TCapabilities

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
    ? { capabilities?: ValidateAgentCapabilities<TCapabilities, TWorkspace> }
    : unknown
type BaseAgentResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig, CALL_OPTIONS = unknown> =
  (context: AgentRuntimeContext<TRuntimeConfig>) => Promise<AgentAdapter<CALL_OPTIONS>>
type AgentDefinitionWithBaseResolve<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = AgentDefinition<TRuntimeConfig, CALL_OPTIONS> & {
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
  throw new Error("[vitehub] Agent runtime workflow() requires a name when invoked directly. Use workflow(\"name\") so the Agent Invocation can target a stable Workflow Definition.")
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

  const { createWorkflow } = await import("@vite-hub/workflow")
  const { getInlineWorkflowDefinitions } = await import("@vite-hub/workflow/runtime/state")
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
  const { runWithWorkflowRuntimeEvent } = await import("@vite-hub/workflow/runtime/state")
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
export { verifyAgentWebhookRequest } from "./trigger-runtime.ts"
export type { AgentWebhookVerificationResult, ResolvedAgentTriggerInvocation } from "./trigger-runtime.ts"
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

function validateWorkspaceCapabilities<Name extends WorkspaceName>(options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>): void {
  const capabilities = normalizeCapabilities(options.capabilities)
  const workspaceMode = workspaceModeFromOptions(options)
  for (const capability of capabilities) {
    if (capability.id === "workspace-shell" && normalizeMode(capability.mode, "Workspace Shell") === "write" && workspaceMode !== "write") {
      throw new Error("[vitehub] workspaceShell({ mode: \"write\" }) requires workspace.mode: \"write\".")
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

function validateNonWorkspaceCapabilities(capabilities: NormalizedCapability[], hasWorkspace: boolean): void {
  if (hasWorkspace) return
  for (const capability of capabilities) {
    if (capability.id === "workspace-shell" || capability.id === "sandbox" || accessCapabilityRequiresWorkspace(capability)) {
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
  const { capabilities, description, hooks, runtime, title, version, workspace } = options
  const run = driver.kind === "run" ? driver.run : (options as { run?: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS> }).run
  const normalizedCapabilities = normalizeCapabilities(capabilities as AgentCapabilitiesList | undefined)
  const invoker = normalizeAgentInvokerOptions(options.invoker) as AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS> | undefined
  const chat = getChatCapabilityOptions<TRuntimeConfig>(normalizedCapabilities)
  validateNonWorkspaceCapabilities(normalizedCapabilities, !!workspace)
  const resolveBaseAgent: BaseAgentResolver<TRuntimeConfig, CALL_OPTIONS> = async (context) => {
    const resolvedAdapter = driver.kind === "model"
      ? (await import("./ai-sdk.ts")).createAiSdkAdapter({
          execution: driver.execution,
          instructions: driver.instructions,
          model: driver.model,
        } as never) as AgentAdapter<CALL_OPTIONS>
      : driver.kind === "harness"
        ? createHarnessAgentAdapter<CALL_OPTIONS>(driver as never)
        : undefined
    if (!resolvedAdapter) {
      throw new Error("[vitehub] Agent Driver is required unless the agent defines a custom run() handler.")
    }
    const resolvedContext = createResolvedRuntimeContext(context)
    return typeof resolvedAdapter === "function"
      ? await (resolvedAdapter as AgentAdapterFactory<TRuntimeConfig, CALL_OPTIONS>)(resolvedContext)
      : resolvedAdapter
  }

  const definition = {
    ...(driver.kind === "model" ? { [baseAgentModel]: driver.model } : {}),
    [baseAgentResolve]: resolveBaseAgent,
    chat,
    description,
    hooks,
    invoker,
    runtime,
    run,
    title,
    version,
    workspace,
    ...(normalizedCapabilities.length ? { capabilities: normalizedCapabilities } : {}),
    async resolve(context) {
      const adapterInstance = await resolveBaseAgent(context)
      const resolvedContext = createResolvedRuntimeContext(context)
      const resolvedTools = normalizedCapabilities.length && !workspace
        ? await resolveStaticCapabilityTools({ capabilities: normalizedCapabilities }, resolvedContext)
        : undefined
      const capabilityTools = Object.keys(resolvedTools || {}).length
        ? withAgentToolStepReporting(applyAgentToolPolicies(resolvedTools) || {}, context.devtools?.reportToolStep)
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

function cloneAgentDefinitionWithRuntime<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  runtime: AgentRuntimeBinding,
): AgentInput<TContext> {
  const clone = Object.create(Object.getPrototypeOf(agent)) as AgentDefinition
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(agent))
  clone.runtime = runtime
  return clone as AgentInput<TContext>
}

export function withAgentDefaults<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext> | undefined,
  options: AgentHandlerOptions = {},
): AgentInput<TContext> | undefined {
  if (!agent || !hasAgentDefinition(agent)) return agent
  const runtime = withAgentWorkflowRuntimeName(agent.runtime, options.inferredName)
  return !runtime || runtime === agent.runtime ? agent : cloneAgentDefinitionWithRuntime(agent, runtime)
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
  ): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS>
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
  ): AgentDefinition<TRuntimeConfig, CALL_OPTIONS>
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
  validateWorkspaceCapabilities(options as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, Name>)
  const definition = defineBaseAgent<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile>({
    ...options,
    description: options.description,
    hooks: options.hooks,
    run: options.run,
    runtime: withAgentWorkflowRuntimeName(options.runtime, defaults.name),
    version: options.version,
    workspace: workspaceDefinition,
  } as never) as WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS>

  if (!definition.run) {
    const run: NonNullable<AgentDefinition<TRuntimeConfig, CALL_OPTIONS>["run"]> = async (context) => {
      const adapter = await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(definition as never, context)
      const invocationContext = await createAgentInvocationContext(definition as never, context as never, context.input)
      const result = await adapter.generate(toAgentAdapterRunContext(invocationContext) as never)
      return typeof result === "object" && result && "text" in result && typeof (result as { text?: unknown }).text === "string"
        ? (result as { text: string }).text
        : result
    }
    definition.run = Object.assign(run, { [syntheticWorkspaceRun]: true })
  }

  Object.assign(definition, workspaceDefinition, {
    __vitehubWorkspaceAgent: true,
    __vitehubWorkspaceAgentDefaults: defaults,
    __vitehubWorkspaceAgentOptions: options,
  })
  return definition
}

export function withWorkspaceAgentDefaults<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
>(
  definition: WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS>,
  defaults: WorkspaceAgentDefaults<Name>,
): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS> {
  if (!definition?.__vitehubWorkspaceAgent) return definition
  return createWorkspaceAgentDefinition(definition.__vitehubWorkspaceAgentOptions, defaults)
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
): Promise<ResolvedAgentTriggerInvocation<TRuntimeConfig, CALL_OPTIONS>> {
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

type AgentInvocationContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
> = AgentRunContext<TRuntimeConfig, CALL_OPTIONS> & {
  capabilityInstructions: AgentInstructionBlock[]
  close: () => Promise<void>
  devtools?: AgentRuntimeContext<TRuntimeConfig>["devtools"]
  finishExtensionProviders: ResolvedAgentFinishExtensionProvider[]
  finishHook?: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS> extends infer TEvent ? (event: TEvent) => MaybePromise<void> : never
  hasCapabilityCleanup: boolean
  outputRenderers: Array<(result: unknown) => MaybePromise<unknown>>
  runtimeContext: ResolvedAgentRuntimeContext<TRuntimeConfig>
  sourceInstructions?: string
  startedAt: number
  invoker: AgentInvoker
  workspace?: ReadonlyWorkspaceFacade<WorkspaceName> | WritableWorkspaceFacade<WorkspaceName>
  workspaceDefinition?: WorkspaceDefinition
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
    instructions: undefined,
    runtime: context.runtimeContext,
    workspace: context.workspace as ReadonlyWorkspaceFacade<WorkspaceName> | undefined,
  }
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
    const resolvedWorkspaceDefinition = workspaceOptions && workspaceName
      ? { ...workspaceDefinitionFromOptions(workspaceOptions), name: workspaceName }
      : undefined
    const workspace = workspaceName
      ? workspaceMode === "write"
        ? (await import("@vite-hub/workspace")).useWorkspace(workspaceName, { mode: "write" })
        : (await import("@vite-hub/workspace")).useWorkspace(workspaceName)
      : undefined
    const capabilityOptions = workspaceOptions && workspace
      ? { capabilities: workspaceOptions.capabilities as AgentCapabilityDefinition<TRuntimeConfig>[], hooks: workspaceOptions.hooks as never }
      : definition?.capabilities?.length
        ? { capabilities: definition.capabilities as AgentCapabilityDefinition<TRuntimeConfig>[], hooks: definition.hooks as never }
        : undefined
    const agentModel = (definition as AgentDefinitionWithBaseResolve<TRuntimeConfig, CALL_OPTIONS> | undefined)?.[baseAgentModel] as AgentModelResolver<TRuntimeConfig> | undefined
    const capabilities = await resolveAgentCapabilities(capabilityOptions, runtimeContext, input, workspace as never, workspaceMode, {
      context: invocationContext,
      invoker,
      model: agentModel as never,
      workspaceDefinition: resolvedWorkspaceDefinition,
    })
    const transformedTools = await applyCapabilityToolTransforms(capabilities.tools, capabilities.toolTransforms)
    const tools = Object.keys(transformedTools || {}).length
      ? withAgentToolStepReporting(applyAgentToolPolicies(transformedTools) || {}, context.devtools?.reportToolStep)
      : undefined
    const activeWorkspace = capabilities.workspace || workspace
    const sourceResolvedWorkspaceDefinition = invocationContext.get<WorkspaceDefinition>("workspace.sourceResolution.definition")
    const activeWorkspaceDefinition = sourceResolvedWorkspaceDefinition || resolvedWorkspaceDefinition
    const workspaceScope = invocationContext.get("access")?.workspaceScope
    const sourceInstructions = activeWorkspaceDefinition && activeWorkspace
      ? await resolveWorkspaceSourceInstructionBlock(
          activeWorkspaceDefinition,
          workspaceScope && !workspaceScope.all ? activeWorkspace as ReadonlyWorkspaceFacade : undefined,
        )
      : undefined

    const invocation = {
      ...callbackContext,
      capabilityInstructions: capabilities.capabilityInstructions,
      close: capabilities.close,
      context: invocationContext,
      devtools: context.devtools,
      finishExtensionProviders: capabilities.registries.finishExtensionProviders,
      finishHook: definition?.hooks?.["agent:finish"] as never,
      hasCapabilityCleanup: capabilities.hasCloseCallbacks,
      input: capabilities.input as AgentRunInput<CALL_OPTIONS>,
      invoker,
      messages: capabilities.messages,
      outputRenderers: capabilities.registries.outputRenderers,
      prompt: typeof capabilities.input.prompt === "string" ? capabilities.input.prompt : undefined,
      providerTools: capabilities.registries.providerTools,
      run: context.run,
      runtimeContext,
      sourceInstructions,
      startedAt,
      tools,
      workspace: activeWorkspace,
      workspaceDefinition: activeWorkspaceDefinition,
      workspaceMode,
    }
    await traceAgentInvocationStart(toTraceContext(invocation))
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
  close: () => Promise<void>
  context: AgentInvocationContextStore
  finishExtensionProviders: ResolvedAgentFinishExtensionProvider[]
  finishHook?: (event: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void>
  input: AgentRunInput<CALL_OPTIONS>
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
  return {
    toUIMessageStream: () => traceUiMessageStream(rendered.toUIMessageStream(), context),
  }
}

function maybeTraceUiMessageStreamOutput<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(rendered: unknown, context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): unknown {
  if (context.runtimeContext.traceLog && hasTraceableStreamResult(rendered)) {
    if (isUIMessageStreamResult(rendered)) {
      return maybeTraceUiMessageStreamResult(rendered, context)
    }
    return maybeTraceAgentStream(streamAgentOutputToEvents(rendered), context)
  }
  return isAsyncIterable(rendered) ? maybeTraceAgentStream(rendered as AsyncIterable<StreamEvent>, context) : rendered
}

function hasFinishWork<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>): boolean {
  return Boolean(context.finishHook)
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
  return context.hasCapabilityCleanup || hasFinishWork(context) || hasWorkspaceAutoCommit(context)
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

async function finishAgentInvocation<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  context: InvocationRunContext<TRuntimeConfig, CALL_OPTIONS>,
  result?: unknown,
  error?: unknown,
): Promise<void> {
  const durationMs = Date.now() - context.startedAt
  try {
    await context.close()
    if (error === undefined) await commitWorkspaceChanges(context)
    if (hasFinishWork(context)) {
      const eventBase = {
        ...(error !== undefined ? { error } : {}),
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
      await context.finishHook?.({ ...eventBase, extensions })
    }
    if (error === undefined) {
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
    await traceAgentInvocationError(toTraceContext(context), error === undefined ? finishError : error)
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
    await finishAgentInvocation(context, undefined, error)
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
    wrapStream?: (stream: AsyncIterable<unknown>) => AsyncIterable<unknown>
  } = {},
): Promise<Response | AsyncIterable<unknown> | TResult> {
  const shouldWrapOutput = shouldWrapInvocationOutput(context)
  let finishLifecycleStarted = false
  try {
    if (result instanceof Response) {
      const response = shouldWrapOutput ? await withResponseCleanup(result, error => finishAgentInvocation(context, error === undefined ? result : undefined, error)) : result
      finishLifecycleStarted = shouldWrapOutput
      return response
    }
    if (isAsyncIterable(result) && !options.finalizeRawStreams) {
      finishLifecycleStarted = shouldWrapOutput
      const stream = options.wrapStream?.(result) || result
      return shouldWrapOutput ? withCapabilityCleanup(stream, error => finishAgentInvocation(context, error === undefined ? result : undefined, error)) : stream
    }
    const finalized = await finalizeObject(result)
    finishLifecycleStarted = true
    if (!finalized.deferFinish) {
      await finishAgentInvocation(context, finalized.finishResult)
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
): Promise<Response | AgentRunResult | unknown> {
  if (hasCustomRun<TRuntimeConfig, CALL_OPTIONS>(agent)) {
    const runContext = await createAgentInvocationContext(agent, context, input)
    runContext.close = once(runContext.close)
    let result: unknown
    try {
      result = await agent.run(runContext)
    }
    catch (error) {
      return await finishFailedAgentInvocation(runContext, error, "[vitehub] Agent run failed and finish lifecycle also failed.")
    }
    try {
      if (isAsyncIterable(result)) {
        result = await applyOutputRenderers(result, runContext.outputRenderers)
      }
    }
    catch (error) {
      return await finishFailedAgentInvocation(runContext, error, "[vitehub] Agent run failed and finish lifecycle also failed.")
    }
    return await finalizeAgentInvocationResult(runContext, result, async (result) => {
      const rendered = await applyOutputRenderers(result, runContext.outputRenderers)
      return { finishResult: rendered, value: rendered }
    }, "[vitehub] Agent run failed and finish lifecycle also failed.", {
      wrapStream: stream => maybeTraceAgentStream(stream as AsyncIterable<StreamEvent>, runContext),
    })
  }

  const resolved = await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(agent, context)
  const definition = hasAgentDefinition(agent) ? agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS> : undefined
  const adapterContext = await createAgentInvocationContext(definition, context, input)
  adapterContext.close = once(adapterContext.close)
  let result: unknown
  try {
    result = await resolved.generate(toAgentAdapterRunContext(adapterContext) as never)
  }
  catch (error) {
    return await finishFailedAgentInvocation(adapterContext, error, "[vitehub] Agent run failed and finish lifecycle also failed.")
  }
  return await finalizeAgentInvocationResult(adapterContext, result, async (result) => {
    const rendered = await applyOutputRenderers(result, adapterContext.outputRenderers)
    const runResult = toAgentRunResult(rendered)
    return { finishResult: rendered, value: runResult }
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
    let result: unknown
    try {
      result = await agent.run(runContext)
    }
    catch (error) {
      return await finishFailedAgentInvocation(runContext, error, "[vitehub] Agent run failed and finish lifecycle also failed.")
    }
    try {
      if (isAsyncIterable(result) && output !== "ui-message-stream") {
        result = await applyOutputRenderers(result, runContext.outputRenderers)
      }
    }
    catch (error) {
      return await finishFailedAgentInvocation(runContext, error, "[vitehub] Agent run failed and finish lifecycle also failed.")
    }
    return await finalizeAgentInvocationResult(runContext, result, async (result) => {
      const rendered = await applyOutputRenderers(result, runContext.outputRenderers)
      if (output === "ui-message-stream") {
        return finalizeUiMessageStreamOutput(maybeTraceUiMessageStreamOutput(rendered, runContext), shouldWrapInvocationOutput(runContext), error => finishAgentInvocation(runContext, error === undefined ? rendered : undefined, error))
      }
      const isStream = isAsyncIterable(rendered)
      return {
        deferFinish: isStream && shouldWrapInvocationOutput(runContext),
        finishResult: rendered,
        value: isStream
          ? maybeTraceAgentStream(rendered as AsyncIterable<StreamEvent>, runContext)
          : rendered,
      }
    }, "[vitehub] Agent run failed and finish lifecycle also failed.", {
      finalizeRawStreams: output === "ui-message-stream",
      wrapStream: stream => maybeTraceAgentStream(stream as AsyncIterable<StreamEvent>, runContext),
    })
  }

  const resolved = await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(agent, context)
  const definition = hasAgentDefinition(agent) ? agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS> : undefined
  const adapterContext = await createAgentInvocationContext(definition, context, input)
  adapterContext.close = once(adapterContext.close)
  let result: unknown
  try {
    result = resolved.stream
      ? await resolved.stream(toAgentAdapterRunContext(adapterContext) as never)
      : await resolved.generate(toAgentAdapterRunContext(adapterContext) as never)
  }
  catch (error) {
    return await finishFailedAgentInvocation(adapterContext, error, "[vitehub] Agent stream failed and finish lifecycle also failed.")
  }
  try {
    if (isAsyncIterable(result) && output !== "ui-message-stream") {
      result = await applyOutputRenderers(result, adapterContext.outputRenderers)
    }
  }
  catch (error) {
    return await finishFailedAgentInvocation(adapterContext, error, "[vitehub] Agent stream failed and finish lifecycle also failed.")
  }
  return await finalizeAgentInvocationResult(adapterContext, result, async (result) => {
    const rendered = await applyOutputRenderers(result, adapterContext.outputRenderers)
    if (output === "ui-message-stream") {
      return finalizeUiMessageStreamOutput(maybeTraceUiMessageStreamOutput(rendered, adapterContext), shouldWrapInvocationOutput(adapterContext), error => finishAgentInvocation(adapterContext, error === undefined ? rendered : undefined, error))
    }
    const events = streamAgentOutputToEvents(rendered)
    const tracedEvents = maybeTraceAgentStream(events, adapterContext)
    const shouldWrapOutput = shouldWrapInvocationOutput(adapterContext)
    return {
      deferFinish: shouldWrapOutput,
      finishResult: rendered,
      value: shouldWrapOutput ? withCapabilityCleanup(tracedEvents, error => finishAgentInvocation(adapterContext, error === undefined ? rendered : undefined, error)) : tracedEvents,
    }
  }, "[vitehub] Agent stream failed and finish lifecycle also failed.", { finalizeRawStreams: output === "ui-message-stream" })
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
