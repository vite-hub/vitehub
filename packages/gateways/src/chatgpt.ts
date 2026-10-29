import { gatewayDiagnostics } from "./diagnostics.ts"

/** A runtime-owned ChatGPT plan route. It contains no credentials. */
export interface ChatGPTGateway {
  readonly kind: "chatgpt"
  readonly name: "chatgpt"
  readonly connection: string
}

/** Use a ChatGPT Connection with a Codex Driver. Defaults to the `chatgpt` Connection. */
export function chatgpt(options: { connection?: string } = {}): ChatGPTGateway {
  const connection = options.connection ?? "chatgpt"
  if (Object.keys(options).some(key => key !== "connection") || typeof connection !== "string" || !connection.trim() || connection !== connection.trim()) {
    throw gatewayDiagnostics.GATEWAYS_R0001({ message: "[vitehub] chatgpt() accepts only a non-empty Connection name: chatgpt({ connection: \"chatgpt\" })." })
  }
  return Object.freeze({ kind: "chatgpt", name: "chatgpt", connection })
}

export function isChatGPTGateway(value: unknown): value is ChatGPTGateway {
  return typeof value === "object" && value !== null
    && "kind" in value && value.kind === "chatgpt"
    && "name" in value && value.name === "chatgpt"
    && "connection" in value && typeof value.connection === "string" && value.connection.length > 0 && value.connection === value.connection.trim()
    && Object.keys(value).every(key => ["kind", "name", "connection"].includes(key))
}
