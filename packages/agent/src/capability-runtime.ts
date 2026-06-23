import { resolveRuntimeValue } from "@vite-hub/runtime"

import { hasTrustedWorkspaceAccessScope, hasTrustedWorkspaceSourceResolutionDefinition, workspaceOverrideSymbol } from "./access-runtime.ts"
import { createMessage } from "./messages.ts"
import { createAgentInvocationContextStore } from "./invocation-context.ts"
import { normalizeAgentWorkspaceSource } from "./workspace-source-metadata.ts"
import {
  createFallbackAgentInvoker,
  ensureAgentInvokerContext,
  resolveInputAgentInvoker,
} from "./invoker.ts"
import { runObservedAgentHook } from "./hooks.ts"
import type {
  AgentAdapterInstructionsValue,
  AgentCallbackContext,
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityWorkspaceContribution,
  AgentCapabilityTypeContract,
  AgentCapabilityHookName,
  AgentCapabilityHooks,
  AgentCapabilityMode,
  AgentCapabilityRuntimeContext,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryFinishEffect,
  AgentFinishEvent,
  AgentFinishExtensionProvider,
  AgentHookObserverHooks,
  AgentInstructionBlock,
  AgentInvocationExtensions,
  AgentOutputExtensionProvider,
  AgentInvocationContextStore,
  AgentInvoker,
  AgentModelExecutionInstrumentation,
  AgentModelResolver,
  AgentOutputRenderer,
  AgentProviderToolContribution,
  AgentRunInput,
  AgentRuntimeConfig,
  AgentToolSet,
  AgentToolTransform,
  MaybePromise,
  ResolvedAgentTriggerDefinition,
  ResolvedAgentRuntimeContext,
} from "./types.ts"
import type { WorkspaceOverrideRuntime } from "./access-runtime.ts"
import type { Message } from "./messages.ts"
import type { ReadonlyWorkspaceFacade, WorkspaceDefinition, WorkspaceName, WorkspaceSelectedScope, WorkspaceSource, WorkspaceSourceInput } from "@vite-hub/workspace"

type ResolvedAgentOutputRenderer = ((result: unknown, extensions?: AgentInvocationExtensions) => MaybePromise<unknown>) & {
  providerCount: number
}
const defaultCapabilityRuntimePhases = ["configure", "prepare", "bind", "input", "resolve", "output"] as const
export const channelDeliveryEffectsContextKey = "channel.delivery.effects"
export const channelDeliveryFinishEffectsContextKey = "channel.delivery.finishEffects"
type AgentCapabilityRuntimePhase = typeof defaultCapabilityRuntimePhases[number]

export interface ResolvedAgentFinishExtensionProvider {
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
  invoker?: AgentInvoker
  model?: AgentModelResolver<TRuntimeConfig, Name>
  phases?: readonly AgentCapabilityRuntimePhase[]
  resolveInstructions?: boolean
  resolveTools?: boolean
  workspaceDefinition?: WorkspaceDefinition
}

export interface ResolvedAgentCapabilities {
  capabilityInstructions: AgentInstructionBlock[]
  close: () => Promise<void>
  hasCloseCallbacks: boolean
  input: AgentRunInput
  messages: Message[]
  response?: Response
  registries: AgentCapabilityRegistries
  toolTransforms: AgentToolTransform[]
  tools?: AgentToolSet
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
>(
  capability: AgentCapabilityDefinition<TRuntimeConfig, Name, TTypeContract>,
): AgentCapabilityDefinition<TRuntimeConfig, Name, TTypeContract> {
  if (!capability || typeof capability !== "object") {
    throw new TypeError("[vitehub] defineCapability() requires a capability definition.")
  }
  assertCapabilityId((capability as { id?: unknown }).id)
  return capability
}

export function normalizeMode(value: unknown, label: string): AgentCapabilityMode {
  if (value === undefined) return "read"
  if (value === "read" || value === "write") return value
  throw new TypeError(`[vitehub] ${label} mode must be "read" or "write".`)
}

export function normalizeCapabilities(
  capabilities: AgentCapabilityDefinition[] | undefined,
): AgentCapabilityDefinition[] {
  if (capabilities === undefined) return []
  if (!Array.isArray(capabilities)) {
    throw new TypeError("[vitehub] defineAgent({ capabilities }) must be an ordered array.")
  }
  const seen = new Set<string>()
  return capabilities.map((capability) => {
    const normalized = defineCapability(capability)
    if (seen.has(normalized.id)) {
      throw new Error(`[vitehub] Duplicate capability id "${normalized.id}" in one agent.`)
    }
    seen.add(normalized.id)
    return normalized
  })
}

export function capabilityWorkspaceSources(
  capabilities: AgentCapabilityDefinition[] | undefined,
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

function addInstructionBlock(
  capabilityInstructions: AgentInstructionBlock[],
  capabilityId: string,
  value: AgentAdapterInstructionsValue | false | undefined,
  options?: { id?: string },
) {
  if (value === false || value === undefined) return
  const instructions = (Array.isArray(value) ? value : [value])
    .map(part => part.trim())
    .filter(Boolean)
    .join("\n\n")
  if (instructions) {
    capabilityInstructions.push({
      id: capabilityInstructionBlockId(options?.id || capabilityId),
      instructions,
    })
  }
}

export function capabilityInstructionBlockId(capabilityId: string): string {
  return `capabilities.${capabilityId === "workspace-shell" ? "workspaceShell" : capabilityId}`
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
  typeof import("@vite-hub/workspace"),
  | "createWorkspaceSourceResolutionFacade"
  | "isWorkspaceSourceRequestOnly"
  | "workspaceSourceRequestDescriptorPath"
>

function isRequestOnlyWorkspaceSource(runtime: WorkspaceContributionRuntime, source: WorkspaceSource | undefined): boolean {
  return Boolean(source && runtime.isWorkspaceSourceRequestOnly(source))
}

function normalizedContributionSource(
  key: string,
  source: WorkspaceSourceInput,
  runtime: WorkspaceContributionRuntime,
): { mountPath: string, requestOnly: boolean } {
  const metadata = normalizeAgentWorkspaceSource(key, source)
  return {
    mountPath: metadata.mountPath,
    requestOnly: isRequestOnlyWorkspaceSource(runtime, metadata.source),
  }
}

function sourceScopePath(runtime: WorkspaceContributionRuntime, key: string, source: { mountPath: string, requestOnly: boolean }): string {
  return source.requestOnly ? runtime.workspaceSourceRequestDescriptorPath(key) : source.mountPath
}

function sourcesConflict(left: { mountPath: string, requestOnly: boolean }, right: { mountPath: string, requestOnly: boolean }): boolean {
  if (left.requestOnly || right.requestOnly) return false
  return pathsConflict(left.mountPath, right.mountPath)
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
  const contributionSources: Array<{ key: string, mountPath: string, requestOnly: boolean }> = []

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
    contributionSources.push({ key, ...contributedSource })
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
    if (!selectedScopeContainsSource(runtime, selectedWorkspaceScope, key, contributedSource)) {
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
    if (!contributedSource.requestOnly && await workspacePathExists(workspace, contributedSource.mountPath)) {
      throw new Error(`[vitehub] ${capabilityId}() workspace contribution source "${key}" conflicts with an existing Workspace path at mount "${contributedSource.mountPath}".`)
    }
  }
}

function selectedWorkspaceScopeFromContext(context: AgentInvocationContextStore): WorkspaceSelectedScope | undefined {
  if (!hasTrustedWorkspaceAccessScope(context)) return
  const access = context.get<{ workspaceScope?: { all?: boolean, paths?: readonly string[], role?: string, scope?: string } }>("access")
  const scope = access?.workspaceScope
  if (!scope?.scope) return
  return {
    all: scope.all === true,
    name: scope.scope,
    paths: scope.paths,
    role: scope.role,
  }
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
  source: { mountPath: string, requestOnly: boolean },
): boolean {
  return selectedScopeContainsMount(scope, sourceScopePath(runtime, key, source))
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
    const metadata = normalizeAgentWorkspaceSource(key, source)
    if (metadata.source?.resolve) continue
    const contributedSource = {
      mountPath: metadata.mountPath,
      requestOnly: isRequestOnlyWorkspaceSource(runtime, metadata.source),
    }
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
  },
  workspaceMode: AgentCapabilityMode,
): Promise<{ definition: WorkspaceDefinition, registries: AgentCapabilityRegistries["workspaceContributions"], workspace: ReadonlyWorkspaceFacade<Name> } | undefined> {
  let definition = context.workspaceDefinition
  const registries: AgentCapabilityRegistries["workspaceContributions"] = []
  const workspaceRuntime = await import("@vite-hub/workspace")

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

  if (!registries.length) return
  const selectedWorkspaceScope = selectedWorkspaceScopeFromContext(context.context)
  assertStaticWorkspaceContributionSourcesInScope(registries, definition, selectedWorkspaceScope, workspaceRuntime)
  const sourceResolution = await workspaceRuntime.createWorkspaceSourceResolutionFacade(context.workspace, definition, {
    invocation: {
      context: context.context,
      run: context.run,
    },
    overlay: true,
    selectedWorkspaceScope,
  })
  await assertResolvedWorkspaceContributionSources(
    registries,
    sourceResolution.definition,
    selectedWorkspaceScope,
    context.workspace,
    workspaceRuntime,
  )
  return {
    definition: sourceResolution.definition,
    registries,
    workspace: sourceResolution.workspace,
  }
}

async function resolveInstructionValue<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  capability: AgentCapabilityDefinition<TRuntimeConfig, Name>,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
) {
  const parts = Array.isArray(capability.instructions)
    ? capability.instructions
    : [capability.instructions]
  const values = await Promise.all(parts.map(part => typeof part === "function"
    ? (part as (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<AgentAdapterInstructionsValue | false | undefined>)(context)
    : part))
  return values.flatMap(value => Array.isArray(value) ? value : [value])
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
  ensureAgentInvokerContext(invocationContext, invoker)
  const capabilities = normalizeCapabilities(options?.capabilities as AgentCapabilityDefinition[] | undefined) as AgentCapabilityDefinition<TRuntimeConfig, Name>[]
  validateAccessCapabilityOrder(capabilities)
  let currentInput = normalizeRunInput(input)
  let currentWorkspace = workspace as ReadonlyWorkspaceFacade<Name> | undefined
  let currentWorkspaceDefinition = invocationOptions.workspaceDefinition
  let messages = getRunMessages(currentInput)
  let tools: AgentToolSet | undefined
  const capabilityInstructions: AgentInstructionBlock[] = []
  const closeCallbacks: Array<() => MaybePromise<void>> = []
  let hasCloseWork = false
  const toolTransforms: AgentToolTransform[] = []
  const initialDeliveryEffectIntents = invocationContext.get<AgentChannelDeliveryEffectIntent[]>(channelDeliveryEffectsContextKey) || []
  const initialFinishDeliveryEffectProviders = invocationContext.get<AgentChannelDeliveryFinishEffect[]>(channelDeliveryFinishEffectsContextKey) || []
  const registries: AgentCapabilityRegistries = {
    deliveryEffectIntents: [...initialDeliveryEffectIntents],
    finishDeliveryEffectProviders: [...initialFinishDeliveryEffectProviders],
    finishExtensionProviders: [],
    modelExecutionInstrumentation: [],
    outputExtensionProviders: [],
    outputRenderers: [],
    providerTools: [],
    stateRequirements: [],
    triggers: [],
    workspaceContributions: [],
  }

  async function closeRegisteredCallbacks() {
    const errors: unknown[] = []
    for (const callback of [...closeCallbacks].reverse()) {
      try {
        await callback()
      }
      catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "[vitehub] Multiple capability close callbacks failed.")
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
      ...runtimeContext,
      actor: invoker,
      context: invocationContext,
      fs: currentWorkspace.fs,
      invoker,
      runtimeContext: runtime,
      workspace: currentWorkspace,
      workspaceDefinition: currentWorkspaceDefinition,
    }, workspaceMode)
    if (workspaceContribution) {
      currentWorkspace = workspaceContribution.workspace
      currentWorkspaceDefinition = workspaceContribution.definition
      registries.workspaceContributions = workspaceContribution.registries
    }
  }

  try {
    for (const capability of capabilities) {
      if (capability.id !== "access") await applyWorkspaceContributions()
      await validateCapabilityRuntimeRequirement(capability as AgentCapabilityDefinition, currentWorkspace, workspaceMode)
      const phases = invocationOptions.phases || defaultCapabilityRuntimePhases
      const metadataContext = {
        ...runtimeContext,
        actor: invoker,
        context: invocationContext,
        fs: currentWorkspace?.fs,
        invoker,
        runtimeContext: runtime,
        workspace: currentWorkspace,
        workspaceDefinition: currentWorkspaceDefinition,
      }
      let capabilityContext: AgentCapabilityRuntimeContext<TRuntimeConfig, Name> & WorkspaceOverrideRuntime<Name>
      capabilityContext = {
        ...metadataContext,
        [workspaceOverrideSymbol](nextWorkspace: ReadonlyWorkspaceFacade<Name>) {
          currentWorkspace = nextWorkspace
          capabilityContext.fs = nextWorkspace.fs
          capabilityContext.workspace = nextWorkspace
        },
        capability,
        mode: capability.mode,
        instructions: {
          add(value, options) {
            addInstructionBlock(capabilityInstructions, capability.id, value, options)
          },
        },
        input: {
          get: () => currentInput,
          messages: () => messages,
          set(value) {
            currentInput = normalizeRunInput(value)
            messages = getRunMessages(currentInput)
          },
          setMessages(value) {
            messages = value
            currentInput = withMessages(currentInput, messages)
          },
        },
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
            if (typeof effect !== "function" && (!effect || typeof effect !== "object" || typeof effect.kind !== "string" || !effect.kind.trim())) {
              throw new TypeError("[vitehub] delivery.finishEffect() requires an effect intent or resolver.")
            }
            const next = [...registries.finishDeliveryEffectProviders, effect]
            registries.finishDeliveryEffectProviders = next
            invocationContext.set(channelDeliveryFinishEffectsContextKey, next, { overwrite: true })
          },
        },
        model: {
          async resolve(model) {
            const resolver = model ?? invocationOptions.model
            if (resolver === undefined) {
              throw new Error(`[vitehub] ${capability.id}() requires a model option or an agent model.`)
            }
            return await resolveRuntimeValue(resolver as never, metadataContext as never) as unknown
          },
        },
        modelExecution: {
          instrument(instrumentation) {
            registries.modelExecutionInstrumentation.push(instrumentation)
          },
        },
        output: {
          extensions: createAgentExtensionReader(new Map()),
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
          },
        },
        finish: {
          provide(value) {
            registries.finishExtensionProviders.push({
              id: capability.id,
              resolve: typeof value === "function"
                ? value as AgentFinishExtensionProvider
                : () => value,
            })
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
            tools = { ...tools, ...value }
          },
          transform(transform) {
            toolTransforms.push(transform)
          },
        },
        workspace: currentWorkspace,
      } as AgentCapabilityRuntimeContext<TRuntimeConfig, Name> & WorkspaceOverrideRuntime<Name>

      for (const [name, trigger] of Object.entries(capability.triggers || {})) {
        assertTriggerName(name, capability.id)
        const id = `${capability.id}.${name}` as const
        registries.triggers.push({
          capabilityId: capability.id,
          definition: trigger as never,
          devtools: trigger.devtools,
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
        hasCloseWork = true
        closeCallbacks.push(async () => {
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
            capabilityInstructions,
            close: closeRegisteredCallbacks,
            hasCloseCallbacks: hasCloseWork,
            input: currentInput,
            messages,
            response: result,
            registries,
            toolTransforms,
            tools,
            workspace: currentWorkspace,
          }
        }
      }
      if (capability.id === "access") await applyWorkspaceContributions()

      if (invocationOptions.resolveInstructions !== false && capability.instructions !== undefined) {
        const values = await resolveInstructionValue(capability, capabilityContext)
        for (const value of values) {
          addInstructionBlock(capabilityInstructions, capability.id, value)
        }
      }
      if (invocationOptions.resolveTools !== false && capability.tools) {
        const resolved = await resolveRuntimeValue(capability.tools as never, capabilityContext) as unknown
        if (isToolSet(resolved)) tools = { ...tools, ...resolved }
      }
    }
    await applyWorkspaceContributions()
  }
  catch (error) {
    try {
      await closeRegisteredCallbacks()
    }
    catch (closeError) {
      throw new AggregateError([error, closeError], "[vitehub] Capability setup failed and cleanup also failed.")
    }
    throw error
  }

  return {
    capabilityInstructions,
    close: closeRegisteredCallbacks,
    hasCloseCallbacks: hasCloseWork,
    input: currentInput,
    messages,
    registries,
    toolTransforms,
    tools,
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

export function applyCapabilityInstructionSlots(instructions: string, blocks: AgentInstructionBlock[] = []): string {
  if (!blocks.length) return instructions

  const remaining = [...blocks]
  const used = new Set<string>()
  const slotPattern = /\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/g
  const rendered = instructions.replace(slotPattern, (match, slot: string) => {
    if (slot === "capabilities") {
      return remaining.splice(0).map(block => block.instructions).join("\n\n")
    }

    const selected = blocks.filter(block => block.id === slot)
    if (!selected.length) {
      return match
    }
    if (used.has(slot)) {
      throw new Error(`[vitehub] Duplicate capability instruction slot "${slot}". Use {{ capabilities }} for repeated catch-all insertion.`)
    }
    if (selected.some(block => !remaining.includes(block))) {
      throw new Error(`[vitehub] Capability instruction slot "${slot}" references instructions that were already inserted by another slot.`)
    }
    used.add(slot)
    for (const block of selected) {
      const index = remaining.indexOf(block)
      if (index >= 0) remaining.splice(index, 1)
    }
    return selected.map(block => block.instructions).join("\n\n")
  })

  const appendix = remaining.map(block => block.instructions).join("\n\n")
  return [rendered.trim(), appendix.trim()].filter(Boolean).join("\n\n")
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

export async function applyOutputRenderers(
  result: unknown,
  renderers: ResolvedAgentOutputRenderer[] = [],
  providers: ResolvedAgentOutputExtensionProvider[] = [],
): Promise<unknown> {
  let current = result
  let providerIndex = 0
  const values = new Map<string, unknown>()
  const extensions = createAgentExtensionReader(values)
  for (const renderer of renderers) {
    while (providerIndex < renderer.providerCount) {
      const provider = providers[providerIndex++]
      const value = await provider.resolve({ extensions, result: current })
      if (value !== undefined) values.set(provider.id, value)
    }
    current = await renderer(current, extensions)
  }
  return withOutputExtensionProperties(current, values)
}

function createAgentExtensionReader(values: Map<string, unknown>): AgentInvocationExtensions {
  return {
    get<T = unknown>(capabilityId: string, key?: string): T | undefined {
      const value = values.get(capabilityId)
      if (key === undefined) return value as T | undefined
      if (typeof value !== "object" || value === null) return undefined
      return (value as Record<string, unknown>)[key] as T | undefined
    },
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function withOutputExtensionProperties(result: unknown, values: Map<string, unknown>): unknown {
  if (!isObjectRecord(result)) return result

  const usageTelemetry = values.get("usage-telemetry")
  if (!isObjectRecord(usageTelemetry)) return result

  const usageRecord = usageTelemetry.usageRecord
  if (!isObjectRecord(usageRecord)) return result

  if (result.usageRecord === undefined) result.usageRecord = usageRecord
  if (result.usage === undefined) result.usage = usageRecord.usage
  return result
}

export async function createAgentInvocationExtensions(
  event: Omit<AgentFinishEvent, "extensions">,
  providers: ResolvedAgentFinishExtensionProvider[] = [],
): Promise<AgentFinishEvent["extensions"]> {
  const values = new Map<string, unknown>()
  const extensions = createAgentExtensionReader(values)
  const finishEvent = { ...event, extensions } as AgentFinishEvent
  for (const provider of providers) {
    const value = await provider.resolve(finishEvent)
    if (value !== undefined) {
      values.set(provider.id, value)
    }
  }
  return extensions
}

export function withCapabilityCleanup<T extends AsyncIterable<unknown>>(
  stream: T,
  close: (error?: unknown) => Promise<void>,
): AsyncIterable<unknown> {
  return (async function* () {
    let error: unknown
    let failed = false
    try {
      yield* stream
    }
    catch (caught) {
      failed = true
      error = caught
      throw caught
    }
    finally {
      await close(failed ? error : undefined)
    }
  })()
}

export function withResponseCleanup(response: Response, close: (error?: unknown) => Promise<void>): Response | Promise<Response> {
  if (!response.body) {
    return close().then(() => response)
  }
  const reader = response.body.getReader()
  let closed = false
  async function closeOnce(error?: unknown) {
    if (closed) return
    closed = true
    await close(error)
  }
  return new Response(new ReadableStream({
    async cancel(reason) {
      let cancelError: unknown
      try {
        await reader.cancel(reason)
      }
      catch (error) {
        cancelError = error
        throw error
      }
      finally {
        await closeOnce(cancelError)
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
        controller.enqueue(result.value)
      }
      catch (error) {
        await closeOnce(error)
        throw error
      }
    },
  }), response)
}
