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

export interface InputCommandRunInput {
  args: string
  command: InputCommand
  context: AgentCapabilityRuntimeContext
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
    throw new TypeError(`[vitehub] Input command "${name}" must be a lowercase stable identifier.`)
  }
}

function normalizeInputCommands(options: InputCommandsOptions): Record<string, InputCommand> {
  if (!options || typeof options !== "object" || !options.commands || typeof options.commands !== "object" || Array.isArray(options.commands)) {
    throw new TypeError("[vitehub] inputCommands({ commands }) requires a command map.")
  }
  for (const [name, command] of Object.entries(options.commands)) {
    assertInputCommandName(name)
    if (!command || typeof command !== "object") {
      throw new TypeError(`[vitehub] Input command "${name}" must be an object.`)
    }
    if (command.description !== undefined && (typeof command.description !== "string" || !command.description.trim())) {
      throw new TypeError(`[vitehub] Input command "${name}" description must be a non-empty string.`)
    }
    if (command.channels !== undefined && (!Array.isArray(command.channels) || command.channels.some(channel => typeof channel !== "string" || !channel.trim()))) {
      throw new TypeError(`[vitehub] Input command "${name}" channels must be non-empty Channel IDs.`)
    }
  }
  return options.commands
}

export function normalizeInputCommandTrigger(trigger: unknown): string {
  if (trigger === undefined) return "/"
  if (typeof trigger !== "string" || !trigger) {
    throw new TypeError("[vitehub] inputCommands({ trigger }) must be a non-empty string.")
  }
  if (/\s/.test(trigger)) {
    throw new TypeError("[vitehub] inputCommands({ trigger }) must not contain whitespace.")
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
    if (!commands[name]) continue
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

function latestUserMessageIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return index
  }
  return -1
}

export function getInputCommandTarget(input: AgentRunInput): InputCommandTarget | undefined {
  if (typeof input.prompt === "string" && !input.messages) {
    return { text: input.prompt, type: "prompt" }
  }

  const messages = input.messages || (Array.isArray(input.prompt) ? input.prompt : undefined)
  if (!messages) return
  const messageIndex = latestUserMessageIndex(messages)
  if (messageIndex < 0) {
    return typeof input.prompt === "string"
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
  if (typeof next.prompt === "string") delete next.prompt
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
  return context.run?.channelId || context.context.get<{ channelId?: string }>("agent.trigger")?.channelId
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
    if (options?.transient && typeof intent.metadata?.transientKey === "string") {
      context.delivery.finishEffect(() => ({
        kind: intent.kind,
        metadata: {
          transient: true,
          transientKey: intent.metadata!.transientKey,
        },
        payload: {
          action: "remove",
          content: typeof intent.payload === "string" ? intent.payload : (intent.payload as { content?: unknown } | undefined)?.content,
        },
      }))
    }
  })
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

export function inputCommands(options: InputCommandsOptions): AgentCapabilityDefinition {
  const commands = normalizeInputCommands(options)
  const trigger = normalizeInputCommandTrigger(options.trigger)
  return defineCapability({
    id: options.id || "inputCommands",
    metadata: {
      commands: Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, {
        ...(command.channels?.length ? { channels: [...command.channels] } : {}),
        ...(command.description ? { description: command.description } : {}),
      }])),
      trigger,
    },
    input: async (context) => {
      let input = context.input.get()
      let target = getInputCommandTarget(input)
      if (!target) return

      let text = target.text
      let cursor = 0
      let runs = 0
      let maxRuns = Math.max(1_000, text.length + 1)
      while (cursor <= text.length) {
        const invocation = findInputCommandInvocation(text, trigger, commands, cursor)
        if (!invocation) break
        if (++runs > maxRuns) throw new Error("[vitehub] inputCommands exceeded the maximum command expansion depth.")

        const command = commands[invocation.name]!
        if (!commandAllowsCurrentChannel(command, context as AgentCapabilityRuntimeContext)) {
          cursor = invocation.end
          continue
        }
        const result = await inputCommandCall(command)({
          args: invocation.args,
          command,
          context: context as AgentCapabilityRuntimeContext,
          input,
          message: target.message,
          name: invocation.name,
          text: invocation.text,
        })
        scheduleInputCommandFinishHook(command, context as AgentCapabilityRuntimeContext, invocation)
        if (result instanceof Response) return result

        const previousText = text
        input = context.input.get()
        target = getInputCommandTarget(input)
        if (!target) return
        text = target.text
        maxRuns = Math.max(maxRuns, text.length + 1)

        if (typeof result === "string") {
          if (text.slice(invocation.start, invocation.end) !== invocation.text) {
            cursor = text === previousText ? invocation.end : 0
            continue
          }
          const replacement = commandReplacementText(text, invocation, result)
          text = `${text.slice(0, invocation.start)}${replacement}${text.slice(invocation.end)}`
          input = replaceTargetText(input, target, text, {
            end: invocation.end,
            replacement,
            start: invocation.start,
          })
          context.input.set(input)
          target = getInputCommandTarget(input)
          if (!target) return
          maxRuns = Math.max(maxRuns, text.length + 1)
          await runInputCommandInputHook(command, context as AgentCapabilityRuntimeContext, invocation)
          cursor = replacement === invocation.text ? invocation.end : invocation.start
          continue
        }

        if (result && typeof result === "object") {
          const changesText = inputCommandChangesText(result)
          input = mergeInputCommandResult(input, result)
          context.input.set(input)
          target = getInputCommandTarget(input)
          if (!target) return
          text = target.text
          maxRuns = Math.max(maxRuns, text.length + 1)
          if (text !== previousText) {
            await runInputCommandInputHook(command, context as AgentCapabilityRuntimeContext, invocation)
            cursor = 0
            continue
          }
          if (changesText) {
            await runInputCommandInputHook(command, context as AgentCapabilityRuntimeContext, invocation)
            cursor = invocation.end
            continue
          }
        }

        if (text.slice(invocation.start, invocation.end) === invocation.text) {
          input = removeInputCommandText(input, target, invocation)
          context.input.set(input)
          target = getInputCommandTarget(input)
          if (!target) return
          text = target.text
          maxRuns = Math.max(maxRuns, text.length + 1)
          await runInputCommandInputHook(command, context as AgentCapabilityRuntimeContext, invocation)
          cursor = 0
          continue
        }

        if (text !== previousText) {
          await runInputCommandInputHook(command, context as AgentCapabilityRuntimeContext, invocation)
          cursor = 0
          continue
        }
        await runInputCommandInputHook(command, context as AgentCapabilityRuntimeContext, invocation)
        cursor = invocation.end
      }
    },
  })
}
