export const chatDevtoolsPanelId = "@vitehub/chat"
export const chatDevtoolsTitle = "ViteHub Chat"
export const chatDevtoolsRoute = "/__vitehub/chat-devtools/"
export const chatDevtoolsBridgeRoute = "/__vitehub/chat/devtools"
export const chatDevtoolsGetStateRpc = "@vitehub/chat:get-state"
export const chatDevtoolsSendRpc = "@vitehub/chat:send"
export const chatDevtoolsClearRpc = "@vitehub/chat:clear"
export const chatDevtoolsStreamChannel = "@vitehub/chat:stream"
export const chatDevtoolsUrlEnv = "VITEHUB_CHAT_DEVTOOLS_URL"
export const chatDevtoolsAdapterName = "devtools"

export type ChatDevtoolsMessageRole = "user" | "assistant"
export type ChatDevtoolsToolStatus = "running" | "completed" | "error"

export interface ChatDevtoolsTool {
  id: string
  input?: unknown
  name: string
  output?: unknown
  status: ChatDevtoolsToolStatus
  text: string
  updatedAt: string
}

export type ChatDevtoolsFileKind = "directory" | "file"

export interface ChatDevtoolsFileTreeItem {
  children?: ChatDevtoolsFileTreeItem[]
  kind: ChatDevtoolsFileKind
  label?: string
  materialize?: "build" | "lazy"
  materialized?: boolean
  materializedAt?: string
  path: string
  source?: string
  updatedAt?: string
}

export interface ChatDevtoolsToolDefinition {
  category?: string
  commands?: string[]
  description?: string
  icon?: string
  name: string
  preset?: string
  status?: "available" | "disabled"
}

export interface ChatDevtoolsMetadata {
  files?: ChatDevtoolsFileTreeItem[]
  instructions?: string[]
  tools?: ChatDevtoolsToolDefinition[]
}

export interface ChatDevtoolsMessage {
  createdAt: string
  id: string
  role: ChatDevtoolsMessageRole
  text: string
  tools?: ChatDevtoolsTool[]
}

export interface ChatDevtoolsConversation {
  messages: ChatDevtoolsMessage[]
  name: string
}

export interface ChatDevtoolsStateResult {
  chats: ChatDevtoolsConversation[]
  files?: ChatDevtoolsFileTreeItem[]
  instructions?: string[]
  selected: string
  tools?: ChatDevtoolsToolDefinition[]
}

export interface ChatDevtoolsSendInput {
  chat?: string
  text: string
}

export interface ChatDevtoolsClearInput {
  chat?: string
}

export interface ChatDevtoolsSendResult extends ChatDevtoolsStateResult {
  streamId?: string
}

export type ChatDevtoolsStreamEvent =
  | { state: ChatDevtoolsStateResult, type: "state" }
  | { type: "done" }
  | { message: string, type: "error" }
