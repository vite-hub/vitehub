import { consoleDiagnosticBody } from "../diagnostics.ts"
import { consoleRequest, installedConsoleOAuth } from "./access.ts"
import { resolveConsoleOAuth } from "./bearer.ts"
import { isConsoleDevelopmentRuntime } from "./request.ts"

import type { H3Event } from "h3"

const prefix = "/.well-known/oauth-authorization-server"

/**
 * OAuth 2.0 authorization server metadata (RFC 8414) of the Better Auth that signs MCP clients in, at the origin root
 * where clients look: `/.well-known/oauth-authorization-server` and, for an issuer with a path such as
 * `https://app.example.com/api/auth`, `/.well-known/oauth-authorization-server/api/auth`. Better Auth serves the same
 * document below its own base path only, which a client that starts from the MCP endpoint never asks.
 */
const consoleMcpAuthorizationServerHandler: (event: H3Event) => Promise<Response> = async (event) => {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" }
  const oauth = installedConsoleOAuth()
  if (!oauth) return Response.json({ code: "CONSOLE_NOT_FOUND", message: "This Console does not use OAuth sign-in for MCP." }, { headers, status: 404 })
  const request = consoleRequest(event)
  const state = await resolveConsoleOAuth(oauth, event, request, isConsoleDevelopmentRuntime())
  if (!state.ready) return Response.json({ ...consoleDiagnosticBody(state.code, state.message), ok: false, status: 503 }, { headers, status: 503 })
  const suffix = new URL(request.url).pathname.slice(prefix.length).replace(/\/+$/, "")
  if (suffix && suffix !== new URL(state.issuer).pathname.replace(/\/+$/, "")) return Response.json({ code: "CONSOLE_NOT_FOUND", message: "This path is not the issuer of the Console." }, { headers, status: 404 })
  const metadata = await state.auth.api.getOAuthServerConfig?.({ asResponse: false, headers: new Headers() })
  if (!metadata) return Response.json({ ...consoleDiagnosticBody("CONSOLE_MCP_OAUTH_INCOMPLETE", "The Auth has no OAuth authorization server. It needs the `oauthProvider()` plugin."), ok: false, status: 503 }, { headers, status: 503 })
  if (typeof metadata !== "object" || !("issuer" in metadata) || metadata.issuer !== state.issuer) {
    return Response.json({ ...consoleDiagnosticBody("CONSOLE_MCP_OAUTH_INCOMPLETE", "The Auth's authorization-server metadata issuer must match the MCP issuer. Configure `jwt.issuer` and `console.mcp.issuer` to the same canonical URL."), ok: false, status: 503 }, { headers, status: 503 })
  }
  return Response.json(metadata, { headers: { ...headers, "cache-control": "public, max-age=15, stale-while-revalidate=15" }, status: 200 })
}

export default consoleMcpAuthorizationServerHandler
