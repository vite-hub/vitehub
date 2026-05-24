import {
  executeHttpRequest,
  parseStandardSchema,
} from "@vitehub/internal/http-request"
import {
  defineCapability,
  normalizeMode,
} from "../capability-runtime.ts"
import {
  appendMessageText,
  getMessageText,
  validateMessage,
} from "../messages.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentCapabilityMode,
  AgentRunInput,
  AgentToolDefinition,
  AgentToolSet,
  MaybePromise,
} from "../types.ts"
import type { AudioPart, Message, StreamEvent } from "../messages.ts"

type AiSdkTranscribe = typeof import("ai")["experimental_transcribe"]
type AiSdkTranscribeOptions = Omit<Parameters<AiSdkTranscribe>[0], "abortSignal" | "audio">
type AiSdkTranscriptionResult = Awaited<ReturnType<AiSdkTranscribe>>

export interface TranscribeExecuteInput {
  audio: AudioPart
}

export type TranscribeExecuteResult = AiSdkTranscriptionResult | string

export type TranscribeOptions =
  | (AiSdkTranscribeOptions & { execute?: never, instructions?: AgentCapabilityDefinition["instructions"] })
  | { execute: (input: TranscribeExecuteInput) => MaybePromise<TranscribeExecuteResult>, instructions?: AgentCapabilityDefinition["instructions"], model?: never }

export type FetchCapabilityMethod = "GET" | "HEAD" | "POST"
export type FetchCapabilityResponseType = "json" | "text"

export interface FetchCapabilityStandardSchemaResultSuccess<T = unknown> {
  issues?: undefined
  value: T
}

export interface FetchCapabilityStandardSchemaResultFailure {
  issues: readonly unknown[]
}

export interface FetchCapabilityStandardSchemaV1<T = unknown> {
  "~standard": {
    validate: (input: unknown) => FetchCapabilityStandardSchemaResultSuccess<T> | FetchCapabilityStandardSchemaResultFailure | Promise<FetchCapabilityStandardSchemaResultSuccess<T> | FetchCapabilityStandardSchemaResultFailure>
  }
}

export interface FetchCapabilityRequestOptions {
  body?: unknown
  headers?: Record<string, string>
  method?: FetchCapabilityMethod
  query?: Record<string, unknown>
  timeout?: number
}

export interface FetchCapabilityRequestDefinition extends FetchCapabilityRequestOptions {
  url: string | URL
}

export interface FetchCapabilityToolOptions<TInput = unknown, TResponse = unknown, TOutput = TResponse> {
  description?: string
  inputSchema?: FetchCapabilityStandardSchemaV1<TInput>
  method?: FetchCapabilityMethod
  request?: FetchCapabilityToolRequest<TInput>
  responseType?: FetchCapabilityResponseType
  schema?: FetchCapabilityStandardSchemaV1<TResponse>
  transform?: (data: TResponse, input: TInput) => TOutput | Promise<TOutput>
  url?: string | URL
}

export type FetchCapabilityToolRequest<TInput = unknown> =
  | (FetchCapabilityRequestOptions & { url?: string | URL })
  | ((input: TInput) => MaybePromise<FetchCapabilityRequestDefinition | (FetchCapabilityRequestOptions & { url?: string | URL })>)

export interface FetchCapabilityOptions<TTools extends Record<string, FetchCapabilityToolOptions<any, any, any>> = Record<string, FetchCapabilityToolOptions>> {
  tools: TTools
}

function primitiveHandle(context: AgentCapabilityContext, name: string): unknown {
  const handle = context.capabilities?.[name] as { value?: unknown } | unknown
  return typeof handle === "object" && handle !== null && "value" in handle
    ? (handle as { value?: unknown }).value
    : handle
}

function requirePrimitive(context: AgentCapabilityContext, name: string): unknown {
  const handle = primitiveHandle(context, name)
  if (!handle) throw new Error(`[vitehub] Capability "${name}" requires the ${name} primitive to be configured.`)
  return handle
}

function isAudioPart(part: unknown): part is AudioPart {
  return !!part
    && typeof part === "object"
    && (part as { type?: unknown }).type === "audio"
    && typeof (part as { mediaType?: unknown }).mediaType === "string"
}

async function toAiSdkAudio(audio: AudioPart): Promise<Parameters<AiSdkTranscribe>[0]["audio"]> {
  if (audio.url) return new URL(audio.url)
  if (audio.data instanceof Blob) return await audio.data.arrayBuffer()
  if (audio.data) return audio.data
  throw new TypeError("[vitehub] transcribe() requires audio data or url.")
}

function transcriptText(result: TranscribeExecuteResult): string {
  return typeof result === "string" ? result : result.text
}

async function runTranscription(options: TranscribeOptions, audio: AudioPart, abortSignal?: AbortSignal): Promise<string> {
  if ("execute" in options && options.execute) {
    return transcriptText(await options.execute({ audio }))
  }

  const {
    instructions: _instructions,
    ...transcribeOptions
  } = options
  const { experimental_transcribe } = await import("ai")
  const result = await experimental_transcribe({
    ...transcribeOptions,
    abortSignal,
    audio: await toAiSdkAudio(audio),
  })
  return result.text
}

function defineInternalTool<TInput = unknown, TOutput = unknown>(
  tool: AgentToolDefinition<TInput, TOutput>,
): AgentToolDefinition<TInput, TOutput> {
  if (!tool || typeof tool !== "object") {
    throw new TypeError("[vitehub] tool definitions must be objects.")
  }
  if (!tool.name || typeof tool.name !== "string") {
    throw new TypeError("[vitehub] tool definitions require a tool name.")
  }
  return tool
}

function normalizeFetchResponseType(responseType: string | undefined): FetchCapabilityResponseType {
  const normalized = responseType || "json"
  if (normalized !== "json" && normalized !== "text") {
    throw new TypeError(`[vitehub] fetch() responseType "${normalized}" is not supported in v1. Use json or text.`)
  }
  return normalized
}

function validateSandboxCommands(commands: unknown): string[] {
  if (!Array.isArray(commands) || !commands.length) {
    throw new TypeError("[vitehub] sandbox({ commands }) requires at least one executable name.")
  }
  for (const command of commands) {
    if (typeof command !== "string" || !/^[A-Za-z0-9_.-]+$/.test(command)) {
      throw new TypeError("[vitehub] sandbox({ commands }) accepts executable names only, not shell command strings.")
    }
  }
  return commands
}

export interface InputCommand {
  description: string
  run: (input: InputCommandRunInput) => MaybePromise<Partial<AgentRunInput> | string | void>
}

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

interface InputCommandInvocation {
  args: string
  end: number
  name: string
  start: number
  text: string
}

interface InputCommandTarget {
  message?: Message
  messageIndex?: number
  messages?: Message[]
  text: string
  type: "message" | "prompt"
}

interface InputCommandTextReplacement {
  end: number
  replacement: string
  start: number
}

function assertInputCommandName(name: string): void {
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
    if (typeof command.description !== "string" || !command.description.trim()) {
      throw new TypeError(`[vitehub] Input command "${name}" requires a description.`)
    }
    if (typeof command.run !== "function") {
      throw new TypeError(`[vitehub] Input command "${name}" requires a run() handler.`)
    }
  }
  return options.commands
}

function normalizeInputCommandTrigger(trigger: unknown): string {
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

function findInputCommandInvocation(
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

function getInputCommandTarget(input: AgentRunInput): InputCommandTarget | undefined {
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

function replaceMessageTextParts(message: Message, replacement: InputCommandTextReplacement): Message {
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

function replaceTargetText(
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

export function inputCommands(options: InputCommandsOptions): AgentCapabilityDefinition {
  const commands = normalizeInputCommands(options)
  const trigger = normalizeInputCommandTrigger(options.trigger)
  return defineCapability({
    id: options.id || "inputCommands",
    metadata: {
      commands: Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, { description: command.description }])),
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
        const result = await command.run({
          args: invocation.args,
          command,
          context: context as AgentCapabilityRuntimeContext,
          input,
          message: target.message,
          name: invocation.name,
          text: invocation.text,
        })

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
          text = `${text.slice(0, invocation.start)}${result}${text.slice(invocation.end)}`
          input = replaceTargetText(input, target, text, {
            end: invocation.end,
            replacement: result,
            start: invocation.start,
          })
          context.input.set(input)
          target = getInputCommandTarget(input)
          if (!target) return
          maxRuns = Math.max(maxRuns, text.length + 1)
          cursor = result === invocation.text ? invocation.end : invocation.start
          continue
        }

        if (result && typeof result === "object") {
          input = mergeInputCommandResult(input, result)
          context.input.set(input)
          target = getInputCommandTarget(input)
          if (!target) return
          text = target.text
          maxRuns = Math.max(maxRuns, text.length + 1)
          if (text !== previousText) {
            cursor = 0
            continue
          }
        }

        if (text !== previousText) {
          cursor = 0
          continue
        }
        cursor = invocation.end
      }
    },
  })
}

export function workspaceShell(options: { mode?: AgentCapabilityMode } = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Workspace Shell")
  return defineCapability({
    id: "workspace-shell",
    mode,
    requires: [{ primitive: "workspace", workspace: { mode, required: true } }],
    tools: ({ workspace }) => (mode === "write" && "write" in workspace.tools
      ? (workspace.tools as unknown as { write: () => AgentToolSet }).write()
      : workspace.tools.inspect()) as AgentToolSet,
  })
}

export function sandbox(options: { commands: string[] }): AgentCapabilityDefinition {
  const commands = validateSandboxCommands(options?.commands)
  return defineCapability({
    id: "sandbox",
    metadata: { commands },
    requires: [{ primitive: "workspace", workspace: { required: true } }, { primitive: "sandbox" }],
    tools: (context) => {
      const handle = requirePrimitive(context as never, "sandbox") as {
        exec?: (command: string, args?: string[], options?: unknown) => MaybePromise<unknown>
      }
      return {
        sandbox_exec: defineInternalTool({
          description: `Run one allowed executable in an isolated sandbox. Allowed commands: ${commands.join(", ")}.`,
          name: "sandbox_exec",
          async execute(input) {
            const value = input as { args?: string[], command?: string, cwd?: string, env?: Record<string, string>, timeout?: number }
            if (!value || typeof value.command !== "string") throw new TypeError("[vitehub] sandbox_exec requires a command.")
            if (!commands.includes(value.command)) throw new Error(`[vitehub] Sandbox command "${value.command}" is not allowed.`)
            if (!handle.exec) throw new Error("[vitehub] Sandbox primitive does not expose exec().")
            return await handle.exec(value.command, value.args || [], { cwd: value.cwd, env: value.env, timeout: value.timeout })
          },
        }),
      }
    },
  })
}

export function skills(options: { path?: string } = {}): AgentCapabilityDefinition {
  const path = options.path || "skills"
  const skillPath = path.replace(/\/+$/, "").endsWith("/SKILL.md")
    ? path.replace(/\/+$/, "")
    : `${path.replace(/\/+$/, "")}/SKILL.md`
  return defineCapability({
    id: "skills",
    metadata: { path: path.replace(/\/+$/, ""), skillPath },
    requires: [{ primitive: "workspace", workspace: { mode: "read", paths: [skillPath], required: true } }],
  })
}

export function transcribe(options: TranscribeOptions): AgentCapabilityDefinition {
  return defineCapability({
    id: "transcribe",
    input: async (context) => {
      const messages = []
      for (const message of context.input.messages()) {
        const audioParts = message.parts.filter(isAudioPart)
        if (!audioParts.length) {
          messages.push(message)
          continue
        }

        const transcripts = await Promise.all(
          audioParts.map(part => runTranscription(options, part, context.input.get().abortSignal)),
        )
        const text = transcripts.filter(Boolean).join("\n")
        const separator = text && message.parts.some(part => part.type === "text" && part.text.length > 0) ? "\n" : ""
        messages.push(appendMessageText(message, `${separator}${text}`))
      }
      context.input.setMessages(messages)
    },
    instructions: options.instructions ?? false,
  })
}

export function fetch<const TTools extends Record<string, FetchCapabilityToolOptions<any, any, any>>>(options: FetchCapabilityOptions<TTools>): AgentCapabilityDefinition {
  if (!options?.tools || typeof options.tools !== "object" || !Object.keys(options.tools).length) {
    throw new TypeError("[vitehub] fetch({ tools }) requires at least one fetch tool.")
  }
  return defineCapability({
    id: "fetch",
    tools: Object.fromEntries(Object.entries(options.tools).map(([name, toolOptions]) => [
      name,
      createFetchTool(name, toolOptions),
    ])),
  })
}

function createFetchTool(name: string, options: FetchCapabilityToolOptions): AgentToolDefinition {
  return defineInternalTool({
    description: options.description || `Fetch ${name}.`,
    inputSchema: options.inputSchema,
    name,
    async execute(input) {
      const parsedInput = options.inputSchema
        ? await parseStandardSchema(options.inputSchema, input, `${name} input`)
        : input
      const request = await resolveFetchToolRequest(options, parsedInput)
      const result = await executeHttpRequest(request, {
        responseType: normalizeFetchResponseType(options.responseType),
        schema: options.schema,
      })
      return options.transform
        ? await options.transform(result.data as never, parsedInput as never)
        : result.data
    },
  })
}

async function resolveFetchToolRequest(options: FetchCapabilityToolOptions, input: unknown): Promise<FetchCapabilityRequestDefinition> {
  const request = typeof options.request === "function"
    ? await options.request(input as never)
    : options.request
  const url = request?.url ?? options.url
  if (!url) throw new TypeError("[vitehub] fetch() tool requires a url or request returning a url.")
  return {
    ...request,
    method: request?.method ?? options.method,
    url,
  }
}

export {
  blob,
  db,
  kv,
} from "./storage/index.ts"
export {
  memory,
  workspaceJsonlMemoryStore,
} from "../memory.ts"
export {
  mcp,
} from "../mcp/capability.ts"
export {
  normalizeAgentUsage,
  staticModelPricing,
  usageTelemetry,
  vercelAiGatewayPricing,
} from "./usage-telemetry.ts"
export {
  webSearch,
} from "./web-search/index.ts"

export type {
  BlobCapabilityOptions,
  DBCapabilityOptions,
  KVCapabilityOptions,
  StorageToolPolicy,
} from "./storage/index.ts"
export type {
  MemoryAppendRequest,
  MemoryCapabilityInstructionsOption,
  MemoryCapabilityOptions,
  MemoryDeleteRequest,
  MemoryExportRequest,
  MemoryKind,
  MemoryProvenance,
  MemoryReadRequest,
  MemoryRecord,
  MemoryScope,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryStoreAdapter,
  MemoryStoreFactory,
  MemoryStoreOptions,
  WorkspaceJsonlMemoryStoreOptions,
} from "../memory.ts"
export type {
  McpCapabilityOptions,
  McpClient,
  McpClientConfig,
  McpServerConfig,
} from "../mcp/types.ts"
export type {
  AgentUsagePricing,
  AgentUsagePricingContext,
  StaticModelPrice,
  UsageTelemetryOptions,
  VercelAiGatewayPricingOptions,
} from "./usage-telemetry.ts"
export type {
  WebReadToolDefinition,
  WebReadToolInput,
  WebReadResult,
  WebSearchModelModeOptions,
  WebSearchOptions,
  WebSearchProvider,
  WebSearchProviderInput,
  WebSearchProviderOptions,
  WebSearchResult,
  WebSearchToolDefinition,
  WebSearchToolInput,
  WebSearchToolModeOptions,
} from "./web-search/index.ts"
