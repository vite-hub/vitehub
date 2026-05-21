import agentRegistry from "#vitehub/agent/registry"
import { getMessageText } from "./messages.ts"
import {
  ApprovalRequiredError,
  resolveRuntimeContext,
} from "@vitehub/runtime"

import {
  applyCapabilityToolTransforms,
  applyOutputRenderers,
  defineCapability,
  normalizeCapabilities,
  normalizeMode,
  resolveAgentCapabilities,
  resolveAgentStaticCapabilities,
  withCapabilityCleanup,
  withResponseCleanup,
} from "./capability-runtime.ts"
import { formatUnknownAgentMessage } from "./registry-error.ts"
import {
  applyAgentToolPolicies,
  withAgentToolStepReporting,
} from "./tool-runtime.ts"

import type {
  AgentAdapter,
  AgentAdapterFactory,
  AgentAdapterMetadataContext,
  AgentAdapterResult,
  AgentCapabilitiesList,
  AgentCapabilityDefinition,
  AgentCapabilityInput,
  AgentCapabilityMode,
  AgentDefinition,
  AgentChatOptions,
  AgentInput,
  AgentModelProvider,
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
  AgentWorkflowRuntimeBinding,
  AgentToolDefinition,
  AgentToolSet,
  AgentChatAgentHooks,
  MaybePromise,
  ResolvedAgentRuntimeContext,
  WorkspaceAgentWorkspaceOptions,
  WorkspaceAgentWorkspaceConfig,
} from "./types.ts"
import type { Message, StreamEvent } from "./messages.ts"
import type {
  ReadonlyWorkspaceFacade,
  WorkspaceEntry,
  WorkspaceName,
} from "@vitehub/workspace"

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
  AgentChatAgentHooks,
  AgentChatEventHookArgs,
  AgentChatEventHooks,
  AgentChatOptions,
  AgentRequestBody,
  AgentDefinition,
  AgentExecution,
  AgentHandlerOptions,
  AgentInput,
  AgentInstructionBlock,
  AgentIntegrationOption,
  AgentIntegrationsOptions,
  AgentModelInput,
  AgentModelInstrumentation,
  AgentModelInstrumentationContext,
  AgentModelProvider,
  AgentModelResolver,
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
  AgentToolTransform,
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

const syntheticWorkspaceRun = Symbol("vitehub.syntheticWorkspaceRun")
const baseAgentResolve = Symbol("vitehub.baseAgentResolve")
const defaultWorkspaceName = "workspace"

type NormalizedWorkspaceOptions = WorkspaceAgentWorkspaceOptions & { mode: AgentCapabilityMode }
type NormalizedCapability = AgentCapabilityDefinition & { mode?: AgentCapabilityMode }
type BaseAgentResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig, CALL_OPTIONS = unknown> =
  (context: AgentRuntimeContext<TRuntimeConfig>) => Promise<AgentAdapter<CALL_OPTIONS>>
type AgentDefinitionWithBaseResolve<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = AgentDefinition<TRuntimeConfig, CALL_OPTIONS> & {
  [baseAgentResolve]?: BaseAgentResolver<TRuntimeConfig, CALL_OPTIONS>
}
type ChatCapabilityMetadata<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> = {
  chat: AgentChatOptions<TRuntimeConfig>
  kind: "chat"
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
export { bash, blob, db, kv, mcp, sandbox, skills } from "./capabilities.ts"
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
    if (capability.id === "bash" && normalizeMode(capability.mode, "Bash") === "write" && workspaceMode !== "write") {
      throw new Error("[vitehub] bash({ mode: \"write\" }) requires workspace.mode: \"write\".")
    }
    if (capability.id === "sandbox") {
      validateSandboxCommands((capability.metadata as { commands?: unknown } | undefined)?.commands)
    }
  }
}

function validateNonWorkspaceCapabilities(capabilities: NormalizedCapability[], hasWorkspace: boolean): void {
  if (hasWorkspace) return
  for (const capability of capabilities) {
    if (capability.id === "bash" || capability.id === "sandbox") {
      throw new Error(`[vitehub] ${capability.id}() requires an explicit workspace.`)
    }
  }
}

function capabilityMetadataTool(capability: NormalizedCapability): AgentDevtoolsToolDefinition | undefined {
  if (capability.id === "bash") {
    const mode = normalizeMode(capability.mode, "Bash")
    return {
      category: "workspace",
      commands: mode === "write" ? writeCommands : readCommands,
      description: mode === "write"
        ? "Run curated workspace read and write shell operations."
        : "Run curated workspace read shell operations.",
      icon: "i-lucide-terminal",
      name: "bash",
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
        description: capability.description,
        icon: "i-lucide-wrench",
        name: capability.id,
        status: "available",
      }
    : undefined
}

function getChatCapabilityOptions<TRuntimeConfig extends AgentRuntimeConfig>(
  capabilities: NormalizedCapability[],
): AgentChatOptions<TRuntimeConfig> | undefined {
  return capabilities.find(capability => capability.id === "chat" && (capability.metadata as ChatCapabilityMetadata | undefined)?.kind === "chat")
    ?.metadata?.chat as AgentChatOptions<TRuntimeConfig> | undefined
}

export function chat<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig>,
): AgentCapabilityDefinition<TRuntimeConfig> {
  return defineCapability({
    id: "chat",
    metadata: {
      chat: options,
      kind: "chat",
    } satisfies ChatCapabilityMetadata<TRuntimeConfig>,
    name: "Chat",
    prepare(context) {
      context.state.require("chat-history", { optional: true })
    },
  })
}

async function resolveProviderAdapter<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  provider: AgentModelProvider,
  options: AgentSettings<TRuntimeConfig, CALL_OPTIONS>,
): Promise<AgentAdapter<CALL_OPTIONS>> {
  if (provider === "ai-sdk") {
    return (await import("./ai-sdk.ts")).createAiSdkProviderAdapter(options as never) as AgentAdapter<CALL_OPTIONS>
  }
  if (provider === "tanstack-ai") {
    return (await import("./tanstack-ai.ts")).createTanStackAiProviderAdapter(options as never) as AgentAdapter<CALL_OPTIONS>
  }
  throw new Error(`[vitehub] Unsupported agent model provider "${provider}".`)
}

function defineBaseAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  options: AgentSettings<TRuntimeConfig, CALL_OPTIONS> & { chat?: AgentChatOptions<TRuntimeConfig>, hooks?: AgentChatAgentHooks<TRuntimeConfig> },
): AgentDefinition<TRuntimeConfig, CALL_OPTIONS> {
  if ("model" in (options as Record<string, unknown>) && !("provider" in (options as Record<string, unknown>))) {
    throw new Error("[vitehub] defineAgent({ model }) requires an explicit provider, for example provider: \"ai-sdk\".")
  }

  const { capabilities, chat: legacyChat, description, hooks, run, runtime, workspace } = options as AgentSettings<TRuntimeConfig, CALL_OPTIONS> & { chat?: AgentChatOptions<TRuntimeConfig>, hooks?: AgentChatAgentHooks<TRuntimeConfig> }
  const normalizedCapabilities = normalizeCapabilities(capabilities as AgentCapabilitiesList | undefined)
  const chat = getChatCapabilityOptions<TRuntimeConfig>(normalizedCapabilities) || legacyChat
  validateNonWorkspaceCapabilities(normalizedCapabilities, !!workspace)
  const resolveBaseAgent: BaseAgentResolver<TRuntimeConfig, CALL_OPTIONS> = async (context) => {
    const resolvedAdapter = "model" in options
      ? await resolveProviderAdapter((options as AgentSettings<TRuntimeConfig, CALL_OPTIONS> & { provider: AgentModelProvider }).provider, options as AgentSettings<TRuntimeConfig, CALL_OPTIONS>)
      : undefined
    if (!resolvedAdapter) {
      throw new Error("[vitehub] Agent model and provider are required unless the agent defines a custom run() handler.")
    }
    const resolvedContext = createResolvedRuntimeContext(context)
    return typeof resolvedAdapter === "function"
      ? await (resolvedAdapter as AgentAdapterFactory<TRuntimeConfig, CALL_OPTIONS>)(resolvedContext)
      : resolvedAdapter
  }

  return {
    [baseAgentResolve]: resolveBaseAgent,
    chat,
    description,
    hooks,
    runtime,
    run,
    workspace,
    ...(normalizedCapabilities.length ? { capabilities: normalizedCapabilities } : {}),
    async resolve(context) {
      const adapterInstance = await resolveBaseAgent(context)
      const resolvedContext = createResolvedRuntimeContext(context)
      const resolvedCapabilities = normalizedCapabilities.length && !workspace
        ? await resolveAgentStaticCapabilities({ capabilities: normalizedCapabilities }, resolvedContext)
        : undefined
      const transformedTools = resolvedCapabilities
        ? await applyCapabilityToolTransforms(resolvedCapabilities.tools, resolvedCapabilities.toolTransforms)
        : undefined
      const capabilityTools = Object.keys(transformedTools || {}).length
        ? withAgentToolStepReporting(applyAgentToolPolicies(transformedTools) || {}, context.devtools?.reportToolStep)
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
  tools?: AgentDevtoolsToolDefinition[]
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
  chat?: AgentChatOptions<TRuntimeConfig>
  description?: string
  hooks?: AgentChatAgentHooks<TRuntimeConfig>
  name?: string
  runtime?: AgentRuntimeBinding
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
  >(
    options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  ): WorkspaceAgentDefinition<TRuntimeConfig, Name>
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    CALL_OPTIONS = unknown,
  >(
    options: AgentSettings<TRuntimeConfig, CALL_OPTIONS> & { chat?: AgentChatOptions<TRuntimeConfig>, hooks?: AgentChatAgentHooks<TRuntimeConfig> },
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
  defaults: WorkspaceAgentDefaults<Name>,
): AgentDevtoolsFileTreeItem[] {
  const workspaceName = workspaceNameFromOptions(options, defaults)
  const sources = workspaceDefinitionFromOptions(options).sources || {}
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
  return Object.entries(workspaceDefinitionFromOptions(options).sources || {}).map(([sourceName, source]) => sourceMountPath(sourceName, source))
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
  const sources = workspaceDefinitionFromOptions(options).sources || {}
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

function clearReadyMaterializationHints(item: AgentDevtoolsFileTreeItem) {
  if (item.materialized || item.materializedAt || item.status === "ready") {
    delete item.materialize
  }
  for (const child of item.children || []) clearReadyMaterializationHints(child)
}

async function resolveWorkspaceMetadataFiles<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
): Promise<AgentDevtoolsFileTreeItem[]> {
  const workspaceName = workspaceNameFromOptions(options, defaults)
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
  clearReadyMaterializationHints(root)
  sortFileTree(root)
  return [root]
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
  defaultsOverride: WorkspaceAgentDefaults<Name> = {},
): Promise<AgentDevtoolsMetadata> {
  const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig, Name>>
  if (!workspaceDefinition.__vitehubWorkspaceAgent || !workspaceDefinition.__vitehubWorkspaceAgentOptions) {
    return { files: [], tools: [] }
  }

  const defaults = {
    ...(workspaceDefinition.__vitehubWorkspaceAgentDefaults || workspaceDefinition as WorkspaceAgentDefaults<Name>),
    ...defaultsOverride,
  }
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
    chat: options.chat,
    description: options.description,
    hooks: options.hooks,
    run: options.run,
    runtime: options.runtime,
    workspace: workspaceDefinition,
  } as never) as WorkspaceAgentDefinition<TRuntimeConfig, Name>

  if (!definition.run) {
    const run: NonNullable<AgentDefinition<TRuntimeConfig>["run"]> = async (context) => {
      const adapter = await resolveAgentForRun<TRuntimeConfig, unknown>(definition, context)
      const result = await adapter.generate(await createAdapterRunContext(definition as never, adapter, context as never, context.input))
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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value
}

function hasCustomRun<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): agent is AgentDefinition<TRuntimeConfig, CALL_OPTIONS> & { run: NonNullable<AgentDefinition<TRuntimeConfig, CALL_OPTIONS>["run"]> } {
  return hasAgentDefinition(agent)
    && typeof agent.run === "function"
    && !(syntheticWorkspaceRun in agent.run)
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
    if (value.error instanceof ApprovalRequiredError) {
      const { request } = value.error
      return { id: request.id, input: request.input, name: request.capability || request.id, reason: request.reason, type: "approval-request" }
    }
    return { error: value.error instanceof Error ? value.error.message : String(value.error || "Unknown error"), type: "error" }
  }
  if (type === "finish") {
    return { reason: typeof value.finishReason === "string" ? value.finishReason : undefined, type: "finish" }
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
    for await (const chunk of value as AsyncIterable<unknown>) {
      const event = toStreamEvent(chunk)
      if (event) yield event
    }
    return
  }
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

async function createRunContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
): Promise<AgentRunContext<TRuntimeConfig, CALL_OPTIONS> & {
  close: () => Promise<void>
  hasCapabilityCleanup: boolean
  outputRenderers: Array<(result: unknown) => MaybePromise<unknown>>
}> {
  const resolvedContext = createResolvedRuntimeContext(context)
  const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig>> | undefined
  const workspaceOptions = workspaceDefinition?.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<AgentRuntimeConfig> | undefined
  const workspaceName = workspaceOptions
    ? workspaceNameFromOptions(workspaceOptions, workspaceDefinition?.__vitehubWorkspaceAgentDefaults)
    : undefined
  const workspaceMode = workspaceOptions ? workspaceModeFromOptions(workspaceOptions) : "read"
  const workspace = workspaceName
    ? workspaceMode === "write"
      ? (await import("@vitehub/workspace")).useWorkspace(workspaceName, { allowWrite: true })
      : (await import("@vitehub/workspace")).useWorkspace(workspaceName)
    : undefined
  const capabilityOptions = workspaceOptions
    ? { capabilities: workspaceOptions.capabilities as AgentCapabilityDefinition<TRuntimeConfig>[], hooks: workspaceOptions.hooks as never }
    : definition.capabilities?.length
      ? { capabilities: definition.capabilities as AgentCapabilityDefinition<TRuntimeConfig>[], hooks: definition.hooks as never }
      : undefined
  const capabilities = await resolveAgentCapabilities(capabilityOptions, resolvedContext, input, workspace as never, workspaceMode)
  const transformedTools = await applyCapabilityToolTransforms(capabilities.tools, capabilities.toolTransforms)
  const tools = Object.keys(transformedTools || {}).length
    ? withAgentToolStepReporting(applyAgentToolPolicies(transformedTools) || {}, context.devtools?.reportToolStep)
    : undefined

  return {
    ...resolvedContext,
    close: capabilities.close,
    hasCapabilityCleanup: capabilities.hasCloseCallbacks,
    input: capabilities.input as AgentRunInput<CALL_OPTIONS>,
    messages: capabilities.messages,
    outputRenderers: capabilities.registries.outputRenderers,
    prompt: typeof capabilities.input.prompt === "string" ? capabilities.input.prompt : undefined,
    tools,
  }
}

async function createAdapterRunContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  adapter: AgentAdapter<CALL_OPTIONS>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
) {
  const runtime = createResolvedRuntimeContext(context)
  const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig>> | undefined
  const workspaceOptions = workspaceDefinition?.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<AgentRuntimeConfig> | undefined
  const workspaceName = workspaceOptions
    ? workspaceNameFromOptions(workspaceOptions, workspaceDefinition?.__vitehubWorkspaceAgentDefaults)
    : workspaceDefinition?.__vitehubWorkspaceAgentDefaults?.workspace
  const workspaceMode = workspaceOptions ? workspaceModeFromOptions(workspaceOptions) : "read"
  const workspace = workspaceName
    ? workspaceMode === "write"
      ? (await import("@vitehub/workspace")).useWorkspace(workspaceName, { allowWrite: true })
      : (await import("@vitehub/workspace")).useWorkspace(workspaceName)
    : undefined
  const capabilityOptions = workspaceOptions && workspace
    ? { capabilities: workspaceOptions.capabilities as AgentCapabilityDefinition<TRuntimeConfig>[], hooks: workspaceOptions.hooks as never }
    : definition?.capabilities?.length
      ? { capabilities: definition.capabilities as AgentCapabilityDefinition<TRuntimeConfig>[], hooks: definition.hooks as never }
      : undefined
  const capabilities = await resolveAgentCapabilities(capabilityOptions, runtime, input, workspace as never, workspaceMode)
  const transformedTools = await applyCapabilityToolTransforms(capabilities.tools, capabilities.toolTransforms)
  const tools = Object.keys(transformedTools || {}).length
    ? withAgentToolStepReporting(applyAgentToolPolicies(transformedTools) || {}, context.devtools?.reportToolStep)
    : undefined
  return {
    capabilityInstructions: capabilities.capabilityInstructions,
    close: capabilities.close,
    devtools: context.devtools,
    hasCapabilityCleanup: capabilities.hasCloseCallbacks,
    input: capabilities.input,
    instructions: undefined,
    messages: capabilities.messages,
    outputRenderers: capabilities.registries.outputRenderers,
    prompt: typeof capabilities.input.prompt === "string" ? capabilities.input.prompt : undefined,
    runtime,
    tools,
    workspace,
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
    const runContext = await createRunContext(agent, context, input)
    runContext.close = once(runContext.close)
    try {
      const result = await agent.run(runContext)
      if (result instanceof Response) return runContext.hasCapabilityCleanup ? await withResponseCleanup(result, runContext.close) : result
      if (isAsyncIterable(result)) return runContext.hasCapabilityCleanup ? withCapabilityCleanup(result, runContext.close) : result
      const rendered = await applyOutputRenderers(result, runContext.outputRenderers)
      await runContext.close()
      return rendered
    }
    catch (error) {
      try {
        await runContext.close()
      }
      catch (closeError) {
        throw new AggregateError([error, closeError], "[vitehub] Agent run failed and capability cleanup also failed.")
      }
      throw error
    }
  }

  const resolved = await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(agent, context)
  const definition = hasAgentDefinition(agent) ? agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS> : undefined
  const adapterContext = await createAdapterRunContext(definition, resolved as AgentAdapter<CALL_OPTIONS>, context, input)
  adapterContext.close = once(adapterContext.close)
  try {
    const result = await resolved.generate(adapterContext as never)
    if (result instanceof Response) return adapterContext.hasCapabilityCleanup ? await withResponseCleanup(result, adapterContext.close) : result
    if (isAsyncIterable(result)) return adapterContext.hasCapabilityCleanup ? withCapabilityCleanup(result, adapterContext.close) : result
    const rendered = await applyOutputRenderers(result, adapterContext.outputRenderers)
    await adapterContext.close()
    return toAgentRunResult(rendered)
  }
  catch (error) {
    try {
      await adapterContext.close()
    }
    catch (closeError) {
      throw new AggregateError([error, closeError], "[vitehub] Agent run failed and capability cleanup also failed.")
    }
    throw error
  }
}

export async function streamAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
): Promise<Response | AsyncIterable<StreamEvent> | unknown> {
  if (hasCustomRun<TRuntimeConfig, CALL_OPTIONS>(agent)) {
    const runContext = await createRunContext(agent, context, input)
    runContext.close = once(runContext.close)
    try {
      const result = await agent.run(runContext)
      if (result instanceof Response) return runContext.hasCapabilityCleanup ? await withResponseCleanup(result, runContext.close) : result
      if (isAsyncIterable(result)) return runContext.hasCapabilityCleanup ? withCapabilityCleanup(result, runContext.close) : result
      const rendered = await applyOutputRenderers(result, runContext.outputRenderers)
      await runContext.close()
      return rendered
    }
    catch (error) {
      try {
        await runContext.close()
      }
      catch (closeError) {
        throw new AggregateError([error, closeError], "[vitehub] Agent run failed and capability cleanup also failed.")
      }
      throw error
    }
  }

  const resolved = await resolveAgentForRun<TRuntimeConfig, CALL_OPTIONS>(agent, context)
  const definition = hasAgentDefinition(agent) ? agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS> : undefined
  const adapterContext = await createAdapterRunContext(definition, resolved as AgentAdapter<CALL_OPTIONS>, context, input)
  adapterContext.close = once(adapterContext.close)
  try {
    const result = resolved.stream
      ? await resolved.stream(adapterContext as never)
      : await resolved.generate(adapterContext as never)
    if (result instanceof Response) return adapterContext.hasCapabilityCleanup ? await withResponseCleanup(result, adapterContext.close) : result
    if (isAsyncIterable(result)) return adapterContext.hasCapabilityCleanup ? withCapabilityCleanup(result, adapterContext.close) : result
    const events = streamTextResultToEvents(await applyOutputRenderers(result, adapterContext.outputRenderers))
    return adapterContext.hasCapabilityCleanup ? withCapabilityCleanup(events, adapterContext.close) : events
  }
  catch (error) {
    try {
      await adapterContext.close()
    }
    catch (closeError) {
      throw new AggregateError([error, closeError], "[vitehub] Agent stream failed and capability cleanup also failed.")
    }
    throw error
  }
}

export async function getAgent<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  context: TContext,
): Promise<AgentAdapter> {
  return await resolveAgent(agent, context)
}
