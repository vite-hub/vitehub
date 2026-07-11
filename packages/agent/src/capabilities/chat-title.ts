import { capabilityInvocationStartSymbol, defineCapability } from "../capability-runtime.ts"
import { streamAgentOutputToEvents, toAgentRunResult } from "../agent-output.ts"
import { messageChannelTitleSupportContextKey } from "../channels.ts"
import {
  claimMessageChannelChatTitleDelivery,
  createMessageChannelChatTitleEffectIntent,
  finishMessageChannelChatTitleDelivery,
  messageChannelStateContextKey,
  messageChannelTitleDeliveredContextKey,
} from "../internal/channels.ts"
import { getMessageText } from "../messages.ts"
import { normalizeAgentDriver } from "../internal/agent-driver.ts"
import { loadAiSdk } from "../internal/ai-sdk-runtime.ts"

import type {
  AgentAdapterRunContext,
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentChannelDeliveryFinishEffectCallback,
  AgentDriver,
  AgentModelResolver,
  AgentRunInput,
  AgentRunContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type {
  Message,
  StreamEvent,
} from "../messages.ts"
import type { MessageChannelChatTitleDeliveryAttempt, MessageChannelStateBinding } from "../internal/channels.ts"

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
  channelDelivery?: "always" | "once-per-thread"
  driver?: AgentDriver<TRuntimeConfig>
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
  "Summarize the user's request as a short chat title.",
  "Return only the title.",
  "Use 4-8 words when possible.",
  `Keep it under {{ maxLength }} characters.`,
  "Do not answer the request.",
  "Use the user's language.",
  "Do not use emoji.",
  "Ignore chat platform mention/channel markup, bot names, and user IDs.",
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
  if (!title) return fallback
  if (title.length <= maxLength) return title
  const cut = title.slice(0, maxLength + 1)
  const boundary = cut.lastIndexOf(" ")
  return (boundary >= 20 ? cut.slice(0, boundary) : title.slice(0, maxLength))
    .replace(/[\s"'`.!?:;,/-]+$/g, "")
    .trim() || fallback
}

function heuristicTitle(text: string, maxLength: number, fallback: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 6).join(" ")
  return cleanGeneratedTitle(words, maxLength, fallback)
}

function stripChatEntityMarkup(text: string): string {
  const clean = text
    .replace(/<[@#!&][^>\s]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return clean || text
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
  return context.context.get<boolean>(messageChannelTitleSupportContextKey) === true
}

function shouldProvideChatTitleFinishExtension(context: AgentCapabilityRuntimeContext): boolean {
  return supportsChatTitleDelivery(context) || context.context.get<boolean>("agent.finishHook") === true
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

function chatTitleDriverInput(input: ChatTitleExecuteInput, prompt: string): AgentRunInput {
  const { message: _message, messages: _messages, prompt: _prompt, ...base } = input.input
  return { ...base, prompt }
}

function chatTitleAdapterRunContext(
  context: AgentCapabilityRuntimeContext,
  input: ChatTitleExecuteInput,
  prompt: string,
): AgentAdapterRunContext {
  if (!context.runtimeContext) {
    throw new Error("[vitehub] chatTitle({ driver }) requires an agent runtime context.")
  }
  return {
    actor: context.actor,
    context: context.context,
    devtools: context.runtimeContext.devtools,
    input: chatTitleDriverInput(input, prompt),
    invoker: context.invoker,
    messages: [],
    prompt,
    runtime: context.runtimeContext,
  }
}

function chatTitleRunContext(
  context: AgentCapabilityRuntimeContext,
  input: ChatTitleExecuteInput,
  prompt: string,
): AgentRunContext {
  if (!context.runtimeContext) {
    throw new Error("[vitehub] chatTitle({ driver }) requires an agent runtime context.")
  }
  const { runtimeConfig: _runtimeConfig, ...runtime } = context.runtimeContext
  return {
    ...runtime,
    actor: context.actor,
    context: context.context,
    input: chatTitleDriverInput(input, prompt),
    invoker: context.invoker,
    messages: [],
    prompt,
  }
}

async function chatTitleResultText(result: unknown): Promise<string | undefined> {
  let text = ""
  for await (const event of streamAgentOutputToEvents(result)) {
    if (event.type === "text-delta") text += event.text
  }
  if (text) return text
  return toAgentRunResult(result).text
}

async function generateChatTitleWithDriver(
  context: AgentCapabilityRuntimeContext,
  options: ChatTitleOptions,
  input: ChatTitleExecuteInput,
  prompt: string,
): Promise<string | undefined> {
  if (!options.driver) return
  const driver = normalizeAgentDriver({ driver: options.driver } as never)
  if (driver.kind === "run") {
    return await chatTitleResultText(await driver.run(chatTitleRunContext(context, input, prompt) as never))
  }
  const runContext = chatTitleAdapterRunContext(context, input, prompt)
  if (driver.kind === "harness") {
    const { createHarnessAgentAdapter } = await import("../harness-agent.ts")
    return await chatTitleResultText(await createHarnessAgentAdapter(driver as never).generate(runContext as never))
  }
  const { createAiSdkAdapter } = await import("../ai-sdk.ts")
  return await chatTitleResultText(await createAiSdkAdapter({
    execution: driver.execution,
    instructions: options.instructions ?? driver.instructions,
    model: driver.model,
  } as never).generate(runContext as never))
}

async function generateChatTitle(context: AgentCapabilityRuntimeContext, options: ChatTitleOptions, input: ChatTitleExecuteInput): Promise<string | undefined> {
  const fallback = options.fallback ?? "New Conversation"
  const maxLength = options.maxLength ?? 80
  const templateInput = {
    ...input,
    fallback,
    maxLength,
    text: stripChatEntityMarkup(input.text),
    trigger: agentTriggerId(context),
  }

  if (!shouldRunForTrigger(options.trigger, templateInput.trigger)) return
  if (options.when && !await options.when(templateInput)) return

  if (options.execute) {
    const result = await options.execute(input)
    return cleanGeneratedTitle(typeof result === "string" ? result : result.title, maxLength, fallback)
  }

  if (options.driver) {
    const prompt = await renderChatTitleTemplate(options, templateInput)
    return cleanGeneratedTitle(await generateChatTitleWithDriver(context, options, input, prompt), maxLength, fallback)
  }

  const model = await resolveChatTitleModel(context, options)
  if (model) {
    const prompt = await renderChatTitleTemplate(options, templateInput)
    const { generateText } = await loadAiSdk()
    const result = await generateText(options.instructions
      ? { instructions: options.instructions, model: model as never, prompt }
      : { model: model as never, prompt })
    return cleanGeneratedTitle(result.text, maxLength, fallback)
  }

  return heuristicTitle(templateInput.text, maxLength, fallback)
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
  const invocationStarts = new WeakMap<object, () => Promise<void>>()
  return Object.assign(defineCapability({
    id: capabilityId,
    output(context) {
      let channelDeliveryAttempt: MessageChannelChatTitleDeliveryAttempt | Promise<MessageChannelChatTitleDeliveryAttempt> | undefined
      const getChannelDeliveryAttempt = () => {
        const state = context.context.get<MessageChannelStateBinding>(messageChannelStateContextKey)
        channelDeliveryAttempt ??= options.channelDelivery === "always" || !supportsChatTitleDelivery(context) || !state || !context.run?.threadId
          ? { deliver: true }
          : claimMessageChannelChatTitleDelivery(context.context, context.run)
              .catch(error => ({ deliver: true, error }))
        return channelDeliveryAttempt
      }
      const releaseChannelDeliveryAttempt = async () => {
        await finishMessageChannelChatTitleDelivery(await getChannelDeliveryAttempt(), false).catch(() => undefined)
      }
      let title: Promise<string | undefined> | undefined
      const getTitle = () => {
        title ??= (async () => {
          const messages = context.input.messages()
          const message = firstUserMessage(messages)
          if (!message) return
          const pendingAttempt = getChannelDeliveryAttempt()
          const attempt = pendingAttempt instanceof Promise ? await pendingAttempt : pendingAttempt
          if (!attempt.deliver) return
          try {
            const resolvedTitle = await generateChatTitle(context, options as ChatTitleOptions, {
              input: context.input.get(),
              message,
              messages,
              text: getMessageText(message),
            })
            if (!resolvedTitle) {
              await finishMessageChannelChatTitleDelivery(attempt, false).catch(() => undefined)
            }
            return resolvedTitle
          }
          catch {
            await finishMessageChannelChatTitleDelivery(attempt, false).catch(() => undefined)
            return undefined
          }
        })()
        return title
      }

      invocationStarts.set(context.context, async () => {
        if (!firstUserMessage(context.input.messages())) return
        if (!shouldProvideChatTitleFinishExtension(context)) return
        if (context.context.get<boolean>(messageChannelTitleDeliveredContextKey) === true) return
        const resolvedTitle = await getTitle()
        if (!resolvedTitle || !supportsChatTitleDelivery(context)) {
          await releaseChannelDeliveryAttempt()
          return
        }
        if (context.context.get<boolean>(messageChannelTitleDeliveredContextKey) === true) {
          await releaseChannelDeliveryAttempt()
          return
        }
        context.delivery.effect(createMessageChannelChatTitleEffectIntent(
          resolvedTitle.trim(),
          options.channelDelivery,
          await getChannelDeliveryAttempt(),
        ))
      })
      context.finish.provide(async () => {
        if (!shouldProvideChatTitleFinishExtension(context)) return
        const resolvedTitle = await getTitle()
        return resolvedTitle ? { title: resolvedTitle } : undefined
      })
      const titleDeliveryEffect: AgentChannelDeliveryFinishEffectCallback = async (finish) => {
        const resolvedTitle = finish.extensions.get(capabilityId, "title")
        return typeof resolvedTitle === "string" && resolvedTitle.trim()
          ? createMessageChannelChatTitleEffectIntent(
              resolvedTitle.trim(),
              options.channelDelivery,
              await getChannelDeliveryAttempt(),
            )
          : undefined
      }
      titleDeliveryEffect.active = finish =>
        Boolean(finish.channel)
        && Boolean(firstUserMessage(context.input.messages()))
        && finish.context.get<boolean>(messageChannelTitleSupportContextKey) !== false
        && finish.context.get<boolean>(messageChannelTitleDeliveredContextKey) !== true
      titleDeliveryEffect.kind = "title"
      context.delivery.finishEffect(titleDeliveryEffect)
      context.output.render((result) => {
        if (hasChatTitleApplied(result)) return result
        if (!firstUserMessage(context.input.messages())) return result
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
  }), {
    [capabilityInvocationStartSymbol](context: AgentCapabilityRuntimeContext<TRuntimeConfig>) {
      return invocationStarts.get(context.context)?.()
    },
  })
}
