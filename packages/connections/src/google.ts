import * as v from "valibot"

import { gmailMethods, gmailRootUrl } from "./google/gmail.ts"

import type { GmailMethods } from "./google/gmail.ts"
import type { ConnectionAccount, ConnectionProvider, ConnectionValue } from "./types.ts"

export type * from "./google/gmail.ts"

export interface GoogleApis {
  gmail: GmailMethods
}

export interface GoogleProviderOptions {
  clientId: ConnectionValue
  clientSecret: ConnectionValue
}

const accountClaims = v.object({ sub: v.string(), email: v.optional(v.string()) })

function decodeIdToken(token: string | undefined): ConnectionAccount | undefined {
  const payload = token?.split(".")[1]
  if (!payload) return undefined
  try {
    const claims: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0))))
    const parsed = v.safeParse(accountClaims, claims)
    if (!parsed.success) return undefined
    const account: ConnectionAccount = { id: parsed.output.sub }
    if (parsed.output.email !== undefined) account.email = parsed.output.email
    return account
  }
  catch {
    return undefined
  }
}

/**
 * Google OAuth 2.0 with offline access. The account comes from the ID token that
 * Google returns from the token endpoint over TLS.
 */
export function google(options: GoogleProviderOptions): ConnectionProvider<GoogleApis> {
  return {
    id: "google",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    identityScopes: ["openid", "email"],
    authorizationParams: { access_type: "offline", prompt: "consent" },
    apis: {
      gmail: {
        rootUrl: gmailRootUrl,
        methods: gmailMethods,
        highRisk: [
          "users.drafts.delete",
          "users.drafts.send",
          "users.labels.delete",
          "users.messages.batchDelete",
          "users.messages.delete",
          "users.messages.send",
          "users.settings.*",
          "users.threads.delete",
        ],
      },
    },
    account: token => decodeIdToken(token.id_token),
  }
}
