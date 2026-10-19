import { describe, expect, it } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { oauthLogin } from "../src/oauth-login.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createStore } from "./helpers.ts"

import type { ConnectionsRuntimeOptions } from "../src/runtime.ts"
import type { ConnectionLoginContext } from "../src/types.ts"

const BASE = "https://portal.example.com"
const MCP = `${BASE}/mcp`
const ISSUER = `${BASE}/api/auth`
const REDIRECT_URI = "http://127.0.0.1/callback"

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function challenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return base64Url(String.fromCharCode(...digest))
}

/**
 * A mock authorization server and MCP resource in one fetch handler. It signs in with a
 * `email:password` form, answers authorize with JSON like Better Auth, and checks PKCE, `state`,
 * `resource`, and the client id.
 */
function mockServer() {
  const server = {
    accepted: new Set<string>(),
    codes: new Map<string, { challenge: string, redirectUri: string }>(),
    expiresIn: 3600 as number | undefined,
    issueRefreshTokens: false,
    log: [] as string[],
    password: "pa:ss",
    registrations: [] as unknown[],
    tokens: 0,
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const body = request.method === "GET" ? "" : await request.text()
      server.log.push(`${request.method} ${url.origin === BASE ? url.pathname : url.href}`)
      const cookie = request.headers.get("cookie") ?? ""
      switch (url.pathname) {
        case "/.well-known/oauth-protected-resource/mcp":
          return Response.json({ authorization_servers: [ISSUER], resource: MCP })
        case "/.well-known/oauth-authorization-server/api/auth":
          return Response.json({
            authorization_endpoint: `${ISSUER}/oauth2/authorize`,
            issuer: ISSUER,
            registration_endpoint: `${ISSUER}/oauth2/register`,
            token_endpoint: `${ISSUER}/oauth2/token`,
          })
        case "/api/auth/oauth2/register":
          server.registrations.push(JSON.parse(body))
          return Response.json({ client_id: `client-${server.registrations.length}` })
        case "/api/auth/sign-in": {
          const { email, password } = JSON.parse(body) as { email: string, password: string }
          if (request.headers.get("origin") !== BASE || email !== "bot@example.com" || password !== server.password) return Response.json({ error: "bad" }, { status: 401 })
          const headers = new Headers()
          headers.append("set-cookie", "session=abc; Path=/; HttpOnly")
          headers.append("set-cookie", "other=1; Path=/")
          return Response.json({ ok: true }, { headers })
        }
        case "/api/auth/oauth2/authorize": {
          if (!cookie.includes("session=abc")) return Response.json({ error: "no session" }, { status: 401 })
          const query = url.searchParams
          if (query.get("code_challenge_method") !== "S256" || query.get("resource") !== MCP || query.get("response_type") !== "code") return Response.json({ error: "bad request" }, { status: 400 })
          const code = `code-${server.codes.size + 1}`
          server.codes.set(code, { challenge: query.get("code_challenge")!, redirectUri: query.get("redirect_uri")! })
          return Response.json({ url: `${query.get("redirect_uri")}?code=${code}&state=${query.get("state")}` })
        }
        case "/api/auth/oauth2/token": {
          const form = new URLSearchParams(body)
          if (form.get("resource") !== MCP || !form.get("client_id")) return Response.json({ error: "invalid_request" }, { status: 400 })
          if (form.get("grant_type") === "refresh_token") {
            if (form.get("refresh_token") !== "refresh-1") return Response.json({ error: "invalid_grant" }, { status: 400 })
          }
          else {
            const issued = server.codes.get(form.get("code") ?? "")
            if (!issued || issued.redirectUri !== form.get("redirect_uri") || issued.challenge !== await challenge(form.get("code_verifier") ?? "")) {
              return Response.json({ error: "invalid_grant" }, { status: 400 })
            }
            server.codes.delete(form.get("code")!)
          }
          const token = `token-${++server.tokens}`
          server.accepted.add(token)
          return Response.json({
            access_token: token,
            ...(server.expiresIn === undefined ? {} : { expires_in: server.expiresIn }),
            id_token: `x.${base64Url(JSON.stringify({ email: "bot@example.com", sub: "user-1" }))}.y`,
            ...(server.issueRefreshTokens ? { refresh_token: "refresh-1" } : {}),
            scope: "openid email",
            token_type: "Bearer",
          })
        }
        case "/mcp": {
          const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
          if (!server.accepted.has(token)) return Response.json({ error: "unauthorized" }, { status: 401 })
          return Response.json({ id: 1, jsonrpc: "2.0", result: { token } })
        }
        default:
          return Response.json({ error: "not found" }, { status: 404 })
      }
    },
  }
  return server
}

/** Sign in with `email:password` and return the redirect that authorize answers with. */
async function login({ credentials, fetch, url }: ConnectionLoginContext): Promise<string> {
  const separator = credentials.indexOf(":")
  const signIn = await fetch("/api/auth/sign-in", {
    body: JSON.stringify({ email: credentials.slice(0, separator), password: credentials.slice(separator + 1) }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  if (!signIn.ok) throw new Error(`Sign-in failed with ${signIn.status} for ${credentials}.`)
  return (await (await fetch(url)).json() as { url: string }).url
}

function setup(credentials: Record<string, string | undefined> = { acme: "bot@example.com:pa:ss" }, provider: Partial<Parameters<typeof oauthLogin>[0]> = {}) {
  const server = mockServer()
  const portal = defineConnection({
    instances: Object.keys(credentials),
    definition: tenant => ({
      access: { server: { read: true, write: ["fetch"], approve: false } },
      provider: oauthLogin({ clientName: "Example Agent", credentials: () => credentials[tenant], id: "portal", login, mcp: MCP, ...provider }),
      scopes: ["openid", "email"],
    }),
  })
  const options: ConnectionsRuntimeOptions = { definitions: { portal }, fetch: (input, init) => server.fetch(input, init), store: createStore() }
  const runtime = createConnectionsRuntime(options)
  const post = async (name = "portal:acme") => {
    const response = await runtime.client(name, { actor: "server" }).fetch(MCP, { body: "{\"jsonrpc\":\"2.0\"}", headers: { "content-type": "application/json" }, method: "POST" })
    return (await response.json() as { result: { token: string } }).result.token
  }
  return { credentials, post, runtime, server }
}

const SIGN_IN = ["POST /api/auth/sign-in", "GET /api/auth/oauth2/authorize", "POST /api/auth/oauth2/token"]

describe("oauthLogin", () => {
  it("discovers the authorization server, registers a client, and signs in once for concurrent requests", async () => {
    const test = setup()
    expect(await Promise.all([test.post(), test.post(), test.post()])).toEqual(["token-1", "token-1", "token-1"])
    expect(test.server.log.filter(line => line !== "POST /mcp")).toEqual([
      "GET /.well-known/oauth-protected-resource/mcp",
      "GET /.well-known/oauth-authorization-server/api/auth",
      "POST /api/auth/oauth2/register",
      ...SIGN_IN,
    ])
    expect(test.server.registrations).toEqual([{
      application_type: "native",
      client_name: "Example Agent",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }])
    expect(await test.runtime.inspect("portal:acme")).toMatchObject({
      account: { email: "bot@example.com", id: "user-1" },
      credential: "oauth2",
      mcp: MCP,
      provider: "portal",
      scopes: { declared: ["openid", "email"], granted: ["openid", "email"], missing: [] },
      status: "connected",
    })
  })

  it("signs in again once after a 401, without registering again", async () => {
    const test = setup()
    await test.post()
    test.server.accepted.clear()
    test.server.log.length = 0
    expect(await test.post()).toBe("token-2")
    expect(test.server.log).toEqual(["POST /mcp", ...SIGN_IN, "POST /mcp"])
  })

  it("signs in again before the token expires, or refreshes it with a refresh token", async () => {
    const test = setup()
    test.server.expiresIn = 30
    expect(await test.post()).toBe("token-1")
    expect(await test.post()).toBe("token-2")
    test.server.issueRefreshTokens = true
    expect(await test.post()).toBe("token-3")
    test.server.log.length = 0
    expect(await test.post()).toBe("token-4")
    expect(test.server.log).toEqual(["POST /api/auth/oauth2/token", "POST /mcp"])
  })

  it("is disconnected without credentials and fails requests with reauth_required", async () => {
    const test = setup({ acme: "bot@example.com:pa:ss", beta: undefined })
    expect((await test.runtime.list()).map(connection => [connection.name, connection.status])).toEqual([
      ["portal:acme", "connected"],
      ["portal:beta", "disconnected"],
    ])
    await expect(test.post("portal:beta")).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect(test.server.log).toEqual([])
  })

  it("shares a failed sign-in with every waiter and hides the login error", async () => {
    const test = setup()
    test.server.password = "changed"
    const failures = await Promise.allSettled([test.post(), test.post()])
    expect(failures.map(failure => failure.status)).toEqual(["rejected", "rejected"])
    expect(test.server.log.filter(line => line === "POST /api/auth/sign-in")).toHaveLength(1)
    const [failure] = failures
    expect(failure?.status === "rejected" ? failure.reason : undefined).toMatchObject({ code: "CONNECTION_PROVIDER" })
    expect(String(failure?.status === "rejected" ? failure.reason.message : "")).not.toContain("pa:ss")
    test.server.password = "pa:ss"
    expect(await test.post()).toMatch(/^token-/)
  })

  it("rejects a login result that does not match the request", async () => {
    for (const result of ["https://evil.example.com/callback?code=code-1", `${REDIRECT_URI}?code=code-1&state=other`, `${REDIRECT_URI}?error=access_denied`]) {
      const test = setup({ acme: "bot@example.com:pa:ss" }, { login: async () => result })
      await expect(test.post()).rejects.toMatchObject({ code: "CONNECTION_PROVIDER" })
    }
  })

  it("uses issuer and clientId without discovery or registration, and unseals credentials", async () => {
    const test = setup({ acme: "unused" }, {
      clientId: "registered-client",
      credentials: () => ({ unseal: () => "bot@example.com:pa:ss" }),
      issuer: ISSUER,
    })
    expect(await test.post()).toBe("token-1")
    expect(test.server.log.filter(line => line !== "POST /mcp")).toEqual(["GET /.well-known/oauth-authorization-server/api/auth", ...SIGN_IN])
    expect(test.server.registrations).toEqual([])
  })

  it("sends the token only to the mcp endpoint and the declared origins", async () => {
    const test = setup({ acme: "bot@example.com:pa:ss" }, { origins: ["https://api.example.com"] })
    const client = test.runtime.client("portal:acme", { actor: "server" })
    await expect(client.fetch("https://other.example.com/mcp")).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect((await client.fetch("https://api.example.com/v1")).status).toBe(404)
    expect(test.server.log.at(-1)).toBe("GET https://api.example.com/v1")
  })

  it("has no connect flow and no key, and revoke signs in again on the next request", async () => {
    const test = setup()
    await expect(test.runtime.authorize({ name: "portal:acme", redirectUri: REDIRECT_URI })).rejects.toThrow("signs in by itself")
    await expect(test.runtime.setKey({ key: "key", name: "portal:acme" })).rejects.toThrow("signs in by itself")
    await test.post()
    await expect(test.runtime.revoke({ name: "portal:acme" })).resolves.toMatchObject({ status: "connected" })
    expect((await test.runtime.inspect("portal:acme")).account).toBeUndefined()
    test.server.log.length = 0
    expect(await test.post()).toBe("token-2")
    expect(test.server.log).toContain("POST /api/auth/oauth2/register")
  })

  it("works without the Connections store", async () => {
    const server = mockServer()
    const definition = defineConnection({
      access: { server: { read: true, write: ["fetch"], approve: false } },
      provider: oauthLogin({ credentials: () => "bot@example.com:pa:ss", login, mcp: MCP }),
      scopes: ["openid"],
    })
    const runtime = createConnectionsRuntime({ definitions: { portal: definition }, fetch: (input, init) => server.fetch(input, init), store: () => Promise.reject(new Error("no store")) })
    expect((await runtime.client("portal", { actor: "server" }).fetch(MCP, { body: "{}", method: "POST" })).status).toBe(200)
    expect(await runtime.inspect("portal")).toMatchObject({ status: "connected" })
  })

  it("rejects invalid providers", () => {
    expect(() => oauthLogin({ login })).toThrow(expect.objectContaining({ code: "CONNECTION_INVALID" }))
    expect(() => oauthLogin({ login, mcp: "http://portal.example.com/mcp" })).toThrow(expect.objectContaining({ code: "CONNECTION_INVALID" }))
    expect(() => oauthLogin({ login, mcp: MCP, redirectUri: "http://example.com/callback" })).toThrow(expect.objectContaining({ code: "CONNECTION_INVALID" }))
    expect(() => oauthLogin({ login, mcp: MCP, origins: ["https://api.example.com/v1"] })).toThrow(expect.objectContaining({ code: "CONNECTION_INVALID" }))
    expect(oauthLogin({ login, mcp: "http://127.0.0.1:8787/mcp" })).toMatchObject({ kind: "oauth-login", mcp: "http://127.0.0.1:8787/mcp", redirectUri: REDIRECT_URI })
  })
})

describe("keyed Connections", () => {
  it("names each instance <name>:<instance> and rejects the bare name and unknown instances", async () => {
    const test = setup({ acme: "bot@example.com:pa:ss", beta: "bot@example.com:pa:ss" })
    expect((await test.runtime.list()).map(connection => connection.name)).toEqual(["portal:acme", "portal:beta"])
    await expect(test.runtime.definition("portal")).rejects.toThrow("has instances. Use \"portal:acme\", \"portal:beta\".")
    await expect(test.runtime.definition("portal:gamma")).rejects.toThrow("No Connection Definition")
    expect((await test.runtime.definition("portal:beta")).provider.mcp).toBe(MCP)
    // Each instance signs in with its own token.
    expect([await test.post("portal:acme"), await test.post("portal:beta")]).toEqual(["token-1", "token-2"])
  })

  it("loads keyed definitions from a module and validates instances", async () => {
    const definition = defineConnection({
      instances: ["one"],
      definition: () => defineConnection({ access: { server: { read: true } }, provider: oauthLogin({ login, mcp: MCP }) }),
    })
    const runtime = createConnectionsRuntime({ definitions: { group: async () => ({ default: definition }) }, store: createStore() })
    expect((await runtime.list()).map(connection => connection.name)).toEqual(["group:one"])
    expect(() => defineConnection({ instances: ["a", "a"], definition: () => definition.definition("one") })).toThrow(expect.objectContaining({ code: "CONNECTION_INVALID" }))
    expect(() => defineConnection({ instances: ["a:b"], definition: () => definition.definition("one") })).toThrow(expect.objectContaining({ code: "CONNECTION_INVALID" }))
    // SAFETY: The test checks that the runtime rejects an instance definition that is not a Connection Definition.
    const broken = { instances: ["one"], definition: () => ({}) } as unknown as typeof definition
    const brokenRuntime = createConnectionsRuntime({ definitions: { group: broken }, store: createStore() })
    await expect(brokenRuntime.definition("group:one")).rejects.toThrow("instance \"group:one\" is invalid")
  })
})
