import type { UIMessage } from "ai"

export const chatDevtoolsFeatureId = "agent.chat" as const
export const chatDevtoolsTitle = "Chat"
export const chatDevtoolsBridgeRoute = "/__vitehub/agent/chat/devtools"
export const chatDevtoolsGetStateRpc = "@vite-hub/agent/chat:get-state"
export const chatDevtoolsSendRpc = "@vite-hub/agent/chat:send"
export const chatDevtoolsClearRpc = "@vite-hub/agent/chat:clear"
export const chatDevtoolsMaterializeSourceRpc = "@vite-hub/agent/chat:materialize-source"
export const chatDevtoolsStreamChannel = "@vite-hub/agent/chat:stream"
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
  status?: "lazy" | "updating" | "ready" | "error"
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

export interface ChatDevtoolsInvokerProfile {
  id: string
  kind?: string
  label?: string
  meta?: Record<string, unknown>
}

export interface ChatDevtoolsMetadata {
  files?: ChatDevtoolsFileTreeItem[]
  instructions?: string[]
  invokerProfiles?: ChatDevtoolsInvokerProfile[]
  title?: string
  tools?: ChatDevtoolsToolDefinition[]
  version?: string
}

export type ChatDevtoolsMetadataStatus = "error" | "loading" | "ready"

export interface ChatDevtoolsMessage {
  createdAt: string
  id: string
  loading?: boolean
  role: ChatDevtoolsMessageRole
  text: string
  tools?: ChatDevtoolsTool[]
}

export interface ChatDevtoolsConversation {
  invokerFallback?: boolean
  invokerProfileId?: string
  messages: ChatDevtoolsMessage[]
  name: string
  title?: string
  uiMessages?: UIMessage[]
}

export interface ChatDevtoolsStateResult {
  chats: ChatDevtoolsConversation[]
  files?: ChatDevtoolsFileTreeItem[]
  instructions?: string[]
  invokerFallback?: boolean
  invokerProfileId?: string
  invokerProfiles?: ChatDevtoolsInvokerProfile[]
  metadataError?: string
  metadataStatus?: ChatDevtoolsMetadataStatus
  selected: string
  thinkingFallback?: string | null
  title?: string
  tools?: ChatDevtoolsToolDefinition[]
  uiMessages?: UIMessage[]
  version?: string
}

export interface ChatDevtoolsSendInput {
  chat?: string
  invokerFallback?: boolean
  invokerProfileId?: string
  stream?: boolean
  text: string
}

export interface ChatDevtoolsClearInput {
  chat?: string
  invokerFallback?: boolean
  invokerProfileId?: string
}

export interface ChatDevtoolsMaterializeSourceInput {
  chat?: string
  invokerFallback?: boolean
  invokerProfileId?: string
  path?: string
  source?: string
}

export interface ChatDevtoolsSendResult extends ChatDevtoolsStateResult {
  streamId?: string
}

export type ChatDevtoolsStreamEvent =
  | { state: ChatDevtoolsStateResult, type: "state" }
  | { type: "done" }
  | { message: string, type: "error" }
