import { defineCapability } from "../capability-runtime.ts"
import { messageChannelTitleSupportContextKey } from "../channels.ts"
import { getMessageText } from "../messages.ts"
import { loadAiSdk } from "../internal/ai-sdk-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentModelResolver,
  AgentRunInput,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type {
  Message,
  StreamEvent,
} from "../messages.ts"

type ToUIMessageStream = (...args: unknown[]) => ReadableStream<unknown>
const chatTitleApplied = Symbol("vitehub.chat-title.applied")
type ChatTitleApplied = { [chatTitleApplied]?: true }

export interface ChatTitleExecuteInput {
  input: AgentRunInput
  message: Message
  messages: Message[]
  text: string
}

export type ChatTitleExecuteResult = string | { title?: string }

export interface ChatTitleTemplateInput extends ChatTitleExecuteInput {
  fallback: string
  maxLength: number
  trigger?: string
}

export type ChatTitleTemplate = string | ((input: ChatTitleTemplateInput) => MaybePromise<string>)
export type ChatTitleTemplateVariable =
  | boolean
  | null
  | number
  | string
  | undefined
  | ((input: ChatTitleTemplateInput) => MaybePromise<boolean | null | number | string | undefined>)

export interface ChatTitleOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  execute?: (input: ChatTitleExecuteInput) => MaybePromise<ChatTitleExecuteResult>
  fallback?: string
  id?: string
  instructions?: string
  maxLength?: number
  model?: AgentModelResolver<TRuntimeConfig>
  template?: ChatTitleTemplate
  trigger?: string | string[]
  variables?: Record<string, ChatTitleTemplateVariable>
  when?: (input: ChatTitleTemplateInput) => MaybePromise<boolean>
}

const defaultChatTitleTemplate = [
  "Generate a short chat title from the user's first message.",
  "Return only the title.",
  "Use 2-5 words when possible.",
  `Use "{{ fallback }}" when the message is too vague.`,
  "",
  "User message:",
  "{{ message }}",
].join("\n")

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

function hasChatTitleApplied(value: unknown): boolean {
  return isObjectLike(value) && (value as ChatTitleApplied)[chatTitleApplied] === true
}

function markChatTitleApplied<T>(value: T): T {
  if (isObjectLike(value)) {
    Object.defineProperty(value, chatTitleApplied, {
      configurable: true,
      value: true,
    })
  }
  return value
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

function chatTitleData(title: string) {
  return { title, type: "chat-title" }
}

function shouldRunForTrigger(filter: ChatTitleOptions["trigger"], trigger: string | undefined): boolean {
  if (!filter) return true
  const allowed = Array.isArray(filter) ? filter : [filter]
  return trigger !== undefined && allowed.includes(trigger)
}

function agentTriggerId(context: AgentCapabilityRuntimeContext): string | undefined {
  const trigger = context.context.get<{ id?: unknown }>("agent.trigger")
  return typeof trigger?.id === "string" ? trigger.id : undefined
}

function supportsChatTitleDelivery(context: AgentCapabilityRuntimeContext): boolean {
  return context.context.get<boolean>(messageChannelTitleSupportContextKey) !== false
}

async function resolveTemplateVariables(options: ChatTitleOptions, input: ChatTitleTemplateInput): Promise<Record<string, unknown>> {
  const variables: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(options.variables || {})) {
    variables[name] = typeof value === "function"
      ? await (value as (input: ChatTitleTemplateInput) => MaybePromise<unknown>)(input)
      : value
  }
  return {
    ...variables,
    fallback: input.fallback,
    maxLength: input.maxLength,
    message: input.text,
    trigger: input.trigger,
  }
}

async function renderChatTitleTemplate(options: ChatTitleOptions, input: ChatTitleTemplateInput): Promise<string> {
  const template = options.template ?? defaultChatTitleTemplate
  if (typeof template === "function") {
    return await template(input)
  }
  const variables = await resolveTemplateVariables(options, input)
  return template.replace(/\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, name)) return match
    const value = variables[name]
    return value === null || value === undefined ? "" : String(value)
  })
}

async function resolveChatTitleModel(context: AgentCapabilityRuntimeContext, options: ChatTitleOptions): Promise<unknown | undefined> {
  if (options.model) return await context.model.resolve(options.model)
  try {
    return await context.model.resolve()
  }
  catch (error) {
    if (error instanceof Error && error.message.includes("requires a model option or an agent model")) {
      return undefined
    }
    throw error
  }
}

async function generateChatTitle(context: AgentCapabilityRuntimeContext, options: ChatTitleOptions, input: ChatTitleExecuteInput): Promise<string | undefined> {
  const fallback = options.fallback ?? "New Conversation"
  const maxLength = options.maxLength ?? 80
  const templateInput = {
    ...input,
    fallback,
    maxLength,
    trigger: agentTriggerId(context),
  }

  if (!shouldRunForTrigger(options.trigger, templateInput.trigger)) return
  if (options.when && !await options.when(templateInput)) return

  if (options.execute) {
    const result = await options.execute(input)
    return cleanGeneratedTitle(typeof result === "string" ? result : result.title, maxLength, fallback)
  }

  const model = await resolveChatTitleModel(context, options)
  if (model) {
    const { generateText } = await loadAiSdk()
    const prompt = await renderChatTitleTemplate(options, templateInput)
    const result = await generateText(options.instructions
      ? { instructions: options.instructions, model: model as never, prompt }
      : { model: model as never, prompt })
    return cleanGeneratedTitle(result.text, maxLength, fallback)
  }

  return heuristicTitle(input.text, maxLength, fallback)
}

function withChatTitleParallel<T>(
  result: AsyncIterable<T>,
  title: Promise<string | undefined>,
  renderTitle: (title: string) => T,
): AsyncIterable<T> {
  const iterable = (async function* () {
    const iterator = result[Symbol.asyncIterator]()
    let streamNext = iterator.next()
    let titlePending = true
    const titleNext = title
      .then(value => ({ title: value, type: "title" as const }))
      .catch(() => ({ title: undefined, type: "title" as const }))

    try {
      while (true) {
        const next = titlePending
          ? await Promise.race([
              streamNext.then(value => ({ type: "stream" as const, value })),
              titleNext,
            ])
          : { type: "stream" as const, value: await streamNext }

        if (next.type === "title") {
          titlePending = false
          if (next.title) {
            yield renderTitle(next.title)
          }
          continue
        }

        if (next.value.done) {
          break
        }
        yield next.value.value
        streamNext = iterator.next()
      }

      if (titlePending) {
        const resolvedTitle = await titleNext
        if (resolvedTitle.title) {
          yield renderTitle(resolvedTitle.title)
        }
      }
    }
    finally {
      await iterator.return?.()
    }
  })()
  return markChatTitleApplied(iterable)
}

function withChatTitleEvent(result: AsyncIterable<StreamEvent>, title: Promise<string | undefined>): AsyncIterable<StreamEvent> {
  return withChatTitleParallel(result, title, resolvedTitle => ({ data: chatTitleData(resolvedTitle), type: "data" }))
}

function withChatTitleFullStream(result: AsyncIterable<unknown>, title: Promise<string | undefined>): AsyncIterable<unknown> {
  return withChatTitleParallel(result, title, resolvedTitle => ({ data: chatTitleData(resolvedTitle), type: "data" }))
}

function withChatTitleTextStream(result: AsyncIterable<string>, title: Promise<string | undefined>): AsyncIterable<StreamEvent> {
  return withChatTitleParallel<StreamEvent>(
    (async function* () {
      for await (const text of result) {
        yield { text, type: "text-delta" } satisfies StreamEvent
      }
    })(),
    title,
    resolvedTitle => ({ data: chatTitleData(resolvedTitle), type: "data" }),
  )
}

function withChatTitleUiMessageStream(result: ReadableStream<unknown>, title: Promise<string | undefined>): ReadableStream<unknown> {
  const reader = result.getReader()
  let cancelled = false
  const titleNext = title
    .then(value => ({ title: value, type: "title" as const }))
    .catch(() => ({ title: undefined, type: "title" as const }))

  return markChatTitleApplied(new ReadableStream<unknown>({
    async start(controller) {
      let streamNext = reader.read()
      let titlePending = true
      try {
        while (!cancelled) {
          const next = titlePending
            ? await Promise.race([
                streamNext.then(value => ({ type: "stream" as const, value })),
                titleNext,
              ])
            : { type: "stream" as const, value: await streamNext }

          if (next.type === "title") {
            titlePending = false
            if (next.title) {
              controller.enqueue({ data: chatTitleData(next.title), type: "data-chat-title" })
            }
            continue
          }

          if (next.value.done) {
            break
          }
          controller.enqueue(next.value.value)
          streamNext = reader.read()
        }

        if (!cancelled && titlePending) {
          const resolvedTitle = await titleNext
          if (resolvedTitle.title) {
            controller.enqueue({ data: chatTitleData(resolvedTitle.title), type: "data-chat-title" })
          }
        }
        if (!cancelled) {
          controller.close()
        }
      }
      catch (error) {
        if (!cancelled) {
          controller.error(error)
        }
      }
    },
    cancel(reason) {
      cancelled = true
      return reader.cancel(reason)
    },
  }))
}

function isAsyncIterable(value: unknown): value is AsyncIterable<StreamEvent> {
  return !!value
    && typeof value === "object"
    && Symbol.asyncIterator in value
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
}

function isStreamTextResult(value: unknown): value is { fullStream?: AsyncIterable<unknown>, stream?: AsyncIterable<unknown>, textStream?: AsyncIterable<string>, toUIMessageStream?: ToUIMessageStream } {
  return !!value && typeof value === "object"
    && (
      isAsyncIterable((value as { stream?: unknown }).stream)
      || isAsyncIterable((value as { fullStream?: unknown }).fullStream)
      || isAsyncIterable((value as { textStream?: unknown }).textStream)
      || typeof (value as { toUIMessageStream?: unknown }).toUIMessageStream === "function"
    )
}

function cloneStreamTextResult<T extends { fullStream?: AsyncIterable<unknown>, stream?: AsyncIterable<unknown>, textStream?: AsyncIterable<string>, toUIMessageStream?: ToUIMessageStream }>(
  result: T,
  streams: { fullStream?: AsyncIterable<unknown>, stream?: AsyncIterable<unknown>, textStream?: AsyncIterable<string>, toUIMessageStream?: ToUIMessageStream },
): T {
  const clone = Object.create(Object.getPrototypeOf(result))
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(result))
  if (streams.fullStream) {
    Object.defineProperty(clone, "fullStream", {
      configurable: true,
      enumerable: true,
      value: streams.fullStream,
      writable: true,
    })
  }
  if (streams.stream) {
    Object.defineProperty(clone, "stream", {
      configurable: true,
      enumerable: true,
      value: streams.stream,
      writable: true,
    })
  }
  if (streams.textStream) {
    Object.defineProperty(clone, "textStream", {
      configurable: true,
      enumerable: true,
      value: streams.textStream,
      writable: true,
    })
  }
  if (streams.toUIMessageStream) {
    Object.defineProperty(clone, "toUIMessageStream", {
      configurable: true,
      enumerable: true,
      value: streams.toUIMessageStream,
      writable: true,
    })
  }
  return markChatTitleApplied(clone)
}

function chatTitleUiMessageStreamOverride(toUIMessageStream: ToUIMessageStream | undefined, title: Promise<string | undefined>) {
  return toUIMessageStream
    ? {
        toUIMessageStream: (...args: unknown[]) => withChatTitleUiMessageStream(toUIMessageStream(...args), title),
      }
    : {}
}

export function chatTitle<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: ChatTitleOptions<TRuntimeConfig> = {},
): AgentCapabilityDefinition<TRuntimeConfig> {
  const capabilityId = options.id || "chat-title"
  return defineCapability({
    id: capabilityId,
    output(context) {
      const messages = context.input.messages()
      const message = firstUserMessage(messages)
      if (!message) return

      const text = getMessageText(message)
      let title: Promise<string | undefined> | undefined
      const getTitle = () => {
        title ??= generateChatTitle(context, options as ChatTitleOptions, {
          input: context.input.get(),
          message,
          messages,
          text,
        }).catch(() => undefined)
        return title
      }

      context.finish.provide(async () => {
        if (!supportsChatTitleDelivery(context)) return
        const resolvedTitle = await getTitle()
        return resolvedTitle ? { title: resolvedTitle } : undefined
      })
      context.delivery.finishEffect((finish) => {
        const resolvedTitle = finish.extensions.get(capabilityId, "title")
        return typeof resolvedTitle === "string" && resolvedTitle.trim()
          ? { kind: "title", payload: { title: resolvedTitle.trim() } }
          : undefined
      })
      context.output.render((result) => {
        if (hasChatTitleApplied(result)) return result
        if (isStreamTextResult(result)) {
          const toUIMessageStream = result.toUIMessageStream?.bind(result)
          if (result.stream || result.fullStream) {
            const stream = result.stream
            const fullStream = result.fullStream
            const title = getTitle()
            const titleStream = stream ? withChatTitleFullStream(stream, title) : undefined
            return cloneStreamTextResult(result, {
              ...(titleStream ? { stream: titleStream } : {}),
              ...(fullStream
                ? { fullStream: fullStream === stream && titleStream ? titleStream : withChatTitleFullStream(fullStream, title) }
                : {}),
              ...chatTitleUiMessageStreamOverride(toUIMessageStream, title),
            })
          }
          if (result.textStream) {
            const title = getTitle()
            return cloneStreamTextResult(result, {
              stream: withChatTitleTextStream(result.textStream, title),
              ...chatTitleUiMessageStreamOverride(toUIMessageStream, title),
            })
          }
          if (toUIMessageStream) {
            return cloneStreamTextResult(result, {
              ...chatTitleUiMessageStreamOverride(toUIMessageStream, getTitle()),
            })
          }
        }
        if (!isAsyncIterable(result)) return result
        return withChatTitleEvent(result, getTitle())
      })
    },
  })
}
