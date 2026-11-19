import { isRecord } from "@vite-hub/internal/object"

export const mcpRegistrationPluginId = "vitehub-mcp-registration"

/**
 * The resources of MCP OAuth: the Better Auth `oauthProvider()` with `resources` and JWT access tokens of `jwt()`, from
 * `mcpOAuth()` or added by hand. Empty when the Auth has no MCP OAuth, also with `disableJwtPlugin`, whose access tokens
 * are opaque. `verifyMcpRequest()` and `requireCaller()` both use this one rule.
 */
export function mcpOAuthResources(plugins: ReadonlyArray<{ id?: string, options?: unknown }> = []): string[] {
  const provider = plugins.find(plugin => plugin.id === "oauth-provider")?.options
  if (!isRecord(provider) || !Array.isArray(provider.resources) || provider.disableJwtPlugin === true) return []
  if (!plugins.some(plugin => plugin.id === "jwt")) return []
  return provider.resources.flatMap(entry => typeof entry === "string" ? [entry] : isRecord(entry) && typeof entry.identifier === "string" ? [entry.identifier] : [])
}

/** True for a token in the JWS compact form (`header.payload.signature`), the form of an MCP OAuth access token. */
export const isJwsToken = (token: string): boolean => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)
