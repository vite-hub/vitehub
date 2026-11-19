import { isRecord } from "@vite-hub/internal/object"

export const mcpRegistrationPluginId = "vitehub-mcp-registration"

/**
 * The resources of the Better Auth `oauthProvider()` plugin, from `mcpOAuth()` or added by hand. An Auth signs MCP
 * clients in when this list is not empty. `verifyMcpRequest()` and `requireCaller()` both use this one rule.
 */
export function mcpResourcesOf(plugins: ReadonlyArray<{ id?: string, options?: unknown }> = []): string[] {
  const provider = plugins.find(plugin => plugin.id === "oauth-provider")?.options
  if (!isRecord(provider) || !Array.isArray(provider.resources)) return []
  return provider.resources.flatMap(entry => typeof entry === "string" ? [entry] : isRecord(entry) && typeof entry.identifier === "string" ? [entry.identifier] : [])
}
