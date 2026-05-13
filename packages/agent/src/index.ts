import agentRegistry from "#vitehub/agent/registry"
import { getMessageText } from "@vitehub/messages"
import {
  ApprovalRequiredError,
  CapabilityDeniedError,
  resolveCapabilityPolicy,
  resolveRuntimeContext,
  resolveRuntimeValue,
} from "@vitehub/runtime"

import { formatUnknownAgentMessage } from "./registry-error.ts"

import type {
  Agent,
  AgentCallParameters,
  AssistantContent,
  ModelMessage,
  ToolContent,
  ToolLoopAgentSettings,
  ToolResultPart,
  ToolSet,
} from "ai"
import type {
  AgentDefinition,
  AgentChatOptions,
  AgentInput,
  AgentRegistry,
  AgentRegistryModule,
  AgentRequestBody,
  AgentRunContext,
  AgentRunCallbackContext,
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeBinding,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentSettings,
  AgentWorkflowRuntimeBinding,
  AgentToolDefinition,
  AgentToolStepItem,
  AgentChatAgentHooks,
  AgentModelInput,
  AgentModelInstrumentation,
  MaybePromise,
  MaybeResolvable,
  ResolvedAgentRuntimeContext,
} from "./types.ts"
import type { Message, MessagePart, StreamEvent } from "@vitehub/messages"
import type {
  ReadonlyWorkspaceFacade,
  ReadonlyWorkspaceFs,
  WorkspaceDefinitionInput,
  WorkspaceEntry,
  WorkspaceName,
} from "@vitehub/workspace"

export type {
  Agent,
  AgentCapabilities,
  AgentCapabilityHandle,
  AgentChatAgentHookArgs,
  AgentChatAgentHooks,
  AgentChatEventHookArgs,
  AgentChatEventHooks,
  AgentChatOptions,
  AgentRequestBody,
  AgentDefinition,
  AgentExecution,
  AgentHandlerOptions,
  AgentInput,
  AgentIntegrationOption,
  AgentIntegrationsOptions,
  AgentModelInput,
  AgentModelInstrumentation,
  AgentModelInstrumentationContext,
  AgentModelProviderOptions,
  AgentModuleOptions,
  AgentProvidersOptions,
  AgentRegistryHandlerOptions,
  AgentRegistry,
  AgentRegistryModule,
  AgentRunContext,
  AgentRunCallbackContext,
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
  AgentWorkflowRuntimeBinding,
  AgentSandboxProviderOptions,
  AgentSchedulerProviderOptions,
  AgentSettings,
  AgentToolDefinition,
  AgentToolPolicyContext,
  AgentToolPolicyDecision,
  AgentStateProviderOptions,
  AgentToolResolver,
  AgentToolStep,
  AgentWaitUntil,
  CloudflareExportedHandlerFetchHandler,
  DiscoveredAgentDefinition,
  MaybePromise,
  MaybeResolvable,
  Resolvable,
  ResolvedAgentModuleOptions,
  ResolvedAgentRuntimeContext,
} from "./types.ts"

export type {
  Message,
  MessageMetadata,
  MessagePart,
  MessageRole,
  RunEvent,
  StreamEvent,
  ToolInvocation,
  ToolInvocationState,
} from "@vitehub/messages"

async function resolveValue<T, TContext extends AgentRuntimeContext>(
  value: MaybeResolvable<T, TContext>,
  context: TContext,
): Promise<T> {
  return await resolveRuntimeValue(value, context)
}

function hasAgentMethods(value: unknown): value is Agent {
  return typeof value === "object"
    && value !== null
    && "generate" in value
    && typeof (value as { generate?: unknown }).generate === "function"
    && "stream" in value
    && typeof (value as { stream?: unknown }).stream === "function"
}

function hasAgentDefinition(value: unknown): value is AgentDefinition {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof (value as { resolve?: unknown }).resolve === "function"
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

async function createToolLoopAgent<CALL_OPTIONS, TOOLS extends ToolSet>(
  settings: Omit<AgentSettings<AgentRuntimeConfig, CALL_OPTIONS, TOOLS>, "description" | "run" | "tools">,
  tools: TOOLS | undefined,
): Promise<Agent<CALL_OPTIONS, TOOLS>> {
  const ai = await import("ai")
  const { ToolLoopAgent } = ai
  return new ToolLoopAgent<CALL_OPTIONS, TOOLS>({
    ...(settings as unknown as ConstructorParameters<typeof ToolLoopAgent<CALL_OPTIONS, TOOLS>>[0]),
    tools,
  })
}

async function instrumentModel<TRuntimeConfig extends AgentRuntimeConfig>(
  model: AgentModelInput,
  instrumentation: AgentModelInstrumentation<TRuntimeConfig> | undefined,
  context: ResolvedAgentRuntimeContext<TRuntimeConfig>,
) {
  return instrumentation
    ? await instrumentation({ ...context, model, run: context.run })
    : model
}

function withRunCallbacks<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOOLS extends ToolSet,
>(
  settings: Record<string, unknown>,
  context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TOOLS>,
) {
  const {
    onRunStepFinish,
    onRunToolCallFinish,
    onRunToolCallStart,
    onStepFinish,
    experimental_onToolCallFinish,
    experimental_onToolCallStart,
    ...rest
  } = settings as {
    experimental_onToolCallFinish?: (event: unknown) => MaybePromise<void>
    experimental_onToolCallStart?: (event: unknown) => MaybePromise<void>
    onRunStepFinish?: (step: unknown, context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TOOLS>) => MaybePromise<void>
    onRunToolCallFinish?: (event: unknown, context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TOOLS>) => MaybePromise<void>
    onRunToolCallStart?: (event: unknown, context: AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS, TOOLS>) => MaybePromise<void>
    onStepFinish?: (step: unknown) => MaybePromise<void>
  } & Record<string, unknown>

  return {
    ...rest,
    ...(onRunStepFinish
      ? {
          async onStepFinish(step: unknown) {
            await onStepFinish?.(step)
            await onRunStepFinish?.(step, context)
          },
        }
      : onStepFinish
        ? { onStepFinish }
        : {}),
    ...(onRunToolCallStart
      ? {
          async experimental_onToolCallStart(event: unknown) {
            await experimental_onToolCallStart?.(event)
            await onRunToolCallStart?.(event, context)
          },
        }
      : experimental_onToolCallStart
        ? { experimental_onToolCallStart }
        : {}),
    ...(onRunToolCallFinish
      ? {
          async experimental_onToolCallFinish(event: unknown) {
            await experimental_onToolCallFinish?.(event)
            await onRunToolCallFinish?.(event, context)
          },
        }
      : experimental_onToolCallFinish
        ? { experimental_onToolCallFinish }
        : {}),
  }
}

function isAgentToolDefinition(value: unknown): value is AgentToolDefinition {
  return typeof value === "object" && value !== null && "name" in value && typeof (value as { name?: unknown }).name === "string"
}

function createApprovalRequest(name: string, input: unknown, reason?: string) {
  return {
    capability: name,
    id: `approval_${name}_${Math.random().toString(36).slice(2, 10)}`,
    input,
    reason,
    state: "awaiting-approval" as const,
  }
}

function withToolPolicy(tool: AgentToolDefinition): AgentToolDefinition {
  if (!tool.policy || typeof tool.execute !== "function") {
    return tool
  }

  const execute = tool.execute
  const policy = tool.policy

  return {
    ...tool,
    async execute(input) {
      const decision = typeof policy === "function"
        ? await policy({
            name: tool.name,
            input,
          })
        : await resolveCapabilityPolicy(policy, {
            capability: tool.name,
            input,
            operation: "tool.execute",
          })

      const approvalRequest = createApprovalRequest(tool.name, input)

      if (decision === "deny") {
        throw new CapabilityDeniedError(tool.name)
      }
      if (decision === "require-approval") {
        throw new ApprovalRequiredError(approvalRequest)
      }
      if (decision === "retryable-failure") {
        throw new Error(`[vitehub:agent] Tool "${tool.name}" failed with a retryable policy decision.`)
      }

      return await execute(input)
    },
  }
}

function applyToolPolicies<TTools extends Record<string, unknown>>(tools: TTools | undefined): TTools | undefined {
  if (!tools || typeof tools !== "object") {
    return tools
  }

  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!isAgentToolDefinition(tool)) {
      return [name, tool]
    }
    return [name, withToolPolicy(tool)]
  })) as TTools
}

type AgentToolStepReporter = NonNullable<AgentRuntimeContext["devtools"]>["reportToolStep"]

function createToolCallId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getErrorOutput(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function materializeSummary(output: unknown): unknown {
  if (!output || typeof output !== "object") return output
  const result = output as {
    bytes?: unknown
    directories?: unknown
    durationMs?: unknown
    files?: unknown
    path?: unknown
    sources?: unknown
  }
  const files = typeof result.files === "number" ? result.files : 0
  const sources = Array.isArray(result.sources)
    ? result.sources.map(source => typeof source === "object" && source && "source" in source ? String((source as { source: unknown }).source) : "").filter(Boolean)
    : []
  const target = sources.length ? sources.join(" and ") : "workspace sources"
  return {
    ...result,
    summary: `Materialized ${target}${files ? ` (${files.toLocaleString()} file${files === 1 ? "" : "s"})` : ""}.`,
  }
}

async function reportWorkspaceMaterialization(
  tools: ToolSet | undefined,
  reportToolStep?: AgentToolStepReporter,
) {
  if (!reportToolStep || !tools || typeof tools !== "object") return
  const materializeTool = (tools as Record<string, unknown>).materialize_sources
  const execute = materializeTool && typeof materializeTool === "object" && typeof (materializeTool as { execute?: unknown }).execute === "function"
    ? (materializeTool as { execute: (input: unknown) => Promise<unknown> }).execute
    : undefined
  if (!execute) return

  const toolCall: AgentToolStepItem = {
    input: { path: "" },
    toolCallId: createToolCallId("materialize_sources"),
    toolName: "materialize_sources",
  }
  await reportToolStep({ toolCalls: [toolCall] })
  try {
    const output = await execute.call(materializeTool, toolCall.input)
    await reportToolStep({ toolResults: [{ ...toolCall, output: materializeSummary(output) }] })
  }
  catch (error) {
    await reportToolStep({ toolErrors: [{ ...toolCall, output: getErrorOutput(error) }] })
  }
}

function withToolStepReporting<TTools extends ToolSet>(tools: TTools, reportToolStep?: AgentToolStepReporter): TTools {
  if (!reportToolStep || !tools || typeof tools !== "object") {
    return tools
  }

  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!tool || typeof tool !== "object" || typeof (tool as { execute?: unknown }).execute !== "function") {
      return [name, tool]
    }

    const execute = (tool as { execute: (...args: unknown[]) => unknown }).execute
    return [name, {
      ...tool,
      async execute(input: unknown, ...args: unknown[]) {
        const toolCall: AgentToolStepItem = {
          input,
          toolCallId: createToolCallId(name),
          toolName: name,
        }

        await reportToolStep({ toolCalls: [toolCall] })
        try {
          const output = await execute.call(tool, input, ...args)
          await reportToolStep({ toolResults: [{ ...toolCall, output }] })
          return output
        }
        catch (error) {
          await reportToolStep({ toolErrors: [{ ...toolCall, output: getErrorOutput(error) }] })
          throw error
        }
      },
    }]
  })) as TTools
}

function defineBaseAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
>(
  options: (AgentSettings<TRuntimeConfig, CALL_OPTIONS, TOOLS> & { chat?: AgentChatOptions<TRuntimeConfig>, hooks?: AgentChatAgentHooks<TRuntimeConfig> }) | Agent<CALL_OPTIONS, TOOLS>,
): AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS> {
  if (hasAgentMethods(options)) {
    const agent = options as Agent<CALL_OPTIONS, TOOLS>
    return {
      resolve: async () => agent,
    }
  }

  const { chat, description, hooks, instrumentModel: modelInstrumentation, run, runtime, tools, ...settings } = options as AgentSettings<TRuntimeConfig, CALL_OPTIONS, TOOLS> & { chat?: AgentChatOptions<TRuntimeConfig>, hooks?: AgentChatAgentHooks<TRuntimeConfig> }

  return {
    chat,
    description,
    hooks,
    runtime,
    run,
    async resolve(context) {
      if (!("model" in settings) || !settings.model) {
        throw new Error("[vitehub] Agent model is required unless the agent defines a custom run() handler.")
      }

      const resolvedContext = createResolvedRuntimeContext(context)
      const resolvedTools = tools
        ? applyToolPolicies(await resolveValue(tools, resolvedContext))
        : undefined
      const model = await instrumentModel(settings.model, modelInstrumentation, resolvedContext)

      return await createToolLoopAgent({ ...settings, model } as never, resolvedTools as TOOLS | undefined)
    },
  }
}

export function workflow(name?: string): AgentWorkflowRuntimeBinding {
  return {
    kind: "workflow",
    ...(name ? { name } : {}),
  }
}

type WorkspaceRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig> =
  ResolvedAgentRuntimeContext<TRuntimeConfig>

type WorkspaceModel<TRuntimeConfig extends AgentRuntimeConfig> =
  | ToolLoopAgentSettings["model"]
  | ((context: WorkspaceRuntimeContext<TRuntimeConfig>) => MaybePromise<ToolLoopAgentSettings["model"]>)

type WorkspaceAgentInstructionsValue = string | string[]

interface WorkspaceAgentInstructionsContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends WorkspaceRuntimeContext<TRuntimeConfig> {
  fs: ReadonlyWorkspaceFs<Name>
  workspace: ReadonlyWorkspaceFacade<Name>
}

type WorkspaceAgentInstructions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | WorkspaceAgentInstructionsPart<TRuntimeConfig, Name>
  | Array<WorkspaceAgentInstructionsPart<TRuntimeConfig, Name>>

export type WorkspaceAgentToolsResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = (context: WorkspaceAgentInstructionsContext<TRuntimeConfig, Name>) => MaybePromise<ToolSet | undefined>

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

export interface AgentDevtoolsMetadata {
  files?: AgentDevtoolsFileTreeItem[]
  instructions?: string[]
  tools?: AgentDevtoolsToolDefinition[]
}

type WorkspaceAgentInstructionsPart<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | WorkspaceAgentInstructionsValue
  | ((context: WorkspaceAgentInstructionsContext<TRuntimeConfig, Name>) => MaybePromise<WorkspaceAgentInstructionsValue | undefined>)

export interface WorkspaceAgentFallbackOptions {
  enabled?: boolean
  maxToolResults?: number
}

export type WorkspaceAgentWorkspaceOptions = Omit<WorkspaceDefinitionInput, "name">

export interface WorkspaceAgentOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends Omit<ToolLoopAgentSettings<never, ToolSet>, "instructions" | "model" | "tools"> {
  chat?: AgentChatOptions<TRuntimeConfig>
  description?: string
  fallback?: boolean | WorkspaceAgentFallbackOptions
  experimental_onToolCallFinish?: (event: unknown) => MaybePromise<void>
  experimental_onToolCallStart?: (event: unknown) => MaybePromise<void>
  hooks?: AgentChatAgentHooks<TRuntimeConfig>
  instructions?: WorkspaceAgentInstructions<TRuntimeConfig, Name>
  instrumentModel?: AgentModelInstrumentation<TRuntimeConfig>
  model: WorkspaceModel<TRuntimeConfig>
  onRunStepFinish?: (step: unknown, context: AgentRunCallbackContext<TRuntimeConfig>) => MaybePromise<void>
  onRunToolCallFinish?: (event: unknown, context: AgentRunCallbackContext<TRuntimeConfig>) => MaybePromise<void>
  onRunToolCallStart?: (event: unknown, context: AgentRunCallbackContext<TRuntimeConfig>) => MaybePromise<void>
  name?: string
  runtime?: AgentRuntimeBinding
  stepLimit?: number
  tools?: WorkspaceAgentToolsResolver<TRuntimeConfig, Name>
  workspace: WorkspaceAgentWorkspaceOptions
}

export type WorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = AgentDefinition<TRuntimeConfig, never, ToolSet> & WorkspaceDefinitionInput & {
  __vitehubWorkspaceAgent: true
  __vitehubWorkspaceAgentDefaults?: WorkspaceAgentDefaults<Name>
  __vitehubWorkspaceAgentOptions: WorkspaceAgentOptions<TRuntimeConfig, Name>
}

export interface WorkspaceAgentDefaults<Name extends WorkspaceName = WorkspaceName> {
  name?: string
  workspace?: Name
}

export interface DefineAgent {
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    Name extends WorkspaceName = WorkspaceName,
  >(
    options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  ): WorkspaceAgentDefinition<TRuntimeConfig, Name>
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    CALL_OPTIONS = never,
    TOOLS extends ToolSet = ToolSet,
  >(
    options: (AgentSettings<TRuntimeConfig, CALL_OPTIONS, TOOLS> & { chat?: AgentChatOptions<TRuntimeConfig>, hooks?: AgentChatAgentHooks<TRuntimeConfig> }) | Agent<CALL_OPTIONS, TOOLS>,
  ): AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS>
}

function isWorkspaceAgentOptions(value: unknown): value is WorkspaceAgentOptions {
  return typeof value === "object"
    && value !== null
    && "workspace" in value
    && typeof (value as { workspace?: unknown }).workspace === "object"
    && (value as { workspace?: unknown }).workspace !== null
}

function isModelResolver<TRuntimeConfig extends AgentRuntimeConfig>(
  model: WorkspaceModel<TRuntimeConfig>,
): model is (context: WorkspaceRuntimeContext<TRuntimeConfig>) => MaybePromise<ToolLoopAgentSettings["model"]> {
  return typeof model === "function"
}

async function resolveModel<TRuntimeConfig extends AgentRuntimeConfig>(
  model: WorkspaceModel<TRuntimeConfig>,
  context: WorkspaceRuntimeContext<TRuntimeConfig>,
) {
  return isModelResolver(model) ? await model(context) : model
}

function getPromptText(input: AgentRunInput) {
  if (typeof input.prompt === "string") return input.prompt

  const messages = input.messages || (Array.isArray(input.prompt) ? input.prompt : [])
  const latestUserMessage = [...messages].reverse().find(message => message.role === "user")

  if (!latestUserMessage) return ""
  return getMessageText(latestUserMessage)
}

function getAgentCall(input: AgentRunInput) {
  if (input.messages) return { messages: toModelMessages(input.messages) }
  if (Array.isArray(input.prompt)) return { messages: toModelMessages(input.prompt) }
  if (input.prompt) return { prompt: input.prompt }
  return { messages: [] }
}

function joinInstructions(...parts: Array<WorkspaceAgentInstructionsValue | undefined>) {
  return parts
    .flatMap(part => Array.isArray(part) ? part : [part])
    .map(part => part?.trim())
    .filter(Boolean)
    .join("\n\n")
}

async function resolveWorkspaceInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
  context: WorkspaceRuntimeContext<TRuntimeConfig>,
  _defaults: WorkspaceAgentDefaults<Name>,
) {
  const instructionContext = {
    ...context,
    fs: workspace.fs,
    workspace,
  }
  const parts = Array.isArray(options.instructions) ? options.instructions : [options.instructions]
  const instructions = await Promise.all(parts.map(part => typeof part === "function"
    ? part(instructionContext)
    : part))

  return joinInstructions(...instructions)
}

function getFallbackOptions(fallback: WorkspaceAgentOptions["fallback"]): Required<WorkspaceAgentFallbackOptions> {
  if (fallback === false) return { enabled: false, maxToolResults: 0 }
  if (fallback === true || fallback === undefined) return { enabled: true, maxToolResults: 8 }
  return {
    enabled: fallback.enabled ?? true,
    maxToolResults: fallback.maxToolResults ?? 8,
  }
}

function createShellMetadataTool(): AgentDevtoolsToolDefinition {
  return {
    category: "workspace",
    commands: ["pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc"],
    description: "Run a workspace shell command. Use narrow paths; root-wide rg/grep searches are rejected.",
    icon: "i-lucide-terminal",
    name: "shell",
    preset: "vitehub-workspace",
    status: "available",
  }
}

function createMaterializeMetadataTool(): AgentDevtoolsToolDefinition {
  return {
    category: "workspace",
    description: "Materialize lazy workspace source files before inspection.",
    icon: "i-lucide-database-zap",
    name: "materialize_sources",
    preset: "vitehub-workspace",
    status: "available",
  }
}

function createWorkspaceMutationTool(name: string, description: string): AgentDevtoolsToolDefinition {
  return {
    category: "workspace",
    description,
    icon: "i-lucide-file-pen-line",
    name,
    preset: "vitehub-workspace",
    status: "available",
  }
}

function createMetadataToolSet() {
  const materialize = createMaterializeMetadataTool()
  const shell = createShellMetadataTool()
  const writeTools = {
    appendFile: createWorkspaceMutationTool("appendFile", "Append text to a workspace file."),
    copyPath: createWorkspaceMutationTool("copyPath", "Copy a workspace file or directory."),
    deletePath: createWorkspaceMutationTool("deletePath", "Delete a workspace file or directory."),
    makeDir: createWorkspaceMutationTool("makeDir", "Create a workspace directory."),
    movePath: createWorkspaceMutationTool("movePath", "Move a workspace file or directory."),
    writeFile: createWorkspaceMutationTool("writeFile", "Write a text file to the workspace."),
  } satisfies Record<string, AgentDevtoolsToolDefinition>

  return {
    default: () => ({ materialize_sources: materialize, shell }),
    inspect: () => ({ materialize_sources: materialize, shell }),
    none: () => ({}),
    readonly: () => ({ materialize_sources: materialize, shell }),
    write: () => ({ materialize_sources: materialize, shell, ...writeTools }),
  }
}

function toolDefinitionFromEntry(name: string, tool: unknown): AgentDevtoolsToolDefinition {
  const description = typeof tool === "object" && tool !== null && "description" in tool && typeof (tool as { description?: unknown }).description === "string"
    ? (tool as { description: string }).description
    : undefined
  return {
    category: "workspace",
    ...(name === "shell" ? { commands: createShellMetadataTool().commands } : {}),
    description,
    icon: name === "shell" ? "i-lucide-terminal" : name === "materialize_sources" ? "i-lucide-database-zap" : "i-lucide-wrench",
    name,
    preset: "vitehub-workspace",
    status: "available",
  }
}

function sourceMountPath(key: string, source: NonNullable<WorkspaceAgentWorkspaceOptions["sources"]>[string]) {
  if (typeof source.mount === "string") return source.mount
  if (typeof source.mount === "object" && typeof source.mount.path === "string") return source.mount.path
  return key
}

function sourceMaterialize(key: string, source: NonNullable<WorkspaceAgentWorkspaceOptions["sources"]>[string]) {
  if (typeof source.mount === "object" && source.mount.materialize) return source.mount.materialize
  if (source.materialize) return source.materialize
  return source.cache ? "lazy" : "build"
}

function hasLazyWorkspaceSources<Name extends WorkspaceName>(options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>) {
  return Object.entries(options.workspace.sources || {}).some(([sourceName, source]) => sourceMaterialize(sourceName, source) === "lazy")
}

function workspaceMetadataFiles<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name>,
): AgentDevtoolsFileTreeItem[] {
  const workspaceName = options.name || defaults.workspace || defaults.name || "workspace"
  const sources = options.workspace.sources || {}
  const children = Object.entries(sources).sort(([left], [right]) => left.localeCompare(right)).map(([sourceName, source]) => {
    const materialize = sourceMaterialize(sourceName, source)
    return {
      kind: "directory" as const,
      label: sourceName,
      materialize,
      materialized: materialize === "build",
      path: `${workspaceName}/${sourceMountPath(sourceName, source)}`,
      source: sourceName,
      status: materialize === "build" ? "ready" as const : "lazy" as const,
    }
  })

  return [{
    children,
    kind: "directory",
    label: workspaceName,
    path: workspaceName,
  }]
}

function getNodeBuiltin<T>(name: string): T | undefined {
  const process = globalThis.process as { getBuiltinModule?: (name: string) => T } | undefined
  try {
    return process?.getBuiltinModule?.(name)
  }
  catch {
    return undefined
  }
}

function localWorkspaceRoots(options: WorkspaceAgentOptions<AgentRuntimeConfig, WorkspaceName>): string[] {
  const fs = getNodeBuiltin<typeof import("node:fs")>("node:fs")
  const path = getNodeBuiltin<typeof import("node:path")>("node:path")
  const cwd = (globalThis.process as { cwd?: () => string } | undefined)?.cwd?.()
  if (!fs || !path || !cwd) return []

  const root = path.join(cwd, ".vitehub", "workspaces")
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(root, entry.name))
      .filter(candidate => sourceMountPaths(options).some(mount => fs.existsSync(path.join(candidate, mount))))
  }
  catch {
    return []
  }
}

function sourceMountPaths(options: WorkspaceAgentOptions<AgentRuntimeConfig, WorkspaceName>): string[] {
  return Object.entries(options.workspace.sources || {}).map(([sourceName, source]) => sourceMountPath(sourceName, source))
}

function addFileTreePath(root: AgentDevtoolsFileTreeItem, entry: WorkspaceEntry) {
  const path = entry.path
  const kind = entry.type
  const parts = path.split("/").filter(Boolean)
  let current = root
  for (const [index, part] of parts.entries()) {
    const childPath = [root.path, ...parts.slice(0, index + 1)].filter(Boolean).join("/")
    const childKind = index === parts.length - 1 ? kind : "directory"
    current.children ||= []
    let child = current.children.find(item => item.path === childPath)
    if (!child) {
      child = {
        kind: childKind,
        label: part,
        path: childPath,
      }
      current.children.push(child)
    }
    else if (child.kind !== childKind && childKind === "directory") {
      child.kind = "directory"
    }
    if (index === parts.length - 1) {
      child.updatedAt = entry.mtime ? new Date(entry.mtime).toISOString() : child.updatedAt
      child.materialized = entry.mtime !== undefined || entry.size !== undefined ? true : child.materialized
      child.materializedAt = entry.mtime ? new Date(entry.mtime).toISOString() : child.materializedAt
    }
    current = child
  }
}

function sortFileTree(item: AgentDevtoolsFileTreeItem) {
  item.children?.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1
    return (left.label || left.path).localeCompare(right.label || right.path)
  })
  for (const child of item.children || []) sortFileTree(child)
}

function markSourceTreeMetadata(
  root: AgentDevtoolsFileTreeItem,
  options: WorkspaceAgentOptions<AgentRuntimeConfig, WorkspaceName>,
) {
  const sources = options.workspace.sources || {}
  for (const [sourceName, source] of Object.entries(sources)) {
    const mountPath = sourceMountPath(sourceName, source)
    const materialize = sourceMaterialize(sourceName, source)
    const mountedRoot = `${root.path}/${mountPath}`.replace(/\/+/g, "/")
    const pending = [...(root.children || [])]
    while (pending.length) {
      const item = pending.shift()!
      if (item.path === mountedRoot) {
        item.materialize = materialize
        item.materialized = item.materialized || materialize === "build" || Boolean(item.children?.length)
        item.source = sourceName
        item.status = item.materialized ? "ready" : materialize === "lazy" ? "lazy" : "ready"
      }
      else if (item.path.startsWith(`${mountedRoot}/`)) {
        item.materialize = materialize
        item.materialized = item.materialized || materialize === "build"
        item.source = sourceName
      }
      pending.push(...(item.children || []))
    }
  }
}

function propagateMaterializedDirectories(item: AgentDevtoolsFileTreeItem): boolean {
  const childMaterialized = (item.children || []).map(propagateMaterializedDirectories)
  if (item.kind === "directory" && item.materialize === "lazy" && childMaterialized.some(Boolean)) {
    item.materialized = true
  }
  return Boolean(item.materialized || item.materializedAt || childMaterialized.some(Boolean))
}

async function resolveWorkspaceMetadataFiles<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
): Promise<AgentDevtoolsFileTreeItem[]> {
  const workspaceName = options.name || defaults.workspace || defaults.name || "workspace"
  const root: AgentDevtoolsFileTreeItem = {
    children: [],
    kind: "directory",
    label: workspaceName,
    path: workspaceName,
  }
  const entries = await workspace.fs.list("", { recursive: true })
  for (const entry of entries) {
    addFileTreePath(root, entry)
  }
  markSourceTreeMetadata(root, options as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, WorkspaceName>)
  propagateMaterializedDirectories(root)
  sortFileTree(root)
  return [root]
}

function workspaceMetadataTools<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
): AgentDevtoolsToolDefinition[] {
  if (!options.tools) return []

  try {
    const metadataTools = createMetadataToolSet()
    const workspace = {
      fs: {},
      tools: Object.assign(metadataTools.default, metadataTools),
    }
    const resolved = options.tools({
      fs: workspace.fs,
      workspace,
    } as unknown as WorkspaceAgentInstructionsContext<AgentRuntimeConfig, Name>)
    if (typeof (resolved as { then?: unknown })?.then === "function") return []

    return Object.entries(resolved || {})
      .map(([name, tool]) => toolDefinitionFromEntry(name, tool))
      .sort((left, right) => left.name.localeCompare(right.name))
  }
  catch {
    return []
  }
}

function workspaceMetadataInstructions<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
): string[] {
  const parts = Array.isArray(options.instructions) ? options.instructions : [options.instructions]
  return parts.flatMap((part) => {
    if (typeof part === "string" && part.trim().length > 0) return [part]
    if (typeof part === "function") {
      const localInstructions = readLocalWorkspaceInstructions(options as WorkspaceAgentOptions<AgentRuntimeConfig, WorkspaceName>)
      if (localInstructions) return [localInstructions]
      return ["Dynamic system instructions resolver configured."]
    }
    return []
  })
}

function readLocalWorkspaceInstructions(options: WorkspaceAgentOptions<AgentRuntimeConfig, WorkspaceName>): string | undefined {
  const fs = getNodeBuiltin<typeof import("node:fs")>("node:fs")
  const path = getNodeBuiltin<typeof import("node:path")>("node:path")
  if (!fs || !path) return undefined
  for (const root of localWorkspaceRoots(options)) {
    const file = path.join(root, "AGENTS.md")
    try {
      const content = fs.readFileSync(file, "utf8").trim()
      if (content) return content
    }
    catch {}
  }
}

async function resolveWorkspaceMetadataInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
) {
  const instructionContext = {
    fs: workspace.fs,
    workspace,
  } as WorkspaceAgentInstructionsContext<TRuntimeConfig, Name>
  const parts = Array.isArray(options.instructions) ? options.instructions : [options.instructions]
  const instructions = await Promise.all(parts.map(part => typeof part === "function"
    ? part(instructionContext)
    : part))
  return instructions
    .flatMap(part => Array.isArray(part) ? part : [part])
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part))
}

export function createAgentDevtoolsMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): AgentDevtoolsMetadata {
  const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig, Name>>
  if (!workspaceDefinition.__vitehubWorkspaceAgent || !workspaceDefinition.__vitehubWorkspaceAgentOptions) {
    return { files: [], tools: [] }
  }

  const options = workspaceDefinition.__vitehubWorkspaceAgentOptions as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, Name>
  return {
    files: workspaceMetadataFiles(options, workspaceDefinition.__vitehubWorkspaceAgentDefaults || workspaceDefinition as WorkspaceAgentDefaults<Name>),
    instructions: workspaceMetadataInstructions(options),
    tools: workspaceMetadataTools(options),
  }
}

export async function resolveAgentDevtoolsMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): Promise<AgentDevtoolsMetadata> {
  const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig, Name>>
  if (!workspaceDefinition.__vitehubWorkspaceAgent || !workspaceDefinition.__vitehubWorkspaceAgentOptions) {
    return { files: [], tools: [] }
  }

  const defaults = workspaceDefinition.__vitehubWorkspaceAgentDefaults || workspaceDefinition as WorkspaceAgentDefaults<Name>
  const workspaceName = defaults.workspace || defaults.name
  if (!workspaceName) {
    return createAgentDevtoolsMetadata(definition)
  }

  const { useWorkspace } = await import("@vitehub/workspace")
  const workspace = useWorkspace(workspaceName)
  const options = workspaceDefinition.__vitehubWorkspaceAgentOptions as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, Name>
  return {
    files: await resolveWorkspaceMetadataFiles(options, defaults, workspace),
    instructions: await resolveWorkspaceMetadataInstructions(options, workspace),
    tools: workspaceMetadataTools(options),
  }
}

function collectToolResults(
  result: { steps?: Array<{ content?: Array<{ type: string, output?: unknown }> }> },
  maxToolResults: number,
) {
  const parts: string[] = []

  for (const step of result.steps || []) {
    for (const content of step.content || []) {
      if (content.type !== "tool-result") continue
      parts.push(JSON.stringify(content.output).slice(0, 4000))
      if (parts.length >= maxToolResults) return parts
    }
  }

  return parts
}

function hasToolResults(result: { steps?: Array<{ content?: Array<{ type: string }> }> }) {
  return result.steps?.some(step => step.content?.some(content => content.type === "tool-result")) || false
}

async function synthesizeWorkspaceFallback<TRuntimeConfig extends AgentRuntimeConfig>(
  model: ToolLoopAgentSettings["model"],
  context: AgentRunContext<TRuntimeConfig>,
  result: { steps?: Array<{ content?: Array<{ type: string, output?: unknown }> }> },
  maxToolResults: number,
) {
  const evidence = collectToolResults(result, maxToolResults)
  if (evidence.length === 0) return undefined

  const { generateText } = await import("ai")
  const summary = await generateText({
    model,
    system: [
      "Answer the user's last message using only the workspace tool results.",
      "If the tool results are insufficient, say what is missing.",
    ].join("\n"),
    prompt: [
      `User message:\n${getPromptText(context.input)}`,
      `Workspace tool results:\n${evidence.join("\n\n---\n\n")}`,
    ].join("\n\n"),
  })

  return summary.text.trim() || undefined
}

function createWorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name> = {},
): WorkspaceAgentDefinition<TRuntimeConfig, Name> {
  const workspaceName = defaults.workspace
  const definition = defineBaseAgent<TRuntimeConfig, never, ToolSet>({
    chat: options.chat,
    description: options.description,
    hooks: options.hooks,
    runtime: options.runtime,
    async run(context) {
      if (!workspaceName) {
        throw new Error("[vitehub] Workspace agents require an inferred workspace name from server/agents/<name>/config.ts.")
      }
      const { useWorkspace } = await import("@vitehub/workspace")
      const { stepCountIs, ToolLoopAgent } = await import("ai")
      const workspace = useWorkspace(workspaceName)
      const resolvedModel = await resolveModel(options.model, context)
      const model = await instrumentModel(resolvedModel, options.instrumentModel, context)
      const instructions = await resolveWorkspaceInstructions(options, workspace, context, defaults)
      const workspaceContext = {
        ...context,
        fs: workspace.fs,
        workspace,
      }
      const reportToolStep = context.devtools?.reportToolStep
      const {
        chat: _chat,
        description: _description,
        fallback: _fallback,
        hooks: _hooks,
        instructions: _instructions,
        instrumentModel: _instrumentModel,
        model: _model,
        name: _name,
        onRunStepFinish: _onRunStepFinish,
        onRunToolCallFinish: _onRunToolCallFinish,
        onRunToolCallStart: _onRunToolCallStart,
        runtime: _runtime,
        stepLimit: _stepLimit,
        tools: _tools,
        workspace: _workspace,
        ...settings
      } = options
      const resolvedTools = options.tools
        ? await options.tools(workspaceContext)
        : undefined
      const runSettings = withRunCallbacks({
        ...settings,
        onRunStepFinish: _onRunStepFinish,
        onRunToolCallFinish: _onRunToolCallFinish,
        onRunToolCallStart: _onRunToolCallStart,
      } as Record<string, unknown>, context)
      const agentSettings = {
        ...runSettings,
        instructions,
        model,
        stopWhen: ((runSettings as Record<string, unknown>).stopWhen ?? stepCountIs(options.stepLimit ?? 20)) as never,
        ...(resolvedTools ? { tools: withToolStepReporting(resolvedTools, reportToolStep) } : {}),
      }
      if (hasLazyWorkspaceSources(options)) {
        await reportWorkspaceMaterialization(resolvedTools, reportToolStep)
      }
      const agent = new ToolLoopAgent(agentSettings)
      const result = await agent.generate({
        ...getAgentCall(context.input),
        abortSignal: context.input.abortSignal,
        timeout: context.input.timeout,
      })
      const text = result.text.trim()

      if (text) return text

      const fallback = getFallbackOptions(options.fallback)
      if (fallback.enabled && (result.finishReason === "tool-calls" || hasToolResults(result))) {
        const synthesized = await synthesizeWorkspaceFallback(model, context, result, fallback.maxToolResults)
        if (synthesized) return synthesized
      }

      return result
    },
  }) as WorkspaceAgentDefinition<TRuntimeConfig, Name>

  Object.assign(definition, options.workspace, {
    __vitehubWorkspaceAgent: true,
    __vitehubWorkspaceAgentDefaults: defaults,
    __vitehubWorkspaceAgentOptions: options,
  })
  return definition
}

export function withWorkspaceAgentDefaults<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  definition: WorkspaceAgentDefinition<TRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name>,
): WorkspaceAgentDefinition<TRuntimeConfig, Name> {
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
): Promise<Agent> {
  if (hasAgentMethods(agent)) {
    return agent
  }

  if (hasAgentDefinition(agent)) {
    return await agent.resolve(context as never)
  }

  throw new TypeError("[vitehub] Invalid agent definition.")
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

  return agent
}

function createCallParameters<CALL_OPTIONS, TOOLS extends ToolSet>(
  input: AgentRunInput<CALL_OPTIONS, TOOLS>,
): AgentCallParameters<CALL_OPTIONS, TOOLS> {
  const base = {
    abortSignal: input.abortSignal,
    timeout: input.timeout,
    ...("options" in input ? { options: input.options as CALL_OPTIONS } : {}),
  }

  if (input.messages) {
    return {
      ...base,
      messages: toModelMessages(input.messages),
    } as AgentCallParameters<CALL_OPTIONS, TOOLS>
  }

  if (input.prompt) {
    if (Array.isArray(input.prompt)) {
      return {
        ...base,
        messages: toModelMessages(input.prompt),
      } as AgentCallParameters<CALL_OPTIONS, TOOLS>
    }

    return {
      ...base,
      prompt: input.prompt,
    } as AgentCallParameters<CALL_OPTIONS, TOOLS>
  }

  return {
    ...base,
    messages: [],
  } as AgentCallParameters<CALL_OPTIONS, TOOLS>
}

function toTextModelMessageContent(parts: MessagePart[]): string {
  return parts.map((part) => {
    if (part.type === "text") return part.text
    if (part.type === "error") return part.error
    if (part.type === "data") return JSON.stringify(part.data)
    if (part.type === "tool-call") return JSON.stringify({ input: part.input, toolCallId: part.id, toolName: part.name, type: "tool-call" })
    if (part.type === "tool-result") return JSON.stringify({ error: part.error, output: part.output, toolCallId: part.id, toolName: part.name, type: "tool-result" })
    if (part.type === "approval-request") return JSON.stringify({ input: part.input, reason: part.reason, toolCallId: part.id, toolName: part.name, type: "approval-request" })
    if (part.type === "approval-decision") return JSON.stringify({ approved: part.approved, reason: part.reason, toolCallId: part.id, type: "approval-decision" })
    if (part.type === "source") return part.url || part.title || ""
    return ""
  }).filter(Boolean).join("\n")
}

function toToolResultOutput(part: Extract<MessagePart, { type: "tool-result" }>): ToolResultPart["output"] {
  return (part.error ? { error: part.error } : part.output ?? null) as ToolResultPart["output"]
}

function toAssistantModelMessageContent(parts: MessagePart[]): AssistantContent {
  const content: Exclude<AssistantContent, string> = []

  for (const part of parts) {
    if (part.type === "text") {
      content.push({ text: part.text, type: "text" as const })
    }
    if (part.type === "tool-call") {
      content.push({
        input: part.input,
        toolCallId: part.id,
        toolName: part.name,
        type: "tool-call" as const,
      })
    }
    if (part.type === "tool-result") {
      content.push({
        output: toToolResultOutput(part),
        toolCallId: part.id,
        toolName: part.name,
        type: "tool-result" as const,
      })
    }
    if (part.type === "approval-request") {
      content.push({
        approvalId: part.id,
        toolCallId: part.id,
        type: "tool-approval-request" as const,
      })
    }
  }

  return content.length ? content : toTextModelMessageContent(parts)
}

function toToolModelMessageContent(parts: MessagePart[]): ToolContent {
  const content: ToolContent = []

  for (const part of parts) {
    if (part.type === "tool-result") {
      content.push({
        output: toToolResultOutput(part),
        toolCallId: part.id,
        toolName: part.name,
        type: "tool-result" as const,
      })
    }
    if (part.type === "approval-decision") {
      content.push({
        approvalId: part.id,
        approved: part.approved,
        reason: part.reason,
        type: "tool-approval-response" as const,
      })
    }
  }

  return content
}

export function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        content: toAssistantModelMessageContent(message.parts),
        role: message.role,
      }
    }
    if (message.role === "tool") {
      return {
        content: toToolModelMessageContent(message.parts),
        role: message.role,
      }
    }
    return {
      content: getMessageText(message) || toTextModelMessageContent(message.parts),
      role: message.role,
    }
  }) as ModelMessage[]
}

export function defineTool<TInput = unknown, TOutput = unknown>(
  tool: AgentToolDefinition<TInput, TOutput>,
): AgentToolDefinition<TInput, TOutput> {
  if (!tool || typeof tool !== "object") {
    throw new TypeError("[vitehub] defineTool() requires a tool definition.")
  }
  if (!tool.name || typeof tool.name !== "string") {
    throw new TypeError("[vitehub] defineTool() requires a tool name.")
  }
  return tool
}

function toAgentRunResult(value: unknown): AgentRunResult {
  if (typeof value !== "object" || value === null) {
    return { raw: value, text: typeof value === "string" ? value : undefined }
  }

  const result = value as Record<string, unknown>
  return {
    finishReason: result.finishReason,
    raw: value,
    text: typeof result.text === "string" ? result.text : undefined,
    usage: result.usage,
    warnings: result.warnings,
  }
}

function toStreamEvent(chunk: unknown): StreamEvent | undefined {
  if (typeof chunk === "string") {
    return { text: chunk, type: "text-delta" }
  }
  if (!chunk || typeof chunk !== "object") {
    return undefined
  }

  const value = chunk as Record<string, unknown>
  const type = String(value.type || "")
  if (type === "text-delta" || type === "text") {
    return { id: value.id as string | undefined, text: String(value.text || value.textDelta || value.delta || ""), type: "text-delta" }
  }
  if (type === "tool-input-start") {
    return { id: String(value.id || value.toolCallId), input: value.input, name: String(value.toolName || value.name), type: "tool-input-start" }
  }
  if (type === "tool-call") {
    return { id: String(value.toolCallId ?? value.id), input: value.input ?? value.args, name: String(value.toolName ?? value.name), type: "tool-call" }
  }
  if (type === "tool-result") {
    return { error: typeof value.error === "string" ? value.error : undefined, id: String(value.toolCallId ?? value.id), name: String(value.toolName ?? value.name), output: value.output ?? value.result, type: "tool-result" }
  }
  if (type === "error") {
    return { error: value.error instanceof Error ? value.error.message : String(value.error || "Unknown error"), type: "error" }
  }
  if (type === "finish") {
    return { reason: typeof value.finishReason === "string" ? value.finishReason : undefined, type: "finish" }
  }
  return undefined
}

async function* streamTextResultToEvents(value: unknown): AsyncIterable<StreamEvent> {
  const result = value as { fullStream?: AsyncIterable<unknown>, textStream?: AsyncIterable<string> }
  if (result.fullStream) {
    for await (const chunk of result.fullStream) {
      const event = toStreamEvent(chunk)
      if (event) yield event
    }
    return
  }
  if (result.textStream) {
    for await (const text of result.textStream) {
      yield { text, type: "text-delta" }
    }
  }
}

function createRunContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOOLS extends ToolSet,
>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, TOOLS>,
): AgentRunContext<TRuntimeConfig, CALL_OPTIONS, TOOLS> {
  const resolvedContext = createResolvedRuntimeContext(context)

  return {
    ...resolvedContext,
    createAgent: () => definition.resolve(context),
    generateText: async options => await (await definition.resolve(context)).generate(options),
    input,
    streamText: async options => await (await definition.resolve(context)).stream(options),
  }
}

export async function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, TOOLS>,
): Promise<Response | AgentRunResult | unknown> {
  if (hasAgentDefinition(agent) && agent.run) {
    const definition = agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS>
    return await definition.run!(createRunContext(definition, context, input))
  }

  const resolved = await resolveAgent(agent, context)
  return toAgentRunResult(await resolved.generate(createCallParameters(input) as never))
}

export async function streamAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, TOOLS>,
): Promise<Response | AsyncIterable<StreamEvent> | unknown> {
  if (hasAgentDefinition(agent) && agent.run) {
    const definition = agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS>
    return await definition.run!(createRunContext(definition, context, input))
  }

  const resolved = await resolveAgent(agent, context)
  const result = await resolved.stream(createCallParameters(input) as never)
  return streamTextResultToEvents(result)
}

export async function getAgent<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  context: TContext,
): Promise<Agent> {
  return await resolveAgent(agent, context)
}
