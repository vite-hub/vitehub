export const chatDevtoolsAdapterName = "devtools"
export const chatDevtoolsDefaultUrl = "https://vitehub.dev/playground/chat"
export const chatDevtoolsDockId = "@vitehub/chat"
export const chatDevtoolsRoute = "/__vitehub/chat/devtools"
export const chatDevtoolsRpcClear = "@vitehub/chat:clear"
export const chatDevtoolsRpcGetState = "@vitehub/chat:get-state"
export const chatDevtoolsRpcSend = "@vitehub/chat:send"

export interface ChatDevtoolsTranscriptMessage {
  author: "assistant" | "user"
  chat: string
  id: string
  text: string
  threadId: string
  timestamp: string
}

export interface ChatDevtoolsRequest {
  chatName?: string
  clear?: boolean
  text?: string
}

export interface ChatDevtoolsResult {
  chatName?: string
  chats: string[]
  messages: ChatDevtoolsTranscriptMessage[]
  status: string
}

export interface ChatDevtoolsSendParams {
  chatName?: string
  text?: string
}

export interface ChatDevtoolsChatParams {
  chatName?: string
}
