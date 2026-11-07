import { describe, expectTypeOf, it } from "vitest"

import { defineAuth } from "../src/definition.ts"
import { deleteUnusedMcpClients, mcpOAuth, serveMcpOAuthDiscovery, verifyMcpRequest } from "../src/mcp.ts"

import type { BetterAuthPlugin } from "better-auth"
import type { AuthFor } from "../src/types.ts"

it("returns the codes that each MCP helper can fail with", async () => {
  const [error, caller] = await verifyMcpRequest(new Request("https://app.example.com/mcp"))
  if (error) expectTypeOf(error.code).toEqualTypeOf<"AUTH_MCP_TOKEN_INVALID" | "AUTH_MCP_TOKEN_MISSING">()
  else expectTypeOf(caller.clientName).toEqualTypeOf<string | undefined>()
  const [cleanupError, cleanup] = await deleteUnusedMcpClients()
  if (cleanupError) expectTypeOf(cleanupError.code).toEqualTypeOf<"AUTH_MCP_CLEANUP_FAILED">()
  else expectTypeOf(cleanup.deleted).toEqualTypeOf<number>()
})

it("returns Better Auth plugins and passes provider options through", () => {
  expectTypeOf(mcpOAuth({ loginPage: "/oauth", provider: { codeExpiresIn: 1800 }, resource: "https://app.example.com/mcp" })).toExtend<BetterAuthPlugin[]>()
  // @ts-expect-error The resource is required.
  mcpOAuth({ loginPage: "/oauth" })
})

describe("the typed Auth of a Definition with mcpOAuth()", () => {
  const callback = defineAuth(({ requestOrigin }) => ({
    baseURL: requestOrigin,
    plugins: [...mcpOAuth({ loginPage: "/oauth", resource: `${requestOrigin}/mcp` })],
  }))
  const object = defineAuth({ plugins: [...mcpOAuth({ loginPage: "/oauth", resource: "https://app.example.com/mcp" })] })

  it("has the JWT and OAuth provider endpoints", () => {
    expectTypeOf<AuthFor<typeof callback>["api"]>().toHaveProperty("getJwks")
    expectTypeOf<AuthFor<typeof object>["api"]>().toHaveProperty("getOAuthServerConfig")
  })

  it("is accepted as the auth of each MCP helper", async () => {
    const auth = {} as AuthFor<typeof callback>
    const request = new Request("https://app.example.com/mcp")
    await verifyMcpRequest(request, { auth })
    await serveMcpOAuthDiscovery(request, { auth })
    await deleteUnusedMcpClients({ auth })
    await verifyMcpRequest(request, { auth: {} as AuthFor<typeof object> })
  })
})
