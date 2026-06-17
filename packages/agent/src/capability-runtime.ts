import { resolveRuntimeValue } from "@vite-hub/runtime"

import { workspaceOverrideSymbol } from "./access-runtime.ts"
import { createMessage } from "./messages.ts"
import { createAgentInvocationContextStore } from "./invocation-context.ts"
import {
  createFallbackAgentInvoker,
  ensureAgentInvokerContext,
  resolveInputAgentInvoker,
} from "./invoker.ts"
import type {
  AgentAdapterInstructionsValue,
  AgentCallbackContext,
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityTypeContract,
  AgentCapabilityHookName,
  AgentCapabilityHooks,
  AgentCapabilityMode,
  AgentCapabilityRuntimeContext,
  AgentFinishEvent,
  AgentFinishExtensionProvider,
  AgentInstructionBlock,
  AgentInvocationContextStore,
  AgentInvoker,
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
import type { ReadonlyWorkspaceFacade, WorkspaceDefinition, WorkspaceName } from "@vite-hub/workspace"

type ResolvedAgentOutputRenderer = (result: unknown) => MaybePromise<unknown>
const defaultCapabilityRuntimePhases = ["configure", "prepare", "bind", "input", "resolve", "output"] as const
type AgentCapabilityRuntimePhase = typeof defaultCapabilityRuntimePhases[number]

export interface ResolvedAgentFinishExtensionProvider {
  id: string
  resolve: AgentFinishExtensionProvider
}

export interface AgentCapabilityRegistries {
  finishExtensionProviders: ResolvedAgentFinishExtensionProvider[]
  outputRenderers: ResolvedAgentOutputRenderer[]
  providerTools: AgentProviderToolContribution[]
  stateRequirements: Array<{ name: string, optional?: boolean }>
  triggers: ResolvedAgentTriggerDefinition[]
}

export interface AgentCapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  capabilities?: AgentCapabilityDefinition<TRuntimeConfig, Name>[]
  hooks?: AgentCapabilityHooks<TRuntimeConfig, Name>
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
  registries: AgentCapabilityRegistries
  toolTransforms: AgentToolTransform[]
  tools?: AgentToolSet
  workspace?: ReadonlyWorkspaceFacade
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
  return { ...input, messages: getRunMessages(input) }
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
  agentHooks?: AgentCapabilityHooks<TRuntimeConfig, Name>,
) {
  await context.capability.hooks?.[name]?.(context)
  await agentHooks?.[name]?.(context)
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
  let messages = getRunMessages(currentInput)
  let tools: AgentToolSet | undefined
  const capabilityInstructions: AgentInstructionBlock[] = []
  const closeCallbacks: Array<() => MaybePromise<void>> = []
  const toolTransforms: AgentToolTransform[] = []
  const registries: AgentCapabilityRegistries = {
    finishExtensionProviders: [],
    outputRenderers: [],
    providerTools: [],
    stateRequirements: [],
    triggers: [],
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

  try {
    for (const capability of capabilities) {
      await validateCapabilityRuntimeRequirement(capability as AgentCapabilityDefinition, currentWorkspace, workspaceMode)
      const phases = invocationOptions.phases || defaultCapabilityRuntimePhases
      const metadataContext = {
        ...runtimeContext,
        context: invocationContext,
        fs: currentWorkspace?.fs,
        invoker,
        runtimeContext: runtime,
        workspace: currentWorkspace,
        workspaceDefinition: invocationOptions.workspaceDefinition,
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
        model: {
          async resolve(model) {
            const resolver = model ?? invocationOptions.model
            if (resolver === undefined) {
              throw new Error(`[vitehub] ${capability.id}() requires a model option or an agent model.`)
            }
            return await resolveRuntimeValue(resolver as never, metadataContext as never) as unknown
          },
        },
        output: {
          render(renderer: AgentOutputRenderer) {
            registries.outputRenderers.push(result => renderer(result, capabilityContext))
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
            capability,
            trigger: {
              capabilityId: capability.id,
              id,
              name,
            },
          }, input as never),
          name,
          output: trigger.output,
        })
      }

      closeCallbacks.push(async () => {
        await callHooks("capability:close", capabilityContext, options?.hooks)
        await capability.close?.(capabilityContext)
        await callHooks("capability:close:after", capabilityContext, options?.hooks)
      })

      for (const phase of phases) {
        await callHooks(`capability:${phase}`, capabilityContext, options?.hooks)
        await capability[phase]?.(capabilityContext)
        await callHooks(`capability:${phase}:after`, capabilityContext, options?.hooks)
      }

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
    hasCloseCallbacks: closeCallbacks.length > 0,
    input: currentInput,
    messages,
    registries,
    toolTransforms,
    tools,
    workspace: currentWorkspace,
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
      context: invocationContext,
      fs: workspace?.fs,
      invoker,
      mode: capability.mode,
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
): Promise<unknown> {
  let current = result
  for (const renderer of renderers) {
    current = await renderer(current)
  }
  return current
}

export async function createAgentInvocationExtensions(
  event: Omit<AgentFinishEvent, "extensions">,
  providers: ResolvedAgentFinishExtensionProvider[] = [],
): Promise<AgentFinishEvent["extensions"]> {
  const values = new Map<string, unknown>()
  const extensions: AgentFinishEvent["extensions"] = {
    get<T = unknown>(capabilityId: string, key?: string): T | undefined {
      const value = values.get(capabilityId)
      if (key === undefined) return value as T | undefined
      if (typeof value !== "object" || value === null) return undefined
      return (value as Record<string, unknown>)[key] as T | undefined
    },
  }
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
