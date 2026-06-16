import {
  applyCapabilityInstructionSlots,
  capabilityInstructionBlockId,
  normalizeCapabilities,
  normalizeMode,
  resolveAgentCapabilities,
} from "./capability-runtime.ts"
import { createAgentInvocationContextStore } from "./invocation-context.ts"
import {
  getWorkspaceSourceRequestDescriptor,
  isWorkspaceSourceRequestOnly,
  workspaceSourceRequestDescriptorPath,
} from "@vite-hub/workspace"
import {
  normalizeAgentInvokerProfiles,
  resolveAgentInvoker,
} from "./invoker.ts"
import { normalizeAgentDriver } from "./internal/agent-driver.ts"
import { normalizeAgentWorkspaceSources } from "./workspace-source-metadata.ts"

import type {
  AgentAdapterMetadataContext,
  AgentAdapterInstructions,
  AgentCapabilityDefinition,
  AgentCapabilityMode,
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
  AgentInvocationContextStore,
  AgentInvocationContextValues,
  AgentInvokerProfile,
  AgentInput,
  AgentInstructionBlock,
  AgentModelInput,
  AgentModelResolver,
  AgentRunInput,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentSettings,
  ResolvedAgentRuntimeContext,
  WorkspaceAgentWorkspaceConfig,
  WorkspaceAgentWorkspaceOptions,
} from "./types.ts"
import type { AgentWorkspaceSourceMetadata } from "./workspace-source-metadata.ts"
import type {
  ReadonlyWorkspaceFacade,
  SourceContext,
  WorkspaceEntry,
  WorkspaceDefinition,
  WorkspaceMaterializeSourcesOptions,
  WorkspaceName,
  WorkspaceSourceResolutionContextValueReader,
} from "@vite-hub/workspace"

const defaultWorkspaceName = "workspace"
const readCommands = ["pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc"]
const writeCommands = [...readCommands, "mkdir", "touch", "cp", "mv", "rm"]

type NormalizedWorkspaceOptions = WorkspaceAgentWorkspaceOptions & { mode: AgentCapabilityMode }
type NormalizedCapability = AgentCapabilityDefinition & { mode?: AgentCapabilityMode }

export type WorkspaceAgentOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  _Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
  TCapabilities extends readonly AgentCapabilityDefinition<TRuntimeConfig>[] | undefined = AgentCapabilityDefinition<TRuntimeConfig>[] | undefined,
> = AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues, TCapabilities> & {
  name?: string
  workspace: WorkspaceAgentWorkspaceConfig
}

export type WorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
  TCapabilities extends readonly AgentCapabilityDefinition<TRuntimeConfig>[] | undefined = AgentCapabilityDefinition<TRuntimeConfig>[] | undefined,
> = AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues> & WorkspaceAgentWorkspaceOptions & {
  __vitehubWorkspaceAgent: true
  __vitehubWorkspaceAgentDefaults?: WorkspaceAgentDefaults<Name>
  __vitehubWorkspaceAgentOptions: WorkspaceAgentOptions<TRuntimeConfig, Name, CALL_OPTIONS, TInvokerProfile, TContextValues, TCapabilities>
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

export interface AgentDevtoolsSourceMaterializationOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends AgentDevtoolsMetadataResolutionOptions<TRuntimeConfig, Name> {
  path?: string
  source?: string
  sources?: string[]
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

function modelDriverInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
): AgentAdapterInstructions<TRuntimeConfig, Name> | undefined {
  const driver = (options as unknown as { driver?: unknown }).driver
  if (typeof driver === "object" && driver !== null) {
    return "model" in driver
      ? (driver as { instructions?: AgentAdapterInstructions<TRuntimeConfig, Name> }).instructions
      : undefined
  }
  return (options as { instructions?: AgentAdapterInstructions<TRuntimeConfig, Name> }).instructions
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function agentSettings<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>): AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile> | undefined {
  return (definition as { __vitehubAgentSettings?: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile> }).__vitehubAgentSettings
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
}

function modelProviderFromId(id: string | undefined): string | undefined {
  const provider = id?.split("/", 1)[0]?.trim()
  return provider && provider !== id ? provider : undefined
}

function modelMetadata(model: AgentModelInput, dynamic = false): AgentDevtoolsModelMetadata {
  const record = isRecord(model) ? model : undefined
  const id = record ? stringField(record, ["modelId", "id", "model", "name"]) : undefined
  const provider = record ? stringField(record, ["provider", "providerId"]) || modelProviderFromId(id) : undefined
  return {
    ...(dynamic ? { dynamic: true } : {}),
    ...(id ? { id } : {}),
    ...(provider ? { provider } : {}),
  }
}

function configValue(value: unknown): AgentDevtoolsConfigValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value
  }
}

function redactedConfigValue(key: string, value: unknown): AgentDevtoolsConfigValue | undefined {
  if (/(?:api[-_]?key|authorization|credential|password|secret|token)/i.test(key)) {
    return "[redacted]"
  }
  return configValue(value)
}

function callSettingsMetadata(value: unknown): Record<string, AgentDevtoolsConfigValue> | undefined {
  if (!isRecord(value)) return
  const entries = Object.entries(value)
    .flatMap(([key, setting]) => {
      const metadataValue = redactedConfigValue(key, setting)
      return metadataValue === undefined ? [] : [[key, metadataValue] as const]
    })
  return entries.length ? Object.fromEntries(entries) : undefined
}

function workspaceFallbackMetadata(
  value: AgentDevtoolsModelExecutionMetadata["workspaceFallback"] | boolean | undefined,
): AgentDevtoolsModelExecutionMetadata["workspaceFallback"] | undefined {
  if (typeof value === "boolean") return { enabled: value }
  if (!isRecord(value)) return
  const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined
  const maxToolResults = typeof value.maxToolResults === "number" ? value.maxToolResults : undefined
  return enabled !== undefined || maxToolResults !== undefined
    ? {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(maxToolResults !== undefined ? { maxToolResults } : {}),
      }
    : undefined
}

function executionMetadata(value: AgentDevtoolsDriverMetadata["execution"] | undefined): AgentDevtoolsModelExecutionMetadata | undefined {
  if (!value) return
  const callSettings = callSettingsMetadata(value.callSettings)
  const workspaceFallback = workspaceFallbackMetadata(value.workspaceFallback)
  const stepLimit = typeof value.stepLimit === "number" ? value.stepLimit : undefined
  return callSettings || workspaceFallback || stepLimit !== undefined
    ? {
        ...(callSettings ? { callSettings } : {}),
        ...(stepLimit !== undefined ? { stepLimit } : {}),
        ...(workspaceFallback ? { workspaceFallback } : {}),
      }
    : undefined
}

function harnessMetadata(driver: { credentials?: unknown, harness: unknown, sandbox?: unknown, sessionKey?: unknown }): AgentDevtoolsHarnessMetadata | undefined {
  const harness = isRecord(driver.harness) ? driver.harness : undefined
  const provider = harness ? stringField(harness, ["provider", "name"]) : undefined
  const credentials = isRecord(driver.credentials)
    ? {
        ...(typeof driver.credentials.label === "string" && driver.credentials.label ? { label: driver.credentials.label } : {}),
        ...(typeof driver.credentials.source === "string" && driver.credentials.source ? { source: driver.credentials.source } : {}),
      }
    : undefined
  return provider || credentials || driver.sandbox || driver.sessionKey
    ? {
        ...(credentials && Object.keys(credentials).length ? { credentials } : {}),
        ...(provider ? { provider } : {}),
        ...(driver.sandbox ? { sandbox: true } : {}),
        ...(driver.sessionKey ? { sessionKey: true } : {}),
      }
    : undefined
}

function staticDriverMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(settings: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile> | undefined): AgentDevtoolsDriverMetadata | undefined {
  if (!settings) return
  const driver = normalizeAgentDriver(settings)
  if (driver.kind === "model") {
    return {
      ...(driver.execution ? { execution: executionMetadata(driver.execution as never) } : {}),
      kind: "model",
      model: modelMetadata(typeof driver.model === "function" ? undefined : driver.model, typeof driver.model === "function"),
    }
  }
  if (driver.kind === "harness") {
    return {
      ...(harnessMetadata(driver) ? { harness: harnessMetadata(driver) } : {}),
      kind: "harness",
    }
  }
  return { kind: "run" }
}

async function resolvedDriverMetadata<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(
  settings: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile> | undefined,
  context: AgentAdapterMetadataContext<TRuntimeConfig, Name>,
): Promise<AgentDevtoolsDriverMetadata | undefined> {
  if (!settings) return
  const driver = normalizeAgentDriver(settings)
  if (driver.kind === "model") {
    const dynamic = typeof driver.model === "function"
    const model = dynamic
      ? await (driver.model as (context: AgentAdapterMetadataContext<TRuntimeConfig, Name>) => AgentModelInput | Promise<AgentModelInput>)(context)
      : driver.model
    return {
      ...(driver.execution ? { execution: executionMetadata(driver.execution as never) } : {}),
      kind: "model",
      model: modelMetadata(model, dynamic),
    }
  }
  if (driver.kind === "harness") {
    const harness = harnessMetadata(driver)
    return {
      ...(harness ? { harness } : {}),
      kind: "harness",
    }
  }
  return { kind: "run" }
}

function staticConfigMetadata<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): AgentDevtoolsConfigMetadata | undefined {
  const driver = staticDriverMetadata(agentSettings(definition))
  return driver ? { driver } : undefined
}

async function resolvedConfigMetadata<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentAdapterMetadataContext<TRuntimeConfig, Name>,
): Promise<AgentDevtoolsConfigMetadata | undefined> {
  const driver = await resolvedDriverMetadata(agentSettings(definition), context)
  return driver ? { driver } : undefined
}

function agentDevtoolsMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  definition: Pick<AgentDefinition<TRuntimeConfig, CALL_OPTIONS>, "invoker" | "title" | "version"> & AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): Pick<AgentDevtoolsMetadata, "config" | "invokerProfiles" | "title" | "version"> {
  const invokerProfiles = normalizeAgentInvokerProfiles(definition.invoker?.profiles)
  const config = staticConfigMetadata(definition)
  return {
    ...(config ? { config } : {}),
    ...(invokerProfiles.length ? { invokerProfiles } : {}),
    ...(definition.title ? { title: definition.title } : {}),
    ...(definition.version ? { version: definition.version } : {}),
  }
}

function normalizedSourcesFromOptions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: WorkspaceAgentOptions<TRuntimeConfig, Name>): AgentWorkspaceSourceMetadata[] {
  return normalizeAgentWorkspaceSources(workspaceDefinitionFromOptions(options).sources)
}

function sourceMountPath(source: AgentWorkspaceSourceMetadata) {
  return source.mountPath
}

function sourceMaterialize(source: AgentWorkspaceSourceMetadata): AgentDevtoolsFileTreeItem["materialize"] {
  return source.materialize === "none" ? undefined : source.materialize
}

function workspaceMetadataFiles<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  _defaults: WorkspaceAgentDefaults<Name>,
): AgentDevtoolsFileTreeItem[] {
  const sources = normalizedSourcesFromOptions(options)
  return sources.sort((left, right) => left.key.localeCompare(right.key)).map((source) => {
    const materialize = sourceMaterialize(source)
    const mountPath = sourceMountPath(source)
    return {
      kind: "directory" as const,
      label: mountPath.split("/").filter(Boolean).at(-1) || source.key,
      materialize,
      materialized: materialize === "build",
      path: mountPath,
      source: source.key,
      status: materialize === "lazy" ? "lazy" as const : "ready" as const,
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

function localWorkspaceRoots<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: WorkspaceAgentOptions<TRuntimeConfig, Name>): string[] {
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

function sourceMountPaths<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: WorkspaceAgentOptions<TRuntimeConfig, Name>): string[] {
  return normalizedSourcesFromOptions(options).map(source => sourceMountPath(source))
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
  const sources = normalizedSourcesFromOptions(options)
  for (const source of sources) {
    const mountPath = sourceMountPath(source)
    const materialize = sourceMaterialize(source)
    const mountedRoot = [root.path, mountPath].filter(Boolean).join("/")
    const pending = [...(root.children || [])]
    while (pending.length) {
      const item = pending.shift()!
      if (item.path === mountedRoot) {
        item.materialize = materialize
        item.materialized = item.materialized || materialize === "build" || Boolean(item.children?.length)
        item.source = source.key
        item.status = item.materialized ? "ready" : materialize === "lazy" ? "lazy" : "ready"
      }
      else if (item.path.startsWith(`${mountedRoot}/`)) {
        item.materialize = materialize
        item.materialized = item.materialized || materialize === "build"
        item.source = source.key
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

function workspaceMetadataTools<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
): AgentDevtoolsToolDefinition[] {
  return normalizeCapabilities(options.capabilities)
    .map(capabilityMetadataTool)
    .filter((tool): tool is AgentDevtoolsToolDefinition => Boolean(tool))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function staticCapabilityInstructionBlocks<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
): AgentInstructionBlock[] {
  return normalizeCapabilities(options.capabilities)
    .flatMap((capability) => {
      if (capability.instructions === undefined || capability.instructions === false) return []
      const parts = Array.isArray(capability.instructions) ? capability.instructions : [capability.instructions]
      const instructions = parts
        .flatMap(part => Array.isArray(part) ? part : [part])
        .map(part => typeof part === "string" ? part.trim() : "")
        .filter(Boolean)
        .join("\n\n")
      return instructions
        ? [{ id: capabilityInstructionBlockId(capability.id), instructions }]
        : []
    })
}

const capabilityInstructionSlotPattern = /\{\{\s*capabilities(?:\.[a-zA-Z][\w.-]*)?\s*\}\}/g

function applyPassiveCapabilityInstructionSlots(instructions: string, blocks: AgentInstructionBlock[] = []): string {
  const rendered = blocks.length
    ? applyCapabilityInstructionSlots(instructions, blocks)
    : instructions
  return rendered.replace(capabilityInstructionSlotPattern, "").trim().replace(/\n{3,}/g, "\n\n")
}

function workspaceMetadataInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
): string[] {
  const configuredInstructions = modelDriverInstructions(options)
  const parts = Array.isArray(configuredInstructions) ? configuredInstructions : [configuredInstructions]
  const instructions = parts.flatMap((part) => {
    if (typeof part === "string" && part.trim().length > 0) return [part]
    if (typeof part === "function") {
      const localInstructions = readLocalWorkspaceInstructions(options)
      if (localInstructions) return [localInstructions]
      return ["Dynamic system instructions resolver configured."]
    }
    return []
  })
  const renderedInstructions = applyPassiveCapabilityInstructionSlots(
    instructions.join("\n\n"),
    staticCapabilityInstructionBlocks(options),
  )
  return applyWorkspaceSourceInstructionsToParts(
    renderedInstructions ? [renderedInstructions] : [],
    renderWorkspaceSourceInstructionBlock(workspaceDefinitionFromOptions(options).sources),
  )
}

function readLocalWorkspaceInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: WorkspaceAgentOptions<TRuntimeConfig, Name>): string | undefined {
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
  capabilityBlocks: AgentInstructionBlock[] = staticCapabilityInstructionBlocks(options),
  sourceDefinition: WorkspaceDefinition = workspaceDefinitionWithNameFromOptions(options, resolution),
) {
  const instructionContext = {
    fs: workspace.fs,
    workspace,
  }
  const configuredInstructions = modelDriverInstructions(options)
  const parts = Array.isArray(configuredInstructions) ? configuredInstructions : [configuredInstructions]
  const instructions = await Promise.all(parts.map(part => typeof part === "function"
    ? part(instructionContext as never)
    : part))
  const baseInstructions = instructions
    .flatMap(part => Array.isArray(part) ? part : [part])
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part))
  const renderedInstructions = applyPassiveCapabilityInstructionSlots(
    baseInstructions.join("\n\n"),
    capabilityBlocks,
  )
  return applyWorkspaceSourceInstructionsToParts(
    renderedInstructions ? [renderedInstructions] : [],
    await resolveWorkspaceSourceInstructionBlock(
      sourceDefinition,
      workspace,
    ),
  )
}

function sourceInstructionsText(value: AgentWorkspaceSourceMetadata["instructions"]): string | undefined {
  const instructions = (Array.isArray(value) ? value : [value])
    .map(part => part?.trim())
    .filter(Boolean)
    .join("\n\n")
  return instructions || undefined
}

function renderWorkspaceSourceInstructionBlock(sources: WorkspaceDefinition["sources"] | undefined, visible?: Set<string>): string | undefined {
  const entries = normalizeAgentWorkspaceSources(sources)
    .filter(source => !visible || visible.has(source.key))
    .map(source => ({ instructions: sourceInstructionsText(source.instructions), key: source.key }))
    .filter((entry): entry is { instructions: string, key: string } => Boolean(entry.instructions))
    .sort((left, right) => left.key.localeCompare(right.key))

  if (!entries.length) return undefined

  return [
    "## Workspace Sources",
    ...entries.map(entry => `### ${entry.key}\n\n${entry.instructions}`),
  ].join("\n\n")
}

async function visibleWorkspaceSourceNames(
  sources: WorkspaceDefinition["sources"],
  workspace: ReadonlyWorkspaceFacade,
  definition?: WorkspaceDefinition,
): Promise<Set<string>> {
  const visible = new Set<string>()
  await Promise.all(normalizeAgentWorkspaceSources(sources).map(async (source) => {
    try {
      const paths = await sourceVisibilityProbePaths(source, definition)
      for (const path of paths) {
        if (await workspace.fs.exists(path)) {
          visible.add(source.key)
          break
        }
      }
    }
    catch {}
  }))
  return visible
}

async function sourceVisibilityProbePaths(
  source: AgentWorkspaceSourceMetadata,
  definition?: WorkspaceDefinition,
): Promise<string[]> {
  const descriptorSource = source.source
  const descriptorPath = descriptorSource && getWorkspaceSourceRequestDescriptor(descriptorSource)
    ? workspaceSourceRequestDescriptorPath(source.key)
    : undefined
  if (descriptorPath && descriptorSource && isWorkspaceSourceRequestOnly(descriptorSource)) {
    return [descriptorPath]
  }
  const mountPath = normalizeSourceInstructionPath(sourceMountPath(source))
  const descriptorPaths = descriptorPath ? [descriptorPath] : []
  if (mountPath === undefined) return descriptorPaths
  if (mountPath) return [...descriptorPaths, mountPath]
  if (source.probeKeys?.length) {
    return [
      ...descriptorPaths,
      ...source.probeKeys
      .map(sourcePath => joinSourceInstructionPath(mountPath, sourcePath))
        .filter((path): path is string => Boolean(path)),
    ]
  }
  if (!source.source) return descriptorPaths

  const ctx = sourceInstructionContext(definition, source.key, mountPath)
  try {
    await source.source.prepare?.(ctx)
    const keys = await source.source.getKeys(ctx)
    return [
      ...descriptorPaths,
      ...(keys || [])
      .map(sourcePath => joinSourceInstructionPath(mountPath, sourcePath))
        .filter((path): path is string => Boolean(path)),
    ]
  }
  catch {
    return descriptorPaths
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

function createDevtoolsSourceResolutionContext(input: AgentRunInput | undefined): WorkspaceSourceResolutionContextValueReader<object> {
  const values = new Map<string, unknown>()
  if (input?.context && typeof input.context === "object") {
    for (const [key, value] of Object.entries(input.context as Record<string, unknown>)) {
      values.set(key, value)
    }
  }

  return {
    entries: () => values.entries(),
    get: (key: string) => values.get(key) as never,
    has: key => values.has(key),
    toJSON: () => Object.fromEntries(values),
  }
}

function workspaceOptionsFromDefinition<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  definition: WorkspaceDefinition,
): WorkspaceAgentOptions<TRuntimeConfig, Name> {
  const { name: _name, ...workspace } = definition
  return {
    ...options,
    workspace: {
      ...workspace,
      mode: normalizeWorkspaceOptions(options.workspace).mode,
    },
  }
}

function hasAccessCapability<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
): boolean {
  return normalizeCapabilities(options.capabilities as AgentCapabilityDefinition[] | undefined)
    .some(capability => capability.id === "access")
}

async function createDevtoolsMetadataWorkspace<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  definition: Partial<WorkspaceAgentDefinition<TRuntimeConfig, Name>>,
  defaultsOverride: AgentDevtoolsMetadataResolutionOptions<TRuntimeConfig, Name> = {},
) {
  const defaults = {
    ...(definition.__vitehubWorkspaceAgentDefaults || definition as WorkspaceAgentDefaults<Name>),
    ...defaultsOverride,
  }
  const workspaceName = defaults.workspace || defaults.name
  if (!workspaceName || !definition.__vitehubWorkspaceAgentOptions) return

  const { createWorkspaceSourceResolutionFacade, hasWorkspaceSourceResolvers, useWorkspace } = await import("@vite-hub/workspace")
  const workspace = useWorkspace(workspaceName)
  const options = definition.__vitehubWorkspaceAgentOptions as unknown as WorkspaceAgentOptions<TRuntimeConfig, Name>
  const workspaceDefinition = workspaceDefinitionWithNameFromOptions(options, defaults)

  if (hasAccessCapability(options)) {
    return { defaults, options, workspace }
  }

  if (!hasWorkspaceSourceResolvers(workspaceDefinition)) {
    return { defaults, options, workspace }
  }

  const resolved = await createWorkspaceSourceResolutionFacade(workspace, workspaceDefinition, {
    invocation: {
      context: createDevtoolsSourceResolutionContext(defaults.input),
    },
  })

  return {
    defaults,
    options: workspaceOptionsFromDefinition(options, resolved.definition),
    workspace: resolved.workspace,
  }
}

function createDevtoolsMetadataRuntime<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  resolution: AgentDevtoolsMetadataResolutionOptions<TRuntimeConfig, Name>,
): ResolvedAgentRuntimeContext<TRuntimeConfig> {
  const runtime = resolution.runtime || {}
  return {
    ...runtime,
    memo: runtime.memo || ((_key, create) => create()),
    runtime: runtime.runtime || "unknown",
    runtimeConfig: (runtime.runtimeConfig || {}) as TRuntimeConfig,
    waitUntil: runtime.waitUntil || (() => {}),
  }
}

function agentCallbackContext<
  TRuntimeConfig extends AgentRuntimeConfig,
>(
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>,
) {
  const { runtimeConfig: _runtimeConfig, ...context } = runtime
  return context
}

async function resolveWorkspaceMetadataCapabilityContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  definition: Partial<WorkspaceAgentDefinition<TRuntimeConfig, Name>>,
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
  resolution: AgentDevtoolsMetadataResolutionOptions<TRuntimeConfig, Name>,
) {
  const runtime = createDevtoolsMetadataRuntime(resolution)
  const input = resolution.input || { messages: [] }
  const invocationContext: AgentInvocationContextStore = createAgentInvocationContextStore(input.context)
  const invoker = await resolveAgentInvoker(
    (definition as AgentDefinition<TRuntimeConfig>).invoker as never,
    agentCallbackContext(runtime),
    invocationContext,
    input as never,
    runtime.run,
  )
  const workspaceDefinition = workspaceDefinitionWithNameFromOptions(options, resolution)
  const capabilities = await resolveAgentCapabilities({
    capabilities: options.capabilities as AgentCapabilityDefinition<TRuntimeConfig, Name>[],
    hooks: options.hooks as never,
  }, runtime, input, workspace, workspaceModeFromOptions(options), {
    context: invocationContext,
    invoker,
    phases: ["prepare"],
    resolveTools: false,
    workspaceDefinition,
  })
  const sourceResolvedDefinition = invocationContext.get<WorkspaceDefinition>("workspace.sourceResolution.definition")
  const metadataWorkspace = capabilities.workspace || workspace

  return {
    capabilityInstructions: capabilities.capabilityInstructions,
    definition: sourceResolvedDefinition || workspaceDefinition,
    metadataContext: {
      ...agentCallbackContext(runtime),
      context: invocationContext,
      fs: metadataWorkspace.fs,
      invoker,
      workspace: metadataWorkspace,
    } satisfies AgentAdapterMetadataContext<TRuntimeConfig, Name>,
    workspace: metadataWorkspace,
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

  const options = workspaceDefinition.__vitehubWorkspaceAgentOptions as unknown as WorkspaceAgentOptions<TRuntimeConfig, Name>
  return {
    files: workspaceMetadataFiles(options, workspaceDefinition.__vitehubWorkspaceAgentDefaults || workspaceDefinition as WorkspaceAgentDefaults<Name>),
    instructions: workspaceMetadataInstructions(options),
    ...agentDevtoolsMetadata(workspaceDefinition as AgentDefinition<TRuntimeConfig>),
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

  const metadataWorkspace = await createDevtoolsMetadataWorkspace(workspaceDefinition, defaultsOverride)
  if (!metadataWorkspace) {
    return createAgentDevtoolsMetadata(definition)
  }
  const capabilityContext = await resolveWorkspaceMetadataCapabilityContext(
    workspaceDefinition as never,
    metadataWorkspace.options as never,
    metadataWorkspace.workspace as never,
    defaultsOverride,
  )
  const metadataOptions = workspaceOptionsFromDefinition(
    metadataWorkspace.options as never,
    capabilityContext.definition as never,
  )
  const config = await resolvedConfigMetadata(
    workspaceDefinition as AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
    capabilityContext.metadataContext,
  )

  return {
    files: await resolveWorkspaceMetadataFiles(metadataOptions as never, metadataWorkspace.defaults as never, capabilityContext.workspace as never),
    instructions: await resolveWorkspaceMetadataInstructions(
      metadataOptions as never,
      capabilityContext.workspace as never,
      defaultsOverride,
      capabilityContext.capabilityInstructions,
      capabilityContext.definition,
    ),
    ...agentDevtoolsMetadata(workspaceDefinition as AgentDefinition<TRuntimeConfig>),
    ...(config ? { config } : {}),
    tools: workspaceMetadataTools(metadataWorkspace.options as never),
  }
}

export async function materializeAgentDevtoolsSourceMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  options: AgentDevtoolsSourceMaterializationOptions<TRuntimeConfig, Name> = {},
): Promise<AgentDevtoolsMetadata> {
  const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig, Name>>
  if (!workspaceDefinition.__vitehubWorkspaceAgent || !workspaceDefinition.__vitehubWorkspaceAgentOptions) {
    return { files: [], ...agentDevtoolsMetadata(definition), tools: [] }
  }

  const metadataWorkspace = await createDevtoolsMetadataWorkspace(workspaceDefinition, options)
  if (!metadataWorkspace) {
    return createAgentDevtoolsMetadata(definition)
  }
  const capabilityContext = await resolveWorkspaceMetadataCapabilityContext(
    workspaceDefinition as never,
    metadataWorkspace.options as never,
    metadataWorkspace.workspace as never,
    options,
  )

  const sources = [...new Set([
    ...(options.sources || []),
    ...(options.source ? [options.source] : []),
  ])]
  const preservedSources = options.source
    ? sources.filter(source => source !== options.source)
    : []
  if (preservedSources.length) {
    await capabilityContext.workspace.fs.materializeSources?.({ sources: preservedSources })
  }

  const materializeOptions: WorkspaceMaterializeSourcesOptions = {
    ...(options.path ? { path: options.path } : {}),
    ...(options.source ? { sources: [options.source] } : !preservedSources.length && sources.length ? { sources } : {}),
  }
  if (materializeOptions.path || materializeOptions.sources?.length) {
    await capabilityContext.workspace.fs.materializeSources?.(materializeOptions)
  }
  const metadataOptions = workspaceOptionsFromDefinition(
    metadataWorkspace.options as never,
    capabilityContext.definition as never,
  )
  const config = await resolvedConfigMetadata(
    workspaceDefinition as AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
    capabilityContext.metadataContext,
  )

  return {
    files: await resolveWorkspaceMetadataFiles(metadataOptions as never, metadataWorkspace.defaults as never, capabilityContext.workspace as never),
    instructions: await resolveWorkspaceMetadataInstructions(
      metadataOptions as never,
      capabilityContext.workspace as never,
      options,
      capabilityContext.capabilityInstructions,
      capabilityContext.definition,
    ),
    ...agentDevtoolsMetadata(workspaceDefinition as AgentDefinition<TRuntimeConfig>),
    ...(config ? { config } : {}),
    tools: workspaceMetadataTools(metadataWorkspace.options as never),
  }
}
