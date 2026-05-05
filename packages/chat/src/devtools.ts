export const chatDevtoolsAdapterName = "devtools"
export const chatDevtoolsDefaultUrl = "https://devtools.vitehub.dev/chat"
export const chatDevtoolsDockId = "@vitehub/chat"
export const chatDevtoolsLocalAssetsRoute = "/__vitehub/chat/devtools-assets"
export const chatDevtoolsLocalUiRoute = "/__vitehub/chat/devtools-ui"
export const chatDevtoolsRoute = "/__vitehub/chat/devtools"
export const chatDevtoolsRpcClear = "@vitehub/chat:clear"
export const chatDevtoolsRpcGetState = "@vitehub/chat:get-state"
export const chatDevtoolsRpcSend = "@vitehub/chat:send"
export const chatDevtoolsStateKey = "@vitehub/chat:state"

export interface ChatDevtoolsTranscriptTool {
  id: string
  input?: unknown
  name: string
  output?: unknown
  status: "running" | "completed" | "error"
  text: string
  timestamp: string
}

export interface ChatDevtoolsTranscriptMessage {
  author: "assistant" | "user"
  chat: string
  id: string
  text: string
  threadId: string
  timestamp: string
  tools?: ChatDevtoolsTranscriptTool[]
}

export interface ChatDevtoolsRequest {
  chatName?: string
  clear?: boolean
  stream?: boolean
  text?: string
}

export interface ChatDevtoolsResult {
  chatName?: string
  chats: string[]
  messages: ChatDevtoolsTranscriptMessage[]
  pending?: boolean
  status: string
}

export interface ChatDevtoolsState extends ChatDevtoolsResult {
  pending: boolean
}

export interface ChatDevtoolsSendParams {
  chatName?: string
  text?: string
}

export interface ChatDevtoolsChatParams {
  chatName?: string
}

export interface ChatDevtoolsToolStatusInput {
  id?: string
  input?: unknown
  name: string
  output?: unknown
  status?: ChatDevtoolsTranscriptTool["status"]
  text?: string
}

export interface ChatDevtoolsToolStepItem {
  input?: unknown
  output?: unknown
  toolCallId?: string
  toolName?: string
}

export interface ChatDevtoolsToolStep {
  text?: string
  toolCalls?: ChatDevtoolsToolStepItem[]
  toolResults?: ChatDevtoolsToolStepItem[]
}

export interface ChatDevtoolsToolStepReportOptions {
  label?: (tool: ChatDevtoolsToolStepItem, status: ChatDevtoolsTranscriptTool["status"]) => string | undefined
  outputPreviewLength?: number
}

export interface ChatDevtoolsTypingThread {
  startTyping(text?: string): Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function truncateText(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, Math.max(0, length - 3))}...` : value
}

function defaultToolLabel(tool: ChatDevtoolsToolStepItem): string | undefined {
  if (isRecord(tool.input) && typeof tool.input.command === "string") {
    return truncateText(tool.input.command.trim(), 80)
  }
  return tool.toolName
}

function previewToolOutput(output: unknown, length: number): unknown {
  return typeof output === "string" ? truncateText(output, length) : output
}

export function createChatDevtoolsToolStatus(input: ChatDevtoolsToolStatusInput): string {
  return JSON.stringify({
    id: input.id,
    input: input.input,
    name: input.name,
    output: input.output,
    status: input.status || "completed",
    text: input.text || input.name,
    type: "vitehub.chat.devtools.tool",
  })
}

export async function reportChatDevtoolsToolStep(
  thread: ChatDevtoolsTypingThread,
  step: ChatDevtoolsToolStep,
  options: ChatDevtoolsToolStepReportOptions = {},
): Promise<void> {
  if (step.text?.trim()) return

  const latestTool = step.toolResults?.at(-1) || step.toolCalls?.at(-1)
  if (!latestTool?.toolName) return

  const status: ChatDevtoolsTranscriptTool["status"] = step.toolResults?.at(-1) === latestTool ? "completed" : "running"
  const toolCalls = step.toolCalls?.filter(tool => tool.toolName).length || 0
  const toolResults = step.toolResults?.filter(tool => tool.toolName).length || 0
  const text = options.label?.(latestTool, status) || defaultToolLabel(latestTool) || latestTool.toolName
  await thread.startTyping(createChatDevtoolsToolStatus({
    id: latestTool.toolCallId || `${latestTool.toolName}-${toolResults || toolCalls}`,
    input: latestTool.input,
    name: latestTool.toolName,
    output: "output" in latestTool ? previewToolOutput(latestTool.output, options.outputPreviewLength ?? 4000) : undefined,
    status,
    text,
  }))
}
