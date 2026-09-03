export const consoleRpcMethods = {
  agents: "vitehub:console:agents",
  blob: "vitehub:console:blob",
  database: "vitehub:console:database",
  definitions: "vitehub:console:definitions",
  invocation: "vitehub:console:invocation",
  invocationCapabilities: "vitehub:console:invocation-capabilities",
  invocations: "vitehub:console:invocations",
  kv: "vitehub:console:kv",
  search: "vitehub:console:search",
  sections: "vitehub:console:sections",
  usage: "vitehub:console:usage",
} as const

export interface ConsoleRpcInput {
  body?: unknown
  id?: string
  method?: "GET" | "POST"
  query?: Record<string, string | string[]>
}

export type ConsoleRpcResult = { ok: true; value: unknown } | { message: string; ok: false; status: number }
