import type { Message } from "@vite-hub/agent"

export interface ConsoleAgentInvocationInput {
  attachments?: string[]
  invokerProfileId?: string
  messages?: Array<Message & { role: "user" | "assistant" }>
  prompt: string
}

export const consoleRpcMethods = {
  agents: "vitehub:console:agents",
  attachments: "vitehub:console:attachments",
  agentInvocations: "vitehub:console:agent-invocations",
  blob: "vitehub:console:blob",
  database: "vitehub:console:database",
  definitions: "vitehub:console:definitions",
  invocation: "vitehub:console:invocation",
  invocationCapabilities: "vitehub:console:invocation-capabilities",
  invocations: "vitehub:console:invocations",
  kv: "vitehub:console:kv",
  search: "vitehub:console:search",
  sections: "vitehub:console:sections",
  status: "vitehub:console:status",
  usage: "vitehub:console:usage",
} as const

export type ConsoleRpcMethod = (typeof consoleRpcMethods)[keyof typeof consoleRpcMethods]

export interface ConsoleRpcInput {
  agent?: string
  body?: unknown
  id?: string
  method?: "GET" | "POST"
  query?: Record<string, string | string[]>
}

export type ConsoleRpcResult = { ok: true; value: unknown } | { message: string; ok: false; status: number }

export type ConsoleRpcFunctions = {
  [Method in ConsoleRpcMethod]: (input: ConsoleRpcInput) => Promise<ConsoleRpcResult>
}

declare module "devframe" {
  interface DevframeRpcServerFunctions extends ConsoleRpcFunctions {}
}
