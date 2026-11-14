import type { AuthTableName } from "./schema.ts"

/**
 * The schema keys of the Auth schemas and their SQL names. Its own module, so the Vite plugin lists the tables without
 * loading Drizzle or the schema module.
 */
export const authTableNames: Readonly<Record<AuthTableName, string>> = {
  user: "user",
  session: "session",
  account: "account",
  verification: "verification",
  jwks: "jwks",
  oauthClient: "oauth_client",
  oauthResource: "oauth_resource",
  oauthClientResource: "oauth_client_resource",
  oauthRefreshToken: "oauth_refresh_token",
  oauthAccessToken: "oauth_access_token",
  oauthConsent: "oauth_consent",
  oauthClientAssertion: "oauth_client_assertion",
  rateLimit: "rate_limit",
  organization: "organization",
  member: "member",
  invitation: "invitation",
  passkey: "passkey",
}
