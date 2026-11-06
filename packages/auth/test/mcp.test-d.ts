import { expectTypeOf, it } from "vitest"

import { deleteUnusedMcpClients, mcpOAuth, verifyMcpRequest } from "../src/mcp.ts"

import type { BetterAuthPlugin } from "better-auth"
import type { H3Event } from "h3"

it("returns the codes that each MCP helper can fail with", async () => {
  const [error, caller] = await verifyMcpRequest(new Request("https://app.example.com/mcp"))
  if (error) expectTypeOf(error.code).toEqualTypeOf<"AUTH_MCP_TOKEN_INVALID" | "AUTH_MCP_TOKEN_MISSING">()
  else expectTypeOf(caller.clientName).toEqualTypeOf<string | undefined>()
  const [cleanupError, cleanup] = await deleteUnusedMcpClients()
  if (cleanupError) expectTypeOf(cleanupError.code).toEqualTypeOf<"AUTH_MCP_CLEANUP_FAILED">()
  else expectTypeOf(cleanup.deleted).toEqualTypeOf<number>()
})

it("returns Better Auth plugins and passes provider options through", () => {
  expectTypeOf(mcpOAuth({ loginPage: "/oauth", provider: { codeExpiresIn: 1800 }, resource: "https://app.example.com/mcp" })).toEqualTypeOf<BetterAuthPlugin[]>()
  // @ts-expect-error The resource is required.
  mcpOAuth({ loginPage: "/oauth" })
})

it("accepts an H3 request and any value with url and headers", async () => {
  const event = {} as H3Event
  await verifyMcpRequest(event.req)
  await verifyMcpRequest({ headers: new Headers({ authorization: "Bearer token" }), url: "https://app.example.com/mcp" })
  // @ts-expect-error The request needs headers.
  await verifyMcpRequest({ url: "https://app.example.com/mcp" })
})
