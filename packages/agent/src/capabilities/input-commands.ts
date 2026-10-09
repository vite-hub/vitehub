import { getCapability, resolveRuntimeValue } from "@vite-hub/runtime"

import { agentInvocationId } from "../invocations.ts"
import { hasRuntimeType } from "../internal/runtime-type.ts"
import { defineCapability } from "../capability-runtime.ts"
import {
  getMessageText,
  validateMessage,
} from "../messages.ts"

import type {
  AgentChannelDeliveryEffectIntent,
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentFinishEvent,
  AgentRunCallbackContext,
  AgentRunInput,
  MaybePromise,
} from "../types.ts"
import type { Message } from "../messages.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"

export interface InputCommandDeliveryMessage {
  react: (content: string, options?: { transient?: boolean }) => Promise<void>
  reply: (body: string) => Promise<void>
  update: (body: string) => Promise<void>
}

export interface InputCommandAgentInputHookContext extends AgentRunCallbackContext {
  args: string
  command: InputCommand
  message: InputCommandDeliveryMessage
  name: string
  text: string
}

export interface InputCommandAgentFinishHookContext extends AgentFinishEvent {
  args: string
  command: InputCommand
  message: InputCommandDeliveryMessage
  name: string
  text: string
}

export interface InputCommandHooks {
  "agent:finish"?: (context: InputCommandAgentFinishHookContext) => MaybePromise<void>
  "agent:input"?: (context: InputCommandAgentInputHookContext) => MaybePromise<void>
}

export type InputCommandCall = (input: InputCommandRunInput) => MaybePromise<InputCommandResult>

export interface InputCommand {
  call?: InputCommandCall
  channels?: readonly string[]
  description?: string
  hooks?: InputCommandHooks
}

export type InputCommandResult = Partial<AgentRunInput> | Response | string | void

export interface ViteHubInputCommandContext {}

export interface InputCommandRuntimeContext extends AgentCapabilityRuntimeContext, ViteHubInputCommandContext {
  invocation: AgentCapabilityRuntimeContext["invocation"] & { id?: string }
  reply: (body: string) => Promise<Response>
}

export interface InputCommandRunInput {
  args: string
  command: InputCommand
  context: InputCommandRuntimeContext
  input: AgentRunInput
  message?: Message
  name: string
  text: string
}

export interface InputCommandsOptions {
  commands: Record<string, InputCommand>
  id?: string
  trigger?: string
}

export interface InputCommandInvocation {
  args: string
  end: number
  name: string
  start: number
  text: string
}

export interface InputCommandTarget {
  message?: Message
  messageIndex?: number
  messages?: Message[]
  text: string
  type: "message" | "prompt"
}

export interface InputCommandTextReplacement {
  end: number
  replacement: string
  start: number
}

let transientReactionId = 0

export function assertInputCommandName(name: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw agentDiagnostics.AGENT_R0096({ message: `[vitehub] Input command "${name}" must be a lowercase stable identifier.` })
  }
}

function normalizeInputCommands(options: InputCommandsOptions): Record<string, InputCommand> {
  if (!options || !hasRuntimeType(options, "object") || !options.commands || !hasRuntimeType(options.commands, "object") || Array.isArray(options.commands)) {
    throw agentDiagnostics.AGENT_R0097({ message: "[vitehub] inputCommands({ commands }) requires a command map." })
  }
  for (const [name, command] of Object.entries(options.commands)) {
    assertInputCommandName(name)
    if (!command || !hasRuntimeType(command, "object")) {
      throw agentDiagnostics.AGENT_R0098({ message: `[vitehub] Input command "${name}" must be an object.` })
    }
    if (command.description !== undefined && (!hasRuntimeType(command.description, "string") || !command.description.trim())) {
      throw agentDiagnostics.AGENT_R0099({ message: `[vitehub] Input command "${name}" description must be a non-empty string.` })
    }
    if (command.channels !== undefined && (!Array.isArray(command.channels) || command.channels.some(channel => !hasRuntimeType(channel, "string") || !channel.trim()))) {
      throw agentDiagnostics.AGENT_R0100({ message: `[vitehub] Input command "${name}" channels must be non-empty Channel IDs.` })
    }
  }
  return options.commands
}

export function normalizeInputCommandTrigger(trigger: unknown): string {
  if (trigger === undefined) return "/"
  if (!hasRuntimeType(trigger, "string") || !trigger) {
    throw agentDiagnostics.AGENT_R0101({ message: "[vitehub] inputCommands({ trigger }) must be a non-empty string." })
  }
  if (/\s/.test(trigger)) {
    throw agentDiagnostics.AGENT_R0102({ message: "[vitehub] inputCommands({ trigger }) must not contain whitespace." })
  }
  return trigger
}

function isInputCommandBoundary(value: string | undefined): boolean {
  return value === undefined || /\s/.test(value)
}

function trimEndIndex(text: string, start: number, end: number): number {
  let index = end
  while (index > start && /\s/.test(text[index - 1]!)) index--
  return index
}

export function findInputCommandInvocation(
  text: string,
  trigger: string,
  commands: Record<string, InputCommand>,
  from = 0,
): InputCommandInvocation | undefined {
  let current: { afterName: number, name: string, start: number } | undefined
  for (let index = Math.max(0, from); index < text.length; index++) {
    if (!text.startsWith(trigger, index) || !isInputCommandBoundary(text[index - 1])) continue
    const nameStart = index + trigger.length
    const match = /^[a-z][a-z0-9_-]*/.exec(text.slice(nameStart))
    if (!match) continue
    const name = match[0]
    if (!Object.hasOwn(commands, name) || !commands[name]) continue
    const afterName = nameStart + name.length
    if (!isInputCommandBoundary(text[afterName])) continue

    if (current) {
      const end = trimEndIndex(text, current.start, index)
      const args = text.slice(current.afterName, end).trim()
      return {
        args,
        end,
        name: current.name,
        start: current.start,
        text: text.slice(current.start, end),
      }
    }

    current = { afterName, name, start: index }
    index = afterName - 1
  }

  if (current) {
    const args = text.slice(current.afterName).trim()
    return {
      args,
      end: text.length,
      name: current.name,
      start: current.start,
      text: text.slice(current.start),
    }
  }
}

interface InputCommandInvocationCounts {
  byName: Map<string, number>
  total: number
}

function countInputCommandInvocations(
  text: string,
  trigger: string,
  commands: Record<string, InputCommand>,
): InputCommandInvocationCounts {
  const byName = new Map<string, number>()
  let total = 0
  let cursor = 0
  while (cursor <= text.length) {
    const invocation = findInputCommandInvocation(text, trigger, commands, cursor)
    if (!invocation) break
    total++
    byName.set(invocation.name, (byName.get(invocation.name) || 0) + 1)
    cursor = Math.max(invocation.end, invocation.start + 1)
  }
  return { byName, total }
}

function latestUserMessageIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return index
  }
  return -1
}

export function getInputCommandTarget(input: AgentRunInput): InputCommandTarget | undefined {
  if (hasRuntimeType(input.prompt, "string") && !input.messages) {
    return { text: input.prompt, type: "prompt" }
  }

  const messages = input.messages || (Array.isArray(input.prompt) ? input.prompt : undefined)
  if (!messages) return
  const messageIndex = latestUserMessageIndex(messages)
  if (messageIndex < 0) {
    return hasRuntimeType(input.prompt, "string")
      ? { text: input.prompt, type: "prompt" }
      : undefined
  }
  const message = messages[messageIndex]!
  return {
    message,
    messageIndex,
    messages,
    text: getMessageText(message),
    type: "message",
  }
}

export function replaceMessageTextParts(message: Message, replacement: InputCommandTextReplacement): Message {
  let offset = 0
  let inserted = false
  let touched = false
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "text") return part

      const partStart = offset
      const partEnd = partStart + part.text.length
      offset = partEnd
      if (partEnd <= replacement.start || partStart >= replacement.end) return part

      touched = true
      const before = replacement.start > partStart ? part.text.slice(0, replacement.start - partStart) : ""
      const after = replacement.end < partEnd ? part.text.slice(replacement.end - partStart) : ""
      const text = `${before}${inserted ? "" : replacement.replacement}${after}`
      inserted = true
      return { ...part, text }
    }).concat(touched ? [] : [{ id: "text-0", text: replacement.replacement, type: "text" }]),
  }
}

export function replaceTargetText(
  input: AgentRunInput,
  target: InputCommandTarget,
  text: string,
  replacement?: InputCommandTextReplacement,
): AgentRunInput {
  if (target.type === "prompt") return { ...input, prompt: text }

  const nextMessage: Message = replacement
    ? replaceMessageTextParts(target.message!, replacement)
    : { ...target.message!, parts: [{ id: "text-0", text, type: "text" }, ...target.message!.parts.filter(part => part.type !== "text")] }
  validateMessage(nextMessage)
  const messages = [...(target.messages || [])]
  messages[target.messageIndex!] = nextMessage
  if (!input.messages) return { ...input, prompt: messages }
  const next = { ...input, messages }
  if (hasRuntimeType(next.prompt, "string")) delete next.prompt
  return next
}

function inputCommandChangesText(result: Partial<AgentRunInput>): boolean {
  return result.message !== undefined || result.messages !== undefined || result.prompt !== undefined
}

function removeInputCommandText(input: AgentRunInput, target: InputCommandTarget, invocation: InputCommandInvocation): AgentRunInput {
  const before = target.text.slice(0, invocation.start).replace(/\s+$/, "")
  const after = target.text.slice(invocation.end).replace(/^\s+/, "")
  const text = before && after ? `${before} ${after}` : before || after
  return replaceTargetText(input, target, text, {
    end: target.text.length,
    replacement: text,
    start: 0,
  })
}

function commandReplacementText(targetText: string, invocation: InputCommandInvocation, replacement: string): string {
  if (replacement || targetText.slice(0, invocation.start).trim() || targetText.slice(invocation.end).trim()) {
    return replacement
  }
  return invocation.text
}

// An empty replacement also removes the whitespace after the command, or before
// it at the end of the text. Otherwise each removed command leaves a separator,
// and a long expansion grows the text that every later step must copy and scan.
function commandReplacementRange(targetText: string, invocation: InputCommandInvocation, replacement: string): { start: number, end: number } {
  if (replacement) return { start: invocation.start, end: invocation.end }
  let end = invocation.end
  while (end < targetText.length && /\s/.test(targetText[end]!)) end++
  if (end > invocation.end) return { start: invocation.start, end }
  let start = invocation.start
  while (start > 0 && /\s/.test(targetText[start - 1]!)) start--
  return { start, end }
}

function mergeInputCommandResult(input: AgentRunInput, result: Partial<AgentRunInput>): AgentRunInput {
  const next: AgentRunInput = {
    ...input,
    ...result,
    context: result.context
      ? { ...input.context, ...result.context }
      : input.context,
  }
  if (result.messages !== undefined && result.prompt === undefined) {
    delete next.prompt
  }
  if (result.prompt !== undefined && result.messages === undefined) {
    delete next.messages
  }
  return next
}

function inputCommandCall(command: InputCommand): InputCommandCall {
  return command.call || (() => undefined)
}

function activeChannelId(context: AgentCapabilityRuntimeContext): string | undefined {
  return context.run?.channelId || context.context.get("agent.trigger")?.channelId
}

function commandAllowsCurrentChannel(command: InputCommand, context: AgentCapabilityRuntimeContext): boolean {
  return !command.channels?.length || command.channels.includes(activeChannelId(context) || "")
}

function createInputCommandMessage(
  emit: (intent: AgentChannelDeliveryEffectIntent, options?: { transient?: boolean }) => void,
): InputCommandDeliveryMessage {
  return {
    async react(content, options) {
      const key = options?.transient === false ? undefined : `input-command:${++transientReactionId}`
      emit({
        kind: "reaction",
        metadata: key ? { transient: true, transientKey: key } : undefined,
        payload: { content },
      }, { transient: Boolean(key) })
    },
    async reply(body) {
      emit({ kind: "reply", payload: body })
    },
    async update(body) {
      emit({ kind: "update", payload: body })
    },
  }
}

function inputPhaseMessage(context: AgentCapabilityRuntimeContext): InputCommandDeliveryMessage {
  return createInputCommandMessage((intent, options) => {
    context.delivery.effect(intent)
    if (options?.transient && hasRuntimeType(intent.metadata?.transientKey, "string")) {
      context.delivery.finishEffect(() => ({
        kind: intent.kind,
        metadata: {
          transient: true,
          transientKey: intent.metadata!.transientKey,
        },
        payload: {
          action: "remove",
          // SAFETY: Input command parsing establishes the asserted command contract.
          content: hasRuntimeType(intent.payload, "string") ? intent.payload : (intent.payload as { content?: unknown } | undefined)?.content,
        },
      }))
    }
  })
}

async function inputCommandRuntimeContext(context: AgentCapabilityRuntimeContext): Promise<InputCommandRuntimeContext> {
  const capabilities = await Promise.all(Object.keys(context.capabilities).map(async (name) => {
    if (name in context) return [] as const
    const value = getCapability(context, name).value
    if (value === false || value === undefined) return [] as const
    return [name, await resolveRuntimeValue(value, context)] as const
  }))
  const message = inputPhaseMessage(context)
  const id = context.run?.runId && context.agentIdentity?.name
    ? await agentInvocationId(context.run.runId, context.agentIdentity.name)
    : undefined
  const invocation: InputCommandRuntimeContext["invocation"] = { ...context.invocation }
  if (id) invocation.id = id
  return {
    ...context,
    ...Object.fromEntries(capabilities.filter(entry => entry.length === 2)),
    invocation,
    async reply(body) {
      await message.reply(body)
      return new Response(null, { status: 204 })
    },
  }
}

function finishPhaseMessage(effects: AgentChannelDeliveryEffectIntent[]): InputCommandDeliveryMessage {
  return createInputCommandMessage(intent => effects.push(intent))
}

async function runInputCommandInputHook(
  command: InputCommand,
  context: AgentCapabilityRuntimeContext,
  invocation: InputCommandInvocation,
): Promise<void> {
  const hook = command.hooks?.["agent:input"]
  if (!hook) return
  const input = context.input.get()
  // SAFETY: Input command parsing establishes the asserted command contract.
  await hook({
    ...context,
    args: invocation.args,
    command,
    input,
    message: inputPhaseMessage(context),
    name: invocation.name,
    text: invocation.text,
  } as InputCommandAgentInputHookContext)
}

function scheduleInputCommandFinishHook(
  command: InputCommand,
  context: AgentCapabilityRuntimeContext,
  invocation: InputCommandInvocation,
): void {
  const hook = command.hooks?.["agent:finish"]
  if (!hook) return
  context.delivery.finishEffect(async (context) => {
    const effects: AgentChannelDeliveryEffectIntent[] = []
    // SAFETY: Input command parsing establishes the asserted command contract.
    await hook({
      ...context.event,
      args: invocation.args,
      command,
      message: finishPhaseMessage(effects),
      name: invocation.name,
      text: invocation.text,
    } as InputCommandAgentFinishHookContext)
    return effects.length ? effects : false
  })
}

function inputCommandNumericDepth(args: string | undefined): number | undefined {
  const match = args?.match(/^\s*(\d+)(?:\s|$)/)
  if (!match) return
  const depth = Number(match[1])
  return Number.isSafeInteger(depth) ? depth : undefined
}

// Keep a finite resource bound for numeric chains, while allowing chains whose
// decreasing measure is larger than the ordinary command budget.
const MAX_NUMERIC_EXPANSION_DEPTH = 1_000_000
const MAX_NUMERIC_EXPANSION_WORK = 1_000_000

export function inputCommands(options: InputCommandsOptions): AgentCapabilityDefinition {
  const commands = normalizeInputCommands(options)
  const trigger = normalizeInputCommandTrigger(options.trigger)
  return defineCapability({
    id: options.id || "inputCommands",
    metadata: {
      commands: Object.fromEntries(Object.entries(commands).map(([name, command]) => {
        const metadata: { channels?: string[], description?: string } = {}
        if (command.channels?.length) metadata.channels = [...command.channels]
        if (command.description) metadata.description = command.description
        return [name, metadata]
      })),
      trigger,
    },
    input: async (context) => {
      let input = context.input.get()
      let target = getInputCommandTarget(input)
      if (!target) return

      let text = target.text
      let cursor = 0
      let runs = 0
      let numericExpansionWork = 0
      let maxRuns = Math.max(1_000, text.length + 1)
      const creditedGrowth = new Set<string>()
      const blockedTransitions = new Set<string>()
      const transitionGraph = new Map<string, Set<string>>()
      const creditedCyclicTransitions = new Set<string>()
      const numericTransitionDepths = new Map<string, number>()
      let transitionLineage: string[] = []
      let budgetText: string | undefined
      let budgetCommand: string | undefined
      let budgetArgs: string | undefined
      let budgetInvocationRange: { start: number, end: number } | undefined
      let budgetReplacementRange: { start: number, end: number } | undefined
      const invocationCounts = new Map<string, InputCommandInvocationCounts>()
      const cacheInvocationCounts = (value: string, counts: InputCommandInvocationCounts): void => {
        invocationCounts.set(value, counts)
        // Keep the budget, current, and next snapshots available for reuse.
        if (invocationCounts.size > 3) invocationCounts.delete(invocationCounts.keys().next().value!)
      }
      const getInvocationCounts = (value: string): InputCommandInvocationCounts => {
        const cached = invocationCounts.get(value)
        if (cached) return cached
        const counts = countInputCommandInvocations(value, trigger, commands)
        cacheInvocationCounts(value, counts)
        return counts
      }
      const updateInvocationCounts = (previous: string, next: string): void => {
        const previousCounts = getInvocationCounts(previous)
        let start = 0
        while (start < previous.length && start < next.length && previous[start] === next[start]) start++
        let previousEnd = previous.length
        let nextEnd = next.length
        while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) {
          previousEnd--
          nextEnd--
        }
        // A changed slice can split a token when a mutation edits inside a
        // command. Fall back to a complete count in that case.
        const boundarySafe = (value: string, begin: number, end: number): boolean =>
          (begin === 0 || /\s/.test(value[begin - 1]!))
          && (end === value.length || /\s/.test(value[end]!))
        if (!boundarySafe(previous, start, previousEnd) || !boundarySafe(next, start, nextEnd)) {
          cacheInvocationCounts(next, countInputCommandInvocations(next, trigger, commands))
          return
        }
        const removed = countInputCommandInvocations(previous.slice(start, previousEnd), trigger, commands)
        const added = countInputCommandInvocations(next.slice(start, nextEnd), trigger, commands)
        const byName = new Map(previousCounts.byName)
        for (const [name, count] of removed.byName) byName.set(name, (byName.get(name) || 0) - count)
        for (const [name, count] of added.byName) byName.set(name, (byName.get(name) || 0) + count)
        cacheInvocationCounts(next, { byName, total: previousCounts.total - removed.total + added.total })
      }
      const canReenterLineage = (value: string): boolean => {
        if (!transitionLineage.length) return false
        const reachesLineage = (name: string, seen: Set<string>): boolean => {
          if (transitionLineage.includes(name)) return true
          if (seen.has(name)) return false
          seen.add(name)
          return [...(transitionGraph.get(name) || [])].some(successor => reachesLineage(successor, seen))
        }
        let invocation = findInputCommandInvocation(value, trigger, commands)
        while (invocation) {
          if (reachesLineage(invocation.name, new Set())) return true
          invocation = findInputCommandInvocation(value, trigger, commands, Math.max(invocation.end, invocation.start + 1))
        }
        return false
      }
      while (cursor <= text.length) {
        // Each registered command can credit growth or a new rewrite stage only once.
        // Repeated or alternating recursive handlers cannot keep raising the allowance.
        if (budgetText !== undefined && text !== budgetText) {
          const nextCounts = getInvocationCounts(text)
          const previousCounts = getInvocationCounts(budgetText)
          const nextRuns = nextCounts.total
          const previousRuns = previousCounts.total
          const addedRuns = Math.max(0, nextRuns - previousRuns)
          if (budgetCommand !== undefined) {
            const previousOwnRuns = previousCounts.byName.get(budgetCommand) || 0
            const nextOwnRuns = nextCounts.byName.get(budgetCommand) || 0
            const advancesStage = nextOwnRuns < previousOwnRuns && nextRuns - nextOwnRuns > previousRuns - previousOwnRuns
            const finiteStage = nextOwnRuns === 0 && addedRuns > 0
            const ownGrowth = nextOwnRuns > previousOwnRuns && !creditedGrowth.has(budgetCommand)
            // Only record transitions into rewritten command tokens. Unchanged
            // siblings can move when a replacement changes the prompt length.
            let nextInvocation = findInputCommandInvocation(text, trigger, commands, cursor)
            // Channel-skipped tokens must not hide the next executable rewrite.
            // SAFETY: Parsed invocations are registered command names.
            while (nextInvocation && !commandAllowsCurrentChannel(commands[nextInvocation.name]!, context as AgentCapabilityRuntimeContext)) {
              nextInvocation = findInputCommandInvocation(text, trigger, commands, nextInvocation.end)
            }
            let changedRange = budgetReplacementRange
            let revealsBoundaryCommand = false
            if (nextInvocation && nextInvocation.name !== budgetCommand && !changedRange) {
              let start = 0
              while (start < budgetText.length && start < text.length && budgetText[start] === text[start]) start++
              let previousEnd = budgetText.length
              let end = text.length
              while (previousEnd > start && end > start && budgetText[previousEnd - 1] === text[end - 1]) {
                previousEnd--
                end--
              }
              changedRange = { start, end }
              // The changed separator can reveal a command in the unchanged suffix.
              revealsBoundaryCommand = previousEnd > 0 && !/\s/.test(budgetText[previousEnd - 1]!)
                && end > 0 && /\s/.test(text[end - 1]!)
            }
            // Every generated child must decrease the numeric measure. Checking
            // only the first child misses a recursive sibling with unchanged depth.
            let finiteSameCommandGrowth = false
            const depth = inputCommandNumericDepth(budgetArgs)
            if (depth !== undefined && budgetCommand === nextInvocation?.name && budgetInvocationRange) {
              let replacementRange = budgetReplacementRange
              if (!replacementRange) {
                const prefix = budgetText.slice(0, budgetInvocationRange.start)
                const suffix = budgetText.slice(budgetInvocationRange.end)
                if (text.startsWith(prefix) && text.endsWith(suffix) && text.length >= prefix.length + suffix.length) {
                  replacementRange = { start: prefix.length, end: text.length - suffix.length }
                }
              }
              // For broader input mutations, check the whole input conservatively.
              const replacement = replacementRange ? text.slice(replacementRange.start, replacementRange.end) : text
              let child = findInputCommandInvocation(replacement, trigger, commands)
              finiteSameCommandGrowth = child !== undefined
              while (child) {
                const childDepth = inputCommandNumericDepth(child.args)
                if (child.name !== budgetCommand || childDepth === undefined || childDepth >= depth) {
                  finiteSameCommandGrowth = false
                  break
                }
                child = findInputCommandInvocation(replacement, trigger, commands, Math.max(child.end, child.start + 1))
              }
            }
            const introducesNextInvocation = nextInvocation && nextInvocation.name !== budgetCommand && changedRange
              && (nextInvocation.start < changedRange.end || (nextInvocation.start === changedRange.end
                && revealsBoundaryCommand))
              && nextInvocation.start + trigger.length + nextInvocation.name.length > changedRange.start
            let cycleDetected = false
            let numericTransitionBlocked = false
            let generatedNumericDecrease = false
            const budgetDepth = inputCommandNumericDepth(budgetArgs)
            const nextDepth = inputCommandNumericDepth(nextInvocation?.args)
            let advancesNumericStage = Boolean(
              budgetDepth !== undefined && nextDepth !== undefined && nextDepth < budgetDepth
              // Same-command fan-out must decrease every child, including siblings.
              && (nextInvocation?.name !== budgetCommand || finiteSameCommandGrowth || generatedNumericDecrease),
            )
            // Keep every generated edge after leading commands finish and are removed.
            // A cyclic edge can receive credit once, but cannot renew it indefinitely.
            let graphCreditBlocked = false
            if (budgetDepth !== undefined && budgetDepth > MAX_NUMERIC_EXPANSION_DEPTH) {
              graphCreditBlocked = true
            } else if (budgetDepth !== undefined && nextDepth !== undefined && (nextDepth >= budgetDepth || (nextDepth === 0 && nextRuns <= 1))) {
              graphCreditBlocked = true
            }
            if (changedRange) {
              const generatedNames = new Set<string>()
              const generatedText = text.slice(changedRange.start, changedRange.end)
              generatedNumericDecrease = budgetDepth !== undefined
              let generatedSameCommand = false
              let generated = findInputCommandInvocation(generatedText, trigger, commands)
              while (generated) {
                const generatedDepth = inputCommandNumericDepth(generated.args)
                if (generated.name === budgetCommand) {
                  generatedSameCommand = true
                  if (generatedDepth === undefined || budgetDepth === undefined || generatedDepth >= budgetDepth) generatedNumericDecrease = false
                }
                // SAFETY: Input command parsing only yields registered command names.
                if (generated.name !== budgetCommand && commandAllowsCurrentChannel(commands[generated.name]!, context as AgentCapabilityRuntimeContext)) {
                  generatedNames.add(generated.name)
                  const successors = transitionGraph.get(budgetCommand) || new Set<string>()
                  successors.add(generated.name)
                  transitionGraph.set(budgetCommand, successors)
                }
                generated = findInputCommandInvocation(generatedText, trigger, commands, Math.max(generated.end, generated.start + 1))
              }
              if (!generatedSameCommand) generatedNumericDecrease = false
              const reachesBudget = (name: string, seen: Set<string>): boolean => {
                if (name === budgetCommand) return true
                if (seen.has(name)) return false
                seen.add(name)
                return [...(transitionGraph.get(name) || [])].some(successor => reachesBudget(successor, seen))
              }
              for (const successor of generatedNames) {
                if (!reachesBudget(successor, new Set())) continue
                const transition = `${budgetCommand}->${successor}`
                if (creditedCyclicTransitions.has(transition) && !advancesNumericStage && !generatedNumericDecrease) graphCreditBlocked = true
                creditedCyclicTransitions.add(transition)
              }
            }
            advancesNumericStage = Boolean(
              budgetDepth !== undefined && nextDepth !== undefined && nextDepth < budgetDepth
              && (nextInvocation?.name !== budgetCommand || finiteSameCommandGrowth || generatedNumericDecrease),
            )
            if (introducesNextInvocation && nextInvocation) {
              if (!transitionLineage.length) transitionLineage.push(budgetCommand)
              const transition = `${budgetCommand}->${nextInvocation.name}`
              if (advancesNumericStage && nextInvocation.name !== budgetCommand) {
                const previousDepth = numericTransitionDepths.get(transition)
                if (previousDepth !== undefined && budgetDepth! >= previousDepth) {
                  numericTransitionBlocked = true
                } else {
                  numericTransitionDepths.set(transition, budgetDepth!)
                }
              }
              const transitionWasBlocked = blockedTransitions.has(transition)
              const cycleStart = transitionLineage.indexOf(nextInvocation.name)
              if (cycleStart >= 0 && !transitionWasBlocked) {
                cycleDetected = true
                for (let index = cycleStart; index < transitionLineage.length - 1; index++) {
                  blockedTransitions.add(`${transitionLineage[index]}->${transitionLineage[index + 1]}`)
                }
                blockedTransitions.add(transition)
              } else {
                transitionLineage.push(nextInvocation.name)
              }
            } else if (!finiteSameCommandGrowth) {
              transitionLineage = []
              blockedTransitions.clear()
              creditedCyclicTransitions.clear()
              numericTransitionDepths.clear()
            }
            if (!graphCreditBlocked && !numericTransitionBlocked && (!nextInvocation || cycleDetected || advancesNumericStage
              || !blockedTransitions.has(`${budgetCommand}->${nextInvocation.name}`))
              && (finiteStage || advancesStage || ownGrowth || finiteSameCommandGrowth || advancesNumericStage)) {
              // Credit the rewritten invocation too, which may consume the base allowance.
              maxRuns += (addedRuns > 0 ? addedRuns : nextRuns) + 1
              if (ownGrowth) creditedGrowth.add(budgetCommand)
            }
          }
        }
        budgetText = undefined
        budgetCommand = undefined
        budgetArgs = undefined
        budgetInvocationRange = undefined
        budgetReplacementRange = undefined
        const invocation = findInputCommandInvocation(text, trigger, commands, cursor)
        if (!invocation) break
        if (++runs > maxRuns) throw agentDiagnostics.AGENT_R0103({ message: "[vitehub] inputCommands exceeded the maximum command expansion depth." })

        const command = commands[invocation.name]!
        // SAFETY: Input command parsing establishes the asserted command contract.
        if (!commandAllowsCurrentChannel(command, context as AgentCapabilityRuntimeContext)) {
          cursor = invocation.end
          continue
        }
        if (inputCommandNumericDepth(invocation.args) !== undefined
          && ++numericExpansionWork > MAX_NUMERIC_EXPANSION_WORK) {
          throw agentDiagnostics.AGENT_R0103({ message: "[vitehub] inputCommands exceeded the maximum command expansion depth." })
        }
        budgetText = text
        budgetCommand = invocation.name
        budgetArgs = invocation.args
        budgetInvocationRange = { start: invocation.start, end: invocation.end }
        if (transitionLineage.length && transitionLineage[transitionLineage.length - 1] !== invocation.name) {
          transitionLineage = []
        }
        const result = await inputCommandCall(command)({
          args: invocation.args,
          command,
          // SAFETY: Input command parsing establishes the asserted command contract.
          context: await inputCommandRuntimeContext(context as AgentCapabilityRuntimeContext),
          input,
          message: target.message,
          name: invocation.name,
          text: invocation.text,
        })
        // SAFETY: Input command parsing establishes the asserted command contract.
        scheduleInputCommandFinishHook(command, context as AgentCapabilityRuntimeContext, invocation)
        if (result instanceof Response) return result

        const previousText = text
        input = context.input.get()
        target = getInputCommandTarget(input)
        if (!target) return
        text = target.text

        if (hasRuntimeType(result, "string")) {
          if (text.slice(invocation.start, invocation.end) !== invocation.text) {
            cursor = text === previousText ? invocation.end : 0
            continue
          }
          const replacement = commandReplacementText(text, invocation, result)
          const range = commandReplacementRange(text, invocation, replacement)
          const nextText = `${text.slice(0, range.start)}${replacement}${text.slice(range.end)}`
          if (budgetText === text && nextText !== text) {
            budgetReplacementRange = { start: range.start, end: range.start + replacement.length }
            // The invocation has whitespace boundaries, so only its replacement
            // can add or remove commands. Preserve counts for unchanged siblings.
            const previousCounts = getInvocationCounts(text)
            const replacementCounts = countInputCommandInvocations(replacement, trigger, commands)
            const byName = new Map(previousCounts.byName)
            byName.set(invocation.name, (byName.get(invocation.name) || 0) - 1)
            for (const [name, count] of replacementCounts.byName) {
              byName.set(name, (byName.get(name) || 0) + count)
            }
            cacheInvocationCounts(nextText, {
              byName,
              total: previousCounts.total - 1 + replacementCounts.total,
            })
          }
          text = nextText
          input = replaceTargetText(input, target, text, {
            end: range.end,
            replacement,
            start: range.start,
          })
          context.input.set(input)
          target = getInputCommandTarget(input)
          if (!target) return
          // SAFETY: Input command parsing establishes the asserted command contract.
          await runInputCommandInputHook(command, context as AgentCapabilityRuntimeContext, invocation)
          cursor = replacement === invocation.text ? invocation.end : range.start
          continue
        }

        if (result && hasRuntimeType(result, "object")) {
          const changesText = inputCommandChangesText(result)
          input = mergeInputCommandResult(input, result)
          context.input.set(input)
          target = getInputCommandTarget(input)
          if (!target) return
          text = target.text
          if (text !== previousText) {
            updateInvocationCounts(previousText, text)
            // SAFETY: Input command parsing establishes the asserted command contract.
            await runInputCommandInputHook(command, context as AgentCapabilityRuntimeContext, invocation)
            cursor = 0
            continue
          }
          if (changesText) {
            // SAFETY: Input command parsing establishes the asserted command contract.
            await runInputCommandInputHook(command, context as AgentCapabilityRuntimeContext, invocation)
            cursor = invocation.end
            continue
          }
        }

        if (text.slice(invocation.start, invocation.end) === invocation.text) {
          if (text === previousText && !command.hooks?.["agent:input"]) {
            budgetText = undefined
            budgetCommand = undefined
          }
          input = removeInputCommandText(input, target, invocation)
          context.input.set(input)
          target = getInputCommandTarget(input)
          if (!target) return
          const previousCounts = invocationCounts.get(text)
          if (previousCounts) {
            const byName = new Map(previousCounts.byName)
            byName.set(invocation.name, (byName.get(invocation.name) || 0) - 1)
            cacheInvocationCounts(target.text, { byName, total: previousCounts.total - 1 })
          }
          text = target.text
          // SAFETY: Input command parsing establishes the asserted command contract.
          await runInputCommandInputHook(command, context as AgentCapabilityRuntimeContext, invocation)
          input = context.input.get()
          target = getInputCommandTarget(input)
          if (!target) return
          text = target.text
          // Preserve recursive tracking while a remaining sibling can re-enter
          // the active lineage. Reset only at a proven independent boundary,
          // after the hook has had a chance to mutate the input.
          if (!canReenterLineage(text)) {
            transitionLineage = []
            blockedTransitions.clear()
            creditedCyclicTransitions.clear()
            numericTransitionDepths.clear()
          }
          cursor = 0
          continue
        }

        if (text !== previousText) {
          // SAFETY: Input command parsing establishes the asserted command contract.
          await runInputCommandInputHook(command, context as AgentCapabilityRuntimeContext, invocation)
          cursor = 0
          continue
        }
        // SAFETY: Input command parsing establishes the asserted command contract.
        await runInputCommandInputHook(command, context as AgentCapabilityRuntimeContext, invocation)
        cursor = invocation.end
      }
    },
  })
}
