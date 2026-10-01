import { oauth2 } from "./oauth2.ts"

import type { ConnectionOAuthClient, ConnectionProvider } from "../types.ts"

export interface GoogleProviderOptions {
  /** OAuth client of this app. Called for each provider request, so it can read server env. */
  client: (context: { event?: unknown }) => ConnectionOAuthClient | Promise<ConnectionOAuthClient>
  /** Google API scopes. `openid` and `email` are added to show the connected account. */
  scopes: readonly string[]
}

/** Google OAuth 2 with offline access. The grant includes a refresh token. */
export function google(options: GoogleProviderOptions): ConnectionProvider {
  return oauth2({
    authorizationParams: {
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
    },
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    client: options.client,
    id: "google",
    // Google APIs, including Gmail, are served from googleapis.com subdomains.
    origins: ["https://*.googleapis.com"],
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scopes: [...new Set(["openid", "email", ...options.scopes])],
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  })
}
