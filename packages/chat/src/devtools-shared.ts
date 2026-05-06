export const chatDevtoolsPanelId = "@vitehub/chat"
export const chatDevtoolsTitle = "ViteHub Chat"
export const chatDevtoolsRoute = "/__vitehub/chat-devtools/"
export const chatDevtoolsBridgeRoute = "/__vitehub/chat/devtools"
export const chatDevtoolsGetStateRpc = "@vitehub/chat:get-state"
export const chatDevtoolsSendRpc = "@vitehub/chat:send"
export const chatDevtoolsClearRpc = "@vitehub/chat:clear"
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
  selected: string
}

export interface ChatDevtoolsSendInput {
  chat?: string
  text: string
}

export interface ChatDevtoolsClearInput {
  chat?: string
}
