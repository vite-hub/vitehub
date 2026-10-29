import type { EnvAccessContext } from "@vite-hub/env/bridge"
import type { ConnectionsRuntime } from "../runtime.ts"

/** Kept outside the public Connections client and runtime interface. */
export interface ChatGPTCredential {
  accessToken: string
  expiresAt: number
  api: string
  clientInfo: { name: string, title: string, version: string }
}

export type UseChatGPTCredential = <T>(
  name: string,
  options: { access: EnvAccessContext, invocationId?: string, signal?: AbortSignal },
  use: (credential: ChatGPTCredential) => Promise<T>,
) => Promise<T>

const uses = new WeakMap<ConnectionsRuntime, UseChatGPTCredential>()

export function registerChatGPTCredentialUse(runtime: ConnectionsRuntime, use: UseChatGPTCredential): void {
  uses.set(runtime, use)
}

export function useChatGPTCredential(runtime: ConnectionsRuntime): UseChatGPTCredential {
  const use = uses.get(runtime)
  if (!use) throw new Error("The Connections runtime does not support ChatGPT plan usage.")
  return use
}
