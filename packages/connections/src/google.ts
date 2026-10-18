import { gmailMethods, gmailRootUrl } from "./google/gmail.ts"

import type { GmailMethods } from "./google/gmail.ts"
import type { ConnectionProvider, ConnectionValue } from "./types.ts"

export type * from "./google/gmail.ts"

export interface GoogleApis {
  gmail: GmailMethods
}

export interface GoogleProviderOptions {
  clientId: ConnectionValue
  clientSecret: ConnectionValue
}

/**
 * Google OAuth 2.0 with offline access. It requests `openid`, so the account comes
 * from the ID token that Google returns from the token endpoint.
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
  }
}
