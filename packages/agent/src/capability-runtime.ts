import { createAgentMessage } from "./messages.ts"

import type {
  AgentAdapterMetadataContext,
  AgentAdapterRunContext,
  AgentRunInput,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentToolSet,
  MaybePromise,
  ResolvedAgentRuntimeContext,
} from "./types.ts"
import type { AgentMessage } from "./messages.ts"
import type { ReadonlyWorkspaceFacade, WorkspaceName } from "@vitehub/workspace"

export type AgentCapabilityPhase = "configure" | "prepare" | "bind" | "input" | "resolve" | "output" | "close"
export type AgentCapabilityHookName = `capability:${AgentCapabilityPhase}` | `capability:${AgentCapabilityPhase}:after`

export interface AgentInstructionBlock {
  id: string
  instructions: string
}

export type AgentToolTransform = (tools: AgentToolSet | undefined) => MaybePromise<AgentToolSet | undefined>
export type AgentOutputRenderer = (result: unknown, context: AgentCapabilityContext) => MaybePromise<unknown>
type ResolvedAgentOutputRenderer = (result: unknown) => MaybePromise<unknown>

export interface AgentCapabilityRouteContribution {
  handler: string
  method?: string
  route: string
}

export interface AgentCapabilityRuntimeFileContribution {
  contents?: string
  path: string
}

export interface AgentCapabilityRuntimeAliasContribution {
  find: string
  replacement: string
}

export interface AgentCapabilityInvocationContribution {
  handler: (event: unknown) => MaybePromise<unknown>
  name: string
}

export interface AgentCapabilityStateRequirement {
  name: string
  optional?: boolean
}

export interface AgentCapabilityRegistries {
  invocations: AgentCapabilityInvocationContribution[]
  outputRenderers: ResolvedAgentOutputRenderer[]
  routes: AgentCapabilityRouteContribution[]
  runtimeAliases: AgentCapabilityRuntimeAliasContribution[]
  runtimeFiles: AgentCapabilityRuntimeFileContribution[]
  stateRequirements: AgentCapabilityStateRequirement[]
}

export type AgentCapabilityHooks<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = Partial<Record<AgentCapabilityHookName, (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<void>>>

export interface AgentCapabilityDefinition<
  TOptions = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  close?: (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<void>
  bind?: (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<void>
  configure?: (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<void>
  hooks?: AgentCapabilityHooks<TRuntimeConfig, Name>
  id: string
  input?: (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<void>
  instructions?: string | false | ((context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<string | false | undefined>)
  options?: TOptions
  output?: (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<void>
  prepare?: (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<void>
  resolve?: (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<void>
}

export interface AgentCapabilityContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends Omit<AgentAdapterMetadataContext<TRuntimeConfig, Name>, "fs" | "runtime" | "workspace"> {
  capability: AgentCapabilityDefinition<unknown, TRuntimeConfig, Name>
  fs?: ReadonlyWorkspaceFacade<Name>["fs"]
  instructions: {
    add: (instructions: string | false | undefined, options?: { id?: string }) => void
  }
  invocations: {
    add: (name: string, handler: AgentCapabilityInvocationContribution["handler"]) => void
  }
  input: {
    get: () => AgentRunInput
    messages: () => AgentMessage[]
    set: (input: AgentRunInput) => void
    setMessages: (messages: AgentMessage[]) => void
  }
  output: {
    render: (renderer: AgentOutputRenderer) => void
  }
  routes: {
    add: (route: AgentCapabilityRouteContribution) => void
  }
  runtime: {
    alias: (alias: AgentCapabilityRuntimeAliasContribution) => void
    files: {
      add: (file: AgentCapabilityRuntimeFileContribution) => void
    }
  }
  state: {
    require: (name: string, options?: { optional?: boolean }) => void
  }
  tools: {
    add: (tools: AgentToolSet | undefined) => void
    transform: (transform: AgentToolTransform) => void
  }
  workspace?: ReadonlyWorkspaceFacade<Name>
}

export interface AgentCapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  capabilities?: AgentCapabilityDefinition<unknown, TRuntimeConfig, Name>[]
  hooks?: AgentCapabilityHooks<TRuntimeConfig, Name>
}

export interface ResolvedAgentCapabilities {
  capabilityInstructions: AgentInstructionBlock[]
  close: () => Promise<void>
  hasCloseCallbacks: boolean
  input: AgentRunInput
  messages: AgentMessage[]
  registries: AgentCapabilityRegistries
  toolTransforms: AgentToolTransform[]
  tools?: AgentToolSet
}

function getRunMessages(input: AgentRunInput): AgentMessage[] {
  if (input.messages) return input.messages
  if (Array.isArray(input.prompt)) return input.prompt
  return []
}

function withMessages(input: AgentRunInput, messages: AgentMessage[]): AgentRunInput {
  if (input.messages) return { ...input, messages }
  if (Array.isArray(input.prompt)) return { ...input, prompt: messages }
  return { ...input, messages }
}

function assertCapabilityId(id: string) {
  if (!/^[a-z][a-z0-9-_.]*$/i.test(id)) {
    throw new TypeError(`[vitehub] Capability id "${id}" must be a stable identifier.`)
  }
}

export function defineCapability<
  TOptions = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  capability: AgentCapabilityDefinition<TOptions, TRuntimeConfig, Name>,
): AgentCapabilityDefinition<TOptions, TRuntimeConfig, Name> {
  if (!capability || typeof capability !== "object") {
    throw new TypeError("[vitehub] defineCapability() requires a capability object.")
  }
  assertCapabilityId(capability.id)
  return capability
}

async function callHooks<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  name: AgentCapabilityHookName,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
  agentHooks?: AgentCapabilityHooks<TRuntimeConfig, Name>,
) {
  await context.capability.hooks?.[name]?.(context)
  await agentHooks?.[name]?.(context)
}

export async function resolveAgentCapabilities<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: AgentCapabilityOptions<TRuntimeConfig, Name> | undefined,
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput,
  workspace?: ReadonlyWorkspaceFacade<Name>,
): Promise<ResolvedAgentCapabilities> {
  const capabilities = options?.capabilities || []
  const ids = new Set<string>()
  for (const capability of capabilities) {
    assertCapabilityId(capability.id)
    if (ids.has(capability.id)) {
      throw new Error(`[vitehub] Duplicate agent capability "${capability.id}". Each capability can be registered once.`)
    }
    ids.add(capability.id)
  }

  let currentInput = input
  let messages = getRunMessages(currentInput)
  let tools: AgentToolSet | undefined
  const capabilityInstructions: AgentInstructionBlock[] = []
  const closeCallbacks: Array<() => MaybePromise<void>> = []
  const toolTransforms: AgentToolTransform[] = []
  const registries: AgentCapabilityRegistries = {
    invocations: [],
    outputRenderers: [],
    routes: [],
    runtimeAliases: [],
    runtimeFiles: [],
    stateRequirements: [],
  }

  async function closeRegisteredCallbacks() {
    for (const callback of [...closeCallbacks].reverse()) {
      await callback()
    }
  }

  try {
    for (const capability of capabilities) {
      const capabilityContext: AgentCapabilityContext<TRuntimeConfig, Name> = {
        ...runtime,
        capability: capability as AgentCapabilityDefinition<unknown, TRuntimeConfig, Name>,
        fs: workspace?.fs,
        instructions: {
          add(value, blockOptions) {
            if (value === false || value === undefined) return
            const instructions = value.trim()
            if (instructions) {
              capabilityInstructions.push({
                id: blockOptions?.id || capability.id,
                instructions,
              })
            }
          },
        },
        invocations: {
          add(name, handler) {
            if (registries.invocations.some(invocation => invocation.name === name)) {
              throw new Error(`[vitehub] Duplicate capability invocation "${name}".`)
            }
            registries.invocations.push({ handler, name })
          },
        },
        input: {
          get: () => currentInput,
          messages: () => messages,
          set(value) {
            currentInput = value
            messages = getRunMessages(currentInput)
          },
          setMessages(value) {
            messages = value
            currentInput = withMessages(currentInput, messages)
          },
        },
        output: {
          render(renderer) {
            registries.outputRenderers.push(result => renderer(result, capabilityContext))
          },
        },
        routes: {
          add(route) {
            if (registries.routes.some(item => item.route === route.route && (item.method || "POST") === (route.method || "POST"))) {
              throw new Error(`[vitehub] Duplicate capability route "${route.method || "POST"} ${route.route}".`)
            }
            registries.routes.push(route)
          },
        },
        runtime: {
          alias(alias) {
            if (registries.runtimeAliases.some(item => item.find === alias.find)) {
              throw new Error(`[vitehub] Duplicate capability runtime alias "${alias.find}".`)
            }
            registries.runtimeAliases.push(alias)
          },
          files: {
            add(file) {
              if (registries.runtimeFiles.some(item => item.path === file.path)) {
                throw new Error(`[vitehub] Duplicate capability runtime file "${file.path}".`)
              }
              registries.runtimeFiles.push(file)
            },
          },
        },
        state: {
          require(name, stateOptions) {
            if (!registries.stateRequirements.some(requirement => requirement.name === name)) {
              registries.stateRequirements.push({ name, optional: stateOptions?.optional })
            }
          },
        },
        tools: {
          add(value) {
            if (!value) return
            tools = { ...(tools || {}), ...value }
          },
          transform(transform) {
            toolTransforms.push(transform)
          },
        },
        workspace,
      }

      closeCallbacks.push(async () => {
        await callHooks("capability:close", capabilityContext, options?.hooks)
        await capability.close?.(capabilityContext)
        await callHooks("capability:close:after", capabilityContext, options?.hooks)
      })

      for (const phase of ["configure", "prepare", "bind", "input", "resolve", "output"] as const) {
        await callHooks(`capability:${phase}`, capabilityContext, options?.hooks)
        await capability[phase]?.(capabilityContext)
        await callHooks(`capability:${phase}:after`, capabilityContext, options?.hooks)
      }

      if (capability.instructions !== undefined) {
        const value = typeof capability.instructions === "function"
          ? await capability.instructions(capabilityContext)
          : capability.instructions
        capabilityContext.instructions.add(value)
      }
    }
  }
  catch (error) {
    await closeRegisteredCallbacks()
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
  }
}

function levenshtein(left: string, right: string) {
  const costs = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    let prev = i
    for (let j = 1; j <= right.length; j++) {
      const next = left[i - 1] === right[j - 1]
        ? costs[j - 1]
        : Math.min(costs[j - 1], prev, costs[j]) + 1
      costs[j - 1] = prev
      prev = next
    }
    costs[right.length] = prev
  }
  return costs[right.length]
}

function suggestSlot(slot: string, ids: string[]) {
  const matches = ids
    .map(id => ({ distance: levenshtein(slot, id), id }))
    .filter(match => match.distance <= Math.max(2, Math.floor(slot.length / 2)))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map(match => match.id)
  return matches.length ? ` Did you mean ${matches.map(id => `{{ ${id} }}`).join(", ")}?` : ""
}

export function applyCapabilityInstructionSlots(instructions: string, blocks: AgentInstructionBlock[] = []): string {
  if (!blocks.length) return instructions

  const remaining = [...blocks]
  const known = new Set(blocks.map(block => block.id))
  const used = new Set<string>()
  const slotPattern = /\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/g
  const rendered = instructions.replace(slotPattern, (match, slot: string) => {
    if (slot === "capabilities") {
      const value = remaining.splice(0).map(block => block.instructions).join("\n\n")
      return value
    }
    if (!known.has(slot)) {
      throw new Error(`[vitehub] Unknown capability instruction slot "${slot}".${suggestSlot(slot, ["capabilities", ...known])}`)
    }
    if (used.has(slot)) {
      throw new Error(`[vitehub] Duplicate capability instruction slot "${slot}". Use {{ capabilities }} for repeated catch-all insertion.`)
    }
    used.add(slot)
    const selected = remaining.filter(block => block.id === slot)
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

export function appendMessageText(message: AgentMessage, text: string): AgentMessage {
  if (!text.trim()) return message
  return createAgentMessage({
    createdAt: message.createdAt,
    id: message.id,
    metadata: message.metadata,
    parts: [
      ...message.parts,
      { id: `text-${message.parts.length}`, text, type: "text" },
    ],
    role: message.role,
  })
}
