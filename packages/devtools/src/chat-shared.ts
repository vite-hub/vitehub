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

export type ChatDevtoolsConfigValue = boolean | null | number | string

export interface ChatDevtoolsModelMetadata {
  dynamic?: boolean
  id?: string
  provider?: string
}

export interface ChatDevtoolsModelExecutionMetadata {
  callSettings?: Record<string, ChatDevtoolsConfigValue>
  stepLimit?: number
  workspaceFallback?: {
    enabled?: boolean
    maxToolResults?: number
  }
}

export interface ChatDevtoolsHarnessMetadata {
  credentials?: {
    label?: string
    source?: string
  }
  provider?: string
  sandbox?: boolean
  sessionKey?: boolean
}

export interface ChatDevtoolsDriverMetadata {
  execution?: ChatDevtoolsModelExecutionMetadata
  harness?: ChatDevtoolsHarnessMetadata
  kind: "harness" | "model" | "run"
  model?: ChatDevtoolsModelMetadata
}

export interface ChatDevtoolsConfigMetadata {
  driver: ChatDevtoolsDriverMetadata
}

export interface ChatDevtoolsInvokerProfile {
  id: string
  kind?: string
  label?: string
  meta?: Record<string, unknown>
}

export interface ChatDevtoolsWarning {
  id: string
  kind: "instruction-coverage"
  message: string
  primitive: "capability" | "skill" | "source"
  severity: "warning"
}

export interface ChatDevtoolsMetadata {
  config?: ChatDevtoolsConfigMetadata
  files?: ChatDevtoolsFileTreeItem[]
  instructions?: string[]
  invokerProfiles?: ChatDevtoolsInvokerProfile[]
  name?: string
  tools?: ChatDevtoolsToolDefinition[]
  version?: string
  warnings?: ChatDevtoolsWarning[]
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
  config?: ChatDevtoolsConfigMetadata
  files?: ChatDevtoolsFileTreeItem[]
  instructions?: string[]
  invokerFallback?: boolean
  invokerProfileId?: string
  invokerProfiles?: ChatDevtoolsInvokerProfile[]
  meta?: Record<string, unknown>
  metadataError?: string
  metadataStatus?: ChatDevtoolsMetadataStatus
  selected: string
  thinkingFallback?: string | null
  title?: string
  tools?: ChatDevtoolsToolDefinition[]
  uiMessages?: UIMessage[]
  version?: string
  warnings?: ChatDevtoolsWarning[]
}

export interface ChatDevtoolsSendInput {
  chat?: string
  invokerFallback?: boolean
  invokerProfileId?: string
  meta?: Record<string, unknown>
  stream?: boolean
  text: string
}

export interface ChatDevtoolsClearInput {
  chat?: string
  invokerFallback?: boolean
  invokerProfileId?: string
  meta?: Record<string, unknown>
}

export interface ChatDevtoolsMaterializeSourceInput {
  chat?: string
  invokerFallback?: boolean
  invokerProfileId?: string
  meta?: Record<string, unknown>
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
