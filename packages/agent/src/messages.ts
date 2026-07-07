import type { AgentUsageRecord } from "./types.ts"

export type MessageRole = "assistant" | "system" | "tool" | "user"

export interface MessageMetadata {
  [key: string]: unknown
}

export interface TextPart {
  id?: string
  text: string
  type: "text"
}

export interface DataPart {
  data: unknown
  id?: string
  type: "data"
}

export type AudioData = ArrayBuffer | Blob | string | Uint8Array

export interface AudioPart {
  data?: AudioData
  fetchData?: () => Promise<AudioData> | AudioData
  fetchMetadata?: Record<string, string>
  id?: string
  mediaType: string
  name?: string
  size?: number
  type: "audio"
  url?: string
}

export type ToolInvocationState = "approval-required" | "failed" | "proposed" | "running" | "completed"

export interface ToolInvocation {
  error?: string
  id: string
  input?: unknown
  name: string
  output?: unknown
  state: ToolInvocationState
}

export interface ToolCallPart {
  id: string
  input?: unknown
  name: string
  state: Exclude<ToolInvocationState, "completed">
  type: "tool-call"
}

export interface ToolResultPart {
  error?: string
  id: string
  name: string
  output?: unknown
  state: "completed" | "failed"
  type: "tool-result"
}

export interface ApprovalRequestPart {
  id: string
  input?: unknown
  name: string
  reason?: string
  type: "approval-request"
}

export interface ApprovalDecisionPart {
  approved: boolean
  decidedAt?: string
  id: string
  reason?: string
  type: "approval-decision"
}

export interface SourcePart {
  id?: string
  sourceType?: string
  title?: string
  type: "source"
  url?: string
}

export interface ErrorPart {
  error: string
  id?: string
  recoverable?: boolean
  type: "error"
}

export type MessagePart =
  | ApprovalDecisionPart
  | ApprovalRequestPart
  | AudioPart
  | DataPart
  | ErrorPart
  | SourcePart
  | TextPart
  | ToolCallPart
  | ToolResultPart

export interface Message {
  createdAt?: string
  id: string
  metadata?: MessageMetadata
  parts: MessagePart[]
  role: MessageRole
}

export type StreamEvent =
  | { id?: string, messageId?: string, role?: MessageRole, text: string, type: "text-delta" }
  | { data: unknown, id?: string, messageId?: string, type: "data" }
  | { id: string, input?: unknown, messageId?: string, name: string, type: "tool-call" | "tool-input-start" }
  | { durationMs?: number, error?: string, id: string, messageId?: string, name: string, output?: unknown, type: "tool-result" }
  | { id: string, input?: unknown, messageId?: string, name: string, reason?: string, type: "approval-request" }
  | { approved: boolean, decidedAt?: Date | string, id: string, messageId?: string, reason?: string, type: "approval-decision" }
  | { error: string, id?: string, messageId?: string, recoverable?: boolean, type: "error" }
  | { messageId?: string, usageRecord: AgentUsageRecord, type: "usage" }
  | { messageId?: string, reason?: string, type: "finish" }

export type RunEvent = StreamEvent

export interface CreateMessageOptions {
  createdAt?: Date | string
  id?: string
  metadata?: MessageMetadata
  parts?: Array<MessagePart | string>
  role: MessageRole
  text?: string
}

export interface SerializedMessages {
  messages: Message[]
  version: 1
}

function createId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function normalizeCreatedAt(value: Date | string | undefined): string | undefined {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : value
}

function normalizePart(part: MessagePart | string, index: number): MessagePart {
  if (typeof part === "string") {
    return { id: `text-${index}`, text: part, type: "text" }
  }
  return part
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

export function createMessage(options: CreateMessageOptions): Message {
  const parts = [
    ...(options.text ? [{ id: "text-0", text: options.text, type: "text" } satisfies TextPart] : []),
    ...(options.parts || []).map(normalizePart),
  ]

  const message: Message = {
    id: options.id || createId("msg"),
    parts,
    role: options.role,
  }
  const createdAt = normalizeCreatedAt(options.createdAt)
  if (createdAt) message.createdAt = createdAt
  if (options.metadata) message.metadata = options.metadata
  validateMessage(message)
  return message
}

export function getMessageText(message: Message): string {
  return message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map(part => part.text)
    .join("")
}

export function appendMessageText(message: Message, text: string): Message {
  if (!text) return message
  return {
    ...message,
    parts: [
      ...message.parts,
      {
        id: `text-${message.parts.length}`,
        text,
        type: "text",
      },
    ],
  }
}

export function getToolInvocations(message: Message): ToolInvocation[] {
  const invocations = new Map<string, ToolInvocation>()

  for (const part of message.parts) {
    if (part.type === "approval-request") {
      invocations.set(part.id, {
        id: part.id,
        input: part.input,
        name: part.name,
        state: "approval-required",
      })
    }
    if (part.type === "tool-call") {
      invocations.set(part.id, {
        id: part.id,
        input: part.input,
        name: part.name,
        state: part.state,
      })
    }
    if (part.type === "tool-result") {
      invocations.set(part.id, {
        error: part.error,
        id: part.id,
        name: part.name,
        output: part.output,
        state: part.state,
      })
    }
  }

  return [...invocations.values()]
}

function assertString(value: unknown, field: string): void {
  if (typeof value !== "string" || !value) {
    throw new TypeError(`[vitehub:messages] ${field} must be a non-empty string.`)
  }
}

function assertSerializable(value: unknown, field: string): void {
  if (value === undefined) {
    throw new TypeError(`[vitehub:messages] ${field} must not be undefined.`)
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`[vitehub:messages] ${field} must be JSON serializable.`)
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`[vitehub:messages] ${field} must be a finite number.`)
  }
  if (!value || typeof value !== "object") {
    return
  }
  if (value instanceof Date) {
    throw new TypeError(`[vitehub:messages] ${field} must be serialized before storing.`)
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSerializable(item, `${field}[${index}]`))
    return
  }
  for (const [key, item] of Object.entries(value)) {
    assertSerializable(item, `${field}.${key}`)
  }
}

function hasAudioData(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0
  if (!value || typeof value !== "object") return false
  if ("byteLength" in value && typeof value.byteLength === "number") return value.byteLength > 0
  if ("size" in value && typeof value.size === "number") return value.size > 0
  return false
}

export function validateMessage(message: Message): void {
  assertString(message.id, "message.id")
  assertSerializable(message.id, "message.id")
  if (message.createdAt !== undefined) assertSerializable(message.createdAt, "message.createdAt")
  if (message.metadata !== undefined) assertSerializable(message.metadata, "message.metadata")
  if (!["assistant", "system", "tool", "user"].includes(message.role)) {
    throw new TypeError(`[vitehub:messages] Unsupported message role: ${String(message.role)}.`)
  }
  if (!Array.isArray(message.parts)) {
    throw new TypeError("[vitehub:messages] message.parts must be an array.")
  }

  const openToolCalls = new Map<string, ToolCallPart | ApprovalRequestPart>()
  for (const [index, part] of message.parts.entries()) {
    if (part.type !== "audio") assertSerializable(part, `message.parts[${index}]`)
    switch (part.type) {
      case "text":
        if (typeof part.text !== "string") throw new TypeError("[vitehub:messages] text part requires text.")
        break
      case "tool-call":
        assertString(part.id, "tool-call.id")
        assertString(part.name, "tool-call.name")
        openToolCalls.set(part.id, part)
        break
      case "approval-request":
        assertString(part.id, "approval-request.id")
        assertString(part.name, "approval-request.name")
        openToolCalls.set(part.id, part)
        break
      case "approval-decision":
        assertString(part.id, "approval-decision.id")
        if (typeof part.approved !== "boolean") throw new TypeError("[vitehub:messages] approval-decision.approved must be a boolean.")
        if (!openToolCalls.has(part.id)) {
          throw new TypeError(`[vitehub:messages] approval-decision "${part.id}" must follow a matching approval-request.`)
        }
        break
      case "tool-result":
        assertString(part.id, "tool-result.id")
        assertString(part.name, "tool-result.name")
        if (!openToolCalls.has(part.id)) {
          throw new TypeError(`[vitehub:messages] tool-result "${part.id}" must follow a matching tool-call or approval-request.`)
        }
        openToolCalls.delete(part.id)
        break
      case "data":
        if (!("data" in part)) throw new TypeError("[vitehub:messages] data part requires data.")
        break
      case "audio": {
        const { fetchData: _fetchData, ...serializablePart } = part
        assertSerializable(serializablePart, `message.parts[${index}]`)
        if (typeof part.mediaType !== "string" || !part.mediaType.startsWith("audio/")) {
          throw new TypeError("[vitehub:messages] audio part requires an audio/* mediaType.")
        }
        const hasData = hasAudioData(part.data)
        const hasFetchData = typeof part.fetchData === "function"
        const hasUrl = typeof part.url === "string" && part.url.length > 0
        if ([hasData, hasFetchData, hasUrl].filter(Boolean).length !== 1) {
          throw new TypeError("[vitehub:messages] audio part requires exactly one of data, fetchData, or url.")
        }
        if (part.id !== undefined) assertString(part.id, "audio.id")
        break
      }
      case "source":
      case "error":
        break
      default:
        throw new TypeError(`[vitehub:messages] Unsupported message part type: ${String((part as { type?: unknown }).type)}.`)
    }
  }
}

function findOrCreateMessage(messages: Message[], event: StreamEvent): Message {
  const fallback = messages.at(-1)
  const id = event.messageId || (fallback?.role === "assistant" ? fallback.id : createId("msg"))
  let message = messages.find(item => item.id === id)
  if (!message) {
    message = createMessage({ id, parts: [], role: "assistant" })
    messages.push(message)
  }
  return message
}

export function applyStreamEvent(messages: Message[], event: StreamEvent): Message[] {
  const next = messages.map(message => ({ ...message, parts: [...message.parts] }))
  if (event.type === "finish" || event.type === "usage") {
    return next
  }

  const message = findOrCreateMessage(next, event)
  if ("role" in event && event.role) message.role = event.role

  if (event.type === "text-delta") {
    const last = message.parts.at(-1)
    if (last?.type === "text" && (!event.id || last.id === event.id)) {
      last.text += event.text
    }
    else {
      message.parts.push(omitUndefined({ id: event.id, text: event.text, type: "text" }) as TextPart)
    }
  }
  else if (event.type === "data") {
    message.parts.push({ ...omitUndefined({ id: event.id, type: "data" }), data: event.data } as DataPart)
  }
  else if (event.type === "tool-input-start") {
    message.parts.push(omitUndefined({ id: event.id, input: event.input, name: event.name, state: "running", type: "tool-call" }) as ToolCallPart)
  }
  else if (event.type === "tool-call") {
    const existing = message.parts.find((part): part is ToolCallPart => part.type === "tool-call" && part.id === event.id)
    if (existing && event.input !== undefined) existing.input = event.input
    else if (!existing) message.parts.push(omitUndefined({ id: event.id, input: event.input, name: event.name, state: "proposed", type: "tool-call" }) as ToolCallPart)
  }
  else if (event.type === "tool-result") {
    message.parts.push(omitUndefined({ error: event.error, id: event.id, name: event.name, output: event.output, state: event.error ? "failed" : "completed", type: "tool-result" }) as ToolResultPart)
  }
  else if (event.type === "approval-request") {
    message.parts.push(omitUndefined({ id: event.id, input: event.input, name: event.name, reason: event.reason, type: "approval-request" }) as ApprovalRequestPart)
  }
  else if (event.type === "approval-decision") {
    const decidedAt = normalizeCreatedAt(event.decidedAt)
    message.parts.push(omitUndefined({ approved: event.approved, decidedAt, id: event.id, reason: event.reason, type: "approval-decision" }) as ApprovalDecisionPart)
  }
  else if (event.type === "error") {
    message.parts.push(omitUndefined({ error: event.error, id: event.id, recoverable: event.recoverable, type: "error" }) as ErrorPart)
  }

  validateMessage(message)
  return next
}

export async function collectStreamEvents(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

export function serializeMessages(messages: Message[]): string {
  for (const [messageIndex, message] of messages.entries()) {
    validateMessage(message)
    for (const [partIndex, part] of message.parts.entries()) {
      if (part.type === "audio" && typeof part.fetchData === "function") {
        throw new TypeError(`[vitehub:messages] serializeMessages() cannot serialize message[${messageIndex}].parts[${partIndex}].fetchData. Provide audio data or a URL before serializing.`)
      }
    }
  }
  return JSON.stringify({ messages, version: 1 } satisfies SerializedMessages)
}

export function deserializeMessages(input: string | SerializedMessages): Message[] {
  const parsed = typeof input === "string" ? JSON.parse(input) as SerializedMessages : input
  if (parsed.version !== 1 || !Array.isArray(parsed.messages)) {
    throw new TypeError("[vitehub:messages] Unsupported serialized messages payload.")
  }
  for (const message of parsed.messages) validateMessage(message)
  return parsed.messages
}
