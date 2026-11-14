import { describe, expect, it } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { isConnectionError } from "../src/errors.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createStore } from "./helpers.ts"

import type { ConnectionStore } from "../src/store.ts"

const REDIRECT = "https://app.example.com/_vitehub/connections/callback"

/** An MCP server and its Better Auth style authorization server, on one origin per tenant. */
function authorizationServer(options: { challengeOnly?: boolean, registration?: boolean, secretTtl?: number } = {}) {
  const log: string[] = []
  const registrations: Array<Record<string, unknown>> = []
  const tokenRequests: URLSearchParams[] = []
  const revocations: URLSearchParams[] = []
  const tokenResponses: Array<{ body: Record<string, unknown>, status?: number }> = []
  let registered = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? "GET"
    log.push(`${method} ${url.href}`)
    const issuer = `${url.origin}/api/auth`
    // A server can name its metadata only in the challenge of the MCP endpoint, at any path.
    if (options.challengeOnly && url.pathname === "/mcp") {
      return new Response(null, { headers: { "www-authenticate": `Bearer resource_metadata="${url.origin}/auth/metadata"` }, status: 401 })
    }
    if (url.pathname === (options.challengeOnly ? "/auth/metadata" : "/.well-known/oauth-protected-resource/mcp")) {
      return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [issuer] })
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/api/auth") {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/oauth2/authorize`,
        token_endpoint: `${issuer}/oauth2/token`,
        revocation_endpoint: `${issuer}/oauth2/revoke`,
        ...(options.registration === false ? {} : { registration_endpoint: `${issuer}/oauth2/register` }),
      })
    }
    if (url.pathname === "/api/auth/oauth2/register" && method === "POST") {
      registrations.push(JSON.parse(String(init?.body)))
      // Let concurrent registrations overlap.
      await new Promise(resolve => setTimeout(resolve, 5))
      const id = `${url.hostname}-client-${++registered}`
      const secret = options.secretTtl ? { client_secret: `${id}-secret`, client_secret_expires_at: Math.floor(Date.now() / 1000) + options.secretTtl } : {}
      return Response.json({ client_id: id, client_id_issued_at: 1, ...secret }, { status: 201 })
    }
    if (url.pathname === "/api/auth/oauth2/token") {
      const form = new URLSearchParams(String(init?.body))
      tokenRequests.push(form)
      // MCP authorization servers bind each token to the resource of the request.
      if (form.get("resource") !== `${url.origin}/mcp`) return Response.json({ error: "invalid_target" }, { status: 400 })
      const next = tokenResponses.shift() ?? { body: { access_token: "access-1", expires_in: 3600, refresh_token: "refresh-1", token_type: "Bearer" } }
      return Response.json(next.body, { status: next.status ?? 200 })
    }
    if (url.pathname === "/api/auth/oauth2/revoke") {
      revocations.push(new URLSearchParams(String(init?.body)))
      return new Response(null, { status: 200 })
    }
    return new Response("Not found", { status: 404 })
  }
  return { fetch, log, registrations, revocations, tokenRequests, tokenResponses }
}

const portal = defineConnection({
  instances: ["acme", "globex"],
  definition: tenant => ({
    provider: { id: "portal", mcp: `https://${tenant}.example.com/mcp`, account: () => ({ id: tenant }) },
    scopes: ["openid", "offline_access"],
  }),
})

function runtimeOf(server: ReturnType<typeof authorizationServer>, store: ConnectionStore, now = { value: Date.parse("2026-11-14T10:00:00.000Z") }) {
  return createConnectionsRuntime({ definitions: { portal }, fetch: server.fetch, now: () => now.value, store })
}

async function connect(runtime: ReturnType<typeof runtimeOf>, name: string): Promise<URL> {
  const { state, url } = await runtime.authorize({ actor: "user:owner", name, redirectUri: REDIRECT })
  await runtime.complete({ actor: "user:owner", code: "code-1", state })
  return new URL(url)
}

describe("client registration", () => {
  it("registers a public client on the first Connect, stores it, and reuses it after a restart", async () => {
    const server = authorizationServer()
    const store = createStore()
    const url = await connect(runtimeOf(server, store), "portal:acme")

    expect(url.origin + url.pathname).toBe("https://acme.example.com/api/auth/oauth2/authorize")
    expect(url.searchParams.get("client_id")).toBe("acme.example.com-client-1")
    expect(url.searchParams.get("resource")).toBe("https://acme.example.com/mcp")
    expect(server.registrations).toEqual([{
      application_type: "web",
      client_name: "app.example.com",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT],
      response_types: ["code"],
      scope: "openid offline_access",
      token_endpoint_auth_method: "none",
    }])
    expect(server.tokenRequests[0]?.get("client_id")).toBe("acme.example.com-client-1")

    // A new process reads the stored client instead of registering again.
    const restarted = await connect(runtimeOf(server, store), "portal:acme")
    expect(restarted.searchParams.get("client_id")).toBe("acme.example.com-client-1")
    expect(server.registrations).toHaveLength(1)
  })

  it("registers one client per authorization server for keyed Connections", async () => {
    const server = authorizationServer()
    const runtime = runtimeOf(server, createStore())
    const acme = await connect(runtime, "portal:acme")
    const globex = await connect(runtime, "portal:globex")

    expect(acme.searchParams.get("client_id")).toBe("acme.example.com-client-1")
    expect(globex.searchParams.get("client_id")).toBe("globex.example.com-client-2")
    expect(server.registrations).toHaveLength(2)
  })

  it("gives concurrent first Connects the same client", async () => {
    const server = authorizationServer()
    const runtime = runtimeOf(server, createStore())
    const [first, second] = await Promise.all([
      runtime.authorize({ actor: "user:owner", name: "portal:acme", redirectUri: REDIRECT }),
      runtime.authorize({ actor: "user:owner", name: "portal:acme", redirectUri: REDIRECT }),
    ])
    expect(new URL(first.url).searchParams.get("client_id")).toBe(new URL(second.url).searchParams.get("client_id"))
  })

  it("refreshes and revokes with the client of the grant", async () => {
    const server = authorizationServer()
    const now = { value: Date.parse("2026-11-14T10:00:00.000Z") }
    const runtime = runtimeOf(server, createStore(), now)
    await connect(runtime, "portal:acme")
    now.value += 2 * 3600_000
    server.tokenResponses.push({ body: { access_token: "access-2", expires_in: 3600, token_type: "Bearer" } })

    const response = await runtime.client("portal:acme", { actor: "server" }).fetch("https://acme.example.com/mcp")
    expect(response.status).toBe(404)
    expect(Object.fromEntries(server.tokenRequests[0]!)).toMatchObject({ client_id: "acme.example.com-client-1", grant_type: "authorization_code", resource: "https://acme.example.com/mcp" })
    expect(Object.fromEntries(server.tokenRequests[1]!)).toEqual({ client_id: "acme.example.com-client-1", grant_type: "refresh_token", refresh_token: "refresh-1", resource: "https://acme.example.com/mcp" })
    // The refreshed grant keeps its client for the next refresh.
    now.value += 2 * 3600_000
    server.tokenResponses.push({ body: { access_token: "access-3", expires_in: 3600, token_type: "Bearer" } })
    await runtime.client("portal:acme", { actor: "server" }).fetch("https://acme.example.com/mcp")
    expect(server.tokenRequests[2]?.get("client_id")).toBe("acme.example.com-client-1")

    await runtime.revoke({ actor: "user:owner", name: "portal:acme" })
    expect(Object.fromEntries(server.revocations[0]!)).toEqual({ client_id: "acme.example.com-client-1", token: "refresh-1" })
  })

  it("registers again after the authorization server rejects the client", async () => {
    const server = authorizationServer()
    const now = { value: Date.parse("2026-11-14T10:00:00.000Z") }
    const runtime = runtimeOf(server, createStore(), now)
    await connect(runtime, "portal:acme")
    now.value += 2 * 3600_000
    server.tokenResponses.push({ body: { error: "invalid_client" }, status: 401 })

    const error = await runtime.client("portal:acme", { actor: "server" }).fetch("https://acme.example.com/mcp").catch((error: unknown) => error)
    expect(isConnectionError(error, ["CONNECTIONS_NEEDS_RECONNECT"])).toBe(true)
    expect((await runtime.inspect("portal:acme")).status).toBe("reauth_required")

    const reconnected = await connect(runtime, "portal:acme")
    expect(reconnected.searchParams.get("client_id")).toBe("acme.example.com-client-2")
    expect((await runtime.inspect("portal:acme")).status).toBe("connected")
  })

  it("finds the metadata that the MCP endpoint names in its 401 challenge", async () => {
    const server = authorizationServer({ challengeOnly: true })
    const url = await connect(runtimeOf(server, createStore()), "portal:acme")
    expect(url.searchParams.get("client_id")).toBe("acme.example.com-client-1")
    expect(server.log.slice(0, 3)).toEqual(["GET https://acme.example.com/mcp", "GET https://acme.example.com/auth/metadata", "GET https://acme.example.com/.well-known/oauth-authorization-server/api/auth"])
  })

  it("exchanges the code with the client that built the authorization URL, after the registration changed", async () => {
    const server = authorizationServer({ secretTtl: 120 })
    // The store drops pending authorizations by the wall clock, so this test runs at the current time.
    const now = { value: Date.now() }
    const store = createStore()
    const first = await runtimeOf(server, store, now).authorize({ actor: "user:owner", name: "portal:acme", redirectUri: REDIRECT })
    // Near the end of its secret, the next Connect registers another client while the first person still consents.
    now.value += 61_000
    const second = await runtimeOf(server, store, now).authorize({ actor: "user:owner", name: "portal:acme", redirectUri: REDIRECT })
    expect(new URL(second.url).searchParams.get("client_id")).toBe("acme.example.com-client-2")
    await runtimeOf(server, store, now).complete({ actor: "user:owner", code: "code-1", state: first.state })
    expect(server.tokenRequests[0]?.get("client_id")).toBe("acme.example.com-client-1")
  })

  it("fails with a fix when the authorization server does not register clients", async () => {
    const server = authorizationServer({ registration: false })
    const runtime = runtimeOf(server, createStore())
    const error = await runtime.authorize({ actor: "user:owner", name: "portal:acme", redirectUri: REDIRECT }).catch((error: unknown) => error)
    expect(isConnectionError(error, ["CONNECTIONS_INVALID_DEFINITION"])).toBe(true)
    expect(String(error)).toContain("does not offer client registration")
  })

  it("keeps a declared client id and endpoints without discovery", async () => {
    const server = authorizationServer()
    const runtime = createConnectionsRuntime({
      definitions: {
        crm: defineConnection({
          provider: {
            id: "crm",
            authorizationEndpoint: "https://acme.example.com/authorize",
            tokenEndpoint: "https://acme.example.com/token",
            clientId: "static-client",
            mcp: "https://acme.example.com/mcp",
          },
          scopes: [],
        }),
      },
      fetch: server.fetch,
      store: createStore(),
    })
    const { url } = await runtime.authorize({ actor: "user:owner", name: "crm", redirectUri: REDIRECT })
    expect(new URL(url).searchParams.get("client_id")).toBe("static-client")
    expect(new URL(url).searchParams.has("resource")).toBe(false)
    expect(server.log).toEqual([])
  })
})
