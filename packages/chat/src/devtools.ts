export const chatDevtoolsAdapterName = "devtools"
export const chatDevtoolsDefaultUrl = "https://devtools.vitehub.dev/chat"
export const chatDevtoolsDockId = "@vitehub/chat"
export const chatDevtoolsLocalUiRoute = "/__vitehub/chat/devtools-ui"
export const chatDevtoolsRoute = "/__vitehub/chat/devtools"
export const chatDevtoolsRpcClear = "@vitehub/chat:clear"
export const chatDevtoolsRpcGetState = "@vitehub/chat:get-state"
export const chatDevtoolsRpcSend = "@vitehub/chat:send"
export const chatDevtoolsStateKey = "@vitehub/chat:state"

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
