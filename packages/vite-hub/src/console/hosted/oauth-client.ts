/**
 * The OAuth client of the hosted Console. A Console signs in to an app with `console: { auth: "app" }` as a public client
 * with no secret. Its `client_id` is the URL of a client ID Metadata Document (CIMD) that the hosted build writes as a
 * static file. The app reads the document and accepts it only on an origin in `console.origins`.
 */

/** The path of the client ID Metadata Document. Its absolute URL is the `client_id`. */
export const consoleOAuthClientPath = "/oauth-client.json"

/** The path where the authorization server sends the browser back with the code. */
export const consoleOAuthCallbackPath = "/oauth/callback"

/** The scopes that the Console asks for: read and change data, and a refresh token. */
export const consoleOAuthScope = "vitehub:read vitehub:write offline_access"

/** The origin of the hosted Console when the build has no `VITEHUB_CONSOLE_ORIGIN`. */
export const defaultConsoleOrigin = "https://console.vitehub.dev"

/** The client ID Metadata Document of a Console on `origin`. */
export interface ConsoleOAuthClientDocument {
  client_id: string
  client_name: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: "none"
  scope: string
}

/**
 * Read the origin that the hosted build serves the Console on, from `VITEHUB_CONSOLE_ORIGIN`. It must be an `https://`
 * origin with no path, because an app accepts a client ID Metadata Document only on an `https://` origin.
 */
export function resolveConsoleHostedOrigin(value: string | undefined): string {
  const input = value?.trim() || defaultConsoleOrigin
  let url: URL
  try {
    url = new URL(input)
  }
  catch {
    throw new Error(`VITEHUB_CONSOLE_ORIGIN is ${JSON.stringify(input)}, which is not a URL. Set it to the origin of the Console, such as https://console.example.com.`)
  }
  if (url.protocol !== "https:") throw new Error(`VITEHUB_CONSOLE_ORIGIN must be an https:// origin, because apps accept a Console OAuth client only on https. It is ${input}.`)
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`VITEHUB_CONSOLE_ORIGIN must be an origin with no path, such as ${url.origin}. It is ${input}.`)
  }
  return url.origin
}

/** The client ID Metadata Document that the hosted build writes to `/oauth-client.json`. */
export function consoleOAuthClientDocument(origin: string): ConsoleOAuthClientDocument {
  return {
    client_id: `${origin}${consoleOAuthClientPath}`,
    client_name: "ViteHub Console",
    redirect_uris: [`${origin}${consoleOAuthCallbackPath}`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: consoleOAuthScope,
  }
}
