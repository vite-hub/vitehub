import agentRegistry from "#vitehub/agent/registry"
import { getMessageText } from "@vitehub/messages"
import {
  ApprovalRequiredError,
  resolveRuntimeContext,
  resolveRuntimeValue,
} from "@vitehub/runtime"

import { formatUnknownAgentMessage } from "./registry-error.ts"
import {
  applyAgentToolPolicies,
  reportWorkspaceMaterialization,
  withAgentToolStepReporting,
} from "./tool-runtime.ts"
import {
  mergeAgentToolSets,
  normalizeAgentSkillsOptions,
  resolveSkillsInstructions,
} from "./skills.ts"

import type {
  AgentAdapter,
  AgentAdapterFactory,
  AgentAdapterMetadataContext,
  AgentAdapterResult,
  AgentDefinition,
  AgentChatOptions,
  AgentInput,
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
  MaybeResolvable,
  ResolvedAgentRuntimeContext,
  WorkspaceAgentWorkspaceOptions,
} from "./types.ts"
import type { Message, StreamEvent } from "@vitehub/messages"
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
  AgentToolResolverWithWorkspace,
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
} from "./types.ts"

export type {
  AgentSkillsOptions,
  ResolvedAgentSkillsOptions,
} from "./skills.ts"

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

const syntheticWorkspaceRun = Symbol("vitehub.syntheticWorkspaceRun")

async function resolveValue<T, TContext extends AgentRuntimeContext>(
  value: MaybeResolvable<T, TContext>,
  context: TContext,
): Promise<T> {
  return await resolveRuntimeValue(value, context)
}

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

export { applyAgentToolPolicies, withAgentToolStepReporting } from "./tool-runtime.ts"

function defineBaseAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  options: (AgentSettings<TRuntimeConfig, CALL_OPTIONS> & { chat?: AgentChatOptions<TRuntimeConfig>, hooks?: AgentChatAgentHooks<TRuntimeConfig> }) | AgentAdapter<CALL_OPTIONS>,
): AgentDefinition<TRuntimeConfig, CALL_OPTIONS> {
  if (hasAgentMethods(options)) {
    const agent = options as AgentAdapter<CALL_OPTIONS> & { tools?: unknown }
    return {
      resolve: async () => normalizeDirectAgent(agent),
    }
  }

  const { adapter, chat, description, hooks, run, runtime, workspace } = options as AgentSettings<TRuntimeConfig, CALL_OPTIONS> & { chat?: AgentChatOptions<TRuntimeConfig>, hooks?: AgentChatAgentHooks<TRuntimeConfig> }
  const skills = normalizeAgentSkillsOptions((options as AgentSettings<TRuntimeConfig, CALL_OPTIONS>).skills)

  return {
    chat,
    description,
    hooks,
    runtime,
    run,
    skills,
    workspace,
    async resolve(context) {
      const resolvedAdapter = adapter || ("model" in options
        ? (await import("./ai-sdk.ts")).aiSdkAdapter(options as never)
        : undefined)
      if (!resolvedAdapter) {
        throw new Error("[vitehub] Agent adapter is required unless the agent defines a custom run() handler.")
      }
      const resolvedContext = createResolvedRuntimeContext(context)
      return typeof resolvedAdapter === "function"
        ? await (resolvedAdapter as AgentAdapterFactory<TRuntimeConfig, CALL_OPTIONS>)(resolvedContext)
        : resolvedAdapter
    },
  }
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

export type WorkspaceAgentOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = AgentSettings<TRuntimeConfig> & {
  chat?: AgentChatOptions<TRuntimeConfig>
  description?: string
  hooks?: AgentChatAgentHooks<TRuntimeConfig>
  name?: string
  runtime?: AgentRuntimeBinding
} & (
  | {
    skills?: boolean | import("./skills.ts").AgentSkillsOptions
    workspace: WorkspaceAgentWorkspaceOptions
  }
  | {
    skills: true | import("./skills.ts").AgentSkillsOptions
    workspace?: WorkspaceAgentWorkspaceOptions
  }
)

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
    options: (AgentSettings<TRuntimeConfig, CALL_OPTIONS> & { chat?: AgentChatOptions<TRuntimeConfig>, hooks?: AgentChatAgentHooks<TRuntimeConfig> }) | AgentAdapter<CALL_OPTIONS>,
  ): AgentDefinition<TRuntimeConfig, CALL_OPTIONS>
}

function isWorkspaceAgentOptions(value: unknown): value is WorkspaceAgentOptions {
  return typeof value === "object"
    && value !== null
    && ((("workspace" in value
      && typeof (value as { workspace?: unknown }).workspace === "object"
      && (value as { workspace?: unknown }).workspace !== null)
    || Boolean((value as { skills?: unknown }).skills)))
}

function getPromptText(input: AgentRunInput) {
  if (typeof input.prompt === "string") return input.prompt

  const messages = input.messages || (Array.isArray(input.prompt) ? input.prompt : [])
  const latestUserMessage = [...messages].reverse().find(message => message.role === "user")

  if (!latestUserMessage) return ""
  return getMessageText(latestUserMessage)
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

function hasLazyWorkspaceSources<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: WorkspaceAgentOptions<TRuntimeConfig, Name>) {
  return Object.entries(options.workspace?.sources || {}).some(([sourceName, source]) => sourceMaterialize(sourceName, source) === "lazy")
}

function workspaceMetadataFiles<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name>,
): AgentDevtoolsFileTreeItem[] {
  const workspaceName = options.name || defaults.workspace || defaults.name || "workspace"
  const sources = options.workspace?.sources || {}
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
  return Object.entries(options.workspace?.sources || {}).map(([sourceName, source]) => sourceMountPath(sourceName, source))
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
  const sources = options.workspace?.sources || {}
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
  clearReadyMaterializationHints(root)
  sortFileTree(root)
  return [root]
}

function workspaceMetadataTools<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
): AgentDevtoolsToolDefinition[] {
  if (!options.tools || typeof options.tools !== "function") return []

  try {
    const metadataTools = createMetadataToolSet()
    const workspace = {
      fs: {},
      tools: Object.assign(metadataTools.default, metadataTools),
    }
    const resolved = options.tools({
      fs: workspace.fs,
      workspace,
    } as never)
    if (typeof (resolved as { then?: unknown })?.then === "function") return []

    return [
      ...Object.entries(resolved as Record<string, unknown> || {})
      .map(([name, tool]) => toolDefinitionFromEntry(name, tool))
      .sort((left, right) => left.name.localeCompare(right.name)),
    ]
  }
  catch {
    return []
  }
}

function workspaceMetadataInstructions<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
): string[] {
  const parts = Array.isArray(options.instructions) ? options.instructions : [options.instructions]
  const instructions = parts.flatMap((part) => {
    if (typeof part === "string" && part.trim().length > 0) return [part]
    if (typeof part === "function") {
      const localInstructions = readLocalWorkspaceInstructions(options as WorkspaceAgentOptions<AgentRuntimeConfig, WorkspaceName>)
      if (localInstructions) return [localInstructions]
      return ["Dynamic system instructions resolver configured."]
    }
    return []
  })
  if (options.skills) {
    instructions.push("Workspace-backed Skills configured.")
  }
  return instructions
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
  const resolvedInstructions = instructions
    .flatMap(part => Array.isArray(part) ? part : [part])
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part))
  if (options.skills) {
    const skills = normalizeAgentSkillsOptions(options.skills)
    const skillInstructions = skills ? await resolveSkillsInstructions(workspace, skills) : undefined
    if (skillInstructions) resolvedInstructions.push(skillInstructions)
  }
  return resolvedInstructions
}

async function resolveWorkspaceTools<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  workspace: ReadonlyWorkspaceFacade<Name>,
): Promise<AgentToolSet | undefined> {
  if (!options.tools) return
  const toolContext = {
    ...runtime,
    fs: workspace.fs,
    workspace,
  } as AgentAdapterMetadataContext<TRuntimeConfig, Name>
  const resolved = typeof options.tools === "function"
    ? await options.tools(toolContext)
    : options.tools
  return resolved as AgentToolSet | undefined
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
  const metadataContext = {
    fs: workspace.fs,
    workspace,
  } as AgentAdapterMetadataContext<AgentRuntimeConfig, Name>
  let adapterMetadata: AgentDevtoolsMetadata | undefined
  if (options.adapter) {
    try {
      const adapter = await workspaceDefinition.resolve?.({
        input: { messages: [] },
        memo: (_key: string, create: () => unknown) => create(),
        runtime: "devtools",
        runtimeConfig: {},
        waitUntil: () => {},
      } as never)
      adapterMetadata = await adapter?.metadata?.(metadataContext as never)
    }
    catch {}
  }
  return {
    files: await resolveWorkspaceMetadataFiles(options, defaults, workspace),
    instructions: [
      ...(adapterMetadata?.instructions || []),
      ...await resolveWorkspaceMetadataInstructions(options, workspace),
    ],
    tools: [
      ...(adapterMetadata?.tools || []),
      ...workspaceMetadataTools(options),
    ],
  }
}

function createWorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name> = {},
): WorkspaceAgentDefinition<TRuntimeConfig, Name> {
  const skills = normalizeAgentSkillsOptions(options.skills)
  const resolvedDefaults = skills && !defaults.workspace
    ? { ...defaults, workspace: (defaults.name || options.name || "workspace") as Name }
    : defaults
  const workspace = options.workspace || {}
  const definition = defineBaseAgent<TRuntimeConfig>({
    ...options,
    chat: options.chat,
    description: options.description,
    hooks: options.hooks,
    run: options.run,
    runtime: options.runtime,
    skills,
    workspace,
  } as never) as WorkspaceAgentDefinition<TRuntimeConfig, Name>

  if (!definition.run) {
    const run: NonNullable<AgentDefinition<TRuntimeConfig>["run"]> = async (context) => {
      const adapter = await definition.resolve(context)
      const result = await adapter.generate(await createAdapterRunContext(definition as never, adapter, context as never, context.input))
      return typeof result === "object" && result && "text" in result && typeof (result as { text?: unknown }).text === "string"
        ? (result as { text: string }).text
        : result
    }
    definition.run = Object.assign(run, { [syntheticWorkspaceRun]: true })
  }

  Object.assign(definition, workspace, {
    __vitehubWorkspaceAgent: true,
    __vitehubWorkspaceAgentDefaults: resolvedDefaults,
    __vitehubWorkspaceAgentOptions: {
      ...options,
      skills,
      workspace,
    },
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

function getRunMessages(input: AgentRunInput): Message[] {
  if (input.messages) return input.messages
  if (Array.isArray(input.prompt)) return input.prompt
  return []
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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value
}

function isTransportReadyResult(value: unknown): value is Response | AsyncIterable<StreamEvent> {
  return value instanceof Response || isAsyncIterable(value)
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

function createRunContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
): AgentRunContext<TRuntimeConfig, CALL_OPTIONS> {
  const resolvedContext = createResolvedRuntimeContext(context)

  return {
    ...resolvedContext,
    input,
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
  const workspaceName = workspaceDefinition?.__vitehubWorkspaceAgentDefaults?.workspace
  const skills = (workspaceDefinition?.skills || false) as false | import("./skills.ts").ResolvedAgentSkillsOptions
  const workspaceModule = workspaceName ? await import("@vitehub/workspace") : undefined
  const readWorkspace = workspaceName && workspaceModule
    ? workspaceModule.useWorkspace(workspaceName)
    : undefined
  const skillInstructions = readWorkspace && skills
    ? await resolveSkillsInstructions(readWorkspace, skills)
    : undefined
  const workspaceTools = readWorkspace && workspaceDefinition?.__vitehubWorkspaceAgentOptions?.adapter
    ? await resolveWorkspaceTools(workspaceDefinition.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<TRuntimeConfig>, runtime, readWorkspace)
    : undefined
  return {
    devtools: context.devtools,
    input,
    instructions: skillInstructions,
    messages: getRunMessages(input),
    prompt: typeof input.prompt === "string" ? input.prompt : undefined,
    runtime,
    skills,
    tools: workspaceTools,
    workspace: readWorkspace,
  }
}

async function validateCustomRunSkills<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS>,
  context: AgentRuntimeContext<TRuntimeConfig>,
) {
  const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig>> | undefined
  const workspaceName = workspaceDefinition?.__vitehubWorkspaceAgentDefaults?.workspace
  const skills = (workspaceDefinition?.skills || false) as false | import("./skills.ts").ResolvedAgentSkillsOptions
  if (!workspaceName || !skills) return
  const { useWorkspace } = await import("@vitehub/workspace")
  await resolveSkillsInstructions(useWorkspace(workspaceName), skills)
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
    await validateCustomRunSkills(agent, context)
    return await agent.run(createRunContext(agent, context, input))
  }

  const resolved = await resolveAgent(agent, context)
  const definition = hasAgentDefinition(agent) ? agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS> : undefined
  const result = await resolved.generate(await createAdapterRunContext(definition, resolved as AgentAdapter<CALL_OPTIONS>, context, input))
  return isTransportReadyResult(result) ? result : toAgentRunResult(result)
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
    await validateCustomRunSkills(agent, context)
    return await agent.run(createRunContext(agent, context, input))
  }

  const resolved = await resolveAgent(agent, context)
  const definition = hasAgentDefinition(agent) ? agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS> : undefined
  const adapterContext = await createAdapterRunContext(definition, resolved as AgentAdapter<CALL_OPTIONS>, context, input)
  const result = resolved.stream
    ? await resolved.stream(adapterContext)
    : await resolved.generate(adapterContext)
  return isTransportReadyResult(result) ? result : streamTextResultToEvents(result)
}

export async function getAgent<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  context: TContext,
): Promise<AgentAdapter> {
  return await resolveAgent(agent, context)
}
