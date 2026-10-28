import type { Message } from "@vite-hub/agent"

export const consoleRpcHeader = "x-vitehub-console"

export interface ConsoleAgentInvocationInput {
  attachments?: Array<{ id: string, name: string }>
  files?: Array<{ url: string, filename?: string }>
  invokerProfileId?: string
  messages?: Array<Message & { role: "user" | "assistant" }>
  prompt: string
}

/**
 * One Console RPC result. A failure has the Console diagnostic fields: a stable `code`, `message` (the why),
 * and `fix` and `docs` when the failure site has them. Owner action failures, such as `CONTENT_INVALID`, also carry
 * JSON-safe `details`, such as per-field issues.
 */
export type ConsoleRpcResult =
  | { ok: true; value: unknown }
  | { code: string; details?: Record<string, unknown>; docs?: string; fix?: string; message: string; ok: false; status: number }
