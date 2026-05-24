import { defineCapability } from "../capability-runtime.ts"
import { getMessageText } from "../messages.ts"

import type {
  AgentCapabilityDefinition,
  AgentRunInput,
  MaybePromise,
} from "../types.ts"
import type {
  Message,
  StreamEvent,
} from "../messages.ts"

export interface ChatTitleExecuteInput {
  input: AgentRunInput
  message: Message
  messages: Message[]
  text: string
}

export type ChatTitleExecuteResult = string | { title?: string }

export interface ChatTitleOptions {
  execute?: (input: ChatTitleExecuteInput) => MaybePromise<ChatTitleExecuteResult>
  fallback?: string
  id?: string
  instructions?: string
  maxLength?: number
  model?: unknown
}

function firstUserMessage(messages: Message[]): Message | undefined {
  return messages.find(message => message.role === "user")
}

function cleanGeneratedTitle(value: unknown, maxLength: number, fallback: string): string {
  const raw = typeof value === "string" ? value : ""
  const title = raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim()
  return title || fallback
}

function heuristicTitle(text: string, maxLength: number, fallback: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 6).join(" ")
  return cleanGeneratedTitle(words, maxLength, fallback)
}

async function generateChatTitle(options: ChatTitleOptions, input: ChatTitleExecuteInput): Promise<string> {
  const fallback = options.fallback ?? "New Conversation"
  const maxLength = options.maxLength ?? 80

  if (options.execute) {
    const result = await options.execute(input)
    return cleanGeneratedTitle(typeof result === "string" ? result : result.title, maxLength, fallback)
  }

  if (options.model) {
    const { generateText } = await import("ai")
    const result = await generateText({
      model: options.model as never,
      system: options.instructions ?? [
        "Generate a short chat title from the user's first message.",
        "Return only the title.",
        "Use 2-5 words when possible.",
        `Use "${fallback}" when the message is too vague.`,
      ].join("\n"),
      prompt: input.text,
    })
    return cleanGeneratedTitle(result.text, maxLength, fallback)
  }

  return heuristicTitle(input.text, maxLength, fallback)
}

async function* withChatTitleEvent(result: AsyncIterable<StreamEvent>, title: Promise<string | undefined>): AsyncIterable<StreamEvent> {
  const resolvedTitle = await title
  if (resolvedTitle) {
    yield { data: { title: resolvedTitle, type: "chat-title" }, type: "data" }
  }
  yield* result
}

async function* withChatTitleFullStream(result: AsyncIterable<unknown>, title: Promise<string | undefined>): AsyncIterable<unknown> {
  const resolvedTitle = await title
  if (resolvedTitle) {
    yield { data: { title: resolvedTitle, type: "chat-title" }, type: "data" }
  }
  yield* result
}

async function* withChatTitleTextStream(result: AsyncIterable<string>, title: Promise<string | undefined>): AsyncIterable<StreamEvent> {
  const resolvedTitle = await title
  if (resolvedTitle) {
    yield { data: { title: resolvedTitle, type: "chat-title" }, type: "data" }
  }
  for await (const text of result) {
    yield { text, type: "text-delta" }
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<StreamEvent> {
  return !!value
    && typeof value === "object"
    && Symbol.asyncIterator in value
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
}

function isStreamTextResult(value: unknown): value is { fullStream?: AsyncIterable<unknown>, textStream?: AsyncIterable<string> } {
  return !!value && typeof value === "object"
    && (isAsyncIterable((value as { fullStream?: unknown }).fullStream) || isAsyncIterable((value as { textStream?: unknown }).textStream))
}

export function chatTitle(options: ChatTitleOptions = {}): AgentCapabilityDefinition {
  return defineCapability({
    id: options.id || "chat-title",
    output(context) {
      const messages = context.input.messages()
      const message = firstUserMessage(messages)
      if (!message) return

      const text = getMessageText(message)
      const title = generateChatTitle(options, {
        input: context.input.get(),
        message,
        messages,
        text,
      }).catch(() => undefined)

      context.finish.provide(async () => {
        const resolvedTitle = await title
        return resolvedTitle ? { title: resolvedTitle } : undefined
      })
      context.output.render((result) => {
        if (isStreamTextResult(result)) {
          if (result.fullStream) return { ...result, fullStream: withChatTitleFullStream(result.fullStream, title) }
          if (result.textStream) return withChatTitleTextStream(result.textStream, title)
        }
        if (!isAsyncIterable(result)) return result
        return withChatTitleEvent(result, title)
      })
    },
  })
}
