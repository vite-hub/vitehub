import * as v from "valibot"

import { connectionsErrorDiagnostics } from "./error-diagnostics.ts"
import { chatgptResource } from "./internal/chatgpt-identity.ts"
import type { ConnectionChatGPTProvider, ConnectionDefinition } from "./types.ts"

const appText = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128), v.check(value => [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)))
export const chatgptProviderSchema: v.GenericSchema<unknown, ConnectionChatGPTProvider> = v.strictObject({
  kind: v.literal("chatgpt"),
  id: v.literal("chatgpt"),
  appName: appText,
  appVersion: appText,
  api: v.pipe(v.string(), v.check((value) => {
    if (value === chatgptResource) return true
    try {
      const url = new URL(value)
      return url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password && !url.search && !url.hash
    }
    catch { return false }
  })),
})

export interface ChatGPTOptions {
  /** Your app's name, used for registration and Codex attribution on every host. */
  appName: string
  /** Your app's version, sent in Codex clientInfo. Default: `0.0.0`. */
  appVersion?: string
}

/** Sign in with ChatGPT for plan usage. No client secret or API key is required. */
export function chatgpt(options: ChatGPTOptions): ConnectionChatGPTProvider {
  const provider = v.safeParse(chatgptProviderSchema, { kind: "chatgpt", id: "chatgpt", appName: options.appName, appVersion: options.appVersion ?? "0.0.0", api: chatgptResource })
  if (!provider.success) throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_PROVIDER({ problem: "chatgpt" })
  return Object.freeze(provider.output)
}

export function isChatGPTProvider(provider: ConnectionDefinition["provider"]): provider is ConnectionChatGPTProvider {
  return "kind" in provider && provider.kind === "chatgpt"
}
