import { asUnknownBoundary, hasRuntimeType } from "./internal/runtime-type.ts"
import { normalizeWorkspaceSourcesMetadata, workspaceSourceGrantPaths, type WorkspaceSourceMetadata } from "@vite-hub/workspace/source-metadata"
import {
  noExecutionAuthority,
  normalizeExecutionAuthority,
  unknownExecutionAuthority,
  type ExecutionAuthority,
} from "@vite-hub/runtime"

import {
  hasTrustedWorkspaceAccessScope,
  markTrustedSourceFreeInspection,
} from "./access-runtime.ts"
import {
  capabilityWorkspaceSources,
  normalizeCapabilities,
  normalizeMode,
  resolveAgentCapabilities,
  resolveAgentCapabilityDefinitions,
  validateAgentCapabilityComposition,
} from "./capability-runtime.ts"
import { agentInvocationCallbackContextValues, agentInvocationSourceContext, createAgentInvocationContextStore } from "./invocation-context.ts"
import {
  normalizeAgentInvokerProfiles,
  resolveAgentInvoker,
} from "./invoker.ts"
import {
  collectStaticInstructionCoverage,
  createInstructionCoverage,
  composeInstructionDocument,
  resolveInstructionImports,
} from "./instruction-composition.ts"
import { inheritAgentCapacity, inspectAgentCapacity } from "./internal/agent-capacity.ts"
import { normalizeAgentDriver } from "./internal/agent-driver.ts"
import { gatewayModelDescriptor } from "./internal/agent-model.ts"
import { consumesMessageChannelInstructions, inspectMessageChannelInstructions } from "./internal/channels.ts"

import type {
  AgentAdapterInstructions,
  AgentCapabilitiesInput,
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentDefinition,
  AgentInspectionCapabilityMetadata,
  AgentInspectionConfigMetadata,
  AgentInspectionConfigValue,
  AgentInspectionDriverMetadata,
  AgentInspectionFileTreeItem,
  AgentInspectionProviderMetadata,
  AgentInspectionMetadata,
  AgentInspectionModelExecutionMetadata,
  AgentInspectionModelMetadata,
  AgentInspectionToolDefinition,
  AgentInspectionWarning,
  AgentInspectionValue,
  AgentDriver,
  AgentDriverKind,
  AgentInvocationContextStore,
  AgentInvocationContextValues,
  AgentHostIdentity,
  AgentInvoker,
  AgentInvokerProfile,
  AgentInput,
  AgentModelInput,
  AgentModelResolverContext,
  AgentRunCallbackContext,
  AgentRunInput,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeName,
  AgentSettings,
  AgentUIMessageStreamProjection,
  ResolvedAgentRuntimeContext,
  WorkspaceAgentWorkspaceConfig,
  WorkspaceAgentWorkspaceOptions,
} from "./types.ts"
import type {
  ReadonlyWorkspaceFacade,
  WorkspaceEntry,
  WorkspaceDefinition,
  WorkspaceMaterializeSourcesOptions,
  WorkspaceName,
  WorkspaceRules,
} from "@vite-hub/workspace"

const defaultWorkspaceName = "workspace"
const colocatedAgentInstructionsPath = "instructions.md"
const colocatedAgentInstructionsWorkspacePath = "AGENTS.md"
export const colocatedAgentInstructionsSourceKey = "__vitehubAgentInstructions"
const readCommands = ["pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc"]
const sourceRequestCommands = ["curl"]
const writeCommands = [...readCommands, "mkdir", "touch", "cp", "mv", "rm"]
const workspaceDefinitionKeys = new Set([
  "bindings",
  "commit",
  "hooks",
  "loaders",
  "plugins",
  "publish",
  "rootDir",
  "rules",
  "runtime",
  "sourceRootDir",
  "sources",
  "store",
])
const workspaceReferenceKeys = new Set(["mode", "name"])

type NormalizedWorkspaceOptions = WorkspaceAgentWorkspaceOptions & { mode: AgentCapabilityMode }
type NormalizedCapability = AgentCapabilityDefinition & { mode?: AgentCapabilityMode }

function staticAgentCapabilities<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(capabilities: AgentCapabilitiesInput<TRuntimeConfig, Name> | undefined): AgentCapabilityDefinition<TRuntimeConfig, Name>[] {
  return Array.isArray(capabilities)
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    ? normalizeCapabilities(capabilities) as AgentCapabilityDefinition<TRuntimeConfig, Name>[]
    : []
}

export type WorkspaceAgentOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  _Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
  TCapabilities extends AgentCapabilitiesInput<TRuntimeConfig, _Name, CALL_OPTIONS> | undefined = AgentCapabilitiesInput<TRuntimeConfig, _Name, CALL_OPTIONS> | undefined,
  TOutput = unknown,
  TDriver extends AgentDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues, TOutput> = AgentDriver<TRuntimeConfig, CALL_OPTIONS, TContextValues, TOutput>,
> = AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues, TCapabilities, TOutput, TDriver> & {
  name?: string
  workspace: WorkspaceAgentWorkspaceConfig<_Name>
}

export type WorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
  TContextValues extends object = AgentInvocationContextValues,
  TCapabilities extends AgentCapabilitiesInput<TRuntimeConfig, Name, CALL_OPTIONS> | undefined = AgentCapabilitiesInput<TRuntimeConfig, Name, CALL_OPTIONS> | undefined,
  TOutput = unknown,
> = AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile, TContextValues, TOutput> & WorkspaceAgentWorkspaceOptions & {
  __vitehubWorkspaceAgent: true
  __vitehubWorkspaceAgentOptions: WorkspaceAgentOptions<TRuntimeConfig, Name, CALL_OPTIONS, TInvokerProfile, TContextValues, TCapabilities, TOutput>
}

export interface WorkspaceAgentDefaults<Name extends WorkspaceName = WorkspaceName> {
  name?: string
  workspace?: Name
}

export interface AgentInspectionMetadataResolutionOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends WorkspaceAgentDefaults<Name> {
  input?: AgentRunInput
  resolveSources?: boolean
  runtime?: Partial<ResolvedAgentRuntimeContext<TRuntimeConfig>>
}

export interface AgentInspectionSourceMaterializationOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends Omit<AgentInspectionMetadataResolutionOptions<TRuntimeConfig, Name>, "resolveSources"> {
  path?: string
  source?: string
  sources?: string[]
}

interface MetadataCapabilitySelection<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
> {
  capabilities: AgentCapabilityDefinition<TRuntimeConfig, Name>[]
  driverKind: AgentDriverKind
  input: AgentRunInput
  invocationContext: AgentInvocationContextStore
  invoker: AgentInvoker
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>
}

export function normalizeWorkspaceOptions(workspace: WorkspaceAgentWorkspaceConfig): NormalizedWorkspaceOptions {
  if (isWorkspaceReference(workspace)) return { mode: normalizeMode(workspace.mode, "Workspace") }
  if (hasRuntimeType(workspace, "string")) return { mode: "read" }
  return {
    ...workspace,
    mode: normalizeMode(workspace.mode, "Workspace"),
  }
}

export function workspaceDefinitionWithAutoCommitRules(definition: WorkspaceDefinition, commit: boolean | string | undefined): WorkspaceDefinition {
  if (commit !== true && !hasRuntimeType(commit, "string")) return definition
  return { ...definition, rules: mergeWorkspaceCommitRules(definition.rules, commit) }
}

function isWorkspaceReference(workspace: WorkspaceAgentWorkspaceConfig): workspace is { mode?: AgentCapabilityMode, name: string } {
  return hasRuntimeType(workspace, "object")
    && workspace !== null
    && "name" in workspace
    && hasRuntimeType(workspace.name, "string")
}

export function workspaceAgentOwnsWorkspaceDefinition(agent: unknown): boolean {
  const options = hasRuntimeType(agent, "object") && agent !== null
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    ? (agent as { __vitehubWorkspaceAgentOptions?: { workspace?: unknown } }).__vitehubWorkspaceAgentOptions
    : undefined
  const workspace = options?.workspace
  return hasRuntimeType(workspace, "object")
    && workspace !== null
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    && !isWorkspaceReference(workspace as WorkspaceAgentWorkspaceConfig)
}

const registeredWorkspaceAgentNames = Symbol("vitehub.registeredWorkspaceAgentNames")

type RegisteredWorkspaceAgent = {
  [registeredWorkspaceAgentNames]?: Set<string>
}

export function markWorkspaceAgentDefinitionRegistered(agent: unknown, name: string): void {
  if (!hasRuntimeType(agent, "object") || agent === null) return
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const registeredAgent = agent as RegisteredWorkspaceAgent
  const names = registeredAgent[registeredWorkspaceAgentNames] || new Set<string>()
  names.add(name)
  if (registeredAgent[registeredWorkspaceAgentNames]) return
  Object.defineProperty(registeredAgent, registeredWorkspaceAgentNames, {
    configurable: true,
    value: names,
  })
}

export function markDiscoveredWorkspaceAgentDefinitionRegistered(
  agent: unknown,
  defaults: WorkspaceAgentDefaults = {},
): string | undefined {
  if (!workspaceAgentOwnsWorkspaceDefinition(agent)) return
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const options = (agent as WorkspaceAgentDefinition).__vitehubWorkspaceAgentOptions
  const name = workspaceNameFromOptions(options, defaults)
  markWorkspaceAgentDefinitionRegistered(agent, name)
  return name
}

export function workspaceAgentUsesRegisteredDefinition(agent: unknown, name: string): boolean {
  return hasRuntimeType(agent, "object")
    && agent !== null
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    && Boolean((agent as RegisteredWorkspaceAgent)[registeredWorkspaceAgentNames]?.has(name))
}

export function workspaceAgentWithSourceRoot<Agent>(agent: Agent, sourceRootDir: string, colocatedInstructions?: string): Agent {
  if (!workspaceAgentOwnsWorkspaceDefinition(agent)) return agent

  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const workspaceAgent = agent as WorkspaceAgentDefinition
  const options = workspaceAgent.__vitehubWorkspaceAgentOptions
  const workspace = options.workspace
  if (!hasRuntimeType(workspace, "object") || workspace === null || isWorkspaceReference(workspace)) return agent
  // SAFETY: The string and named-reference variants returned above, leaving owned Workspace options.
  const ownedWorkspace = asUnknownBoundary(workspace) as WorkspaceAgentWorkspaceOptions

  const resolvedSourceRootDir = ownedWorkspace.sourceRootDir ?? workspaceAgent.sourceRootDir ?? sourceRootDir
  const sources = colocatedInstructions
    ? { __vitehubAgentInstructions: { content: colocatedInstructions, materialize: "build", mount: "", workspacePath: "AGENTS.md" }, ...ownedWorkspace.sources }
    : { ...ownedWorkspace.sources }
  const workspaceOptions = {
    ...options,
    workspace: {
      ...ownedWorkspace,
      ...(Object.keys(sources).length ? { sources } : {}),
      sourceRootDir: resolvedSourceRootDir,
    },
  }

  const decoratedAgent = {
    ...workspaceAgent,
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    ...workspaceDefinitionFromOptions(workspaceOptions as never),
    __vitehubWorkspaceAgentOptions: workspaceOptions,
  }
  inheritAgentCapacity(workspaceAgent, decoratedAgent)
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  return decoratedAgent as Agent
}

function assertWorkspaceReference(reference: { name: string }): void {
  if (!reference.name.trim()) {
    throw new TypeError("[vitehub] Workspace reference requires a non-empty string name.")
  }
  const unsupported = Object.keys(reference).filter(key => !workspaceReferenceKeys.has(key))
  if (unsupported.length) {
    throw new TypeError(`[vitehub] Workspace reference does not support option${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`)
  }
}

export function workspaceNameFromOptions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name> = {},
  identity?: AgentHostIdentity,
): Name | string {
  if (hasRuntimeType(options.workspace, "string")) return options.workspace
  if (isWorkspaceReference(options.workspace)) return options.workspace.name
  return options.name || identity?.workspace || identity?.name || defaults.workspace || defaults.name || defaultWorkspaceName
}

export function workspaceDefinitionFromOptions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
): WorkspaceAgentWorkspaceOptions {
  if (hasRuntimeType(options.workspace, "string")) {
    return withCapabilityWorkspaceSources({ mode: "read" }, staticAgentCapabilities(options.capabilities))
  }
  if (isWorkspaceReference(options.workspace)) {
    assertWorkspaceReference(options.workspace)
    return withCapabilityWorkspaceSources(
      normalizeWorkspaceOptions(options.workspace),
      staticAgentCapabilities(options.capabilities),
    )
  }
  const { commit: _commit, ...workspace } = normalizeWorkspaceOptions(options.workspace)
  const { mode: _mode, ...definition } = workspace
  assertWorkspaceDefinition(definition)
  return withColocatedAgentInstructions(withCapabilityWorkspaceSources(
    workspace,
    staticAgentCapabilities(options.capabilities),
  ))
}

function mergeWorkspaceCommitRules(rules: WorkspaceRules | undefined, commit: boolean | string): WorkspaceRules {
  const merged: WorkspaceRules = rules ? { ...rules } : {}
  if (!merged["**"]) merged["**"] = { commit, write: true }
  for (const [pattern, rule] of Object.entries(merged)) {
    if (rule.commit === undefined) merged[pattern] = { ...rule, commit }
  }
  return merged
}

function assertWorkspaceDefinition(definition: Record<string, unknown>): void {
  if (!definition || !hasRuntimeType(definition, "object")) {
    throw new TypeError("[vitehub] defineWorkspace requires a workspace definition.")
  }
  if ("name" in definition) {
    throw new TypeError("[vitehub] Workspace names are inferred from definition filenames.")
  }
  const unsupported = Object.keys(definition).filter(key => !workspaceDefinitionKeys.has(key))
  if (unsupported.length) {
    throw new TypeError(`[vitehub] defineWorkspace does not support option${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`)
  }
}

function withCapabilityWorkspaceSources(
  workspace: NormalizedWorkspaceOptions,
  capabilities: AgentCapabilityDefinition[] | undefined,
): NormalizedWorkspaceOptions {
  const contributed = capabilityWorkspaceSources(capabilities)
  if (!contributed) return workspace
  const sources = { ...workspace.sources }
  for (const [key, source] of Object.entries(contributed)) {
    if (key in sources) {
      throw new Error(`[vitehub] Workspace source "${key}" is already defined.`)
    }
    sources[key] = source
  }
  return {
    ...workspace,
    sources,
  }
}

function hasColocatedAgentInstructions(sourceRootDir: string | undefined): boolean {
  if (!sourceRootDir) return false
  const fs = getNodeBuiltin("node:fs")
  const path = getNodeBuiltin("node:path")
  if (!fs || !path) return false
  try {
    return fs.statSync(path.join(sourceRootDir, colocatedAgentInstructionsPath)).isFile()
  }
  catch {
    return false
  }
}

function withColocatedAgentInstructions(workspace: NormalizedWorkspaceOptions): NormalizedWorkspaceOptions {
  if (!hasColocatedAgentInstructions(workspace.sourceRootDir)) return workspace
  if (workspace.sources && colocatedAgentInstructionsSourceKey in workspace.sources) return workspace
  return {
    ...workspace,
    sources: {
      [colocatedAgentInstructionsSourceKey]: {
        materialize: "build",
        mount: "",
        path: colocatedAgentInstructionsPath,
        workspacePath: colocatedAgentInstructionsWorkspacePath,
      },
      ...workspace.sources,
    },
  }
}

function workspaceDefinitionWithNameFromOptions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name> = {},
  identity?: AgentHostIdentity,
): WorkspaceDefinition {
  const { mode: _mode, ...definition } = workspaceDefinitionFromOptions(options)
  return {
    ...definition,
    name: workspaceNameFromOptions(options, defaults, identity),
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
  return hasRuntimeType(value, "object")
    && value !== null
    && "workspace" in value
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    && (hasRuntimeType((value as { workspace?: unknown }).workspace, "string")
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      || (hasRuntimeType((value as { workspace?: unknown }).workspace, "object")
        // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
        && (value as { workspace?: unknown }).workspace !== null))
}

function modelDriverInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
): AgentAdapterInstructions<TRuntimeConfig, Name> | undefined {
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const driver = (asUnknownBoundary(options) as { driver?: unknown }).driver
  if (hasRuntimeType(driver, "object") && driver !== null) {
    return "model" in driver
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      ? (driver as { instructions?: AgentAdapterInstructions<TRuntimeConfig, Name> }).instructions
      : undefined
  }
  return undefined
}

function shouldUseColocatedAgentInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: WorkspaceAgentOptions<TRuntimeConfig, Name>): boolean {
  return modelDriverInstructions(options) === undefined
    && workspaceAgentDriverKind(options) === "model"
}

function workspaceAgentDriverKind<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: WorkspaceAgentOptions<TRuntimeConfig, Name>): AgentDriverKind {
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  return normalizeAgentDriver(options as AgentSettings<TRuntimeConfig>).kind
}

function workspaceShellMetadataCommands(mode: AgentCapabilityMode, sourceRequests = false) {
  const commands = mode === "write" ? writeCommands : readCommands
  return sourceRequests ? [...commands, ...sourceRequestCommands] : commands
}

function capabilityMetadataTool(capability: NormalizedCapability, options: { driverKind?: AgentDriverKind, sourceRequests?: boolean } = {}): AgentInspectionToolDefinition | undefined {
  if (capability.id === "workspace-shell") {
    const mode = normalizeMode(capability.mode, "Workspace Shell")
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    const configuredCommands = (capability.metadata as { commands?: unknown } | undefined)?.commands
    if (options.driverKind === "provider" && configuredCommands === undefined) return undefined
    const allCommands = configuredCommands === "all"
    const executableCommands = Array.isArray(configuredCommands)
      ? configuredCommands.map(command => `workspace_exec (${command})`)
      : allCommands ? ["workspace_exec (any Workspace Session executable)"] : []
    return {
      category: "workspace",
      commands: [
        ...(options.driverKind === "provider" ? [] : workspaceShellMetadataCommands(mode, options.sourceRequests)),
        ...executableCommands,
      ],
      description: allCommands
        ? `Run workspace ${mode === "write" ? "read and write" : "read"} operations and any executable in the Workspace Session.`
        : mode === "write"
          ? "Run curated workspace read and write shell operations."
          : "Run curated workspace read shell operations.",
      icon: "i-lucide-terminal",
      name: "workspaceShell",
      status: "available",
    }
  }
  if (capability.id === "gmail") {
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    const mode = (capability.metadata as { mode?: unknown } | undefined)?.mode
    return {
      category: "capability",
      commands: ["gmail_auth", "gmail_search", ...(mode === "draft" ? ["gmail_draft"] : [])],
      description: mode === "draft"
        ? "Authorize Gmail, search threads, and create unsent drafts."
        : "Authorize Gmail and search threads.",
      icon: "i-lucide-mail-search",
      name: "gmail",
      status: "available",
    }
  }
  if (capability.id === "sandbox") {
    return {
      category: "execution",
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
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

function capabilityMetadataTools(
  capabilities: readonly AgentCapabilityDefinition[],
  options: { driverKind?: AgentDriverKind, sourceRequests?: boolean } = {},
): AgentInspectionToolDefinition[] {
  return normalizeCapabilities(capabilities)
    .map(capability => capabilityMetadataTool(capability, options))
    .filter((tool): tool is AgentInspectionToolDefinition => Boolean(tool))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && hasRuntimeType(value, "object") && !Array.isArray(value)
}

function staticDriverExecutionAuthority(driver: { credentials?: unknown, kind: AgentDriverKind }): ExecutionAuthority {
  if (driver.kind !== "provider") return noExecutionAuthority
  return normalizeExecutionAuthority({
    credentials: driver.credentials === undefined ? "ambient" : "provisioned",
    environment: "selected",
    filesystem: { access: "read-write", scope: "host" },
    isolation: "none",
    network: "unrestricted",
    processes: "arbitrary",
  })
}

function resolvedDriverExecutionAuthority<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  driver: ReturnType<typeof normalizeAgentDriver<TRuntimeConfig, CALL_OPTIONS>>,
  runtime?: AgentRuntimeName,
): ExecutionAuthority {
  if (driver.kind === "model") return noExecutionAuthority
  if (driver.kind === "provider" && (runtime === "cloudflare-agents" || runtime === "deno")) return noExecutionAuthority
  return driver.kind === "provider" ? staticDriverExecutionAuthority(driver) : unknownExecutionAuthority
}

function agentSettings<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>, unknown, CALL_OPTIONS, TInvokerProfile>): AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile> | undefined {
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  return (definition as { __vitehubAgentSettings?: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile> }).__vitehubAgentSettings
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (hasRuntimeType(value, "string") && value.trim()) return value.trim()
  }
}

function modelProviderFromId(id: string | undefined): string | undefined {
  const provider = id?.split("/", 1)[0]?.trim()
  return provider && provider !== id ? provider : undefined
}

function modelMetadata(model: AgentModelInput | undefined, dynamic = false): AgentInspectionModelMetadata {
  if (model === undefined) return dynamic ? { dynamic: true } : {}
  const gateway = gatewayModelDescriptor(model)
  if (gateway) {
    const id = gateway.id.trim()
    const provider = modelProviderFromId(id)
    return {
      ...(dynamic ? { dynamic: true } : {}),
      ...(id ? { id, transport: "gateway" } : {}),
      ...(provider ? { provider } : {}),
    }
  }
  const record = isRecord(model) ? model : undefined
  const id = record ? stringField(record, ["modelId", "id", "model", "name"]) : undefined
  const rawProvider = record ? stringField(record, ["provider", "providerId"]) : undefined
  const transport = rawProvider === "gateway" ? "gateway" : undefined
  const provider = transport ? modelProviderFromId(id) : rawProvider || modelProviderFromId(id)
  return {
    ...(dynamic ? { dynamic: true } : {}),
    ...(id ? { id } : {}),
    ...(provider ? { provider } : {}),
    ...(transport ? { transport } : {}),
  }
}

function configValue(value: unknown): AgentInspectionConfigValue | undefined {
  if (value === null || hasRuntimeType(value, "boolean") || hasRuntimeType(value, "number") || hasRuntimeType(value, "string")) {
    return value
  }
}

function redactedConfigValue(key: string, value: unknown): AgentInspectionConfigValue | undefined {
  if (/(?:api[-_]?key|authorization|credential|password|secret|token)/i.test(key)) {
    return "[redacted]"
  }
  return configValue(value)
}

function callSettingsMetadata(value: unknown): Record<string, AgentInspectionConfigValue> | undefined {
  if (!isRecord(value)) return
  const entries = Object.entries(value)
    .flatMap(([key, setting]) => {
      const metadataValue = redactedConfigValue(key, setting)
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      return metadataValue === undefined ? [] : [[key, metadataValue] as const]
    })
  return entries.length ? Object.fromEntries(entries) : undefined
}

function workspaceFallbackMetadata(
  value: AgentInspectionModelExecutionMetadata["workspaceFallback"] | boolean | undefined,
): AgentInspectionModelExecutionMetadata["workspaceFallback"] | undefined {
  if (hasRuntimeType(value, "boolean")) return { enabled: value }
  if (!isRecord(value)) return
  const enabled = hasRuntimeType(value.enabled, "boolean") ? value.enabled : undefined
  const maxToolResults = hasRuntimeType(value.maxToolResults, "number") ? value.maxToolResults : undefined
  return enabled !== undefined || maxToolResults !== undefined
    ? {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(maxToolResults !== undefined ? { maxToolResults } : {}),
      }
    : undefined
}

function executionMetadata(value: AgentInspectionDriverMetadata["execution"] | undefined): AgentInspectionModelExecutionMetadata | undefined {
  if (!value) return
  const callSettings = callSettingsMetadata(value.callSettings)
  const workspaceFallback = workspaceFallbackMetadata(value.workspaceFallback)
  const stepLimit = hasRuntimeType(value.stepLimit, "number") ? value.stepLimit : undefined
  return callSettings || workspaceFallback || stepLimit !== undefined
    ? {
        ...(callSettings ? { callSettings } : {}),
        ...(stepLimit !== undefined ? { stepLimit } : {}),
        ...(workspaceFallback ? { workspaceFallback } : {}),
      }
    : undefined
}

function secretInspectionMetadataKey(key: string): boolean {
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
  return /(?:^|[-_])(?:api[-_]?key|auth(?:entication|orization)?|cookies?|credentials?|passwords?|private[-_]?key|secrets?|sessions?|signing[-_]?key|tokens?)(?:$|[-_])/i.test(normalized)
    || /^[A-Z0-9]+$/.test(key) && /(?:APIKEY|AUTH|COOKIE|CREDENTIAL|PASSWORD|PRIVATEKEY|SECRET|SESSION|SIGNINGKEY|TOKEN)/.test(key)
}

function inspectionMetadataValue(
  value: unknown,
  key = "",
  depth = 0,
  seen = new WeakSet<object>(),
): AgentInspectionValue | undefined {
  if (secretInspectionMetadataKey(key)) return "[redacted]"
  if (value === null || hasRuntimeType(value, "boolean") || hasRuntimeType(value, "string")) return value
  if (hasRuntimeType(value, "number")) return Number.isFinite(value) ? value : undefined
  if (!value || !hasRuntimeType(value, "object") || depth >= 8 || seen.has(value)) return

  seen.add(value)
  const resolved = Array.isArray(value)
    ? value.flatMap((item) => {
        const entry = inspectionMetadataValue(item, "", depth + 1, seen)
        return entry === undefined ? [] : [entry]
      })
    : Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
      ? Object.fromEntries(Object.entries(value)
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .flatMap(([entryKey, item]) => {
            const entry = inspectionMetadataValue(item, entryKey, depth + 1, seen)
            return entry === undefined ? [] : [[entryKey, entry]]
          }))
      : undefined
  seen.delete(value)
  if (!Array.isArray(resolved) && resolved && Object.keys(resolved).length === 0) return
  return resolved
}

function capabilityInspectionMetadata(
  capabilities: readonly AgentCapabilityDefinition[],
): AgentInspectionCapabilityMetadata[] {
  return normalizeCapabilities(capabilities)
    .flatMap((capability) => {
      const metadata = inspectionMetadataValue(capability.metadata)
      return isRecord(metadata) && Object.keys(metadata).length
        // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
        ? [{ id: capability.id, metadata: metadata as Record<string, AgentInspectionValue> }]
        : []
    })
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

function capabilityInspectionMetadataProjection(
  capabilities: readonly AgentCapabilityDefinition[] | undefined,
): Pick<AgentInspectionMetadata, "capabilities"> | Record<string, never> {
  const metadata = capabilityInspectionMetadata(capabilities || [])
  return metadata.length ? { capabilities: metadata } : {}
}

function providerMetadata(driver: { model?: string, permissions: AgentInspectionProviderMetadata["permissions"], provider: string }): AgentInspectionProviderMetadata {
  return {
    ...(driver.model ? { model: driver.model } : {}),
    permissions: driver.permissions,
    provider: driver.provider,
  }
}

function staticDriverMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(settings: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile> | undefined): AgentInspectionDriverMetadata | undefined {
  if (!settings) return { executionAuthority: unknownExecutionAuthority, kind: "unknown" }
  const driver = normalizeAgentDriver(settings)
  if (driver.kind === "model") {
    return {
      executionAuthority: noExecutionAuthority,
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      ...(driver.execution ? { execution: executionMetadata(driver.execution as never) } : {}),
      kind: "model",
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      model: modelMetadata(hasRuntimeType(driver.model, "function") ? undefined : driver.model as AgentModelInput, hasRuntimeType(driver.model, "function")),
    }
  }
  if (driver.kind === "provider") {
    return {
      executionAuthority: staticDriverExecutionAuthority(driver),
      kind: "provider",
      provider: providerMetadata(driver),
    }
  }
  return { executionAuthority: unknownExecutionAuthority, kind: "run" }
}

async function resolvedDriverMetadata<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
  CALL_OPTIONS = unknown,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(
  settings: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile> | undefined,
  context: AgentModelResolverContext<TRuntimeConfig, Name> & AgentRunCallbackContext<TRuntimeConfig, CALL_OPTIONS>,
): Promise<AgentInspectionDriverMetadata | undefined> {
  if (!settings) return
  const driver = normalizeAgentDriver(settings)
  if (driver.kind === "model") {
    const dynamic = hasRuntimeType(driver.model, "function")
    const model = dynamic
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      ? await (driver.model as (context: AgentModelResolverContext<TRuntimeConfig, Name>) => AgentModelInput | Promise<AgentModelInput>)(context)
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      : driver.model as AgentModelInput
    return {
      executionAuthority: noExecutionAuthority,
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      ...(driver.execution ? { execution: executionMetadata(driver.execution as never) } : {}),
      kind: "model",
      model: modelMetadata(model, dynamic),
    }
  }
  if (driver.kind === "provider") {
    return {
      executionAuthority: resolvedDriverExecutionAuthority(driver, context.runtime),
      kind: "provider",
      provider: providerMetadata(driver),
    }
  }
  return { executionAuthority: unknownExecutionAuthority, kind: "run" }
}

function staticConfigMetadata<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): AgentInspectionConfigMetadata | undefined {
  const settings = agentSettings(definition)
  const driver = staticDriverMetadata(settings)
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const capacity = inspectAgentCapacity(definition as object)
  const uiMessageStream = hasRuntimeType(settings?.uiMessageStream, "function")
    ? undefined
    : settings?.uiMessageStream
  return driver ? { driver: { ...driver, ...(capacity ? { capacity } : {}) }, ...(uiMessageStream ? { uiMessageStream } : {}) } : undefined
}

async function resolvedUiMessageStreamProjection<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentModelResolverContext<TRuntimeConfig, Name> & AgentRunCallbackContext<TRuntimeConfig>,
): Promise<AgentUIMessageStreamProjection | undefined> {
  const uiMessageStream = agentSettings(definition)?.uiMessageStream
  return hasRuntimeType(uiMessageStream, "function")
    ? await uiMessageStream(context)
    : uiMessageStream
}

async function resolvedConfigMetadata<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentModelResolverContext<TRuntimeConfig, Name> & AgentRunCallbackContext<TRuntimeConfig>,
): Promise<AgentInspectionConfigMetadata | undefined> {
  const driver = await resolvedDriverMetadata(agentSettings(definition), context)
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const capacity = inspectAgentCapacity(definition as object)
  const uiMessageStream = await resolvedUiMessageStreamProjection(definition, context)
  return driver ? { driver: { ...driver, ...(capacity ? { capacity } : {}) }, ...(uiMessageStream ? { uiMessageStream } : {}) } : undefined
}

function agentInspectionMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  definition: Pick<AgentDefinition<TRuntimeConfig, CALL_OPTIONS>, "invoker" | "version"> & AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): Pick<AgentInspectionMetadata, "config" | "invokerProfiles" | "version"> {
  const invokerProfiles = normalizeAgentInvokerProfiles(definition.invoker?.profiles)
  const config = staticConfigMetadata(definition)
  return {
    ...(config ? { config } : {}),
    ...(invokerProfiles.length ? { invokerProfiles } : {}),
    ...(definition.version ? { version: definition.version } : {}),
  }
}

function agentChannelMetadataInstructions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): string[] {
  const settings = agentSettings(definition)
  if (!settings || normalizeAgentDriver(settings).kind === "run") return []
  return inspectMessageChannelInstructions(definition.channels)
}

function normalizedSourcesFromOptions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: WorkspaceAgentOptions<TRuntimeConfig, Name>): WorkspaceSourceMetadata[] {
  return normalizeWorkspaceSourcesMetadata(workspaceDefinitionFromOptions(options).sources)
}

function sourceMountPath(source: WorkspaceSourceMetadata) {
  return source.mountPath
}

function sourceMaterialize(source: WorkspaceSourceMetadata): AgentInspectionFileTreeItem["materialize"] {
  return source.materialize === "none" ? undefined : source.materialize
}

function workspaceMetadataFiles<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  context?: AgentInvocationContextStore,
): AgentInspectionFileTreeItem[] {
  const access = context && hasTrustedWorkspaceAccessScope(context)
    ? context.get("access")
    : undefined
  const scope = access?.workspaceScope
  const pathIntersects = (left: string, right: string) => !left || !right || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  const sources = normalizedSourcesFromOptions(options).filter(source => {
    if (!scope || scope.all || scope.sources?.includes(source.key)) return true
    const grantPaths = source.requestOnly || source.probeKeys?.length || source.mountPath
      ? workspaceSourceGrantPaths(source.key, source)
      : []
    return scope.paths?.some(path => grantPaths.some(grantPath => pathIntersects(path, grantPath)))
  })
  return sources.sort((left, right) => left.key.localeCompare(right.key)).map((source) => {
    const materialize = sourceMaterialize(source)
    const mountPath = sourceMountPath(source)
    return {
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      kind: "directory" as const,
      label: mountPath.split("/").filter(Boolean).at(-1) || source.key,
      materialize,
      materialized: materialize === "build",
      path: mountPath,
      source: source.key,
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      status: materialize === "lazy" ? "lazy" as const : "ready" as const,
    }
  })
}

interface NodeBuiltinModuleMap {
  "node:fs": typeof import("node:fs")
  "node:path": typeof import("node:path")
}

function getNodeBuiltin<TKey extends keyof NodeBuiltinModuleMap>(name: TKey): NodeBuiltinModuleMap[TKey] | undefined
function getNodeBuiltin(name: string): unknown
function getNodeBuiltin(name: string): unknown {
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const process = globalThis.process as { getBuiltinModule?: (name: string) => unknown } | undefined
  try {
    return process?.getBuiltinModule?.(name)
  }
  catch {
    return undefined
  }
}

function resolveInstructionImportFromFile(specifier: string, importer: string): { content: string, file: string } {
  const fs = getNodeBuiltin("node:fs")
  const path = getNodeBuiltin("node:path")
  if (!fs || !path) {
    throw new Error(`[vitehub] Instruction import "${specifier}" requires local filesystem access.`)
  }
  const file = path.resolve(path.dirname(importer), specifier)
  return {
    content: fs.readFileSync(file, "utf8"),
    file,
  }
}

export async function resolveInstructionDocumentImports(content: string, file: string): Promise<string> {
  return await resolveInstructionImports(content, {
    file,
    read: resolveInstructionImportFromFile,
  })
}

export async function resolveColocatedAgentInstructionDocument(content: string, sourceRootDir: string | undefined): Promise<string> {
  const fs = getNodeBuiltin("node:fs")
  const path = getNodeBuiltin("node:path")
  if (!fs || !path || !sourceRootDir || !hasColocatedAgentInstructions(sourceRootDir)) return content
  return await resolveInstructionDocumentImports(content, path.join(sourceRootDir, colocatedAgentInstructionsPath))
}

async function composeInstructions(
  content: string,
  context?: AgentInvocationContextStore,
  workspace?: Record<string, unknown>,
  coverage?: ReturnType<typeof createInstructionCoverage>,
): Promise<string> {
  return await composeInstructionDocument(content, { context: context?.toJSON(), coverage, workspace })
}

export async function resolveWorkspaceInstructionBindings(
  definition: WorkspaceDefinition | undefined,
  workspace: ReadonlyWorkspaceFacade | undefined,
): Promise<Record<string, unknown> | undefined> {
  const bindings = definition?.bindings
  if (!bindings) return
  const resolved: Record<string, unknown> = {}
  for (const [key, binding] of Object.entries(bindings)) {
    if (key === "sources") {
      throw new Error("[vitehub] Workspace instruction binding \"sources\" is reserved. Cover Sources with ::source blocks in Agent Driver Instructions.")
    }
    if (!/^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*$/.test(key)) {
      throw new TypeError(`[vitehub] Workspace instruction binding "${key}" must be addressable as workspace.${key}.`)
    }
    if (binding === null || hasRuntimeType(binding, "string") || hasRuntimeType(binding, "number") || hasRuntimeType(binding, "boolean")) {
      resolved[key] = binding
      continue
    }
    if (binding && hasRuntimeType(binding, "object") && hasRuntimeType(binding.path, "string")) {
      if (!workspace) throw new Error(`[vitehub] Workspace instruction binding "${key}" requires Workspace access.`)
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      resolved[key] = await workspace.fs.readFile(binding.path as never)
      continue
    }
    throw new TypeError(`[vitehub] Workspace instruction binding "${key}" must be a scalar value or { path }.`)
  }
  return Object.keys(resolved).length ? resolved : undefined
}

function localWorkspaceRoots<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: WorkspaceAgentOptions<TRuntimeConfig, Name>): string[] {
  const fs = getNodeBuiltin("node:fs")
  const path = getNodeBuiltin("node:path")
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
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

function addFileTreePath(root: AgentInspectionFileTreeItem, entry: WorkspaceEntry) {
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

function sortFileTree(item: AgentInspectionFileTreeItem) {
  item.children?.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1
    return (left.label || left.path).localeCompare(right.label || right.path)
  })
  for (const child of item.children || []) sortFileTree(child)
}

function markSourceTreeMetadata(
  root: AgentInspectionFileTreeItem,
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

function propagateMaterializedDirectories(item: AgentInspectionFileTreeItem): boolean {
  const childMaterialized = (item.children || []).map(propagateMaterializedDirectories)
  if (item.kind === "directory" && item.materialize === "lazy" && childMaterialized.some(Boolean)) {
    item.materialized = true
  }
  return Boolean(item.materialized || item.materializedAt || childMaterialized.some(Boolean))
}

function clearReadyMaterializationHints(item: AgentInspectionFileTreeItem) {
  if (item.materialized || item.materializedAt || item.status === "ready") {
    delete item.materialize
  }
  for (const child of item.children || []) clearReadyMaterializationHints(child)
}

async function resolveWorkspaceMetadataFiles<Name extends WorkspaceName>(
  options: WorkspaceAgentOptions<AgentRuntimeConfig, Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
): Promise<AgentInspectionFileTreeItem[]> {
  const root: AgentInspectionFileTreeItem = {
    children: [],
    kind: "directory",
    label: "",
    path: "",
  }
  const entries = await workspace.fs.list("", { recursive: true })
  for (const entry of entries) {
    addFileTreePath(root, entry)
  }
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  markSourceTreeMetadata(root, asUnknownBoundary(options) as WorkspaceAgentOptions<AgentRuntimeConfig, WorkspaceName>)
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
  toolOptions: { sourceRequests?: boolean } = {},
): AgentInspectionToolDefinition[] {
  const driverKind = workspaceAgentDriverKind(options)
  return capabilityMetadataTools(staticAgentCapabilities(options.capabilities), { ...toolOptions, driverKind })
}

async function workspaceHasSourceRequestDescriptors<Name extends WorkspaceName>(
  workspace: ReadonlyWorkspaceFacade<Name>,
): Promise<boolean> {
  try {
    const entries = await workspace.fs.list(".vitehub/sources")
    return entries.some(entry =>
      entry.type === "file"
      && entry.path.startsWith(".vitehub/sources/")
      && entry.path.endsWith(".json"),
    )
  }
  catch {
    return false
  }
}

async function resolveWorkspaceMetadataTools<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
): Promise<AgentInspectionToolDefinition[]> {
  return workspaceMetadataTools(options, {
    sourceRequests: await workspaceHasSourceRequestDescriptors(workspace),
  })
}

function workspaceMetadataInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  resolveLocalInstructions = true,
): string[] {
  const configuredInstructions = modelDriverInstructions(options)
  const defaultInstructions = shouldUseColocatedAgentInstructions(options)
    ? readColocatedAgentInstructionsRaw(options)
    : undefined
  const parts = Array.isArray(configuredInstructions) ? configuredInstructions : [configuredInstructions]
  const instructions = parts.flatMap((part) => {
    if (hasRuntimeType(part, "string") && part.trim().length > 0) return [part]
    if (hasRuntimeType(part, "function")) {
      const localInstructions = resolveLocalInstructions ? readLocalWorkspaceInstructions(options) : undefined
      if (localInstructions) return [localInstructions]
      return ["Dynamic system instructions resolver configured."]
    }
    return []
  })
  if (defaultInstructions) instructions.unshift(defaultInstructions)
  const content = instructions.join("\n\n").trim()
  return content ? [content] : []
}

async function staticWorkspaceMetadataInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  definition: WorkspaceDefinition,
  context: AgentInvocationContextStore,
): Promise<{ instructions: string[], warnings: AgentInspectionWarning[] }> {
  const instructions = workspaceMetadataInstructions(options, false)
  const coverage = await collectStaticInstructionCoverage(instructions.join("\n\n"))
  const configuredInstructions = modelDriverInstructions(options)
  const hasDynamicInstructions = (Array.isArray(configuredInstructions) ? configuredInstructions : [configuredInstructions])
    .some(instruction => hasRuntimeType(instruction, "function"))
  const visibleSources = new Set(workspaceMetadataFiles(options, context).map(file => file.source).filter(Boolean))
  const visibleDefinition = definition.sources
    ? {
        ...definition,
        sources: Object.fromEntries(Object.entries(definition.sources).filter(([key]) => visibleSources.has(key))),
      }
    : definition
  return {
    instructions,
    warnings: hasDynamicInstructions
      ? []
      : instructionCoverageWarnings(coverage, visibleDefinition, staticAgentCapabilities(options.capabilities), workspaceAgentDriverKind(options)),
  }
}

function readLocalWorkspaceInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: WorkspaceAgentOptions<TRuntimeConfig, Name>): string | undefined {
  const fs = getNodeBuiltin("node:fs")
  const path = getNodeBuiltin("node:path")
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

function readColocatedAgentInstructionsRaw<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: WorkspaceAgentOptions<TRuntimeConfig, Name>): string | undefined {
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const embedded = workspaceDefinitionFromOptions(options).sources?.[colocatedAgentInstructionsSourceKey] as {
    content?: unknown
    source?: { content?: unknown }
  } | undefined
  const embeddedContent = embedded?.content ?? embedded?.source?.content
  if (hasRuntimeType(embeddedContent, "string") && embeddedContent.trim()) return embeddedContent.trim()

  const fs = getNodeBuiltin("node:fs")
  const path = getNodeBuiltin("node:path")
  const sourceRootDir = workspaceDefinitionFromOptions(options).sourceRootDir
  if (!fs || !path || !hasColocatedAgentInstructions(sourceRootDir)) return undefined
  const file = path.join(sourceRootDir!, colocatedAgentInstructionsPath)
  const content = fs.readFileSync(file, "utf8").trim()
  if (content) return content
}

export async function resolveWorkspaceAgentDefaultInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
): Promise<string | undefined> {
  if (!shouldUseColocatedAgentInstructions(options)) return undefined
  const definition = workspaceDefinitionFromOptions(options)
  if (!definition.sources || !(colocatedAgentInstructionsSourceKey in definition.sources)) return undefined
  let content: string | undefined
  try {
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    content = (await workspace.fs.readFile(colocatedAgentInstructionsWorkspacePath as never)).trim()
  }
  catch {}
  if (!content) return undefined

  const fs = getNodeBuiltin("node:fs")
  const path = getNodeBuiltin("node:path")
  const sourceRootDir = definition.sourceRootDir
  if (fs && path && sourceRootDir && hasColocatedAgentInstructions(sourceRootDir)) {
    return await resolveColocatedAgentInstructionDocument(content, sourceRootDir)
  }
  return content
}

async function resolveWorkspaceMetadataInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
  resolution: AgentInspectionMetadataResolutionOptions<TRuntimeConfig, Name> = {},
  sourceDefinition: WorkspaceDefinition = workspaceDefinitionWithNameFromOptions(options, resolution),
  compositionContext?: AgentInvocationContextStore,
): Promise<{ instructions: string[], warnings: AgentInspectionWarning[] }> {
  const instructionContext = {
    fs: workspace.fs,
    workspace,
  }
  const configuredInstructions = modelDriverInstructions(options)
  const defaultInstructions = shouldUseColocatedAgentInstructions(options)
    ? await resolveWorkspaceAgentDefaultInstructions(options, workspace)
    : undefined
  const parts = Array.isArray(configuredInstructions) ? configuredInstructions : [configuredInstructions]
  const instructions = await Promise.all(parts.map(part => hasRuntimeType(part, "function")
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    ? part(instructionContext as never)
    : part))
  const baseInstructions = instructions
    .flatMap(part => Array.isArray(part) ? part : [part])
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part))
  if (defaultInstructions) baseInstructions.unshift(defaultInstructions)
  const workspaceBindings = await resolveWorkspaceInstructionBindings(sourceDefinition, workspace)
  const coverage = createInstructionCoverage()
  const composed = await composeInstructions(baseInstructions.join("\n\n"), compositionContext, workspaceBindings, coverage)
  return {
    instructions: composed ? [composed] : [],
    warnings: instructionCoverageWarnings(coverage, sourceDefinition, staticAgentCapabilities(options.capabilities), workspaceAgentDriverKind(options)),
  }
}

function instructionCoverageWarnings(
  coverage: ReturnType<typeof createInstructionCoverage>,
  definition: WorkspaceDefinition | undefined,
  capabilities: readonly AgentCapabilityDefinition[] | undefined,
  driverKind: AgentDriverKind,
): AgentInspectionWarning[] {
  return [
    ...sourceCoverageWarnings(coverage, definition),
    ...capabilityCoverageWarnings(coverage, capabilities),
    ...(driverKind === "provider" ? [] : skillCoverageWarnings(coverage, capabilities)),
  ]
}

function warning(id: string, primitive: AgentInspectionWarning["primitive"], message: string): AgentInspectionWarning {
  return { id, kind: "instruction-coverage", message, primitive, severity: "warning" }
}

function sourceCoverageWarnings(
  coverage: ReturnType<typeof createInstructionCoverage>,
  definition: WorkspaceDefinition | undefined,
): AgentInspectionWarning[] {
  return normalizeWorkspaceSourcesMetadata(definition?.sources)
    .filter(source => source.key !== colocatedAgentInstructionsSourceKey)
    .filter(source => !coverage.sources.has(source.key))
    .map(source => warning(
      `instruction-coverage:source:${source.key}`,
      "source",
      `Source "${source.key}" is configured but not covered by Agent Driver Instructions. Add ::source{key="${source.key}"} around the relevant instruction section.`,
    ))
}

function capabilityCoverageKeys(id: string): string[] {
  return [...new Set([id, id.replace(/-([a-z])/g, (_, value: string) => value.toUpperCase())])]
}

function capabilityCoverageWarnings(
  coverage: ReturnType<typeof createInstructionCoverage>,
  capabilities: readonly AgentCapabilityDefinition[] | undefined,
): AgentInspectionWarning[] {
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  return normalizeCapabilities(capabilities as AgentCapabilityDefinition[] | undefined)
    .filter(capability => capability.id !== "skills" && !capability.id.startsWith("skills."))
    .filter(capability => !capabilityCoverageKeys(capability.id).some(key => coverage.capabilities.has(key)))
    .map(capability => warning(
      `instruction-coverage:capability:${capability.id}`,
      "capability",
      `Capability "${capability.id}" is configured but not covered by Agent Driver Instructions. Add ::capability{key="${capabilityCoverageKeys(capability.id).at(-1)}"} around the relevant instruction section.`,
    ))
}

function skillCoveragePath(value: unknown): string | undefined {
  if (!hasRuntimeType(value, "string") || !value.trim()) return
  return value.trim().replace(/\/+$/, "").replace(/\/SKILL\.md$/, "") || "."
}

function skillCoverageWarnings(
  coverage: ReturnType<typeof createInstructionCoverage>,
  capabilities: readonly AgentCapabilityDefinition[] | undefined,
): AgentInspectionWarning[] {
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  return normalizeCapabilities(capabilities as AgentCapabilityDefinition[] | undefined)
    .filter(capability => capability.id === "skills" || capability.id.startsWith("skills."))
    .flatMap((capability) => {
      const metadata = capability.metadata || {}
      const path = skillCoveragePath(metadata.path) || skillCoveragePath(metadata.skillPath)
      if (!path) return []
      const skillPath = skillCoveragePath(metadata.skillPath)
      const covered = [path, skillPath].filter((value): value is string => Boolean(value)).some(value => coverage.skills.has(value) || coverage.skills.has(`${value}/SKILL.md`))
      return covered
        ? []
        : [warning(
            `instruction-coverage:skill:${path}`,
            "skill",
            `Skill "${path}" is configured but not covered by Agent Driver Instructions. Add ::skill{path="${path}"} around the relevant instruction section.`,
          )]
    })
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

function hasAccessCapability(capabilities: readonly AgentCapabilityDefinition[]): boolean {
  return normalizeCapabilities(capabilities)
    .some(capability => capability.id === "access")
}

async function createInspectionMetadataWorkspace<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  definition: Partial<WorkspaceAgentDefinition<TRuntimeConfig, Name>>,
  defaultsOverride: AgentInspectionMetadataResolutionOptions<TRuntimeConfig, Name> = {},
  selection: {
    capabilities: readonly AgentCapabilityDefinition[]
    invocationContext: AgentInvocationContextStore
  },
) {
  const defaults = {
    ...(hasRuntimeType(definition.name, "string") ? { name: definition.name } : {}),
    ...defaultsOverride,
  }
  if (!definition.__vitehubWorkspaceAgentOptions) return
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const options = asUnknownBoundary(definition.__vitehubWorkspaceAgentOptions) as WorkspaceAgentOptions<TRuntimeConfig, Name>
  const workspaceName = workspaceNameFromOptions(options, defaults, defaultsOverride.runtime?.agentIdentity)

  const { createWorkspaceSourceResolutionFacade, hasWorkspaceSourceResolvers, useWorkspace } = await import("@vite-hub/workspace/runtime")
  const workspace = useWorkspace(workspaceName)
  const workspaceDefinition = workspaceDefinitionWithNameFromOptions(options, defaults, defaultsOverride.runtime?.agentIdentity)

  if (defaultsOverride.resolveSources === false) {
    return { options, workspace }
  }

  if (hasAccessCapability(selection.capabilities)) {
    return { options, workspace }
  }

  if (!hasWorkspaceSourceResolvers(workspaceDefinition)) {
    return { options, workspace }
  }

  const resolved = await createWorkspaceSourceResolutionFacade(workspace, workspaceDefinition, {
    invocation: {
      context: agentInvocationSourceContext(selection.invocationContext),
    },
  })

  return {
    options: workspaceOptionsFromDefinition(options, resolved.definition),
    workspace: resolved.workspace,
  }
}

function createInspectionMetadataRuntime<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  resolution: AgentInspectionMetadataResolutionOptions<TRuntimeConfig, Name>,
): ResolvedAgentRuntimeContext<TRuntimeConfig> {
  const runtime = resolution.runtime || {}
  return {
    ...runtime,
    memo: runtime.memo || ((_key, create) => create()),
    runtime: runtime.runtime || "unknown",
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
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

async function resolveMetadataCapabilitySelection<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  settings: Pick<WorkspaceAgentOptions<TRuntimeConfig, Name>, "capabilities" | "driver" | "invoker">,
  resolution: AgentInspectionMetadataResolutionOptions<TRuntimeConfig, Name>,
): Promise<MetadataCapabilitySelection<TRuntimeConfig, Name>> {
  const runtime = createInspectionMetadataRuntime(resolution)
  const input = resolution.input || { messages: [] }
  const invocationContext: AgentInvocationContextStore = createAgentInvocationContextStore(input.context)
  const callbackContext = agentCallbackContext(runtime)
  const invoker = await resolveAgentInvoker(
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    settings.invoker as never,
    callbackContext,
    invocationContext,
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    input as never,
    runtime.run,
  )
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const driverKind = normalizeAgentDriver(settings as AgentSettings<TRuntimeConfig>).kind
  const capabilities = await resolveAgentCapabilityDefinitions(settings.capabilities, {
    ...agentInvocationCallbackContextValues(invocationContext),
    ...callbackContext,
    abortSignal: input.abortSignal,
    actor: invoker,
    context: invocationContext,
    driver: { kind: driverKind },
    input,
    invoker,
    run: runtime.run,
  })

  return {
    capabilities,
    driverKind,
    input,
    invocationContext,
    invoker,
    runtime,
  }
}

async function resolveWorkspaceMetadataCapabilityContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
  resolution: AgentInspectionMetadataResolutionOptions<TRuntimeConfig, Name>,
  selection: MetadataCapabilitySelection<TRuntimeConfig, Name>,
) {
  const { capabilities: capabilityDefinitions, driverKind, input, invocationContext, invoker, runtime } = selection
  const workspaceDefinition = workspaceDefinitionWithNameFromOptions(options, resolution, resolution.runtime?.agentIdentity)
  if (resolution.resolveSources === false) {
    markTrustedSourceFreeInspection(invocationContext)
  }
  const capabilities = await resolveAgentCapabilities({
    capabilities: capabilityDefinitions,
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    hooks: options.hooks as never,
  }, runtime, input, workspace, workspaceModeFromOptions(options), {
    context: invocationContext,
    driverKind,
    invoker,
    phases: ["prepare"],
    resolveTools: false,
    workspaceDefinition,
  })
  const sourceResolvedDefinition = invocationContext.get("workspace.sourceResolution.definition")
  const metadataWorkspace = capabilities.workspace || workspace
  const resolvedDefinition = capabilities.workspaceDefinition || sourceResolvedDefinition || workspaceDefinition

  return {
    close: capabilities.close,
    definition: resolvedDefinition,
    metadataContext: {
      ...agentInvocationCallbackContextValues(invocationContext),
      ...agentCallbackContext(runtime),
      abortSignal: input.abortSignal,
      actor: invoker,
      context: invocationContext,
      driver: { kind: driverKind },
      fs: metadataWorkspace.fs,
      input,
      invoker,
      runtimeConfig: runtime.runtimeConfig,
      workspace: metadataWorkspace,
    } satisfies AgentModelResolverContext<TRuntimeConfig, Name> & AgentRunCallbackContext<TRuntimeConfig>,
    options: {
      ...workspaceOptionsFromDefinition(options, resolvedDefinition),
      capabilities: capabilityDefinitions,
    },
    workspace: metadataWorkspace,
  }
}

async function withMetadataCapabilityCleanup<T>(
  context: { close: () => Promise<void> },
  resolve: () => Promise<T>,
): Promise<T> {
  let value: T
  try {
    value = await resolve()
  }
  catch (error) {
    try {
      await context.close()
    }
    catch (closeError) {
      throw new AggregateError([error, closeError], "[vitehub] Agent inspection metadata resolution failed and Capability cleanup also failed.")
    }
    throw error
  }
  await context.close()
  return value
}

async function resolveNonWorkspaceAgentInspectionMetadata<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  resolution: AgentInspectionMetadataResolutionOptions<TRuntimeConfig, Name>,
): Promise<AgentInspectionMetadata> {
  const settings = agentSettings(definition)
  if (!settings) {
    const definedChannelInstructions = inspectMessageChannelInstructions(definition.channels)
    const capabilities = capabilityInspectionMetadataProjection(definition.capabilities)
    if (!definedChannelInstructions.length) {
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      return { ...capabilities, files: [], ...agentInspectionMetadata(definition as never), tools: [] }
    }
    const adapter = await definition.resolve(createInspectionMetadataRuntime(resolution))
    const channelInstructions = consumesMessageChannelInstructions(adapter)
      ? definedChannelInstructions
      : []
    return {
      ...capabilities,
      files: [],
      ...(channelInstructions.length ? { instructions: channelInstructions } : {}),
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      ...agentInspectionMetadata(definition as never),
      tools: [],
    }
  }
  const channelInstructions = agentChannelMetadataInstructions(definition)

  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const selection = await resolveMetadataCapabilitySelection(settings as never, resolution)
  validateAgentCapabilityComposition(selection.capabilities, {
    hasWorkspace: false,
  })
  const capabilities = await resolveAgentCapabilities({
    capabilities: selection.capabilities,
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    hooks: settings.hooks as never,
  }, selection.runtime, selection.input, undefined, "read", {
    context: selection.invocationContext,
    driverKind: selection.driverKind,
    invoker: selection.invoker,
    phases: ["prepare"],
    resolveTools: false,
  })
  return await withMetadataCapabilityCleanup(capabilities, async () => {
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    const context = {
      ...agentInvocationCallbackContextValues(selection.invocationContext),
      ...agentCallbackContext(selection.runtime),
      abortSignal: selection.input.abortSignal,
      actor: selection.invoker,
      context: selection.invocationContext,
      driver: { kind: selection.driverKind },
      input: selection.input,
      invoker: selection.invoker,
      runtimeConfig: selection.runtime.runtimeConfig,
    } as AgentModelResolverContext<TRuntimeConfig, Name> & AgentRunCallbackContext<TRuntimeConfig>
    const staticConfig = staticConfigMetadata(definition)
    const uiMessageStream = await resolvedUiMessageStreamProjection(definition, context)
    const config = staticConfig && {
      driver: {
        ...staticConfig.driver,
        executionAuthority: resolvedDriverExecutionAuthority(normalizeAgentDriver(settings), selection.runtime.runtime),
      },
      ...(uiMessageStream ? { uiMessageStream } : {}),
    }
    return {
      ...capabilityInspectionMetadataProjection(selection.capabilities),
      files: [],
      ...(channelInstructions.length ? { instructions: channelInstructions } : {}),
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      ...agentInspectionMetadata(definition as never),
      ...(config ? { config } : {}),
      tools: capabilityMetadataTools(selection.capabilities, { driverKind: selection.driverKind }),
    }
  })
}

export function createAgentInspectionMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): AgentInspectionMetadata {
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig, Name>>
  const channelInstructions = agentChannelMetadataInstructions(definition)
  if (!workspaceDefinition.__vitehubWorkspaceAgent || !workspaceDefinition.__vitehubWorkspaceAgentOptions) {
    const capabilities = agentSettings(definition)?.capabilities || definition.capabilities
    return {
      ...capabilityInspectionMetadataProjection(Array.isArray(capabilities) ? capabilities : undefined),
      files: [],
      ...(channelInstructions.length ? { instructions: channelInstructions } : {}),
      ...agentInspectionMetadata(definition),
      tools: [],
    }
  }

  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const options = asUnknownBoundary(workspaceDefinition.__vitehubWorkspaceAgentOptions) as WorkspaceAgentOptions<TRuntimeConfig, Name>
  return {
    ...capabilityInspectionMetadataProjection(Array.isArray(options.capabilities) ? options.capabilities : undefined),
    files: workspaceMetadataFiles(options),
    instructions: [...workspaceMetadataInstructions(options), ...channelInstructions],
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    ...agentInspectionMetadata(workspaceDefinition as AgentDefinition<TRuntimeConfig>),
    tools: workspaceMetadataTools(options),
  }
}

export function createInvocationInspectionMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  capabilities: readonly AgentCapabilityDefinition<TRuntimeConfig, Name>[],
  tools: readonly string[],
  resolvedModel?: AgentModelInput,
  resolvedInstructions?: string,
): AgentInspectionMetadata {
  const capabilityMetadata = new Map(capabilityInspectionMetadata(capabilities).map(capability => [capability.id, capability]))
  const inspection = createAgentInspectionMetadata(definition)
  const driver = inspection.config?.driver
  return {
    ...inspection,
    capabilities: normalizeCapabilities(capabilities).map(capability => capabilityMetadata.get(capability.id) || { id: capability.id, metadata: {} }),
    ...(driver && resolvedModel !== undefined
      ? { config: { ...inspection.config, driver: { ...driver, model: modelMetadata(resolvedModel, true) } } }
      : {}),
    ...(resolvedInstructions !== undefined ? { instructions: resolvedInstructions ? [resolvedInstructions] : [] } : {}),
    tools: tools.map(name => ({ name })),
  }
}

export async function resolveAgentInspectionMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  defaultsOverride: AgentInspectionMetadataResolutionOptions<TRuntimeConfig, Name> = {},
): Promise<AgentInspectionMetadata> {
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig, Name>>
  if (!workspaceDefinition.__vitehubWorkspaceAgent || !workspaceDefinition.__vitehubWorkspaceAgentOptions) {
    return await resolveNonWorkspaceAgentInspectionMetadata(definition, defaultsOverride)
  }

  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const workspaceOptions = asUnknownBoundary(workspaceDefinition.__vitehubWorkspaceAgentOptions) as WorkspaceAgentOptions<TRuntimeConfig, Name>
  const selection = await resolveMetadataCapabilitySelection(workspaceOptions, defaultsOverride)
  validateAgentCapabilityComposition(selection.capabilities, {
    hasWorkspace: true,
    workspaceMode: workspaceModeFromOptions(workspaceOptions),
  })
  const metadataWorkspace = await createInspectionMetadataWorkspace(workspaceDefinition, defaultsOverride, selection)
  if (!metadataWorkspace) {
    return createAgentInspectionMetadata(definition)
  }
  const capabilityContext = await resolveWorkspaceMetadataCapabilityContext(
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    metadataWorkspace.options as never,
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    metadataWorkspace.workspace as never,
    defaultsOverride,
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    selection as never,
  )
  return await withMetadataCapabilityCleanup(capabilityContext, async () => {
    const config = await resolvedConfigMetadata(
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      workspaceDefinition as AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
      capabilityContext.metadataContext,
    )
    const instructionMetadata = defaultsOverride.resolveSources === false
      ? await staticWorkspaceMetadataInstructions(
          // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
          capabilityContext.options as never,
          capabilityContext.definition,
          capabilityContext.metadataContext.context,
        )
      : await resolveWorkspaceMetadataInstructions(
          // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
          capabilityContext.options as never,
          // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
          capabilityContext.workspace as never,
          defaultsOverride,
          capabilityContext.definition,
          capabilityContext.metadataContext.context,
        )

    return {
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      ...capabilityInspectionMetadataProjection(capabilityContext.options.capabilities as AgentCapabilityDefinition[]),
      files: defaultsOverride.resolveSources === false
        // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
        ? workspaceMetadataFiles(capabilityContext.options as never, capabilityContext.metadataContext.context)
        // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
        : await resolveWorkspaceMetadataFiles(capabilityContext.options as never, capabilityContext.workspace as never),
      instructions: [
        ...instructionMetadata.instructions,
        // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
        ...agentChannelMetadataInstructions(workspaceDefinition as AgentInput<AgentRuntimeContext<TRuntimeConfig>>),
      ],
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      ...agentInspectionMetadata(workspaceDefinition as AgentDefinition<TRuntimeConfig>),
      ...(config ? { config } : {}),
      tools: defaultsOverride.resolveSources === false
        // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
        ? workspaceMetadataTools(capabilityContext.options as never)
        // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
        : await resolveWorkspaceMetadataTools(capabilityContext.options as never, capabilityContext.workspace as never),
      ...(instructionMetadata.warnings.length ? { warnings: instructionMetadata.warnings } : {}),
    }
  })
}

export async function materializeAgentInspectionSourceMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  definition: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  options: AgentInspectionSourceMaterializationOptions<TRuntimeConfig, Name> = {},
): Promise<AgentInspectionMetadata> {
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const workspaceDefinition = definition as Partial<WorkspaceAgentDefinition<TRuntimeConfig, Name>>
  if (!workspaceDefinition.__vitehubWorkspaceAgent || !workspaceDefinition.__vitehubWorkspaceAgentOptions) {
    return await resolveNonWorkspaceAgentInspectionMetadata(definition, options)
  }

  const resolution = { ...options, resolveSources: true }
  // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
  const workspaceOptions = asUnknownBoundary(workspaceDefinition.__vitehubWorkspaceAgentOptions) as WorkspaceAgentOptions<TRuntimeConfig, Name>
  const selection = await resolveMetadataCapabilitySelection(workspaceOptions, resolution)
  validateAgentCapabilityComposition(selection.capabilities, {
    hasWorkspace: true,
    workspaceMode: workspaceModeFromOptions(workspaceOptions),
  })
  const metadataWorkspace = await createInspectionMetadataWorkspace(workspaceDefinition, resolution, selection)
  if (!metadataWorkspace) {
    return createAgentInspectionMetadata(definition)
  }
  const capabilityContext = await resolveWorkspaceMetadataCapabilityContext(
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    metadataWorkspace.options as never,
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    metadataWorkspace.workspace as never,
    resolution,
    // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
    selection as never,
  )
  return await withMetadataCapabilityCleanup(capabilityContext, async () => {
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
    const config = await resolvedConfigMetadata(
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      workspaceDefinition as AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
      capabilityContext.metadataContext,
    )
    const instructionMetadata = await resolveWorkspaceMetadataInstructions(
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      capabilityContext.options as never,
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      capabilityContext.workspace as never,
      options,
      capabilityContext.definition,
      capabilityContext.metadataContext.context,
    )

    return {
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      ...capabilityInspectionMetadataProjection(capabilityContext.options.capabilities as AgentCapabilityDefinition[]),
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      files: await resolveWorkspaceMetadataFiles(capabilityContext.options as never, capabilityContext.workspace as never),
      instructions: [
        ...instructionMetadata.instructions,
        // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
        ...agentChannelMetadataInstructions(workspaceDefinition as AgentInput<AgentRuntimeContext<TRuntimeConfig>>),
      ],
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      ...agentInspectionMetadata(workspaceDefinition as AgentDefinition<TRuntimeConfig>),
      ...(config ? { config } : {}),
      // SAFETY: Workspace definition normalization establishes the asserted owned Workspace contract.
      tools: await resolveWorkspaceMetadataTools(capabilityContext.options as never, capabilityContext.workspace as never),
      ...(instructionMetadata.warnings.length ? { warnings: instructionMetadata.warnings } : {}),
    }
  })
}
