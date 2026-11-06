import { consoleDiagnosticBody } from "../diagnostics.ts"
import { consoleRequest, installedConsoleOAuth } from "./access.ts"
import { consoleMcpScopes, resolveConsoleOAuth } from "./bearer.ts"
import { withListedConsoleOrigin } from "./cors.ts"
import { isConsoleDevelopmentRuntime } from "./request.ts"

import type { H3Event } from "h3"

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" }

/**
 * OAuth 2.0 protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource` and its path-suffixed
 * forms. The bare form and `/.well-known/oauth-protected-resource/_vitehub/mcp` describe the MCP endpoint, which MCP
 * clients try. `/.well-known/oauth-protected-resource/_vitehub` describes the Console resource, the one resource of the
 * Console data routes, when the Auth issues Console tokens. Each names the resource and the authorization server
 * (Better Auth's `oauthProvider`) from trusted configuration, never from the Host of the request. A Console that does
 * not sign in with OAuth has no such server and answers 404. One whose Auth lacks what OAuth needs answers 503 with the
 * fix. A Console on an origin in `console.origins` can read the documents.
 */
const consoleMcpMetadataHandler: (event: H3Event) => Promise<Response> = async (event) => {
  const request = consoleRequest(event)
  return withListedConsoleOrigin(await metadata(event, request), request)
}

async function metadata(event: H3Event, request: Request): Promise<Response> {
  const oauth = installedConsoleOAuth()
  if (!oauth) return Response.json({ code: "CONSOLE_NOT_FOUND", message: "This Console does not use OAuth sign-in for MCP." }, { headers, status: 404 })
  const state = await resolveConsoleOAuth(oauth, event, request, isConsoleDevelopmentRuntime())
  if (!state.ready) return Response.json({ ...consoleDiagnosticBody(state.code, state.message), ok: false, status: 503 }, { headers, status: 503 })
  // `/.well-known/oauth-protected-resource<path>` describes the resource at <path>. The bare form describes the endpoint.
  const suffix = new URL(request.url).pathname.slice("/.well-known/oauth-protected-resource".length).replace(/\/+$/, "")
  const document = (resource: string, name: string) => Response.json({
    authorization_servers: [state.issuer],
    bearer_methods_supported: ["header"],
    resource,
    resource_name: name,
    scopes_supported: [...consoleMcpScopes, "offline_access"],
  }, { headers, status: 200 })
  if (suffix && suffix === new URL(state.console.resource).pathname.replace(/\/+$/, "")) {
    if (!state.console.ready) return Response.json({ ...consoleDiagnosticBody("CONSOLE_MCP_OAUTH_INCOMPLETE", state.console.message), ok: false, status: 503 }, { headers, status: 503 })
    return document(state.console.resource, "ViteHub Console")
  }
  if (suffix && suffix !== new URL(state.resource).pathname.replace(/\/+$/, "")) return Response.json({ code: "CONSOLE_NOT_FOUND", message: "This path is not a protected resource of the Console." }, { headers, status: 404 })
  return document(state.resource, "ViteHub Console")
}

export default consoleMcpMetadataHandler
