import { consoleRequest } from "./access.ts"
import consoleMcpMetadataHandler from "./mcp-metadata.ts"
import consoleMcpAuthorizationServerHandler from "./mcp-authorization-server.ts"

import type { H3Event } from "h3"

/** Public OAuth discovery must run before global app Auth, including when Nitro separates routed middleware. */
export default async function consoleMcpDiscoveryHandler(event: H3Event): Promise<Response | undefined> {
  const request = consoleRequest(event)
  if (request.method !== "GET") return
  const pathname = new URL(request.url).pathname
  for (const [prefix, handler] of [
    ["/.well-known/oauth-protected-resource", consoleMcpMetadataHandler],
    ["/.well-known/oauth-authorization-server", consoleMcpAuthorizationServerHandler],
  ] as const) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const response = await handler(event)
      // Another resource or issuer on this origin belongs to the application's handlers and Auth policy.
      return response.status === 404 ? undefined : response
    }
  }
}
