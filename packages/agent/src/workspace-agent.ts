import {
  applyCapabilityInstructionSlots,
  normalizeCapabilities,
  normalizeMode,
  type ResolvedAgentCapabilities,
  resolveAgentCapabilities,
} from "./capability-runtime.ts"
import { createAgentInvocationContextStore } from "./invocation-context.ts"
import {
  normalizeAgentInvokerProfiles,
  resolveAgentInvoker,
} from "./invoker.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentDefinition,
  AgentDevtoolsFileTreeItem,
  AgentDevtoolsMetadata,
  AgentDevtoolsToolDefinition,
  AgentInput,
  AgentRunInput,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentSettings,
  ResolvedAgentRuntimeContext,
  WorkspaceAgentWorkspaceConfig,
  WorkspaceAgentWorkspaceOptions,
} from "./types.ts"
import type {
  ReadonlyWorkspaceFacade,
  SourceContext,
  WorkspaceEntry,
  WorkspaceDefinition,
  WorkspaceName,
  WorkspaceSource,
} from "@vite-hub/workspace"

const defaultWorkspaceName = "workspace"
const readCommands = ["pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc"]
const writeCommands = [...readCommands, "mkdir", "touch", "cp", "mv", "rm"]

type NormalizedWorkspaceOptions = WorkspaceAgentWorkspaceOptions & { mode: AgentCapabilityMode }
type NormalizedCapability = AgentCapabilityDefinition & { mode?: AgentCapabilityMode }
type WorkspaceSourceMap = NonNullable<WorkspaceDefinition["sources"]>

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

export interface AgentDevtoolsMetadataResolutionOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends WorkspaceAgentDefaults<Name> {
  input?: AgentRunInput
  runtime?: Partial<ResolvedAgentRuntimeContext<TRuntimeConfig>>
}

export function normalizeWorkspaceOptions(workspace: WorkspaceAgentWorkspaceConfig): NormalizedWorkspaceOptions {
  if (typeof workspace === "string") {
    return { mode: "read" }
  }
  return {
    ...workspace,
    mode: normalizeMode(workspace.mode, "Workspace"),
  }
}

export function workspaceNameFromOptions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name> = {},
): Name | string {
  if (typeof options.workspace === "string") return options.workspace
  return options.name || defaults.workspace || defaults.name || defaultWorkspaceName
}

export function workspaceDefinitionFromOptions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
): WorkspaceAgentWorkspaceOptions {
  return typeof options.workspace === "string" ? { mode: "read" } : options.workspace
}

function workspaceDefinitionWithNameFromOptions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name> = {},
): WorkspaceDefinition {
  const { mode: _mode, ...definition } = workspaceDefinitionFromOptions(options)
  return {
    ...definition,
    name: workspaceNameFromOptions(options, defaults),
  }
}

export function workspaceModeFromOptions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
): AgentCapabilityMode {
  return normalizeWorkspaceOptions(options.workspace).mode
}

export function isWorkspaceAgentOptions(value: unknown): value is WorkspaceAgentOptions {
  return typeof value === "object"
    && value !== null
    && "workspace" in value
    && (typeof (value as { workspace?: unknown }).workspace === "string"
      || (typeof (value as { workspace?: unknown }).workspace === "object"
        && (value as { workspace?: unknown }).workspace !== null))
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

function agentDevtoolsMetadata(definition: Pick<AgentDefinition, "invoker" | "title" | "version">): Pick<AgentDevtoolsMetadata, "invokerProfiles" | "title" | "version"> {
  const invokerProfiles = normalizeAgentInvokerProfiles(definition.invoker?.profiles)
  return {
    ...(invokerProfiles.length ? { invokerProfiles } : {}),
    ...(definition.title ? { title: definition.title } : {}),
    ...(definition.version ? { version: definition.version } : {}),
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
  const instructions = parts.flatMap((part) => {
    if (typeof part === "string" && part.trim().length > 0) return [part]
    if (typeof part === "function") {
      const localInstructions = readLocalWorkspaceInstructions(options as WorkspaceAgentOptions<AgentRuntimeConfig, WorkspaceName>)
      if (localInstructions) return [localInstructions]
      return ["Dynamic system instructions resolver configured."]
    }
    return []
  })
  return applyWorkspaceSourceInstructionsToParts(instructions, renderWorkspaceSourceInstructionBlock(workspaceDefinitionFromOptions(options).sources))
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
  resolution: AgentDevtoolsMetadataResolutionOptions<TRuntimeConfig, Name> = {},
  resolvedCapabilities?: ResolvedAgentCapabilities,
) {
  const metadataWorkspace = (resolvedCapabilities?.workspace || workspace) as ReadonlyWorkspaceFacade<Name>
  const instructionContext = {
    fs: metadataWorkspace.fs,
    workspace: metadataWorkspace,
  }
  const parts = Array.isArray(options.instructions) ? options.instructions : [options.instructions]
  const instructions = await Promise.all(parts.map(part => typeof part === "function"
    ? part(instructionContext as never)
    : part))
  const baseInstructions = instructions
    .flatMap(part => Array.isArray(part) ? part : [part])
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part))
  const capabilityInstructions = resolvedCapabilities
    ? [...resolvedCapabilities.capabilityInstructions]
    : await resolveWorkspaceMetadataCapabilityInstructions(options, metadataWorkspace, resolution)
  const renderedInstructions = capabilityInstructions.length
    ? applyCapabilityInstructionSlots(baseInstructions.join("\n\n"), capabilityInstructions).trim()
    : baseInstructions.join("\n\n")
  return applyWorkspaceSourceInstructionsToParts(
    renderedInstructions ? [renderedInstructions] : [],
    await resolveWorkspaceSourceInstructionBlock(workspaceDefinitionWithNameFromOptions(options, resolution), metadataWorkspace),
  )
}

function sourceInstructionsText(value: WorkspaceSource["instructions"]): string | undefined {
  const instructions = (Array.isArray(value) ? value : [value])
    .map(part => part?.trim())
    .filter(Boolean)
    .join("\n\n")
  return instructions || undefined
}

function renderWorkspaceSourceInstructionBlock(sources: WorkspaceDefinition["sources"] | undefined, visible?: Set<string>): string | undefined {
  const entries = Object.entries(sources || {})
    .filter(([key]) => !visible || visible.has(key))
    .map(([key, source]) => ({ instructions: sourceInstructionsText(source.instructions), key }))
    .filter((entry): entry is { instructions: string, key: string } => Boolean(entry.instructions))
    .sort((left, right) => left.key.localeCompare(right.key))

  if (!entries.length) return undefined

  return [
    "## Workspace Sources",
    ...entries.map(entry => `### ${entry.key}\n\n${entry.instructions}`),
  ].join("\n\n")
}

async function visibleWorkspaceSourceNames(
  sources: WorkspaceSourceMap,
  workspace: ReadonlyWorkspaceFacade,
  definition?: WorkspaceDefinition,
): Promise<Set<string>> {
  const visible = new Set<string>()
  await Promise.all(Object.entries(sources).map(async ([key, source]) => {
    try {
      const paths = await sourceVisibilityProbePaths(key, source, definition)
      for (const path of paths) {
        if (await workspace.fs.exists(path)) {
          visible.add(key)
          break
        }
      }
    }
    catch {}
  }))
  return visible
}

async function sourceVisibilityProbePaths(
  key: string,
  source: WorkspaceSource,
  definition?: WorkspaceDefinition,
): Promise<string[]> {
  const mountPath = normalizeSourceInstructionPath(sourceMountPath(key, source))
  if (mountPath === undefined) return []
  if (mountPath) return [mountPath]

  const ctx = sourceInstructionContext(definition, key, mountPath)
  try {
    const keys = await source.getKeys?.(ctx)
    return (keys || [])
      .map(sourcePath => joinSourceInstructionPath(mountPath, sourcePath))
      .filter((path): path is string => Boolean(path))
  }
  catch {
    return []
  }
}

function sourceInstructionContext(definition: WorkspaceDefinition | undefined, key: string, mountPath: string): SourceContext {
  const cwd = (globalThis.process as { cwd?: () => string } | undefined)?.cwd?.() || "."
  return {
    mountPath,
    rootDir: definition?.rootDir || cwd,
    source: key,
    sourceRootDir: definition?.sourceRootDir,
    workspace: definition?.name || defaultWorkspaceName,
  }
}

function joinSourceInstructionPath(...parts: string[]): string | undefined {
  return normalizeSourceInstructionPath(parts.filter(Boolean).join("/"))
}

function normalizeSourceInstructionPath(path = ""): string | undefined {
  const raw = path.replace(/\\/g, "/")
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/+/g, "/")
  const parts = normalized.split("/").filter(Boolean)
  if (raw.startsWith("/") || parts.some(part => part === "." || part === "..")) return undefined
  return normalized
}

export async function resolveWorkspaceSourceInstructionBlock(
  definition: WorkspaceDefinition | undefined,
  workspace: ReadonlyWorkspaceFacade | undefined,
): Promise<string | undefined> {
  const sources = definition?.sources
  if (!sources) return undefined
  const visible = workspace ? await visibleWorkspaceSourceNames(sources, workspace, definition) : undefined
  return renderWorkspaceSourceInstructionBlock(sources, visible)
}

const sourceInstructionSlotPattern = /\{\{\s*workspace\.sources\s*\}\}/g

export function applyWorkspaceSourceInstructionSlot(instructions: string, sourceInstructions: string | undefined): string {
  const sourceBlock = sourceInstructions?.trim()
  let placed = false
  const rendered = instructions.replace(sourceInstructionSlotPattern, () => {
    placed = true
    return sourceBlock || ""
  })

  if (placed) return rendered.trim().replace(/\n{3,}/g, "\n\n")
  return sourceBlock
    ? [instructions.trim(), sourceBlock].filter(Boolean).join("\n\n")
    : instructions
}

function applyWorkspaceSourceInstructionsToParts(parts: string[], sourceInstructions: string | undefined): string[] {
  const hasSourceSlot = parts.some(part => /\{\{\s*workspace\.sources\s*\}\}/.test(part))
  if (!hasSourceSlot && !sourceInstructions?.trim()) return parts
  const instructions = applyWorkspaceSourceInstructionSlot(parts.join("\n\n"), sourceInstructions)
  return instructions ? [instructions] : []
}

function createDevtoolsMetadataRuntime<
  TRuntimeConfig extends AgentRuntimeConfig,
>(
  runtime: Partial<ResolvedAgentRuntimeContext<TRuntimeConfig>> = {},
): ResolvedAgentRuntimeContext<TRuntimeConfig> {
  const memoValues = new Map<string, unknown>()
  return {
    memo(key, create) {
      if (!memoValues.has(key)) memoValues.set(key, create())
      return memoValues.get(key) as never
    },
    runtime: "vite",
    runtimeConfig: {} as TRuntimeConfig,
    waitUntil: () => {},
    ...runtime,
  }
}

async function resolveWorkspaceMetadataCapabilities<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
  resolution: AgentDevtoolsMetadataResolutionOptions<TRuntimeConfig, Name>,
): Promise<ResolvedAgentCapabilities | undefined> {
  const capabilities = normalizeCapabilities(options.capabilities as AgentCapabilityDefinition[] | undefined)
  if (!capabilities.length) return undefined

  const runtime = createDevtoolsMetadataRuntime(resolution.runtime)
  const workspaceName = resolution.workspace || resolution.name || workspaceNameFromOptions(options)
  const input = resolution.input || {}
  const { runtimeConfig: _runtimeConfig, ...callbackContext } = runtime
  const invocationContext = createAgentInvocationContextStore(input.context)
  const invoker = await resolveAgentInvoker(options.invoker, callbackContext, invocationContext, input, runtime.run)
  return await resolveAgentCapabilities({
    capabilities: options.capabilities as AgentCapabilityDefinition<TRuntimeConfig, Name>[] | undefined,
    hooks: options.hooks as never,
  }, runtime, input, workspace, workspaceModeFromOptions(options), {
    context: invocationContext,
    invoker,
    model: "model" in options ? options.model as never : undefined,
    workspaceDefinition: workspaceDefinitionWithNameFromOptions(options, { workspace: workspaceName }),
  })
}

async function resolveWorkspaceMetadataCapabilityInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
  resolution: AgentDevtoolsMetadataResolutionOptions<TRuntimeConfig, Name>,
) {
  const resolved = await resolveWorkspaceMetadataCapabilities(options, workspace, resolution)
  if (!resolved) return []
  try {
    return [...resolved.capabilityInstructions]
  }
  finally {
    await resolved.close()
  }
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
  defaultsOverride: AgentDevtoolsMetadataResolutionOptions<TRuntimeConfig, Name> = {},
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
  const resolved = await resolveWorkspaceMetadataCapabilities(options, workspace, defaultsOverride)
  try {
    const metadataWorkspace = (resolved?.workspace || workspace) as ReadonlyWorkspaceFacade<Name>
    return {
      files: await resolveWorkspaceMetadataFiles(options, defaults, metadataWorkspace),
      instructions: await resolveWorkspaceMetadataInstructions(options, metadataWorkspace, defaultsOverride, resolved),
      ...agentDevtoolsMetadata(workspaceDefinition as AgentDefinition),
      tools: workspaceMetadataTools(options),
    }
  }
  finally {
    await resolved?.close()
  }
}
