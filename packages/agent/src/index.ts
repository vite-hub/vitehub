import agentRegistry from "#vitehub/agent/registry"
import { getMessageText } from "./messages.ts"
import {
  ApprovalRequiredError,
  resolveRuntimeContext,
} from "@vite-hub/runtime"
import { getChatCapabilityOptions } from "./chat-trigger.ts"
import { createAgentInvocationContextStore } from "./invocation-context.ts"

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
import { finalizeUiMessageStreamOutput } from "./stream-output.ts"
import {
  applyAgentToolPolicies,
  withAgentToolStepReporting,
} from "./tool-runtime.ts"
import {
  resolveAgentTriggerInvocation as resolveAgentTriggerInvocationWithResolvedContext,
  resolveAgentTriggers as resolveAgentTriggersWithResolvedContext,
  runAgentTriggerWith,
  streamAgentTriggerWith,
} from "./trigger-runtime.ts"

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
  AgentInput,
  AgentInstructionBlock,
  AgentInvocationHooks,
  AgentInvocationContextStore,
  AgentModelResolver,
  AgentRegistry,
  AgentRegistryModule,
  AgentRequestBody,
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeBinding,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentSettings,
  AgentUsageCost,
  AgentUsageRecord,
  AgentWorkflowRuntimeBinding,
  AgentToolDefinition,
  MaybePromise,
  ResolvedAgentTriggerDefinition,
  ResolvedAgentRuntimeContext,
  WorkspaceAgentWorkspaceOptions,
  WorkspaceAgentWorkspaceConfig,
} from "./types.ts"
import type { Message, StreamEvent } from "./messages.ts"
import type { ResolvedAgentTriggerInvocation } from "./trigger-runtime.ts"
import type {
  ReadonlyWorkspaceFacade,
  WritableWorkspaceFacade,
  WorkspaceDefinition,
  WorkspaceEntry,
  WorkspaceName,
} from "@vite-hub/workspace"

export type {
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
  AgentChatAppExposure,
  AgentChatAppOptions,
  AgentChatEventHookArgs,
  AgentChatEventHooks,
  AgentChatIdentityResolver,
  AgentChatMessageHookArgs,
  AgentChatOptions,
  AgentChatSessionOptions,
  AgentRequestBody,
  AgentDefinition,
  AgentExecution,
  AgentFinishEvent,
  AgentFinishHook,
  AgentHandlerOptions,
  AgentInput,
  AgentInstructionBlock,
  AgentIntegrationOption,
  AgentInvocationExtensions,
  AgentInvocationContextStore,
  AgentInvocationHooks,
  AgentIntegrationsOptions,
  AgentModelInput,
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

export type {
  AgentChatRunContext,
} from "./chat-trigger.ts"

const syntheticWorkspaceRun = Symbol("vitehub.syntheticWorkspaceRun")
const baseAgentResolve = Symbol("vitehub.baseAgentResolve")
const baseAgentModel = Symbol("vitehub.baseAgentModel")
const defaultWorkspaceName = "workspace"

type NormalizedWorkspaceOptions = WorkspaceAgentWorkspaceOptions & { mode: AgentCapabilityMode }
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
interface ScheduleRunContextLike {
  attemptId?: string
  id: string
  runId?: string
  scheduleId?: string
  scheduledAt: Date
  target?: string
}

const readCommands = ["pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc"]
const writeCommands = [...readCommands, "mkdir", "touch", "cp", "mv", "rm"]

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
export type { ResolvedAgentTriggerInvocation }
export * from "./messages.ts"

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

function validateNonWorkspaceCapabilities(capabilities: NormalizedCapability[], hasWorkspace: boolean): void {
  if (hasWorkspace) return
  for (const capability of capabilities) {
    if (capability.id === "workspace-shell" || capability.id === "sandbox" || capability.id === "access") {
      const name = capability.id === "workspace-shell" ? "workspaceShell" : capability.id
      throw new Error(`[vitehub] ${name}() requires an explicit workspace.`)
    }
  }
}

function capabilityMetadataTool(capability: NormalizedCapability): AgentDevtoolsToolDefinition | undefined {
  if (capability.id === "workspace-shell") {
    const mode = normalizeMode(capability.mode, "Workspace Shell")
    return {
      category: "workspace",
      commands: mode === "write" ? writeCommands : readCommands,
      description: mode === "write"
        ? "Run curated workspace read and write shell operations."
        : "Run curated workspace read shell operations.",
      icon: "i-lucide-terminal",
      name: "workspaceShell",
      status: "available",
    }
  }
  if (capability.id === "sandbox") {
    return {
      category: "execution",
      commands: (capability.metadata as { commands?: string[] } | undefined)?.commands,
      description: "Run explicitly allowed executables in an isolated sandbox.",
      icon: "i-lucide-box",
      name: "sandbox",
      status: "available",
    }
  }
  return capability.tools
    ? {
        category: "capability",
        icon: "i-lucide-wrench",
        name: capability.id,
        status: "available",
      }
    : undefined
}

function defineBaseAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  options: AgentSettings<TRuntimeConfig, CALL_OPTIONS>,
): AgentDefinition<TRuntimeConfig, CALL_OPTIONS> {
  const { capabilities, description, hooks, run, runtime, title, version, workspace } = options
  const normalizedCapabilities = normalizeCapabilities(capabilities as AgentCapabilitiesList | undefined)
  const chat = getChatCapabilityOptions<TRuntimeConfig>(normalizedCapabilities)
  validateNonWorkspaceCapabilities(normalizedCapabilities, !!workspace)
  const resolveBaseAgent: BaseAgentResolver<TRuntimeConfig, CALL_OPTIONS> = async (context) => {
    const resolvedAdapter = "model" in options
      ? (await import("./ai-sdk.ts")).createAiSdkAdapter(options as never) as AgentAdapter<CALL_OPTIONS>
      : undefined
    if (!resolvedAdapter) {
      throw new Error("[vitehub] Agent model is required unless the agent defines a custom run() handler.")
    }
    const resolvedContext = createResolvedRuntimeContext(context)
    return typeof resolvedAdapter === "function"
      ? await (resolvedAdapter as AgentAdapterFactory<TRuntimeConfig, CALL_OPTIONS>)(resolvedContext)
      : resolvedAdapter
  }

  return {
    ...("model" in options ? { [baseAgentModel]: options.model } : {}),
    [baseAgentResolve]: resolveBaseAgent,
    chat,
    description,
    hooks,
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
}

export function workflow(name?: string): AgentWorkflowRuntimeBinding {
  return {
    kind: "workflow",
    ...(name ? { name } : {}),
  }
}

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
  title?: string
  tools?: AgentDevtoolsToolDefinition[]
  version?: string
}

function agentDevtoolsMetadata(definition: Pick<AgentDefinition, "title" | "version">): Pick<AgentDevtoolsMetadata, "title" | "version"> {
  return {
    ...(definition.title ? { title: definition.title } : {}),
    ...(definition.version ? { version: definition.version } : {}),
  }
}

function normalizeWorkspaceOptions(workspace: WorkspaceAgentWorkspaceConfig): NormalizedWorkspaceOptions {
  if (typeof workspace === "string") {
    return { mode: "read" }
  }
  return {
    ...workspace,
    mode: normalizeMode(workspace.mode, "Workspace"),
  }
}

function workspaceNameFromOptions<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name> = {},
): Name | string {
  if (typeof options.workspace === "string") return options.workspace
  return options.name || defaults.workspace || defaults.name || defaultWorkspaceName
}

function workspaceDefinitionFromOptions<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
): WorkspaceAgentWorkspaceOptions {
  return typeof options.workspace === "string" ? { mode: "read" } : options.workspace
}

function workspaceModeFromOptions<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
): AgentCapabilityMode {
  return normalizeWorkspaceOptions(options.workspace).mode
}

export type WorkspaceAgentOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  _Name extends WorkspaceName = WorkspaceName,
> = AgentSettings<TRuntimeConfig> & {
  name?: string
  workspace: WorkspaceAgentWorkspaceConfig
}

export type WorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = AgentDefinition<TRuntimeConfig> & WorkspaceAgentWorkspaceOptions & {
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
    const TOptions extends WorkspaceAgentOptions<TRuntimeConfig, Name> = WorkspaceAgentOptions<TRuntimeConfig, Name>,
  >(
    options: TOptions & ValidateWorkspaceAgentOptions<TOptions>,
  ): WorkspaceAgentDefinition<TRuntimeConfig, Name>
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    CALL_OPTIONS = unknown,
  >(
    options: AgentSettings<TRuntimeConfig, CALL_OPTIONS> & { workspace?: never },
  ): AgentDefinition<TRuntimeConfig, CALL_OPTIONS>
}

function isWorkspaceAgentOptions(value: unknown): value is WorkspaceAgentOptions {
  return typeof value === "object"
    && value !== null
    && "workspace" in value
    && (typeof (value as { workspace?: unknown }).workspace === "string"
      || (typeof (value as { workspace?: unknown }).workspace === "object"
        && (value as { workspace?: unknown }).workspace !== null))
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

function workspaceMetadataFiles<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
  _defaults: WorkspaceAgentDefaults<Name>,
): AgentDevtoolsFileTreeItem[] {
  const sources = workspaceDefinitionFromOptions(options).sources || {}
  return Object.entries(sources).sort(([left], [right]) => left.localeCompare(right)).map(([sourceName, source]) => {
    const materialize = sourceMaterialize(sourceName, source)
    const mountPath = sourceMountPath(sourceName, source)
    return {
      kind: "directory" as const,
      label: mountPath.split("/").filter(Boolean).at(-1) || sourceName,
      materialize,
      materialized: materialize === "build",
      path: mountPath,
      source: sourceName,
      status: materialize === "build" ? "ready" as const : "lazy" as const,
    }
  })
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
  return Object.entries(workspaceDefinitionFromOptions(options).sources || {}).map(([sourceName, source]) => sourceMountPath(sourceName, source))
}

function addFileTreePath(root: AgentDevtoolsFileTreeItem, entry: WorkspaceEntry) {
  const path = entry.path === "instructions/AGENTS.md" ? "AGENTS.md" : entry.path
  if (path === "instructions") return
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
  const sources = workspaceDefinitionFromOptions(options).sources || {}
  for (const [sourceName, source] of Object.entries(sources)) {
    const mountPath = sourceMountPath(sourceName, source)
    const materialize = sourceMaterialize(sourceName, source)
    const mountedRoot = [root.path, mountPath].filter(Boolean).join("/")
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

function clearReadyMaterializationHints(item: AgentDevtoolsFileTreeItem) {
  if (item.materialized || item.materializedAt || item.status === "ready") {
    delete item.materialize
  }
  for (const child of item.children || []) clearReadyMaterializationHints(child)
}

async function resolveWorkspaceMetadataFiles<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
  _defaults: WorkspaceAgentDefaults<Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
): Promise<AgentDevtoolsFileTreeItem[]> {
  const root: AgentDevtoolsFileTreeItem = {
    children: [],
    kind: "directory",
    label: "",
    path: "",
  }
  const entries = await workspace.fs.list("", { recursive: true })
  for (const entry of entries) {
    addFileTreePath(root, entry)
  }
  markSourceTreeMetadata(root, options as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, WorkspaceName>)
  propagateMaterializedDirectories(root)
  clearReadyMaterializationHints(root)
  sortFileTree(root)
  return root.children || []
}

function workspaceMetadataTools<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
): AgentDevtoolsToolDefinition[] {
  return normalizeCapabilities(options.capabilities)
    .map(capabilityMetadataTool)
    .filter((tool): tool is AgentDevtoolsToolDefinition => Boolean(tool))
    .sort((left, right) => left.name.localeCompare(right.name))
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
  }
  const parts = Array.isArray(options.instructions) ? options.instructions : [options.instructions]
  const instructions = await Promise.all(parts.map(part => typeof part === "function"
    ? part(instructionContext as never)
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
    return { files: [], ...agentDevtoolsMetadata(definition), tools: [] }
  }

  const options = workspaceDefinition.__vitehubWorkspaceAgentOptions as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, Name>
  return {
    files: workspaceMetadataFiles(options, workspaceDefinition.__vitehubWorkspaceAgentDefaults || workspaceDefinition as WorkspaceAgentDefaults<Name>),
    instructions: workspaceMetadataInstructions(options),
    ...agentDevtoolsMetadata(workspaceDefinition as AgentDefinition),
    tools: workspaceMetadataTools(options),
  }
}

export async function resolveAgentDevtoolsMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  defaultsOverride: WorkspaceAgentDefaults<Name> = {},
): Promise<AgentDevtoolsMetadata> {
  const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig, Name>>
  if (!workspaceDefinition.__vitehubWorkspaceAgent || !workspaceDefinition.__vitehubWorkspaceAgentOptions) {
    return { files: [], ...agentDevtoolsMetadata(definition), tools: [] }
  }

  const defaults = {
    ...(workspaceDefinition.__vitehubWorkspaceAgentDefaults || workspaceDefinition as WorkspaceAgentDefaults<Name>),
    ...defaultsOverride,
  }
  const workspaceName = defaults.workspace || defaults.name
  if (!workspaceName) {
    return createAgentDevtoolsMetadata(definition)
  }

  const { useWorkspace } = await import("@vite-hub/workspace")
  const workspace = useWorkspace(workspaceName)
  const options = workspaceDefinition.__vitehubWorkspaceAgentOptions as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, Name>
  return {
    files: await resolveWorkspaceMetadataFiles(options, defaults, workspace),
    instructions: await resolveWorkspaceMetadataInstructions(options, workspace),
    ...agentDevtoolsMetadata(workspaceDefinition as AgentDefinition),
    tools: workspaceMetadataTools(options),
  }
}

function createWorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name> = {},
): WorkspaceAgentDefinition<TRuntimeConfig, Name> {
  const workspaceDefinition = workspaceDefinitionFromOptions(options as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, Name>)
  validateWorkspaceCapabilities(options as unknown as WorkspaceAgentOptions<AgentRuntimeConfig, Name>)
  const definition = defineBaseAgent<TRuntimeConfig>({
    ...options,
    description: options.description,
    hooks: options.hooks,
    run: options.run,
    runtime: options.runtime,
    version: options.version,
    workspace: workspaceDefinition,
  } as never) as WorkspaceAgentDefinition<TRuntimeConfig, Name>

  if (!definition.run) {
    const run: NonNullable<AgentDefinition<TRuntimeConfig>["run"]> = async (context) => {
      const adapter = await resolveAgentForRun<TRuntimeConfig, unknown>(definition, context)
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
    usageRecord: result.usageRecord as AgentUsageRecord | undefined,
    warnings: result.warnings,
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value
}

function hasCustomRun<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): agent is AgentDefinition<TRuntimeConfig, any> & { run: NonNullable<AgentDefinition<TRuntimeConfig, CALL_OPTIONS>["run"]> } {
  return hasAgentDefinition(agent)
    && typeof agent.run === "function"
    && !(syntheticWorkspaceRun in agent.run)
}

function toStreamEvent(chunk: unknown, toolNames?: Map<string, string>): StreamEvent | undefined {
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
  if (type === "data") {
    return { data: value.data, id: value.id as string | undefined, messageId: value.messageId as string | undefined, type: "data" }
  }
  if (type === "tool-input-start") {
    const id = String(value.id || value.toolCallId)
    const name = String(value.toolName || value.name || toolNames?.get(id) || "tool")
    toolNames?.set(id, name)
    return { id, input: value.input, name, type: "tool-input-start" }
  }
  if (type === "tool-call" || type === "tool-input-available") {
    const id = String(value.toolCallId ?? value.id)
    const name = String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool")
    toolNames?.set(id, name)
    return { id, input: value.input ?? value.args, name, type: "tool-call" }
  }
  if (type === "tool-result" || type === "tool-output-available") {
    const id = String(value.toolCallId ?? value.id)
    return { error: typeof value.error === "string" ? value.error : undefined, id, name: String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool"), output: value.output ?? value.result, type: "tool-result" }
  }
  if (type === "tool-error" || type === "tool-output-error") {
    const id = String(value.toolCallId ?? value.id)
    const error = value.error instanceof Error
      ? value.error.message
      : typeof value.errorText === "string"
        ? value.errorText
        : String(value.error || "Unknown tool error")
    return { error, id, name: String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool"), output: value.output ?? value.result, type: "tool-result" }
  }
  if (type === "error") {
    if (value.error instanceof ApprovalRequiredError) {
      const { request } = value.error
      return { id: request.id, input: request.input, name: request.capability || request.id, reason: request.reason, type: "approval-request" }
    }
    return { error: value.error instanceof Error ? value.error.message : String(value.error || "Unknown error"), type: "error" }
  }
  if (type === "finish") {
    return { reason: typeof value.finishReason === "string" ? value.finishReason : undefined, type: "finish" }
  }
  if (type === "data") {
    return { data: value.data, type: "data" }
  }
  return undefined
}

async function* streamTextResultToEvents(value: unknown): AsyncIterable<StreamEvent> {
  if (typeof value === "string") {
    if (value) yield { text: value, type: "text-delta" }
    yield { type: "finish" }
    return
  }
  if (isAsyncIterable(value)) {
    const toolNames = new Map<string, string>()
    for await (const chunk of value as AsyncIterable<unknown>) {
      const event = toStreamEvent(chunk, toolNames)
      if (event) yield event
    }
    return
  }
  const result = value as { fullStream?: AsyncIterable<unknown>, textStream?: AsyncIterable<string> }
  if (result.fullStream) {
    const toolNames = new Map<string, string>()
    for await (const chunk of result.fullStream) {
      const event = toStreamEvent(chunk, toolNames)
      if (event) yield event
    }
    return
  }
  if (result.textStream) {
    for await (const text of result.textStream) {
      yield { text, type: "text-delta" }
    }
    return
  }
  if (typeof (value as { text?: unknown } | undefined)?.text === "string") {
    const text = (value as { text: string }).text
    if (text) yield { text, type: "text-delta" }
    yield {
      reason: typeof (value as { finishReason?: unknown }).finishReason === "string"
        ? (value as { finishReason: string }).finishReason
        : undefined,
      type: "finish",
    }
  }
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
  startedAt: number
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
  const callbackContext = createAgentCallbackContext(context)
  const invocationContext = createAgentInvocationContextStore(input.context)
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
  const capabilities = await resolveAgentCapabilities(capabilityOptions, resolvedContext, input, workspace as never, workspaceMode, {
    context: invocationContext,
    model: agentModel as never,
    workspaceDefinition: resolvedWorkspaceDefinition,
  })
  const transformedTools = await applyCapabilityToolTransforms(capabilities.tools, capabilities.toolTransforms)
  const tools = Object.keys(transformedTools || {}).length
    ? withAgentToolStepReporting(applyAgentToolPolicies(transformedTools) || {}, context.devtools?.reportToolStep)
    : undefined

  return {
    ...callbackContext,
    capabilityInstructions: capabilities.capabilityInstructions,
    close: capabilities.close,
    context: invocationContext,
    devtools: context.devtools,
    finishExtensionProviders: capabilities.registries.finishExtensionProviders,
    finishHook: definition?.hooks?.["agent:finish"] as never,
    hasCapabilityCleanup: capabilities.hasCloseCallbacks,
    input: capabilities.input as AgentRunInput<CALL_OPTIONS>,
    messages: capabilities.messages,
    outputRenderers: capabilities.registries.outputRenderers,
    prompt: typeof capabilities.input.prompt === "string" ? capabilities.input.prompt : undefined,
    providerTools: capabilities.registries.providerTools,
    run: context.run,
    runtimeContext: resolvedContext,
    startedAt,
    tools,
    workspace: capabilities.workspace || workspace,
    workspaceDefinition: resolvedWorkspaceDefinition,
    workspaceMode,
  }
}

type InvocationRunContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
> = {
  close: () => Promise<void>
  finishExtensionProviders: ResolvedAgentFinishExtensionProvider[]
  finishHook?: (event: AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void>
  input: AgentRunInput<CALL_OPTIONS>
  runtimeContext: ResolvedAgentRuntimeContext<TRuntimeConfig>
  run?: AgentRunContext<TRuntimeConfig, CALL_OPTIONS>["run"]
  startedAt: number
  workspace?: ReadonlyWorkspaceFacade | WritableWorkspaceFacade
  workspaceDefinition?: WorkspaceDefinition
  workspaceMode: AgentCapabilityMode
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
  await context.close()
  if (error === undefined) await commitWorkspaceChanges(context)
  if (!hasFinishWork(context)) return

  const eventBase = {
    ...(error !== undefined ? { error } : {}),
    input: context.input,
    invocation: {
      durationMs: Date.now() - context.startedAt,
      ...(context.run ? { run: context.run } : {}),
    },
    ...(result !== undefined ? { result } : {}),
    runtime: context.runtimeContext,
  } satisfies Omit<AgentFinishEvent<TRuntimeConfig, CALL_OPTIONS>, "extensions">
  const extensions = await createAgentInvocationExtensions(eventBase as never, context.finishExtensionProviders)
  await context.finishHook?.({ ...eventBase, extensions })
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
  options: { finalizeRawStreams?: boolean } = {},
): Promise<Response | AsyncIterable<unknown> | TResult> {
  const shouldWrapOutput = shouldDeferFinish(context)
  let finishLifecycleStarted = false
  try {
    if (result instanceof Response) {
      const response = shouldWrapOutput ? await withResponseCleanup(result, error => finishAgentInvocation(context, error === undefined ? result : undefined, error)) : result
      finishLifecycleStarted = shouldWrapOutput
      return response
    }
    if (isAsyncIterable(result) && !options.finalizeRawStreams) {
      finishLifecycleStarted = shouldWrapOutput
      return shouldWrapOutput ? withCapabilityCleanup(result, error => finishAgentInvocation(context, error === undefined ? result : undefined, error)) : result
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

export async function runAgent<
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
    }, "[vitehub] Agent run failed and finish lifecycle also failed.")
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

export async function streamAgent<
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
        return finalizeUiMessageStreamOutput(rendered, shouldDeferFinish(runContext), error => finishAgentInvocation(runContext, error === undefined ? rendered : undefined, error))
      }
      return { finishResult: rendered, value: rendered }
    }, "[vitehub] Agent run failed and finish lifecycle also failed.", { finalizeRawStreams: output === "ui-message-stream" })
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
      return finalizeUiMessageStreamOutput(rendered, shouldDeferFinish(adapterContext), error => finishAgentInvocation(adapterContext, error === undefined ? rendered : undefined, error))
    }
    const events = streamTextResultToEvents(rendered)
    const shouldWrapOutput = shouldDeferFinish(adapterContext)
    return {
      deferFinish: shouldWrapOutput,
      finishResult: rendered,
      value: shouldWrapOutput ? withCapabilityCleanup(events, error => finishAgentInvocation(adapterContext, error === undefined ? rendered : undefined, error)) : events,
    }
  }, "[vitehub] Agent stream failed and finish lifecycle also failed.", { finalizeRawStreams: output === "ui-message-stream" })
}

export async function getAgent<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  context: TContext,
): Promise<AgentAdapter> {
  return await resolveAgent(agent, context)
}
