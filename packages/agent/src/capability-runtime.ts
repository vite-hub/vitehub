import { resolveRuntimeValue } from "@vite-hub/runtime"

import { hasTrustedWorkspaceAccessScope, hasTrustedWorkspaceSourceResolutionDefinition, isTrustedSourceFreeInspection, workspaceOverrideSymbol } from "./access-runtime.ts"
import {
  assertCapabilityCliContribution,
  createCapabilityCliTool,
} from "./capability-cli.ts"
import { createMessage, memoizeMessageAttachmentData } from "./messages.ts"
import { agentInvocationCallbackContextValues, agentInvocationSourceContext, createAgentInvocationContextStore } from "./invocation-context.ts"
import {
  createFallbackAgentInvoker,
  ensureAgentInvokerContext,
  resolveInputAgentInvoker,
} from "./invoker.ts"
import { runObservedAgentHook } from "./hooks.ts"
import { nextWithAbort } from "./internal/abortable-stream.ts"
import { materializeAgentModel } from "./internal/agent-model.ts"
import { openAgentCapabilityScope } from "./internal/capability-scope.ts"
import type {
  AgentCapabilitiesInput,
  AgentCapabilitiesResolverContext,
  AgentCallbackContext,
  AgentCapabilityCliContribution,
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityWorkspaceContribution,
  AgentCapabilityTypeContract,
  AgentCapabilityHookName,
  AgentCapabilityHooks,
  AgentCapabilityInputContext,
  AgentCapabilityMode,
  AgentCapabilityRuntimeContext,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryFinishEffect,
  AgentDriverContribution,
  AgentDriverContributionKind,
  AgentDriverKind,
  AgentFinishEvent,
  AgentFinishExtensionValues,
  AgentFinishExtensionProvider,
  AgentHookObserverHooks,
  AgentInvocationExtensions,
  AgentOutputExtensionValues,
  AgentOutputExtensions,
  AgentOutputExtensionProvider,
  AgentInvocationContextStore,
  AgentInvoker,
  AgentModelExecutionInstrumentation,
  AgentModelResolver,
  AgentOutputRenderer,
  AgentProviderToolContribution,
  AgentRunInput,
  AgentRuntimeConfig,
  AgentStaticCapabilitiesList,
  AgentToolSet,
  AgentToolTransform,
  MaybePromise,
  ResolvedAgentTriggerDefinition,
  ResolvedAgentRuntimeContext,
} from "./types.ts"
import type { WorkspaceOverrideRuntime } from "./access-runtime.ts"
import type { Message } from "./messages.ts"
import type { ReadonlyWorkspaceFacade, WorkspaceDefinition, WorkspaceName, WorkspaceSelectedScope, WorkspaceSource, WorkspaceSourceInput } from "@vite-hub/workspace"

type ResolvedAgentOutputRenderer = ((result: unknown, extensions?: AgentOutputExtensions) => MaybePromise<unknown>) & {
  order?: "last"
  providerCount: number
}
export const workspaceMaterializationPathsSymbol: unique symbol = Symbol("vitehub.agent.workspaceMaterializationPaths")
export const capabilityInvocationStartSymbol: unique symbol = Symbol("vitehub.agent.capabilityInvocationStart")
export const eagerFinishExtensionSymbol: unique symbol = Symbol("vitehub.agent.eagerFinishExtension")
type InternalAgentCapabilityDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = AgentCapabilityDefinition<TRuntimeConfig, Name> & {
  [capabilityInvocationStartSymbol]?: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<void>
  [eagerFinishExtensionSymbol]?: boolean
  [workspaceMaterializationPathsSymbol]?: readonly string[]
}
type ExactOptions<TInput, TShape> = TInput & Record<Exclude<keyof TInput, keyof TShape>, never>
type AgentCapabilityDefinitionInput<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TTypeContract extends AgentCapabilityTypeContract = AgentCapabilityTypeContract,
> = AgentCapabilityDefinition<TRuntimeConfig, Name, TTypeContract>
const defaultCapabilityRuntimePhases = ["configure", "prepare", "bind", "input", "resolve", "output"] as const
export const channelDeliveryEffectsContextKey = "channel.delivery.effects"
export const channelDeliveryFinishEffectsContextKey = "channel.delivery.finishEffects"
type AgentCapabilityRuntimePhase = typeof defaultCapabilityRuntimePhases[number]
export const optionalWorkspaceCapabilitySymbol: unique symbol = Symbol("vitehub.agent.optionalWorkspaceCapability")

export interface ResolvedAgentFinishExtensionProvider {
  eager?: boolean
  id: string
  resolve: AgentFinishExtensionProvider
}

export interface ResolvedAgentOutputExtensionProvider {
  id: string
  resolve: AgentOutputExtensionProvider
}

export interface AgentCapabilityRegistries {
  deliveryEffectIntents: AgentChannelDeliveryEffectIntent[]
  finishDeliveryEffectProviders: AgentChannelDeliveryFinishEffect[]
  finishExtensionProviders: ResolvedAgentFinishExtensionProvider[]
  finalOutputRenderers: ResolvedAgentOutputRenderer[]
  modelExecutionInstrumentation: AgentModelExecutionInstrumentation[]
  outputExtensionProviders: ResolvedAgentOutputExtensionProvider[]
  outputRenderers: ResolvedAgentOutputRenderer[]
  providerTools: AgentProviderToolContribution[]
  stateRequirements: Array<{ name: string, optional?: boolean }>
  triggers: ResolvedAgentTriggerDefinition[]
  workspaceContributions: Array<{ capabilityId: string, rules: string[], sources: string[] }>
}

export interface AgentCapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  capabilities?: AgentCapabilityDefinition<TRuntimeConfig, Name>[]
  hooks?: AgentCapabilityHooks<TRuntimeConfig, Name> & AgentHookObserverHooks
}

export interface AgentCapabilityInvocationOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  context?: AgentInvocationContextStore
  driverKind?: AgentDriverKind
  invocationKind?: "run" | "stream"
  invoker?: AgentInvoker
  model?: AgentModelResolver<TRuntimeConfig, Name>
  phases?: readonly AgentCapabilityRuntimePhase[]
  resolveCapabilityCli?: boolean
  resolveTools?: boolean
  workspaceDefinition?: WorkspaceDefinition
}

export interface ResolvedAgentCapabilities {
  close: () => Promise<void>
  driverContributions: AgentDriverContribution[]
  hasCloseCallbacks: boolean
  input: AgentRunInput
  messages: Message[]
  response?: Response
  registries: AgentCapabilityRegistries
  start?: () => Promise<AgentChannelDeliveryEffectIntent[]>
  toolTransforms: AgentToolTransform[]
  tools?: AgentToolSet
  workspaceMaterializationPaths: readonly string[]
  workspace?: ReadonlyWorkspaceFacade
  workspaceDefinition?: WorkspaceDefinition
}

function assertCapabilityId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !id.trim()) {
    throw new TypeError("[vitehub] Capability definitions require a non-empty string id.")
  }
  if (!/^[a-z][a-z0-9-_.]*$/i.test(id)) {
    throw new TypeError(`[vitehub] Capability id "${id}" must be a stable identifier.`)
  }
}

function assertTriggerName(name: unknown, capabilityId: string): asserts name is string {
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError(`[vitehub] Capability "${capabilityId}" trigger names must be non-empty strings.`)
  }
  if (!/^[a-z][a-z0-9-_]*$/i.test(name)) {
    throw new TypeError(`[vitehub] Capability "${capabilityId}" trigger "${name}" must be a stable local identifier.`)
  }
}

export function defineCapability<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TTypeContract extends AgentCapabilityTypeContract = AgentCapabilityTypeContract,
  const TCapability extends AgentCapabilityDefinition<TRuntimeConfig, Name, TTypeContract> = AgentCapabilityDefinition<TRuntimeConfig, Name, TTypeContract>,
>(
  capability: ExactOptions<TCapability, AgentCapabilityDefinitionInput<TRuntimeConfig, Name, TTypeContract>>,
): TCapability {
  if (!capability || typeof capability !== "object") {
    throw new TypeError("[vitehub] defineCapability() requires a capability definition.")
  }
  if ("instructions" in capability) {
    throw new TypeError("[vitehub] Capability instructions were removed. Put model-facing guidance in Agent Driver Instructions with ::capability coverage.")
  }
  assertCapabilityId((capability as { id?: unknown }).id)
  const cli = (capability as AgentCapabilityDefinition).cli
  if (typeof cli !== "function") assertCapabilityCliContribution((capability as { id: string }).id, cli)
  return capability
}

export function normalizeMode(value: unknown, label: string): AgentCapabilityMode {
  if (value === undefined) return "read"
  if (value === "read" || value === "write") return value
  throw new TypeError(`[vitehub] ${label} mode must be "read" or "write".`)
}

export function normalizeCapabilities(
  capabilities: AgentStaticCapabilitiesList | undefined,
): AgentCapabilityDefinition[] {
  if (capabilities === undefined) return []
  if (!Array.isArray(capabilities)) {
    throw new TypeError("[vitehub] defineAgent({ capabilities }) must be an ordered array.")
  }
  if (capabilities.some(capability => (capability as Record<symbol, unknown>)?.[Symbol.for("eve.mounted-extension")] === true)) {
    throw new TypeError("[vitehub] Eve extensions must be compiled by the ViteHub Vite plugin.")
  }
  const explicit = capabilities.map(capability => defineCapability(capability as AgentCapabilityDefinition))
  const explicitById = new Map<string, AgentCapabilityDefinition>()
  for (const capability of explicit) {
    if (explicitById.has(capability.id)) {
      throw new Error(`[vitehub] Duplicate capability id "${capability.id}" in one agent.`)
    }
    explicitById.set(capability.id, capability)
  }

  const normalized: AgentCapabilityDefinition[] = []
  const seen = new Set<string>()
  const add = (capability: AgentCapabilityDefinition) => {
    const resolved = defineCapability(capability)
    if (seen.has(resolved.id)) return
    seen.add(resolved.id)
    for (const nested of resolved.capabilities || []) {
      const normalizedNested = defineCapability(nested as AgentCapabilityDefinition)
      if (!explicitById.has(normalizedNested.id)) add(normalizedNested)
    }
    normalized.push(resolved)
  }

  for (const capability of explicit) add(capability)
  return normalized
}

export async function resolveAgentCapabilityDefinitions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
>(
  capabilities: AgentCapabilitiesInput<TRuntimeConfig, Name, CALL_OPTIONS> | undefined,
  context: AgentCapabilitiesResolverContext<TRuntimeConfig, CALL_OPTIONS>,
): Promise<AgentCapabilityDefinition<TRuntimeConfig, Name>[]> {
  const resolved = normalizeCapabilities(
    typeof capabilities === "function" ? await capabilities(context) : capabilities,
  ) as AgentCapabilityDefinition<TRuntimeConfig, Name>[]

  if (typeof capabilities !== "function") return resolved

  for (const capability of resolved) {
    const accessMetadata = capability.id === "access"
      ? capability.metadata as { chat?: unknown } | undefined
      : undefined
    const unsupported = [
      capability.triggers ? "triggers" : undefined,
      capability.workspaceSources ? "workspaceSources" : undefined,
      accessMetadata?.chat === true ? "chat access" : undefined,
    ].filter((value): value is string => Boolean(value))
    if (unsupported.length) {
      throw new Error(`[vitehub] Invocation-resolved Capability "${capability.id}" cannot contribute ${unsupported.join(", ")}. Attach definition-time behavior in a static capabilities array.`)
    }
  }

  return resolved
}

function validateSandboxCommands(commands: unknown): void {
  if (commands === undefined) return
  if (!Array.isArray(commands) || !commands.length) {
    throw new TypeError("[vitehub] sandbox({ commands }) requires at least one executable name.")
  }
  for (const command of commands) {
    if (typeof command !== "string" || !/^[A-Za-z0-9_.-]+$/.test(command)) {
      throw new TypeError("[vitehub] sandbox({ commands }) accepts executable names only, not shell command strings.")
    }
  }
}

function capabilityRequiresWorkspace(capability: AgentCapabilityDefinition): boolean {
  const metadata = capability.metadata
  const optionalWorkspace = typeof metadata === "object"
    && metadata !== null
    && (metadata as { [optionalWorkspaceCapabilitySymbol]?: unknown })[optionalWorkspaceCapabilitySymbol] === true
  const accessWorkspace = capability.id === "access"
    && typeof metadata === "object"
    && metadata !== null
    && (metadata as { workspace?: unknown }).workspace === true
  const sandboxCommands = capability.id === "sandbox"
    && Array.isArray((metadata as { commands?: unknown } | undefined)?.commands)
  return capability.workspace && !optionalWorkspace
    || capability.id === "workspace-shell"
    || sandboxCommands
    || accessWorkspace
}

export function validateAgentCapabilityComposition(
  capabilities: readonly AgentCapabilityDefinition[],
  options: { hasWorkspace: boolean, workspaceMode?: AgentCapabilityMode },
): void {
  for (const capability of normalizeCapabilities(capabilities)) {
    if (capability.id === "sandbox") {
      validateSandboxCommands((capability.metadata as { commands?: unknown } | undefined)?.commands)
    }
    if (!options.hasWorkspace) {
      if (capabilityRequiresWorkspace(capability)) {
        const name = capability.id === "workspace-shell" ? "workspaceShell" : capability.id
        throw new Error(`[vitehub] ${name}() requires an explicit workspace.`)
      }
      continue
    }

    const workspaceMode = options.workspaceMode || "read"
    if (capability.id === "workspace-shell") {
      if (normalizeMode(capability.mode, "Workspace Shell") === "write" && workspaceMode !== "write") {
        throw new Error("[vitehub] workspaceShell({ mode: \"write\" }) requires workspace.mode: \"write\".")
      }
    }
  }
}

export function capabilityWorkspaceSources(
  capabilities: readonly AgentCapabilityDefinition[] | undefined,
): WorkspaceDefinition["sources"] | undefined {
  const normalized = normalizeCapabilities(capabilities)
  const sources: NonNullable<WorkspaceDefinition["sources"]> = {}
  for (const capability of normalized) {
    for (const [key, source] of Object.entries(capability.workspaceSources || {})) {
      if (key in sources) {
        throw new Error(`[vitehub] Duplicate workspace source "${key}" contributed by capabilities.`)
      }
      sources[key] = source
    }
  }
  return Object.keys(sources).length ? sources : undefined
}

function validateAccessCapabilityOrder(capabilities: AgentCapabilityDefinition[]): void {
  const accessIndex = capabilities.findIndex(capability => capability.id === "access")
  if (accessIndex > 0) {
    throw new Error("[vitehub] access() must be the first capability so invocation access is applied before other capabilities can read scoped runtime surfaces or expose tools.")
  }
}

function getRunMessages(input: AgentRunInput): Message[] {
  if (input.messages) return input.messages
  if (Array.isArray(input.prompt)) return input.prompt
  if (input.message !== undefined) return [typeof input.message === "string" ? createMessage({ role: "user", text: input.message }) : input.message]
  return []
}

function normalizeRunInput(input: AgentRunInput): AgentRunInput {
  if (input.messages || Array.isArray(input.prompt) || input.message === undefined) return input
  const { message: _message, ...next } = input
  return { ...next, messages: getRunMessages(input) }
}

function withMessages(input: AgentRunInput, messages: Message[]): AgentRunInput {
  if (input.messages) return { ...input, messages }
  if (Array.isArray(input.prompt)) return { ...input, prompt: messages }
  return { ...input, messages }
}

async function callHooks<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  name: AgentCapabilityHookName,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
  agentHooks?: AgentCapabilityHooks<TRuntimeConfig, Name> & AgentHookObserverHooks,
) {
  await runObservedAgentHook(agentHooks, {
    ids: { capabilityId: context.capability.id },
    name,
    owner: "capability",
    phase: name.replace(/^capability:/, "").replace(/:after$/, ""),
  }, async () => {
    await context.capability.hooks?.[name]?.(context)
    await agentHooks?.[name]?.(context)
  })
}

function toAgentCallbackContext<TRuntimeConfig extends AgentRuntimeConfig>(
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>,
): AgentCallbackContext<TRuntimeConfig> {
  const { runtimeConfig: _runtimeConfig, ...context } = runtime
  return context
}

function pathContains(container: string, path: string): boolean {
  return !container || path === container || path.startsWith(`${container}/`)
}

function compactWorkspacePaths(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort((left, right) => left.length - right.length || left.localeCompare(right))
  return sorted.filter((path, index) => !sorted.some((candidate, candidateIndex) => candidateIndex < index && pathContains(candidate, path)))
}

function pathsConflict(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left)
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function ruleConflictBase(pattern: string): string {
  const wildcard = pattern.search(/[*{[(?]/)
  const base = wildcard === -1 ? pattern : pattern.slice(0, wildcard)
  return base.replace(/\/+$/, "")
}

function rulesConflict(left: string, right: string): boolean {
  if (left === right) return true
  const leftBase = ruleConflictBase(left)
  const rightBase = ruleConflictBase(right)
  return !leftBase || !rightBase || pathsConflict(leftBase, rightBase)
}

function workspaceRulePatterns(definition: WorkspaceDefinition): string[] {
  return [
    ...Object.keys(definition.rules || {}),
    ...(definition.plugins || []).flatMap(plugin => Object.keys(plugin.rules || {})),
  ]
}

type WorkspaceContributionRuntime = Pick<
  typeof import("@vite-hub/workspace/runtime"),
  | "createWorkspaceSourceResolutionFacade"
  | "normalizeWorkspaceSourceMetadata"
  | "resolveWorkspaceSources"
  | "workspaceSourceGrantPaths"
  | "workspaceSourceRequestDescriptorPath"
>

function normalizedContributionSource(
  key: string,
  source: WorkspaceSourceInput,
  runtime: WorkspaceContributionRuntime,
): { key: string, mountPath: string, probePaths?: string[], requestOnly: boolean, source?: WorkspaceSource } {
  const metadata = runtime.normalizeWorkspaceSourceMetadata(key, source)
  return {
    key,
    mountPath: metadata.mountPath,
    ...(metadata.probeKeys?.length ? { probePaths: metadata.probeKeys.map(sourcePath => joinSourcePath(metadata.mountPath, sourcePath)) } : {}),
    requestOnly: Boolean(metadata.requestOnly),
    source: metadata.source,
  }
}

function sourceGrantPath(runtime: WorkspaceContributionRuntime, key: string, source: { mountPath: string, requestOnly: boolean }): string {
  return source.requestOnly ? runtime.workspaceSourceRequestDescriptorPath(key) : source.mountPath
}

function sourcesConflict(left: { mountPath: string, probePaths?: string[], requestOnly: boolean }, right: { mountPath: string, probePaths?: string[], requestOnly: boolean }): boolean {
  if (left.requestOnly || right.requestOnly) return false
  const leftPaths = left.probePaths?.length ? left.probePaths : [left.mountPath]
  const rightPaths = right.probePaths?.length ? right.probePaths : [right.mountPath]
  return leftPaths.some(leftPath => rightPaths.some(rightPath => pathsConflict(leftPath, rightPath)))
}

function assertWorkspaceContribution(
  capabilityId: string,
  contribution: AgentCapabilityWorkspaceContribution,
  definition: WorkspaceDefinition,
  runtime: WorkspaceContributionRuntime,
) {
  const sources = contribution.sources || {}
  const rules = contribution.rules || {}
  const sourceEntries = Object.entries(sources)
  const rulePatterns = Object.keys(rules)
  const contributionSources: Array<{ key: string, mountPath: string, probePaths?: string[], requestOnly: boolean }> = []

  for (const [key, source] of sourceEntries) {
    if (definition.sources?.[key]) {
      throw new Error(`[vitehub] ${capabilityId}() workspace contribution source "${key}" conflicts with an existing Workspace Source.`)
    }
    const contributedSource = normalizedContributionSource(key, source, runtime)
    for (const existing of contributionSources) {
      if (sourcesConflict(existing, contributedSource)) {
        throw new Error(`[vitehub] ${capabilityId}() workspace contribution source "${key}" conflicts with contributed Workspace Source "${existing.key}" at mount "${contributedSource.mountPath || "."}".`)
      }
    }
    contributionSources.push(contributedSource)
    for (const [existingKey, existingSource] of Object.entries(definition.sources || {})) {
      const existing = normalizedContributionSource(existingKey, existingSource, runtime)
      if (sourcesConflict(existing, contributedSource)) {
        throw new Error(`[vitehub] ${capabilityId}() workspace contribution source "${key}" conflicts with Workspace Source "${existingKey}" at mount "${contributedSource.mountPath || "."}".`)
      }
    }
  }

  for (const pattern of rulePatterns) {
    for (const existingPattern of workspaceRulePatterns(definition)) {
      if (rulesConflict(existingPattern, pattern)) {
        throw new Error(`[vitehub] ${capabilityId}() workspace contribution rule "${pattern}" conflicts with existing Workspace Rule "${existingPattern}".`)
      }
    }
  }
}

async function workspacePathExists(workspace: ReadonlyWorkspaceFacade, path: string): Promise<boolean> {
  if (!path) {
    try {
      return Boolean((await workspace.fs.list("" as never)).length)
    }
    catch {
      return false
    }
  }
  if (await workspace.fs.exists(path as never)) return true
  try {
    return Boolean((await workspace.fs.list(path as never)).length)
  }
  catch {
    return false
  }
}

function joinSourcePath(mountPath: string, sourcePath: string): string {
  return [mountPath, sourcePath].filter(Boolean).join("/")
}

async function sourceConflictPaths(source: { key: string, mountPath: string, probePaths?: string[], source?: WorkspaceSource }): Promise<string[]> {
  if (source.mountPath) return [source.mountPath]
  if (source.probePaths?.length) return source.probePaths
  if (source.source?.getKeys.length === 0) {
    try {
      const keys = await source.source.getKeys({
        mountPath: source.mountPath,
        rootDir: process.cwd(),
        source: source.key,
        workspace: "workspace",
      })
      if (keys.length) return keys.map(key => joinSourcePath(source.mountPath, key))
    }
    catch {}
  }
  return [source.mountPath]
}

async function workspaceSourcePathExists(
  workspace: ReadonlyWorkspaceFacade,
  source: { key: string, mountPath: string, probePaths?: string[], source?: WorkspaceSource },
): Promise<boolean> {
  for (const path of await sourceConflictPaths(source)) {
    for (const parent of parentPaths(path)) {
      try {
        const stat = await workspace.fs.stat(parent as never)
        if (stat?.type !== "directory") return true
      }
      catch {}
    }
    if (await workspacePathExists(workspace, path)) return true
  }
  return false
}

function parentPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean)
  parts.pop()
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"))
}

async function assertResolvedWorkspaceContributionSources(
  registries: AgentCapabilityRegistries["workspaceContributions"],
  definition: WorkspaceDefinition,
  selectedWorkspaceScope: WorkspaceSelectedScope | undefined,
  workspace: ReadonlyWorkspaceFacade,
  runtime: WorkspaceContributionRuntime,
) {
  const contributed = new Map<string, string>()
  for (const contribution of registries) {
    for (const source of contribution.sources) contributed.set(source, contribution.capabilityId)
  }

  for (const [key, capabilityId] of contributed) {
    const source = definition.sources?.[key]
    if (!source) continue
    const contributedSource = normalizedContributionSource(key, source, runtime)
    if (!await selectedScopeContainsResolvedSource(runtime, selectedWorkspaceScope, key, contributedSource)) {
      throw new Error(`[vitehub] ${capabilityId}() workspace contribution source "${key}" is outside the selected Workspace Scope.`)
    }
    for (const [existingKey, existingSource] of Object.entries(definition.sources || {})) {
      if (existingKey === key) continue
      const existing = normalizedContributionSource(existingKey, existingSource, runtime)
      if (sourcesConflict(existing, contributedSource)) {
        const label = contributed.has(existingKey) ? "contributed Workspace Source" : "Workspace Source"
        throw new Error(`[vitehub] ${capabilityId}() workspace contribution source "${key}" conflicts with ${label} "${existingKey}" at mount "${contributedSource.mountPath || "."}".`)
      }
    }
    if (!contributedSource.requestOnly && await workspaceSourcePathExists(workspace, contributedSource)) {
      throw new Error(`[vitehub] ${capabilityId}() workspace contribution source "${key}" conflicts with an existing Workspace path at mount "${contributedSource.mountPath}".`)
    }
  }
}

function selectedWorkspaceScopeFromContext(context: AgentInvocationContextStore): WorkspaceSelectedScope | undefined {
  if (!hasTrustedWorkspaceAccessScope(context)) return
  const access = context.get<{ workspaceScope?: { all?: boolean, paths?: readonly string[], role?: string, scope?: string, sources?: readonly string[] } }>("access")
  const scope = access?.workspaceScope
  if (!scope?.scope) return
  return {
    all: scope.all === true,
    name: scope.scope,
    paths: scope.paths,
    role: scope.role,
    sources: scope.sources,
  }
}

function setSelectedWorkspaceScopeContext(context: AgentInvocationContextStore, scope: WorkspaceSelectedScope | undefined) {
  if (!scope || !hasTrustedWorkspaceAccessScope(context)) return
  const access = context.get<{ workspaceScope?: { all?: boolean, paths?: readonly string[], role?: string, scope?: string, sources?: readonly string[] } }>("access")
  context.set("access", {
    ...access,
    workspaceScope: {
      ...access?.workspaceScope,
      all: scope.all,
      paths: scope.paths,
      role: scope.role,
      scope: scope.name,
      sources: scope.sources,
    },
  }, { overwrite: true })
}

function mergeSelectedWorkspaceScopePaths(scope: WorkspaceSelectedScope | undefined, paths: readonly string[]): WorkspaceSelectedScope | undefined {
  if (!scope || scope.all || !paths.length) return scope
  return {
    ...scope,
    paths: compactWorkspacePaths([...(scope.paths || []), ...paths]),
  }
}

function assertSelectedWorkspaceSourceGrants(
  scope: WorkspaceSelectedScope | undefined,
  definitions: readonly (WorkspaceDefinition | undefined)[],
) {
  if (!scope || scope.all) return
  for (const key of scope.sources || []) {
    if (definitions.some(definition => definition?.sources?.[key])) continue
    throw new Error(`[vitehub] Workspace Scope source grant references unknown source "${key}".`)
  }
}

function mergeSelectedWorkspaceSourceGrantPaths(
  scope: WorkspaceSelectedScope | undefined,
  definition: WorkspaceDefinition,
  runtime: WorkspaceContributionRuntime,
): WorkspaceSelectedScope | undefined {
  if (!scope || scope.all || !scope.sources?.length) return scope
  const paths = scope.sources.flatMap((key) => {
    const source = definition.sources?.[key]
    return source ? runtime.workspaceSourceGrantPaths(key, source) : []
  })
  return mergeSelectedWorkspaceScopePaths(scope, paths)
}

function selectedScopeContainsMount(scope: WorkspaceSelectedScope | undefined, mountPath: string): boolean {
  if (!scope || scope.all) return true
  if (!mountPath) return Boolean(scope.paths?.includes(""))
  return Boolean(scope.paths?.some(path => pathContains(path, mountPath)))
}

function selectedScopeContainsSource(
  runtime: WorkspaceContributionRuntime,
  scope: WorkspaceSelectedScope | undefined,
  key: string,
  source: { mountPath: string, probePaths?: string[], requestOnly: boolean },
): boolean {
  if (scope?.sources?.includes(key)) return true
  if (source.probePaths?.length) {
    return source.probePaths.some(path => selectedScopeContainsMount(scope, path))
  }
  return selectedScopeContainsMount(scope, sourceGrantPath(runtime, key, source))
}

async function selectedScopeContainsResolvedSource(
  runtime: WorkspaceContributionRuntime,
  scope: WorkspaceSelectedScope | undefined,
  key: string,
  source: { key: string, mountPath: string, probePaths?: string[], requestOnly: boolean, source?: WorkspaceSource },
): Promise<boolean> {
  if (selectedScopeContainsSource(runtime, scope, key, source)) return true
  if (source.mountPath || source.requestOnly || !source.source) return false
  return (await sourceConflictPaths(source)).some(path => selectedScopeContainsMount(scope, path))
}

function assertStaticWorkspaceContributionSourcesInScope(
  registries: AgentCapabilityRegistries["workspaceContributions"],
  definition: WorkspaceDefinition,
  selectedWorkspaceScope: WorkspaceSelectedScope | undefined,
  runtime: WorkspaceContributionRuntime,
) {
  if (!selectedWorkspaceScope || selectedWorkspaceScope.all) return
  const contributed = new Map<string, string>()
  for (const contribution of registries) {
    for (const source of contribution.sources) contributed.set(source, contribution.capabilityId)
  }
  for (const [key, capabilityId] of contributed) {
    const source = definition.sources?.[key]
    if (!source) continue
    const contributedSource = normalizedContributionSource(key, source, runtime)
    if (contributedSource.source?.resolve) continue
    if (!contributedSource.mountPath && !contributedSource.probePaths?.length && contributedSource.source) continue
    if (!selectedScopeContainsSource(runtime, selectedWorkspaceScope, key, contributedSource)) {
      throw new Error(`[vitehub] ${capabilityId}() workspace contribution source "${key}" is outside the selected Workspace Scope.`)
    }
  }
}

function withInvocationReadableSource(input: WorkspaceSourceInput): WorkspaceSourceInput {
  if (typeof input === "string") return { source: input, materialize: "lazy" }
  if (!isPlainRecord(input)) return input
  const mount = input.mount
  if (input.materialize !== undefined || input.sync !== undefined || isPlainRecord(mount) && mount.materialize !== undefined) {
    return input
  }
  return { ...input, materialize: "lazy" } as WorkspaceSourceInput
}

function withInvocationReadableSources(sources: Record<string, WorkspaceSourceInput>): Record<string, WorkspaceSourceInput> {
  return Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, withInvocationReadableSource(source)]))
}

async function applyCapabilityWorkspaceContributions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  capabilities: AgentCapabilityDefinition<TRuntimeConfig, Name>[],
  context: Omit<AgentCapabilityContext<TRuntimeConfig, Name>, "capability" | "mode"> & {
    workspace: ReadonlyWorkspaceFacade<Name>
    workspaceDefinition: WorkspaceDefinition
    workspaceMaterializationPaths?: readonly string[]
  },
  workspaceMode: AgentCapabilityMode,
  baseWorkspace: ReadonlyWorkspaceFacade<Name>,
  declaredWorkspaceDefinition: WorkspaceDefinition | undefined,
): Promise<{ definition: WorkspaceDefinition, registries: AgentCapabilityRegistries["workspaceContributions"], workspace: ReadonlyWorkspaceFacade<Name> } | undefined> {
  let definition = context.workspaceDefinition
  const registries: AgentCapabilityRegistries["workspaceContributions"] = []
  const workspaceRuntime = await import("@vite-hub/workspace/runtime")

  for (const capability of capabilities) {
    if (!capability.workspace) continue
    await validateCapabilityRuntimeRequirement(capability as AgentCapabilityDefinition, context.workspace, workspaceMode)
    const resolved = typeof capability.workspace === "function"
      ? await capability.workspace({
          ...context,
          mode: capability.mode,
        })
      : capability.workspace
    if (!resolved) continue

    assertWorkspaceContribution(capability.id, resolved, definition, workspaceRuntime)
    const sources = withInvocationReadableSources(resolved.sources || {})
    const rules = resolved.rules || {}
    definition = {
      ...definition,
      rules: Object.keys(rules).length ? { ...definition.rules, ...rules } : definition.rules,
      sources: Object.keys(sources).length ? { ...definition.sources, ...sources } : definition.sources,
    }
    registries.push({
      capabilityId: capability.id,
      rules: Object.keys(rules),
      sources: Object.keys(sources),
    })
  }

  let selectedWorkspaceScope = mergeSelectedWorkspaceScopePaths(selectedWorkspaceScopeFromContext(context.context), context.workspaceMaterializationPaths || [])
  assertSelectedWorkspaceSourceGrants(selectedWorkspaceScope, [definition, declaredWorkspaceDefinition])
  if (!registries.length) return
  assertStaticWorkspaceContributionSourcesInScope(registries, definition, selectedWorkspaceScope, workspaceRuntime)
  if (isTrustedSourceFreeInspection(context.context)) {
    return { definition, registries, workspace: context.workspace }
  }
  const resolvedDefinition = await workspaceRuntime.resolveWorkspaceSources(definition, {
    invocation: {
      context: agentInvocationSourceContext(context.context),
      run: context.run,
    },
    selectedWorkspaceScope,
  })
  selectedWorkspaceScope = mergeSelectedWorkspaceSourceGrantPaths(selectedWorkspaceScope, resolvedDefinition, workspaceRuntime)
  setSelectedWorkspaceScopeContext(context.context, selectedWorkspaceScope)
  const sourceResolution = await workspaceRuntime.createWorkspaceSourceResolutionFacade(context.workspace as never, resolvedDefinition, {
    invocation: {
      context: agentInvocationSourceContext(context.context),
      run: context.run,
    },
    overlay: true,
    selectedWorkspaceScope,
  })
  await assertResolvedWorkspaceContributionSources(
    registries,
    sourceResolution.definition,
    selectedWorkspaceScope,
    baseWorkspace,
    workspaceRuntime,
  )
  return {
    definition: sourceResolution.definition,
    registries,
    workspace: sourceResolution.workspace as ReadonlyWorkspaceFacade<Name>,
  }
}

export async function resolveAgentCapabilities<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: AgentCapabilityOptions<TRuntimeConfig, Name> | undefined,
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput,
  workspace?: ReadonlyWorkspaceFacade<Name>,
  workspaceMode: AgentCapabilityMode = "read",
  invocationOptions: AgentCapabilityInvocationOptions<TRuntimeConfig, Name> = {},
): Promise<ResolvedAgentCapabilities> {
  const runtimeContext = toAgentCallbackContext(runtime)
  const invocationContext = invocationOptions.context || createAgentInvocationContextStore(input.context)
  const invoker = invocationOptions.invoker || resolveInputAgentInvoker(input.context) || createFallbackAgentInvoker(runtime.run)
  const driverKind = invocationOptions.driverKind || "model"
  const resolveCapabilityCli = invocationOptions.resolveCapabilityCli ?? driverKind !== "provider"
  ensureAgentInvokerContext(invocationContext, invoker)
  const capabilities = normalizeCapabilities(options?.capabilities as AgentCapabilityDefinition[] | undefined) as AgentCapabilityDefinition<TRuntimeConfig, Name>[]
  validateAccessCapabilityOrder(capabilities)
  const workspaceMaterializationPaths = driverKind === "provider"
    ? compactWorkspacePaths(capabilities.flatMap(capability =>
        [
          ...((capability as InternalAgentCapabilityDefinition)[workspaceMaterializationPathsSymbol] || []),
          ...(capability.requires || []).flatMap(requirement => requirement.workspace?.paths || []),
        ],
      ))
    : []
  let currentInput = normalizeRunInput(input)
  let currentWorkspace = workspace as ReadonlyWorkspaceFacade<Name> | undefined
  let currentWorkspaceDefinition = invocationOptions.workspaceDefinition
  const inputMessages = getRunMessages(currentInput)
  let messages = memoizeMessageAttachmentData(inputMessages)
  if (messages !== inputMessages) currentInput = withMessages(currentInput, messages)
  let tools: AgentToolSet | undefined
  const driverContributions: AgentDriverContribution[] = []
  let capabilityScope: Awaited<ReturnType<typeof openAgentCapabilityScope>> | undefined
  const toolTransforms: AgentToolTransform[] = []
  const initialDeliveryEffectIntents = invocationContext.get<AgentChannelDeliveryEffectIntent[]>(channelDeliveryEffectsContextKey) || []
  const initialFinishDeliveryEffectProviders = invocationContext.get<AgentChannelDeliveryFinishEffect[]>(channelDeliveryFinishEffectsContextKey) || []
  const registries: AgentCapabilityRegistries = {
    deliveryEffectIntents: [...initialDeliveryEffectIntents],
    finishDeliveryEffectProviders: [...initialFinishDeliveryEffectProviders],
    finishExtensionProviders: [],
    finalOutputRenderers: [],
    modelExecutionInstrumentation: [],
    outputExtensionProviders: [],
    outputRenderers: [],
    providerTools: [],
    stateRequirements: [],
    triggers: [],
    workspaceContributions: [],
  }
  const capabilityContexts: Array<{
    capability: AgentCapabilityDefinition<TRuntimeConfig, Name>
    context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name> & WorkspaceOverrideRuntime<Name>
  }> = []

  function recordDriverContribution(kind: AgentDriverContributionKind, capabilityId: string, names?: string[]) {
    const uniqueNames = Array.from(new Set((names || []).filter(Boolean))).sort()
    driverContributions.push({
      capabilityId,
      kind,
      ...(uniqueNames.length ? { names: uniqueNames } : {}),
    })
  }

  function addFinishExtensionProvider(capabilityId: string, value: unknown | AgentFinishExtensionProvider, eager?: boolean) {
    registries.finishExtensionProviders.push({
      ...(eager ? { eager: true } : {}),
      id: capabilityId,
      resolve: typeof value === "function"
        ? value as AgentFinishExtensionProvider
        : () => value,
    })
  }

  async function closeCapabilities() {
    await capabilityScope?.close()
  }

  let invocationStarted = false
  async function startInvocationCallbacks() {
    if (invocationStarted) return []
    invocationStarted = true
    const deliveryEffectCount = registries.deliveryEffectIntents.length
    for (const { capability, context } of capabilityContexts) {
      await (capability as InternalAgentCapabilityDefinition<TRuntimeConfig, Name>)[capabilityInvocationStartSymbol]?.(context)
    }
    return registries.deliveryEffectIntents.slice(deliveryEffectCount)
  }
  const start = capabilities.some(capability => capabilityInvocationStartSymbol in capability)
    ? startInvocationCallbacks
    : undefined

  function syncCapabilityWorkspaceContext(context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) {
    if (currentWorkspace) {
      context.fs = currentWorkspace.fs
      context.workspace = currentWorkspace
    }
    if (currentWorkspaceDefinition) context.workspaceDefinition = currentWorkspaceDefinition
  }

  let workspaceContributionsApplied = false
  async function applyWorkspaceContributions() {
    if (workspaceContributionsApplied) return
    workspaceContributionsApplied = true
    if (!currentWorkspace || !currentWorkspaceDefinition) return
    const sourceResolvedDefinition = hasTrustedWorkspaceSourceResolutionDefinition(invocationContext)
      ? invocationContext.get<WorkspaceDefinition>("workspace.sourceResolution.definition")
      : undefined
    if (sourceResolvedDefinition) currentWorkspaceDefinition = sourceResolvedDefinition
    const workspaceContribution = await applyCapabilityWorkspaceContributions(capabilities, {
      ...agentInvocationCallbackContextValues(invocationContext),
      ...runtimeContext,
      abortSignal: currentInput.abortSignal,
      actor: invoker,
      context: invocationContext,
      driver: { kind: driverKind },
      fs: currentWorkspace.fs,
      invoker,
      runtimeContext: runtime,
      workspace: currentWorkspace,
      workspaceDefinition: currentWorkspaceDefinition,
      workspaceMaterializationPaths,
    }, workspaceMode, workspace || currentWorkspace, invocationOptions.workspaceDefinition)
    if (workspaceContribution) {
      currentWorkspace = workspaceContribution.workspace
      currentWorkspaceDefinition = workspaceContribution.definition
      registries.workspaceContributions = workspaceContribution.registries
    }
    for (const item of capabilityContexts) syncCapabilityWorkspaceContext(item.context)
  }

  try {
    for (const capability of capabilities) {
      await validateCapabilityRuntimeRequirement(capability as AgentCapabilityDefinition, currentWorkspace, workspaceMode)
      const phases = invocationOptions.phases || defaultCapabilityRuntimePhases
      const metadataContext = {
        ...agentInvocationCallbackContextValues(invocationContext),
        ...runtimeContext,
        abortSignal: currentInput.abortSignal,
        actor: invoker,
        context: invocationContext,
        driver: { kind: driverKind },
        fs: currentWorkspace?.fs,
        invoker,
        runtimeContext: runtime,
        workspace: currentWorkspace,
        workspaceDefinition: currentWorkspaceDefinition,
        workspaceMaterializationPaths,
      }
      let capabilityContext: AgentCapabilityRuntimeContext<TRuntimeConfig, Name> & WorkspaceOverrideRuntime<Name>
      const input: AgentCapabilityInputContext = {
        get: () => currentInput,
        messages: () => messages,
        set(value) {
          currentInput = normalizeRunInput(value)
          const inputMessages = getRunMessages(currentInput)
          messages = memoizeMessageAttachmentData(inputMessages)
          if (messages !== inputMessages) currentInput = withMessages(currentInput, messages)
        },
        setMessages(value) {
          messages = memoizeMessageAttachmentData(value)
          currentInput = withMessages(currentInput, messages)
        },
      }
      capabilityContext = {
        ...metadataContext,
        [workspaceOverrideSymbol](nextWorkspace: ReadonlyWorkspaceFacade<Name>) {
          currentWorkspace = nextWorkspace
          syncCapabilityWorkspaceContext(capabilityContext)
        },
        capability,
        mode: capability.mode,
        input,
        invocation: { input, kind: invocationOptions.invocationKind || "run" },
        delivery: {
          effect(intent) {
            if (!intent || typeof intent !== "object" || typeof intent.kind !== "string" || !intent.kind.trim()) {
              throw new TypeError("[vitehub] delivery.effect() requires an effect intent with a non-empty kind.")
            }
            const next = [...registries.deliveryEffectIntents, intent]
            registries.deliveryEffectIntents = next
            invocationContext.set(channelDeliveryEffectsContextKey, next, { overwrite: true })
          },
          finishEffect(effect) {
            const effects = Array.isArray(effect) ? effect : [effect]
            if (typeof effect !== "function" && effects.some(effect => !effect || typeof effect !== "object" || typeof effect.kind !== "string" || !effect.kind.trim())) {
              throw new TypeError("[vitehub] delivery.finishEffect() requires an effect intent or resolver.")
            }
            const next = [...registries.finishDeliveryEffectProviders, effect]
            registries.finishDeliveryEffectProviders = next
            invocationContext.set(channelDeliveryFinishEffectsContextKey, next, { overwrite: true })
          },
        },
        model: {
          async resolve(model, options) {
            const resolver = model ?? invocationOptions.model
            if (resolver === undefined) {
              throw new Error(`[vitehub] ${capability.id}() requires a model option or an agent model.`)
            }
            const resolverContext = {
              ...metadataContext,
              ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
              fs: currentWorkspace?.fs,
              runtimeConfig: runtime.runtimeConfig,
              workspace: currentWorkspace,
              workspaceDefinition: currentWorkspaceDefinition,
            }
            const resolved = await resolveRuntimeValue(resolver as never, resolverContext as never)
            return await materializeAgentModel(resolved as never, resolverContext)
          },
        },
        modelExecution: {
          instrument(instrumentation) {
            registries.modelExecutionInstrumentation.push(instrumentation)
          },
        },
        output: {
          extensions: createAgentExtensionReader(new Map()),
          final(renderer: AgentOutputRenderer, options?: { order?: "last" }) {
            const resolved = ((result: unknown, extensions = createAgentExtensionReader(new Map())) => renderer(result, {
              ...capabilityContext,
              output: {
                ...capabilityContext.output,
                extensions,
              },
            })) as ResolvedAgentOutputRenderer
            resolved.order = options?.order
            resolved.providerCount = registries.outputExtensionProviders.length
            registries.finalOutputRenderers.push(resolved)
          },
          provide(value) {
            registries.outputExtensionProviders.push({
              id: capability.id,
              resolve: typeof value === "function"
                ? value as AgentOutputExtensionProvider
                : () => value,
            })
          },
          render(renderer: AgentOutputRenderer) {
            const resolved = ((result: unknown, extensions = createAgentExtensionReader(new Map())) => renderer(result, {
              ...capabilityContext,
              output: {
                ...capabilityContext.output,
                extensions,
              },
            })) as ResolvedAgentOutputRenderer
            resolved.providerCount = registries.outputExtensionProviders.length
            registries.outputRenderers.push(resolved)
          },
        },
        providerTools: {
          add(tool) {
            registries.providerTools.push(tool)
            recordDriverContribution("provider tools", capability.id, [tool.name])
          },
        },
        finish: {
          provide(value) {
            addFinishExtensionProvider(capability.id, value)
          },
        },
        state: {
          require(name, options) {
            if (!registries.stateRequirements.some(requirement => requirement.name === name)) {
              registries.stateRequirements.push({ name, optional: options?.optional })
            }
          },
        },
        tools: {
          add(value) {
            if (!value) return
            recordDriverContribution("Capability tools", capability.id, Object.keys(value))
            tools = { ...tools, ...value }
          },
          transform(transform) {
            toolTransforms.push(transform)
          },
        },
        workspace: currentWorkspace,
      } as AgentCapabilityRuntimeContext<TRuntimeConfig, Name> & WorkspaceOverrideRuntime<Name>
      capabilityContexts.push({ capability, context: capabilityContext })
      if (capability.finish) {
        addFinishExtensionProvider(
          capability.id,
          capability.finish,
          (capability as InternalAgentCapabilityDefinition<TRuntimeConfig, Name>)[eagerFinishExtensionSymbol],
        )
      }

      for (const [name, trigger] of Object.entries(capability.triggers || {})) {
        assertTriggerName(name, capability.id)
        const id = `${capability.id}.${name}` as const
        registries.triggers.push({
          capabilityId: capability.id,
          definition: trigger as never,
          id,
          input: trigger.input,
          invoke: input => trigger.invoke({
            ...runtimeContext,
            actor: invoker,
            capability,
            trigger: {
              capabilityId: capability.id,
              id,
              name,
              source: "capability",
            },
          }, input as never),
          name,
          output: trigger.output,
          source: "capability",
        })
      }

      if (capability.close || options?.hooks?.["capability:close"] || options?.hooks?.["capability:close:after"]) {
        capabilityScope ??= await openAgentCapabilityScope()
        await capabilityScope.add(async () => {
          await callHooks("capability:close", capabilityContext, options?.hooks)
          await capability.close?.(capabilityContext)
          await callHooks("capability:close:after", capabilityContext, options?.hooks)
        })
      }

      for (const phase of phases) {
        await callHooks(`capability:${phase}`, capabilityContext, options?.hooks)
        const result = await capability[phase]?.(capabilityContext)
        await callHooks(`capability:${phase}:after`, capabilityContext, options?.hooks)
        if (result instanceof Response) {
          return {
            close: closeCapabilities,
            driverContributions,
            hasCloseCallbacks: Boolean(capabilityScope),
            input: currentInput,
            messages,
            response: result,
            registries,
            start,
            toolTransforms,
            tools,
            workspaceMaterializationPaths,
            workspace: currentWorkspace,
          }
        }
      }
    }
    await applyWorkspaceContributions()
    for (const { capability, context } of capabilityContexts) {
      let cli: AgentCapabilityCliContribution<TRuntimeConfig, Name> | undefined
      if (capability.cli && resolveCapabilityCli && invocationOptions.resolveTools !== false) {
        cli = await resolveRuntimeValue(capability.cli, context)
        assertCapabilityCliContribution(capability.id, cli)
      }
      if (invocationOptions.resolveTools !== false && cli && resolveCapabilityCli) {
        const resolved = createCapabilityCliTool(capability, context, cli)
        if (isToolSet(resolved)) {
          if (tools?.[cli.name]) {
            throw new Error(`[vitehub] Capability CLI "${cli.name}" conflicts with an existing Agent tool.`)
          }
          recordDriverContribution("Capability tools", capability.id, Object.keys(resolved))
          tools = { ...tools, ...resolved }
        }
      }
      if (invocationOptions.resolveTools !== false && capability.tools) {
        const resolved = await resolveRuntimeValue(capability.tools as never, context) as unknown
        if (isToolSet(resolved)) {
          for (const name of Object.keys(resolved)) {
            if (tools?.[name]?.metadata?.vitehubCapabilityCli === true) {
              throw new Error(`[vitehub] Capability tool "${name}" conflicts with an existing Capability CLI.`)
            }
          }
          recordDriverContribution("Capability tools", capability.id, Object.keys(resolved))
          tools = { ...tools, ...resolved }
        }
      }
    }
  }
  catch (error) {
    if (capabilityScope) return await capabilityScope.failSetup(error)
    throw error
  }

  return {
    close: closeCapabilities,
    driverContributions,
    hasCloseCallbacks: Boolean(capabilityScope),
    input: currentInput,
    messages,
    registries,
    start,
    toolTransforms,
    tools,
    workspaceMaterializationPaths,
    workspace: currentWorkspace,
    workspaceDefinition: currentWorkspaceDefinition,
  }
}

export async function resolveStaticCapabilityTools<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: AgentCapabilityOptions<TRuntimeConfig, Name> | undefined,
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  workspace?: ReadonlyWorkspaceFacade<Name>,
  workspaceMode: AgentCapabilityMode = "read",
): Promise<AgentToolSet | undefined> {
  const runtimeContext = toAgentCallbackContext(runtime)
  const invocationContext = createAgentInvocationContextStore()
  const invoker = createFallbackAgentInvoker(runtime.run)
  ensureAgentInvokerContext(invocationContext, invoker)
  const capabilities = normalizeCapabilities(options?.capabilities as AgentCapabilityDefinition[] | undefined) as AgentCapabilityDefinition<TRuntimeConfig, Name>[]
  let tools: AgentToolSet | undefined

  for (const capability of capabilities) {
    await validateCapabilityRuntimeRequirement(capability as AgentCapabilityDefinition, workspace, workspaceMode)
    if (!capability.tools) continue
    const capabilityContext = {
      ...agentInvocationCallbackContextValues(invocationContext),
      ...runtimeContext,
      actor: invoker,
      context: invocationContext,
      fs: workspace?.fs,
      invoker,
      mode: capability.mode,
      runtimeContext: runtime,
      workspace,
    } as unknown as AgentCapabilityContext<TRuntimeConfig, Name>
    const resolved = await resolveRuntimeValue(capability.tools as never, capabilityContext as never) as unknown
    if (isToolSet(resolved)) tools = { ...tools, ...resolved }
  }

  return tools
}

function isToolSet(value: unknown): value is AgentToolSet {
  return typeof value === "object" && value !== null
}

export async function validateCapabilityRuntimeRequirement<Name extends WorkspaceName>(
  capability: AgentCapabilityDefinition,
  workspace?: ReadonlyWorkspaceFacade<Name>,
  workspaceMode: AgentCapabilityMode = "read",
): Promise<void> {
  for (const requirement of capability.requires || []) {
    if (!requirement.workspace) continue
    if (requirement.workspace.required && !workspace) {
      throw new Error(`[vitehub] ${capability.id}() requires an explicit workspace.`)
    }
    if (!workspace) continue
    if (requirement.workspace.mode === "write" && workspaceMode !== "write") {
      throw new Error(`[vitehub] ${capability.id}() requires workspace.mode: "write".`)
    }
    for (const path of requirement.workspace.paths || []) {
      if (!await workspace.fs.exists(path as never)) {
        throw new Error(`[vitehub] ${capability.id}() requires workspace path ${path}.`)
      }
    }
  }
}

export async function applyCapabilityToolTransforms(
  tools: AgentToolSet | undefined,
  transforms: AgentToolTransform[] = [],
): Promise<AgentToolSet | undefined> {
  let current = tools
  for (const transform of transforms) {
    current = await transform(current)
  }
  return current
}

const useCurrentRendererResult = Symbol("useCurrentRendererResult")

export async function applyOutputRenderers(
  result: unknown,
  renderers: ResolvedAgentOutputRenderer[] = [],
  providers: ResolvedAgentOutputExtensionProvider[] = [],
  values: Map<string, unknown> = new Map<string, unknown>(),
  providerResult: unknown = useCurrentRendererResult,
): Promise<unknown> {
  let current = result
  let rendered = false
  let providerIndex = 0
  const extensions = createAgentExtensionReader<AgentOutputExtensionValues>(values)
  const delayedRenderers: Array<{ extensions: AgentOutputExtensions, renderer: ResolvedAgentOutputRenderer }> = []
  for (const renderer of renderers) {
    while (providerIndex < renderer.providerCount) {
      const provider = providers[providerIndex++]
      if (values.has(provider.id)) continue
      const value = await provider.resolve({
        extensions,
        result: providerResult === useCurrentRendererResult || rendered ? current : providerResult,
      })
      if (value !== undefined) values.set(provider.id, value)
    }
    if (renderer.order === "last") {
      delayedRenderers.push({
        extensions: createAgentExtensionReader(new Map(values)),
        renderer,
      })
      continue
    }
    current = await renderer(current, extensions)
    rendered = true
  }
  for (const delayed of delayedRenderers) {
    current = await delayed.renderer(current, delayed.extensions)
  }
  return current
}

function createAgentExtensionReader<TValues extends object = Record<string, unknown>>(values: Map<string, unknown>): AgentInvocationExtensions<TValues> {
  return {
    entries() {
      return Array.from(values.entries())
    },
    get<T = unknown>(capabilityId: string, key?: string): T | undefined {
      const value = values.get(capabilityId)
      if (key === undefined) return value as T | undefined
      if (typeof value !== "object" || value === null) return undefined
      return (value as Record<string, unknown>)[key] as T | undefined
    },
    toJSON() {
      return Object.fromEntries(values.entries())
    },
  }
}

export async function createAgentInvocationExtensions(
  event: Omit<AgentFinishEvent, "extensions">,
  providers: ResolvedAgentFinishExtensionProvider[] = [],
): Promise<AgentFinishEvent["extensions"]> {
  const values = new Map<string, unknown>()
  const extensions = createAgentExtensionReader<AgentFinishExtensionValues>(values)
  const finishEvent = { ...event, extensions } as AgentFinishEvent
  for (const provider of providers) {
    const value = await provider.resolve(finishEvent)
    if (value !== undefined) {
      values.set(provider.id, value)
    }
  }
  return extensions
}

export type CapabilityCleanupOutcome =
  | { completed?: boolean, failed: false }
  | { error: unknown, failed: true }

async function closeCapabilityStreamIterator(
  iterator: AsyncIterator<unknown>,
  completed: boolean,
  outcome: CapabilityCleanupOutcome,
  close: (outcome: CapabilityCleanupOutcome) => Promise<void>,
): Promise<void> {
  if (!completed) {
    let returnTask: Promise<IteratorResult<unknown>> | undefined
    try {
      returnTask = iterator.return?.()
    }
    catch (returnError) {
      returnTask = Promise.reject(returnError)
    }
    if (outcome.failed) void returnTask?.catch(() => {})
    else {
      try {
        await returnTask
      }
      catch (returnError) {
        try {
          await close({ error: returnError, failed: true })
        }
        catch (closeError) {
          throw new AggregateError([returnError, closeError], "[vitehub] Agent stream return failed and finish lifecycle also failed.")
        }
        throw returnError
      }
    }
  }
  await close(outcome.failed ? outcome : { completed, failed: false })
}

export function withCapabilityCleanup<T extends AsyncIterable<unknown>>(
  stream: T,
  close: (outcome: CapabilityCleanupOutcome) => Promise<void>,
  options: { abortSignal?: AbortSignal, cancelOnAbort?: (reason: unknown) => Promise<void> } = {},
): AsyncIterable<unknown> {
  const iterator = stream[Symbol.asyncIterator]()
  let cleanupTask: Promise<void> | undefined
  const cleanup = (completed: boolean, outcome: CapabilityCleanupOutcome, cancelReason?: unknown) => {
    cleanupTask ||= (async () => {
      if (!completed) await options.cancelOnAbort?.(cancelReason).catch(() => {})
      await closeCapabilityStreamIterator(iterator, completed, outcome, close)
    })()
    options.abortSignal?.removeEventListener("abort", onAbort)
    return cleanupTask
  }
  const onAbort = () => {
    const reason = options.abortSignal?.reason ?? new DOMException("[vitehub] Agent Invocation stream aborted.", "AbortError")
    void cleanup(false, { error: reason, failed: true }, reason).catch(() => {})
  }
  if (options.abortSignal?.aborted) onAbort()
  else options.abortSignal?.addEventListener("abort", onAbort, { once: true })
  return (async function* () {
    let completed = false
    let error: unknown
    let failed = false
    try {
      for (;;) {
        const result = await nextWithAbort(iterator.next(), options.abortSignal, "[vitehub] Agent Invocation stream aborted.")
        if (result.done) {
          completed = true
          break
        }
        yield result.value
      }
    }
    catch (caught) {
      failed = true
      error = caught
      throw caught
    }
    finally {
      await cleanup(completed, failed ? { error, failed: true } : { failed: false })
    }
  })()
}

export function withResponseCleanup(
  response: Response,
  close: (outcome: CapabilityCleanupOutcome) => Promise<void>,
  options: { abortSignal?: AbortSignal, onChunk?: (chunk: Uint8Array) => void } = {},
): Response | Promise<Response> {
  if (!response.body) {
    return close({ completed: true, failed: false }).then(() => response)
  }
  const reader = response.body.getReader()
  let closed = false
  let wrappedController: ReadableStreamDefaultController<Uint8Array> | undefined
  async function closeOnce(outcome: CapabilityCleanupOutcome = { completed: true, failed: false }) {
    if (closed) return
    closed = true
    options.abortSignal?.removeEventListener("abort", onAbort)
    await close(outcome)
  }
  const onAbort = () => {
    const reason = options.abortSignal?.reason ?? new DOMException("[vitehub] Agent Invocation response aborted.", "AbortError")
    if (closed) return
    closed = true
    options.abortSignal?.removeEventListener("abort", onAbort)
    wrappedController?.error(reason)
    void (async () => {
      let outcome: CapabilityCleanupOutcome = { error: reason, failed: true }
      try {
        await reader.cancel(reason)
      }
      catch (error) {
        outcome = { error, failed: true }
      }
      await close(outcome)
    })().catch(() => {})
  }
  const wrapped = new Response(new ReadableStream({
    start(controller) {
      wrappedController = controller
    },
    async cancel(reason) {
      let cancelOutcome: CapabilityCleanupOutcome = reason === undefined ? { completed: false, failed: false } : { error: reason, failed: true }
      try {
        await reader.cancel(reason)
      }
      catch (error) {
        cancelOutcome = { error, failed: true }
        throw error
      }
      finally {
        await closeOnce(cancelOutcome)
      }
    },
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          await closeOnce()
          controller.close()
          return
        }
        options.onChunk?.(result.value)
        controller.enqueue(result.value)
      }
      catch (error) {
        await closeOnce({ error, failed: true })
        throw error
      }
    },
  }), response)
  if (options.abortSignal?.aborted) onAbort()
  else options.abortSignal?.addEventListener("abort", onAbort, { once: true })
  Object.defineProperties(wrapped, {
    redirected: { configurable: true, enumerable: true, value: response.redirected },
    type: { configurable: true, enumerable: true, value: response.type },
    url: { configurable: true, enumerable: true, value: response.url },
  })
  return wrapped
}
