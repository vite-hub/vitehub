import { createRemoteJWKSet, customFetch, jwtVerify } from "jose"
import * as v from "valibot"

import { connectionsErrorDiagnostics } from "../error-diagnostics.ts"
import type { ConnectionAccount } from "../types.ts"

export const chatgptIssuer = "https://auth.openai.com"
export const chatgptResource = "https://api.openai.com/v1"
export const chatgptScopes = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"] as const
export const chatgptDynamicClientId = "dynamic_agent_client"

const identities = new WeakMap<typeof fetch, ReturnType<typeof createRemoteJWKSet>>()
const identitySchema = v.object({
  sub: v.pipe(v.string(), v.minLength(1)),
  email: v.optional(v.pipe(v.string(), v.minLength(1))),
})

/** Validate identity before a new grant can replace a saved ChatGPT account. */
export async function verifyChatGPTIdentity(input: {
  clientId: string
  idToken: string | undefined
  nonce?: string
  now: number
  request: typeof fetch
  subject?: string
}): Promise<ConnectionAccount> {
  try {
    if (!input.idToken || input.idToken.length > 65_536) throw new Error("Missing identity")
    let jwks = identities.get(input.request)
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${chatgptIssuer}/.well-known/jwks.json`), {
        [customFetch]: input.request,
        timeoutDuration: 10_000,
      })
      identities.set(input.request, jwks)
    }
    const { payload } = await jwtVerify(input.idToken, jwks, {
      issuer: chatgptIssuer,
      audience: input.clientId,
      requiredClaims: ["sub", "exp", "iat", ...(input.nonce === undefined ? [] : ["nonce"])],
      currentDate: new Date(input.now),
      clockTolerance: 5,
    })
    if (typeof payload.iat !== "number" || payload.iat * 1000 > input.now + 5000) throw new Error("Invalid issue time")
    if (input.nonce !== undefined && (payload.nonce !== input.nonce || !input.nonce)) throw new Error("Invalid nonce")
    if ((Array.isArray(payload.aud) && payload.aud.length > 1 || payload.azp !== undefined) && payload.azp !== input.clientId) throw new Error("Invalid authorized party")
    const identity = v.parse(identitySchema, payload)
    if (input.subject !== undefined && identity.sub !== input.subject) throw new Error("Different account")
    return { id: identity.sub, ...(identity.email === undefined ? {} : { email: identity.email }) }
  }
  catch {
    throw connectionsErrorDiagnostics.CONNECTIONS_CHATGPT_IDENTITY()
  }
}
