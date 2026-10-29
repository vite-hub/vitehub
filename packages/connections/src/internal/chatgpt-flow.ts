import * as v from "valibot"

import { connectionsErrorDiagnostics } from "../error-diagnostics.ts"
import { chatgptDynamicClientId, chatgptIssuer } from "./chatgpt-identity.ts"

export const chatgptRegistration = v.pipe(v.string(), v.regex(/^oaiapp_[A-Za-z0-9_-]{1,240}$/))
export const chatgptTokenMetadata = v.object({
  clientId: chatgptRegistration,
  idToken: v.pipe(v.string(), v.minLength(1), v.maxLength(65_536)),
  earliestRefreshAt: v.optional(v.pipe(v.number(), v.finite())),
})

export const chatgptTerminalRefreshErrors = new Set([
  "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused",
])

export function chatgptCallbackClient(expected: string, received?: string): string {
  const clientId = received ?? expected
  if (!v.is(chatgptRegistration, clientId) || expected !== chatgptDynamicClientId && clientId !== expected) {
    throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_REGISTRATION()
  }
  return clientId
}

export function assertChatGPTCallback(value: string): void {
  const url = new URL(value)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/callback" || url.username || url.password || url.search || url.hash) {
    throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_LOOPBACK()
  }
}

export async function chatgptRevocationEndpoint(request: typeof fetch): Promise<string> {
  const response = await request(`${chatgptIssuer}/.well-known/openid-configuration`, { redirect: "error", signal: AbortSignal.timeout(10_000) })
  const parsed = v.safeParse(v.object({ issuer: v.literal(chatgptIssuer), revocation_endpoint: v.string() }), await response.json().catch(() => undefined))
  if (!response.ok || !parsed.success) throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ provider: "chatgpt", problem: "invalid-json" })
  const url = new URL(parsed.output.revocation_endpoint)
  if (url.origin !== chatgptIssuer || url.username || url.password || url.hash) throw connectionsErrorDiagnostics.CONNECTIONS_PROVIDER_FAILED({ provider: "chatgpt", problem: "invalid-json" })
  return url.href
}
