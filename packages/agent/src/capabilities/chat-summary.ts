import { defineCapability } from "../capability-runtime.ts"
import {
  getMessageText,
  validateMessage,
} from "../messages.ts"
import {
  assertInputCommandName,
  findInputCommandInvocation,
  getInputCommandTarget,
  normalizeInputCommandTrigger,
  replaceMessageTextParts,
  replaceTargetText,
} from "./input-commands.ts"
import { loadAiSdk } from "../internal/ai-sdk-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentFinishEvent,
  AgentRunInput,
  MaybePromise,
} from "../types.ts"
import type { Message } from "../messages.ts"

export interface ChatSummaryCommandOptions {
  description?: string
  name?: string
  trigger?: string
}

export interface ChatSummaryExecuteInput {
  args: string
  input: AgentRunInput
  messages: Message[]
  text: string
}

export type ChatSummaryExecuteResult = string | { summary?: string }

export interface ChatSummaryOptions {
  command?: false | ChatSummaryCommandOptions
  execute?: (input: ChatSummaryExecuteInput) => MaybePromise<ChatSummaryExecuteResult>
  fallback?: string
  id?: string
  instructions?: string
  maxLength?: number
  model?: unknown
}

function chatTranscript(messages: Message[]): string {
  return messages
    .map((message) => {
      const text = getMessageText(message).trim()
      return text ? `${message.role}: ${text}` : ""
    })
    .filter(Boolean)
    .join("\n")
}

function cleanGeneratedSummary(value: unknown, maxLength: number, fallback: string): string {
  const raw = typeof value === "string" ? value : ""
  const summary = raw
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim()
  return summary || fallback
}

function heuristicSummary(text: string, maxLength: number, fallback: string): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  return cleanGeneratedSummary(normalized, maxLength, fallback)
}

async function generateChatSummary(options: ChatSummaryOptions, input: ChatSummaryExecuteInput): Promise<string> {
  const fallback = options.fallback ?? "No conversation to summarize."
  const maxLength = options.maxLength ?? 1_200

  if (options.execute) {
    const result = await options.execute(input)
    return cleanGeneratedSummary(typeof result === "string" ? result : result.summary, maxLength, fallback)
  }

  if (options.model) {
    const { generateText } = await loadAiSdk()
    const result = await generateText({
      instructions: options.instructions ?? [
        "Summarize this chat conversation for future context.",
        "Keep important user goals, decisions, constraints, and unresolved follow-ups.",
        "Return only the summary.",
      ].join("\n"),
      model: options.model as never,
      prompt: input.args
        ? `${input.text}\n\nFocus: ${input.args}`
        : input.text,
    })
    return cleanGeneratedSummary(result.text, maxLength, fallback)
  }

  return heuristicSummary(input.text, maxLength, fallback)
}

function normalizeChatSummaryCommand(command: ChatSummaryOptions["command"]): Required<ChatSummaryCommandOptions> | undefined {
  if (command === false) return
  return {
    description: command?.description || "Summarize this conversation.",
    name: command?.name || "summary",
    trigger: normalizeInputCommandTrigger(command?.trigger),
  }
}

export function chatSummary(options: ChatSummaryOptions = {}): AgentCapabilityDefinition {
  const id = options.id || "chat-summary"
  const summaryContextKey = `${id}:summary`
  const command = normalizeChatSummaryCommand(options.command)
  const commandName = command?.name
  if (commandName) assertInputCommandName(commandName)
  const generatedSummaries = new WeakMap<object, { summary: string }>()

  return defineCapability({
    id,
    metadata: command
      ? {
          commands: {
            [command.name]: { description: command.description },
          },
          trigger: command.trigger,
        }
      : undefined,
    input: async (context) => {
      if (!command) return

      let input = context.input.get()
      const target = getInputCommandTarget(input)
      if (!target) return

      const invocation = findInputCommandInvocation(target.text, command.trigger, {
        [command.name]: {
          description: command.description,
          call: () => undefined,
        },
      })
      if (!invocation) return

      const messages = context.input.messages()
      let sourceMessages = messages
      let sourceText: string | undefined
      if (target.type === "message") {
        const sourceMessage = replaceMessageTextParts(target.message!, {
          end: invocation.end,
          replacement: "",
          start: invocation.start,
        })
        validateMessage(sourceMessage)
        sourceMessages = getMessageText(sourceMessage).trim()
          ? messages.map((message, index) => index === target.messageIndex ? sourceMessage : message)
          : messages.filter((message, index) => index !== target.messageIndex)
      }
      else {
        sourceText = `${target.text.slice(0, invocation.start)}${target.text.slice(invocation.end)}`.trim()
      }
      const text = sourceText ?? chatTranscript(sourceMessages)
      const summary = await generateChatSummary(options, {
        args: invocation.args,
        input,
        messages: sourceMessages,
        text,
      })

      const replacement = `Conversation summary:\n${summary}`
      const nextText = `${target.text.slice(0, invocation.start)}${replacement}${target.text.slice(invocation.end)}`
      input = replaceTargetText(input, target, nextText, {
        end: invocation.end,
        replacement,
        start: invocation.start,
      })
      const summaryValue = { summary }
      const nextInput = {
        ...input,
        context: {
          ...input.context,
          chatSummary: summaryValue,
          [summaryContextKey]: summaryValue,
        },
      }
      generatedSummaries.set(context, summaryValue)
      context.input.set(nextInput)
    },
    output(context) {
      context.finish.provide((event: AgentFinishEvent) => {
        const summaryValue = event.input.context?.[summaryContextKey]
        return typeof summaryValue === "object" && summaryValue !== null && generatedSummaries.get(context) === summaryValue
          ? summaryValue
          : undefined
      })
    },
  })
}
