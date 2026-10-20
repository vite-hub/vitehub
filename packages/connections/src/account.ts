import * as v from "valibot"

import type { ConnectionAccount, ConnectionProvider, ConnectionTokenResponse } from "./types.ts"

const idTokenClaims = v.object({ sub: v.string(), email: v.optional(v.unknown()) })

/** Decode one base64url segment with `atob`, which Node, Deno, and Workerd all provide. */
function decodeBase64Url(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "="))
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
}

/**
 * Read the account from the `sub` and `email` claims of an OpenID Connect ID token.
 *
 * The signature is not verified. The ID token comes directly from the token endpoint
 * over TLS in the authorization code flow, so OpenID Connect Core 1.0, section 3.1.3.7,
 * lets the client use the TLS server validation instead of the token signature.
 * Do not use this for an ID token that arrives through any other channel.
 */
export function accountFromIdToken(token: string | undefined): ConnectionAccount | undefined {
  const payload = token?.split(".")[1]
  if (!payload) return undefined
  try {
    const parsed = v.safeParse(idTokenClaims, JSON.parse(decodeBase64Url(payload)))
    if (!parsed.success) return undefined
    const account: ConnectionAccount = { id: parsed.output.sub }
    if (typeof parsed.output.email === "string") account.email = parsed.output.email
    return account
  }
  catch {
    return undefined
  }
}

/** The account of a token response. Without `account`, a provider that requests `openid` reads the ID token. */
export function providerAccount(provider: ConnectionProvider, response: ConnectionTokenResponse): ConnectionAccount | undefined {
  if (provider.account) return provider.account(response)
  return provider.identityScopes?.includes("openid") ? accountFromIdToken(response.id_token) : undefined
}
