import { consoleDiagnosticBody } from "../diagnostics.ts"
import { consoleRequest, installedConsoleOAuth } from "./access.ts"
import { consoleMcpScopes, resolveConsoleOAuth } from "./bearer.ts"
import { isConsoleDevelopmentRuntime } from "./request.ts"

import type { H3Event } from "h3"

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" }

/**
 * OAuth 2.0 protected resource metadata (RFC 9728) of the MCP endpoint, at `/.well-known/oauth-protected-resource` and
 * the path-suffixed form that MCP clients try. It names the resource and the authorization server (Better Auth's
 * `oauthProvider`) from trusted configuration, never from the Host of the request. A Console that does not sign in with
 * OAuth has no such server and answers 404. One whose Auth lacks what MCP OAuth needs answers 503 with the fix.
 */
const consoleMcpMetadataHandler: (event: H3Event) => Promise<Response> = async (event) => {
  const oauth = installedConsoleOAuth()
  if (!oauth) return Response.json({ code: "CONSOLE_NOT_FOUND", message: "This Console does not use OAuth sign-in for MCP." }, { headers, status: 404 })
  const request = consoleRequest(event)
  const state = await resolveConsoleOAuth(oauth, event, request, isConsoleDevelopmentRuntime())
  if (!state.ready) return Response.json({ ...consoleDiagnosticBody(state.code, state.message), ok: false, status: 503 }, { headers, status: 503 })
  // `/.well-known/oauth-protected-resource<path>` describes the resource at <path>. The bare form describes the endpoint.
  const suffix = new URL(request.url).pathname.slice("/.well-known/oauth-protected-resource".length).replace(/\/+$/, "")
  if (suffix && suffix !== new URL(state.resource).pathname.replace(/\/+$/, "")) return Response.json({ code: "CONSOLE_NOT_FOUND", message: "This path is not a protected resource of the Console." }, { headers, status: 404 })
  return Response.json({
    authorization_servers: [state.issuer],
    bearer_methods_supported: ["header"],
    resource: state.resource,
    resource_name: "ViteHub Console",
    scopes_supported: [...consoleMcpScopes, "offline_access"],
  }, { headers, status: 200 })
}

export default consoleMcpMetadataHandler
