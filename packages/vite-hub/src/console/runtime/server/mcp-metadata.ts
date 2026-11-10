import { consoleDiagnosticBody } from "../diagnostics.ts"
import { consoleRequest, installedConsoleOAuth } from "./access.ts"
import { consoleMcpScopes, resolveConsoleOAuth } from "./bearer.ts"
import { consoleRoute, isConsoleDevelopmentRuntime } from "./request.ts"

import type { ConsoleRoute } from "./request.ts"

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" }

/**
 * OAuth 2.0 protected resource metadata (RFC 9728) of the MCP endpoint, at `/.well-known/oauth-protected-resource` and
 * the path-suffixed form that MCP clients try, and of the Console resource at `/.well-known/oauth-protected-resource/_vitehub`. It names the resource and the authorization server (Better Auth's
 * `oauthProvider`) from trusted configuration, never from the Host of the request. A Console that does not sign in with
 * OAuth has no such server and answers 404. One whose Auth lacks what MCP OAuth needs answers 503 with the fix.
 */
const consoleMcpMetadataRoute: ConsoleRoute = consoleRoute(async (event) => {
  const oauth = installedConsoleOAuth()
  if (!oauth) return Response.json({ code: "CONSOLE_NOT_FOUND", message: "This Console does not use OAuth sign-in for MCP." }, { headers, status: 404 })
  const request = consoleRequest(event)
  const state = await resolveConsoleOAuth(oauth, event, request, isConsoleDevelopmentRuntime())
  if (!state.ready) return Response.json({ ...consoleDiagnosticBody(state.code, state.message), ok: false, status: 503 }, { headers, status: 503 })
  // `/.well-known/oauth-protected-resource<path>` describes the resource at <path>: the MCP endpoint, or the Console
  // resource `<base>/_vitehub` that a hosted Console signs in for. The bare form describes the MCP endpoint.
  const suffix = new URL(request.url).pathname.slice("/.well-known/oauth-protected-resource".length).replace(/\/+$/, "")
  const resource = !suffix || suffix === new URL(state.resource).pathname.replace(/\/+$/, "")
    ? state.resource
    : state.console && suffix === new URL(state.console.resource).pathname ? state.console.resource : undefined
  if (!resource) return Response.json({ code: "CONSOLE_NOT_FOUND", message: "This path is not a protected resource of the Console." }, { headers, status: 404 })
  return Response.json({
    authorization_servers: [state.issuer],
    bearer_methods_supported: ["header"],
    resource,
    resource_name: "ViteHub Console",
    scopes_supported: [...consoleMcpScopes, "offline_access"],
  }, { headers, status: 200 })
})

export default consoleMcpMetadataRoute
