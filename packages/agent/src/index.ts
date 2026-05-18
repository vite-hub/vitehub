import agentRegistry from "#vitehub/agent/registry"
import { getAgentMessageText } from "./messages.ts"
import {
  ApprovalRequiredError,
  resolveRuntimeContext,
  resolveRuntimeValue,
} from "@vitehub/runtime"

import { formatUnknownAgentMessage } from "./registry-error.ts"
import { applyCapabilityToolTransforms, resolveAgentCapabilities } from "./capability-runtime.ts"
import {
  applyAgentToolPolicies,
  reportWorkspaceMaterialization,
  withAgentToolStepReporting,
} from "./tool-runtime.ts"

import type {
  AgentAdapter,
  AgentAdapterMetadataContext,
  AgentAdapterResult,
  AgentDefinition,
  AgentInput,
  AgentRegistry,
  AgentRegistryModule,
  AgentRequestBody,
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  AgentModelProvider,
  AgentModelResolver,
  AgentRuntimeBinding,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentSettings,
  AgentWorkflowRuntimeBinding,
  AgentToolDefinition,
  AgentToolSet,
  MaybePromise,
  MaybeResolvable,
  ResolvedAgentRuntimeContext,
  WorkspaceAgentWorkspaceOptions,
} from "./types.ts"
import type { AgentCapabilityOptions } from "./capability-runtime.ts"
import type { AgentMessage, AgentStreamEvent } from "./messages.ts"
import type {
  ReadonlyWorkspaceFacade,
  WorkspaceEntry,
  WorkspaceName,
} from "@vitehub/workspace"

export type {
  AgentAdapter,
  AgentAdapterInstructions,
  AgentAdapterInstructionsPart,
  AgentAdapterInstructionsValue,
  AgentAdapterMetadataContext,
  AgentAdapterResult,
  AgentAdapterRunContext,
  AgentCapabilities,
  AgentCapabilityHandle,
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
export { defineCapability } from "./capability-runtime.ts"
export type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityHooks,
  AgentCapabilityHookName,
  AgentCapabilityPhase,
  AgentCapabilityRegistries,
  AgentInstructionBlock,
  AgentToolTransform,
} from "./capability-runtime.ts"

export type {
  AgentMessage,
  AgentMessageMetadata,
  AgentMessagePart,
  AgentMessageRole,
  AgentRunEvent,
  AgentStreamEvent,
  ToolInvocation,
  ToolInvocationState,
} from "./messages.ts"
export {
  applyAgentStreamEvent,
  collectAgentStreamEvents,
  createAgentMessage,
  deserializeAgentMessages,
  getAgentMessageText,
  serializeAgentMessages,
  validateAgentMessage,
} from "./messages.ts"

const syntheticWorkspaceRun = Symbol("vitehub.syntheticWorkspaceRun")

async function resolveValue<T, TContext extends AgentRuntimeContext>(
  value: MaybeResolvable<T, TContext>,
  context: TContext,
): Promise<T> {
  return await resolveRuntimeValue(value, context)
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
  options: AgentSettings<TRuntimeConfig, CALL_OPTIONS>,
): AgentDefinition<TRuntimeConfig, CALL_OPTIONS> {
  const { capabilities, description, hooks, run, runtime, workspace } = options as AgentSettings<TRuntimeConfig, CALL_OPTIONS>

  const definition = {
    description,
    hooks,
    runtime,
    run,
    workspace,
    async resolve(context: AgentRuntimeContext<TRuntimeConfig>) {
      if (!("model" in options)) {
        throw new Error("[vitehub] defineAgent() requires model and provider unless the agent defines a custom run() handler.")
      }
      const resolvedContext = createResolvedRuntimeContext<TRuntimeConfig>(context)
      return await createProviderAdapter(options.provider, options as never)
    },
  }
  return Object.assign(definition, {
    __vitehubAgentCapabilityOptions: { capabilities, hooks },
  })
}

async function createProviderAdapter<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  provider: AgentModelProvider | undefined,
  options: AgentSettings<TRuntimeConfig, CALL_OPTIONS>,
): Promise<AgentAdapter<CALL_OPTIONS>> {
  if (!provider) {
    throw new Error("[vitehub] defineAgent({ model }) requires an explicit provider.")
  }
  switch (provider) {
    case "ai-sdk":
      return (await import("./ai-sdk.ts")).createAiSdkProviderAdapter(options as never) as AgentAdapter<CALL_OPTIONS>
    case "tanstack-ai":
      return (await import("./tanstack-ai.ts")).createTanStackAiProviderAdapter(options as never) as AgentAdapter<CALL_OPTIONS>
    default:
      throw new Error(`[vitehub] Unknown agent model provider "${String(provider)}". Pass provider: "ai-sdk" or provider: "tanstack-ai".`)
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
  description?: string
  hooks?: AgentSettings<TRuntimeConfig>["hooks"]
  name?: string
  runtime?: AgentRuntimeBinding
  workspace: WorkspaceAgentWorkspaceOptions
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
    options: AgentSettings<TRuntimeConfig, CALL_OPTIONS>,
  ): AgentDefinition<TRuntimeConfig, CALL_OPTIONS>
}

function isWorkspaceAgentOptions(value: unknown): value is WorkspaceAgentOptions {
  return typeof value === "object"
    && value !== null
    && "workspace" in value
    && typeof (value as { workspace?: unknown }).workspace === "object"
    && (value as { workspace?: unknown }).workspace !== null
}

function getPromptText(input: AgentRunInput) {
  if (typeof input.prompt === "string") return input.prompt

  const messages = input.messages || (Array.isArray(input.prompt) ? input.prompt : [])
  const latestUserMessage = [...messages].reverse().find(message => message.role === "user")

  if (!latestUserMessage) return ""
  return getAgentMessageText(latestUserMessage)
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

    return Object.entries(resolved as Record<string, unknown> || {})
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
  const definition = defineBaseAgent<TRuntimeConfig>({
    ...options,
    description: options.description,
    hooks: options.hooks,
    run: options.run,
    runtime: options.runtime,
    workspace: options.workspace,
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
): Promise<AgentAdapter> {
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

function getRunMessages(input: AgentRunInput): AgentMessage[] {
  if (input.messages) return input.messages
  if (Array.isArray(input.prompt)) return input.prompt
  return []
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

function isTransportReadyResult(value: unknown): value is Response | AsyncIterable<AgentStreamEvent> {
  return value instanceof Response || isAsyncIterable(value)
}

async function* closeAfterAsyncIterable<T>(iterable: AsyncIterable<T>, close: () => Promise<void>): AsyncIterable<T> {
  try {
    for await (const chunk of iterable) {
      yield chunk
    }
  }
  finally {
    await close()
  }
}

function closeAfterResponse(response: Response, body: ReadableStream<Uint8Array>, close: () => Promise<void>): Response {
  const reader = body.getReader()
  let closed = false
  async function closeOnce() {
    if (closed) return
    closed = true
    await close()
  }
  const wrappedBody = new ReadableStream({
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      }
      finally {
        await closeOnce()
      }
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          await closeOnce()
          return
        }
        controller.enqueue(value)
      }
      catch (error) {
        await closeOnce()
        throw error
      }
    },
  })

  return new Response(wrappedBody, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

async function closeAfterTransportResult<T>(result: T, close: () => Promise<void>): Promise<{ deferred: boolean, result: T }> {
  if (result instanceof Response) {
    if (!result.body) {
      await close()
      return { deferred: true, result }
    }
    return { deferred: true, result: closeAfterResponse(result, result.body, close) as T }
  }
  if (isAsyncIterable(result)) {
    return { deferred: true, result: closeAfterAsyncIterable(result, close) as T }
  }
  return { deferred: false, result }
}

function hasCustomRun<TRuntimeConfig extends AgentRuntimeConfig, CALL_OPTIONS>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): agent is AgentDefinition<TRuntimeConfig, CALL_OPTIONS> & { run: NonNullable<AgentDefinition<TRuntimeConfig, CALL_OPTIONS>["run"]> } {
  return hasAgentDefinition(agent)
    && typeof agent.run === "function"
    && !(syntheticWorkspaceRun in agent.run)
}

function getCapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig,
>(
  definition: AgentDefinition<TRuntimeConfig> | undefined,
): AgentCapabilityOptions<TRuntimeConfig> | undefined {
  return (definition as { __vitehubAgentCapabilityOptions?: AgentCapabilityOptions<TRuntimeConfig> } | undefined)?.__vitehubAgentCapabilityOptions
    || (definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig>> | undefined)?.__vitehubWorkspaceAgentOptions
}

function getWorkspaceName<
  TRuntimeConfig extends AgentRuntimeConfig,
>(
  definition: AgentDefinition<TRuntimeConfig> | undefined,
): string | undefined {
  const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig>> | undefined
  const defaults = workspaceDefinition?.__vitehubWorkspaceAgentDefaults
  const options = workspaceDefinition?.__vitehubWorkspaceAgentOptions
  const optionWorkspace = options?.workspace
  const definitionWorkspace = (definition as { workspace?: WorkspaceAgentWorkspaceOptions | string } | undefined)?.workspace

  if (defaults?.workspace) return defaults.workspace
  if (defaults?.name) return defaults.name
  if (options?.name) return options.name
  if (typeof optionWorkspace === "object" && optionWorkspace && "name" in optionWorkspace && typeof optionWorkspace.name === "string") return optionWorkspace.name
  if (typeof definitionWorkspace === "string") return definitionWorkspace
  if (typeof definitionWorkspace === "object" && definitionWorkspace && "name" in definitionWorkspace && typeof definitionWorkspace.name === "string") return definitionWorkspace.name
  if (optionWorkspace || definitionWorkspace) return "workspace"
}

function toStreamEvent(chunk: unknown): AgentStreamEvent | undefined {
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

async function* streamTextResultToEvents(value: unknown): AsyncIterable<AgentStreamEvent> {
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
  capabilities?: Awaited<ReturnType<typeof resolveAgentCapabilities>>,
): Promise<AgentRunContext<TRuntimeConfig, CALL_OPTIONS>> {
  const resolvedContext = createResolvedRuntimeContext(context)
  const tools = await applyCapabilityToolTransforms(capabilities?.tools, capabilities?.toolTransforms)

  return {
    ...resolvedContext,
    input,
    messages: capabilities?.messages ?? getRunMessages(input),
    prompt: typeof input.prompt === "string" ? input.prompt : undefined,
    tools,
  }
}

async function createCapabilityRunContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS> | undefined,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
) {
  const runtime = createResolvedRuntimeContext(context)
  const workspaceName = getWorkspaceName(definition)
  const workspace = workspaceName
    ? (await import("@vitehub/workspace")).useWorkspace(workspaceName, { allowWrite: true })
    : undefined
  const capabilities = await resolveAgentCapabilities(
    getCapabilityOptions(definition),
    runtime,
    input,
    workspace,
  )
  return { capabilities, runtime, workspace }
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
  const { capabilities, runtime, workspace } = await createCapabilityRunContext(definition, context, input)
  return {
    capabilityInstructions: capabilities.capabilityInstructions,
    capabilityClose: capabilities.close,
    capabilityHasCloseCallbacks: capabilities.hasCloseCallbacks,
    capabilityRegistries: capabilities.registries,
    capabilityToolTransforms: capabilities.toolTransforms,
    devtools: context.devtools,
    input: capabilities.input,
    instructions: undefined,
    messages: capabilities.messages,
    prompt: typeof capabilities.input.prompt === "string" ? capabilities.input.prompt : undefined,
    runtime,
    tools: capabilities.tools,
    workspace,
  }
}

async function applyOutputRenderers(result: unknown, registries: Awaited<ReturnType<typeof resolveAgentCapabilities>>["registries"] | undefined) {
  let current = result
  for (const renderer of registries?.outputRenderers || []) {
    current = await renderer(current)
  }
  return current
}

async function closeCapabilitiesImmediately(close: () => Promise<void>, primaryError: unknown, hasPrimaryError: boolean) {
  try {
    await close()
  }
  catch (closeError) {
    if (hasPrimaryError) {
      throw new AggregateError([primaryError, closeError], "[vitehub] Agent run failed and capability cleanup also failed.")
    }
    throw closeError
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
    const { capabilities } = await createCapabilityRunContext(agent, context, input)
    let closeImmediately = true
    let primaryError: unknown
    let hasPrimaryError = false
    try {
      const result = await applyOutputRenderers(
        await agent.run(await createRunContext(agent, context, capabilities.input as AgentRunInput<CALL_OPTIONS>, capabilities)),
        capabilities.registries,
      )
      if (capabilities.hasCloseCallbacks) closeImmediately = false
      const transport = capabilities.hasCloseCallbacks
        ? await closeAfterTransportResult(result, capabilities.close)
        : { deferred: false, result }
      closeImmediately = !transport.deferred
      return transport.result
    }
    catch (error) {
      primaryError = error
      hasPrimaryError = true
      throw error
    }
    finally {
      if (closeImmediately) {
        await closeCapabilitiesImmediately(capabilities.close, primaryError, hasPrimaryError)
      }
    }
  }

  const resolved = await resolveAgent(agent, context)
  const definition = hasAgentDefinition(agent) ? agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS> : undefined
  const adapterContext = await createAdapterRunContext(definition, resolved as AgentAdapter<CALL_OPTIONS>, context, input)
  let closeImmediately = true
  let primaryError: unknown
  let hasPrimaryError = false
  try {
    const result = await applyOutputRenderers(await resolved.generate(adapterContext), adapterContext.capabilityRegistries)
    const runResult = isTransportReadyResult(result) ? result : toAgentRunResult(result)
    if (adapterContext.capabilityHasCloseCallbacks) closeImmediately = false
    const transport = adapterContext.capabilityHasCloseCallbacks
      ? await closeAfterTransportResult(runResult, adapterContext.capabilityClose)
      : { deferred: false, result: runResult }
    closeImmediately = !transport.deferred
    return transport.result
  }
  catch (error) {
    primaryError = error
    hasPrimaryError = true
    throw error
  }
  finally {
    if (closeImmediately) {
      await closeCapabilitiesImmediately(adapterContext.capabilityClose, primaryError, hasPrimaryError)
    }
  }
}

export async function streamAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
): Promise<Response | AsyncIterable<AgentStreamEvent> | unknown> {
  if (hasCustomRun<TRuntimeConfig, CALL_OPTIONS>(agent)) {
    const { capabilities } = await createCapabilityRunContext(agent, context, input)
    let closeImmediately = true
    let primaryError: unknown
    let hasPrimaryError = false
    try {
      const result = await applyOutputRenderers(
        await agent.run(await createRunContext(agent, context, capabilities.input as AgentRunInput<CALL_OPTIONS>, capabilities)),
        capabilities.registries,
      )
      if (capabilities.hasCloseCallbacks) closeImmediately = false
      const transport = capabilities.hasCloseCallbacks
        ? await closeAfterTransportResult(result, capabilities.close)
        : { deferred: false, result }
      closeImmediately = !transport.deferred
      return transport.result
    }
    catch (error) {
      primaryError = error
      hasPrimaryError = true
      throw error
    }
    finally {
      if (closeImmediately) {
        await closeCapabilitiesImmediately(capabilities.close, primaryError, hasPrimaryError)
      }
    }
  }

  const resolved = await resolveAgent(agent, context)
  const definition = hasAgentDefinition(agent) ? agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS> : undefined
  const adapterContext = await createAdapterRunContext(definition, resolved as AgentAdapter<CALL_OPTIONS>, context, input)
  let closeImmediately = true
  let primaryError: unknown
  let hasPrimaryError = false
  try {
    const result = await applyOutputRenderers(
      resolved.stream
        ? await resolved.stream(adapterContext)
        : await resolved.generate(adapterContext),
      adapterContext.capabilityRegistries,
    )
    const streamResult = isTransportReadyResult(result) ? result : streamTextResultToEvents(result)
    if (adapterContext.capabilityHasCloseCallbacks) closeImmediately = false
    const transport = adapterContext.capabilityHasCloseCallbacks
      ? await closeAfterTransportResult(streamResult, adapterContext.capabilityClose)
      : { deferred: false, result: streamResult }
    closeImmediately = !transport.deferred
    return transport.result
  }
  catch (error) {
    primaryError = error
    hasPrimaryError = true
    throw error
  }
  finally {
    if (closeImmediately) {
      await closeCapabilitiesImmediately(adapterContext.capabilityClose, primaryError, hasPrimaryError)
    }
  }
}

export async function getAgent<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  context: TContext,
): Promise<AgentAdapter> {
  return await resolveAgent(agent, context)
}
