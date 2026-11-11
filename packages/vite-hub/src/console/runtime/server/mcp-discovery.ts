import { consoleRequest } from "./access.ts"
import consoleMcpMetadataRoute from "./mcp-metadata.ts"
import consoleMcpAuthorizationServerRoute from "./mcp-authorization-server.ts"

import type { ConsoleRequestEvent } from "./request.ts"

/**
 * Public OAuth discovery must run before global app Auth, including when Nitro separates routed middleware. It stays
 * an H3 middleware, so it returns nothing to pass the request on, and calls the Fetchable discovery routes itself.
 */
export function createConsoleMcpDiscoveryHandler(delegatedPaths: readonly string[] = []): (event: ConsoleRequestEvent) => Promise<Response | undefined> {
  return async (event) => {
    const request = consoleRequest(event)
    if (request.method !== "GET") return
    const pathname = new URL(request.url).pathname
    if (delegatedPaths.includes(pathname)) return
    for (const [prefix, route] of [
      ["/.well-known/oauth-protected-resource", consoleMcpMetadataRoute],
      ["/.well-known/oauth-authorization-server", consoleMcpAuthorizationServerRoute],
    ] as const) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        const response = await route.fetch(request)
        // Another resource or issuer on this origin belongs to the application's handlers and Auth policy.
        return response.status === 404 ? undefined : response
      }
    }
  }
}

const consoleMcpDiscoveryHandler: (event: ConsoleRequestEvent) => Promise<Response | undefined> = createConsoleMcpDiscoveryHandler()

export default consoleMcpDiscoveryHandler
