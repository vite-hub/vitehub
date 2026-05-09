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
  | ApprovalRequestPart
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
  | { error?: string, id: string, messageId?: string, name: string, output?: unknown, type: "tool-result" }
  | { id: string, input?: unknown, messageId?: string, name: string, reason?: string, type: "approval-request" }
  | { error: string, id?: string, messageId?: string, recoverable?: boolean, type: "error" }
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

export function validateMessage(message: Message): void {
  assertString(message.id, "message.id")
  if (!["assistant", "system", "tool", "user"].includes(message.role)) {
    throw new TypeError(`[vitehub:messages] Unsupported message role: ${String(message.role)}.`)
  }
  if (!Array.isArray(message.parts)) {
    throw new TypeError("[vitehub:messages] message.parts must be an array.")
  }

  const openToolCalls = new Map<string, ToolCallPart | ApprovalRequestPart>()
  for (const part of message.parts) {
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
      case "tool-result":
        assertString(part.id, "tool-result.id")
        assertString(part.name, "tool-result.name")
        if (!openToolCalls.has(part.id)) {
          throw new TypeError(`[vitehub:messages] tool-result "${part.id}" must follow a matching tool-call or approval-request.`)
        }
        openToolCalls.delete(part.id)
        break
      case "data":
      case "source":
      case "error":
        break
      default:
        throw new TypeError(`[vitehub:messages] Unsupported message part type: ${String((part as { type?: unknown }).type)}.`)
    }
  }
}

function findOrCreateMessage(messages: Message[], event: StreamEvent): Message {
  const id = event.messageId || messages.at(-1)?.id || createId("msg")
  let message = messages.find(item => item.id === id)
  if (!message) {
    message = createMessage({ id, parts: [], role: "assistant" })
    messages.push(message)
  }
  return message
}

export function applyStreamEvent(messages: Message[], event: StreamEvent): Message[] {
  const next = messages.map(message => ({ ...message, parts: [...message.parts] }))
  if (event.type === "finish") {
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
      message.parts.push({ id: event.id, text: event.text, type: "text" })
    }
  }
  else if (event.type === "data") {
    message.parts.push({ data: event.data, id: event.id, type: "data" })
  }
  else if (event.type === "tool-input-start") {
    message.parts.push({ id: event.id, input: event.input, name: event.name, state: "running", type: "tool-call" })
  }
  else if (event.type === "tool-call") {
    const existing = message.parts.find((part): part is ToolCallPart => part.type === "tool-call" && part.id === event.id)
    if (existing) existing.input = event.input
    else message.parts.push({ id: event.id, input: event.input, name: event.name, state: "proposed", type: "tool-call" })
  }
  else if (event.type === "tool-result") {
    message.parts.push({ error: event.error, id: event.id, name: event.name, output: event.output, state: event.error ? "failed" : "completed", type: "tool-result" })
  }
  else if (event.type === "approval-request") {
    message.parts.push({ id: event.id, input: event.input, name: event.name, reason: event.reason, type: "approval-request" })
  }
  else if (event.type === "error") {
    message.parts.push({ error: event.error, id: event.id, recoverable: event.recoverable, type: "error" })
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
  for (const message of messages) validateMessage(message)
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
