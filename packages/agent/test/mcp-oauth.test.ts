import { describe, expect, it, vi } from "vitest"
import type { OAuthClientProvider } from "@ai-sdk/mcp"
import { mcp } from "../src/capabilities.ts"
import { getMcpWarnings } from "../src/capabilities/mcp.ts"
import { resolveAgentCapabilities } from "../src/capability-runtime.ts"
import { createAgentEnvIdentity } from "../src/internal/env-identity.ts"

function oauthServer(type: "http" | "sse") {
  const origin = "https://mcp.example.com"
  const challenge = { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }
  const metadata = {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  }
  const authProvider = {
    tokens: vi.fn(() => ({ access_token: "expired-token", token_type: "Bearer" })),
    saveTokens: vi.fn(),
    redirectToAuthorization: vi.fn(),
    saveCodeVerifier: vi.fn(),
    codeVerifier: vi.fn(() => "verifier"),
    redirectUrl: "https://app.example.com/callback",
    clientMetadata: { redirect_uris: ["https://app.example.com/callback"] },
    clientInformation: vi.fn(() => ({ client_id: "test-client" })),
    saveAuthorizationServerInformation: vi.fn(),
  } satisfies OAuthClientProvider
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href === `${origin}/mcp`) {
      return new Response("Expired credential", {
        status: 401,
        headers: challenge,
      })
    }
    if (url.href === `${origin}/.well-known/oauth-protected-resource`) {
      return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
    }
    if (url.href === `${origin}/.well-known/oauth-authorization-server`) {
      return Response.json(metadata)
    }
    throw new Error(`Unexpected OAuth request: ${url.href}`)
  })
  const healthy = {
    tools: vi.fn(async () => ({ lookup: { execute: vi.fn() } })),
    close: vi.fn(),
  }
  const resolve = (provider: OAuthClientProvider = authProvider) => resolveAgentCapabilities({
    capabilities: [mcp({ servers: {
      expired: { transport: { type, url: `${origin}/mcp`, authProvider: provider, fetch } },
      healthy: () => healthy,
    } })],
  }, {
    agentIdentity: createAgentEnvIdentity({ name: "agent" }),
    capabilities: {},
    memo: vi.fn(),
    runtime: "unknown",
    runtimeConfig: {},
    waitUntil: vi.fn(),
  }, {})
  return { authProvider, challenge, fetch, healthy, metadata, resolve }
}

describe.each(["http", "sse"] as const)("SDK-managed MCP OAuth over %s", (type) => {
  it("leaves out a server that requires reauthorization and keeps healthy tools", async () => {
    const server = oauthServer(type)
    const resolved = await server.resolve()
    try {
      expect(Object.keys(resolved.tools ?? {})).toEqual(["mcp_healthy_lookup"])
      expect(getMcpWarnings(resolved.input)).toEqual([{ phase: "discovery", server: "expired" }])
      expect(server.authProvider.redirectToAuthorization).toHaveBeenCalledOnce()
      expect(server.authProvider.redirectToAuthorization).toHaveBeenCalledWith(expect.any(URL))
      expect(server.fetch).toHaveBeenCalledWith("https://mcp.example.com/mcp", expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer expired-token" }),
      }))
      expect(server.healthy.close).not.toHaveBeenCalled()
    }
    finally { await resolved.close() }
    expect(server.healthy.close).toHaveBeenCalledOnce()
  })

  it("preserves OAuth configuration failures", async () => {
    const server = oauthServer(type)
    const { saveAuthorizationServerInformation: _save, ...provider } = server.authProvider
    await expect(server.resolve(provider)).rejects.toThrow("OAuth authorization server metadata must be saveable")
    expect(server.authProvider.redirectToAuthorization).not.toHaveBeenCalled()
    expect(server.healthy.close).toHaveBeenCalledOnce()
  })

  it("preserves OAuth URL validation failures", async () => {
    const server = oauthServer(type)
    server.challenge["WWW-Authenticate"] = 'Bearer resource_metadata="https://other.example.com/.well-known/oauth-protected-resource"'
    await expect(server.resolve()).rejects.toThrow(/origin/i)
    expect(server.authProvider.redirectToAuthorization).not.toHaveBeenCalled()
    expect(server.healthy.close).toHaveBeenCalledOnce()
  })

  it("preserves OAuth issuer validation failures", async () => {
    const server = oauthServer(type)
    server.metadata.issuer = "https://other.example.com"
    await expect(server.resolve()).rejects.toThrow(/issuer/i)
    expect(server.authProvider.redirectToAuthorization).not.toHaveBeenCalled()
    expect(server.healthy.close).toHaveBeenCalledOnce()
  })

  it("preserves cancellation during OAuth recovery", async () => {
    const server = oauthServer(type)
    const aborted = new DOMException("OAuth recovery aborted", "AbortError")
    server.authProvider.redirectToAuthorization.mockImplementation(() => { throw aborted })
    await expect(server.resolve()).rejects.toBe(aborted)
    expect(server.healthy.close).toHaveBeenCalledOnce()
  })
})
