import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { oauthProvider } from "@better-auth/oauth-provider"
import { bearer, jwt } from "better-auth/plugins"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import { deleteUnusedMcpClients, mcpOAuth, mcpTokenInvalidReasons, serveMcpOAuthDiscovery, verifyMcpRequest } from "../src/mcp.ts"
import { createAuthForRequest, requireCaller } from "../src/internal/server.ts"

import type { BetterAuthPlugin } from "better-auth"

import type { AuthAccessPolicy } from "../src/index.ts"
import type { McpOAuthAuth, McpOAuthOptions, McpTokenInvalidReason } from "../src/mcp.ts"

const app = "https://app.example.com"
const resource = `${app}/mcp`
const redirect = "http://127.0.0.1:53682/callback"
const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

/** A real Better Auth on SQLite with `mcpOAuth()`, as an app's `server/auth.ts` defines it. */
async function setup(options: Partial<McpOAuthOptions> = {}, rateLimit = false, policy?: AuthAccessPolicy, trustedProxyHeaders = false, plugins: BetterAuthPlugin[] = mcpOAuth({ loginPage: "/oauth", resource, ...options })) {
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  const definition = defineAuth(() => ({
    advanced: { trustedProxyHeaders },
    baseURL: app,
    database,
    emailAndPassword: { enabled: true },
    plugins,
    ...(rateLimit ? { rateLimit: { enabled: true } } : {}),
    ...(policy ? { access: { policy } } : {}),
    secret: "test-secret-at-least-32-bytes-long",
    user: { additionalFields: {
      internalNote: { type: "string", defaultValue: "private", input: false, returned: false },
      nickname: { type: "string", defaultValue: "public", input: false },
    } },
  }))
  // One instance, as a server keeps it: memory rate limits live in the instance.
  const instance = createAuthForRequest(definition, new Request(resource))
  // SAFETY: The registered Auth type does not know the endpoints that jwt() and oauthProvider() add at runtime.
  const auth = instance as unknown as McpOAuthAuth
  await (await instance.$context).runMigrations()
  const call = (path: string, init: RequestInit = {}) => instance.handler(new Request(`${app}/api/auth${path}`, init))
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => call(path, { body: JSON.stringify(body), headers: { "content-type": "application/json", origin: app, ...headers }, method: "POST" })
  return { auth, call, database, definition, post }
}

type Setup = Awaited<ReturnType<typeof setup>>

const Url = v.object({ url: v.string() })

/** The browser flow of an MCP client: register, authorize with PKCE, sign in, consent, and exchange the code. */
async function signInAgent({ call, post }: Setup, email = "ada@example.com", tokenHeaders: Record<string, string> = {}, scope = "openid profile email offline_access", audience = resource) {
  expect((await post("/sign-up/email", { email, name: "Ada", password: "test-password-123" })).status).toBe(200)
  const registration = await post("/oauth2/register", { client_name: "Claude Code", redirect_uris: [redirect], token_endpoint_auth_method: "none" })
  expect(registration.status, await registration.clone().text()).toBe(201)
  const { client_id } = v.parse(v.object({ client_id: v.string() }), await registration.json())
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const query = new URLSearchParams({ client_id, code_challenge: challenge, code_challenge_method: "S256", redirect_uri: redirect, resource: audience, response_type: "code", scope, state: "s" })
  const login = new URL((await call(`/oauth2/authorize?${query}`)).headers.get("location") ?? "", app)
  expect(login.pathname).toBe("/oauth")
  const signedIn = await post("/sign-in/email", { email, oauth_query: login.search.slice(1), password: "test-password-123" })
  expect(signedIn.status, await signedIn.clone().text()).toBe(200)
  const consent = new URL(v.parse(Url, await signedIn.json()).url, app)
  const cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
  const answer = await post("/oauth2/consent", { accept: true, oauth_query: consent.search.slice(1) }, { cookie })
  expect(answer.status, await answer.clone().text()).toBe(200)
  const code = new URL(v.parse(Url, await answer.json()).url).searchParams.get("code") ?? ""
  const token = await call("/oauth2/token", {
    body: new URLSearchParams({ client_id, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirect, resource: audience }),
    headers: { "content-type": "application/x-www-form-urlencoded", ...tokenHeaders },
    method: "POST",
  })
  expect(token.status, await token.clone().text()).toBe(200)
  const tokens = v.parse(v.object({ access_token: v.string(), refresh_token: v.optional(v.string()) }), await token.json())
  return { accessToken: tokens.access_token, clientId: client_id, cookie, refreshToken: tokens.refresh_token }
}

const mcpRequest = (token?: string, url = resource) => new Request(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, method: "POST" })

describe("mcpOAuth", () => {
  it("signs a native MCP client in and verifies its JWT access token", async () => {
    const auth = await setup()
    const { accessToken, clientId } = await signInAgent(auth)
    const [error, caller] = await verifyMcpRequest(mcpRequest(accessToken), { auth: auth.auth })
    expect(error).toBeUndefined()
    expect(caller).toMatchObject({ clientId, clientName: "Claude Code", user: { email: "ada@example.com" } })
    expect(caller?.scopes).toEqual(expect.arrayContaining(["openid", "offline_access"]))
    const [row] = auth.database.prepare("select applicationType from oauthClient where clientId = ?").all(clientId) as Array<{ applicationType: string }>
    expect(row?.applicationType).toBe("native")
  })

  it("refuses the token of a person that `access.policy` no longer allows", async () => {
    let member = true
    const auth = await setup({}, false, { allow: () => member, recheck: "0s" })
    const { accessToken } = await signInAgent(auth)
    expect((await verifyMcpRequest(mcpRequest(accessToken), { auth: auth.auth }))[0]).toBeUndefined()

    member = false
    const [error] = await verifyMcpRequest(mcpRequest(accessToken), { auth: auth.auth })

    expect(error).toMatchObject({ code: "AUTH_MCP_TOKEN_INVALID" })
    expect(error?.message).toContain("access.policy")
  })

  it("verifies a request that has only a URL and headers, such as H3's event.req", async () => {
    const auth = await setup()
    const { accessToken } = await signInAgent(auth)
    const request = mcpRequest(accessToken)
    const [error, caller] = await verifyMcpRequest({ headers: request.headers, url: request.url }, { auth: auth.auth })
    expect(error).toBeUndefined()
    expect(caller?.user).toMatchObject({ email: "ada@example.com" })
  })

  it("rejects a missing, tampered, or foreign-resource token, and a deleted user's", async () => {
    const auth = await setup()
    const { accessToken } = await signInAgent(auth)
    expect((await verifyMcpRequest(mcpRequest(), { auth: auth.auth }))[0]?.code).toBe("AUTH_MCP_TOKEN_MISSING")
    const tampered = `${accessToken.slice(0, -4)}AAAA`
    expect((await verifyMcpRequest(mcpRequest(tampered), { auth: auth.auth }))[0]?.code).toBe("AUTH_MCP_TOKEN_INVALID")
    // The token opens only its resource: another path of the app is not that resource.
    const [other] = await verifyMcpRequest(mcpRequest(accessToken, `${app}/api/drops`), { auth: auth.auth })
    expect(other?.code).toBe("AUTH_MCP_TOKEN_INVALID")
    expect((await verifyMcpRequest(mcpRequest(accessToken, `${app}/api/drops`), { auth: auth.auth, resource: `${app}/other` }))[0]?.code).toBe("AUTH_MCP_TOKEN_INVALID")
    expect((await verifyMcpRequest(mcpRequest(accessToken, `${app}/api/drops`), { auth: auth.auth, resource }))[0]).toBeUndefined()
    expect((await verifyMcpRequest(mcpRequest(accessToken, `${app}/api/drops`), { auth: auth.auth, resource: [`${app}/other`, resource] }))[0]).toBeUndefined()
    // The user is read again on each request, so a deleted person loses access while the token is unexpired.
    auth.database.prepare("delete from session").run()
    auth.database.prepare("delete from account").run()
    auth.database.prepare("delete from user").run()
    expect((await verifyMcpRequest(mcpRequest(accessToken), { auth: auth.auth }))[0]?.code).toBe("AUTH_MCP_TOKEN_INVALID")
  })

  it("bounds open client registration", async () => {
    const { post } = await setup()
    const problem = async (response: Response) => [response.status, v.parse(v.object({ error: v.string() }), await response.json()).error]
    expect(await problem(await post("/oauth2/register", { redirect_uris: Array.from({ length: 6 }, (_, index) => `http://127.0.0.1:${5000 + index}/cb`) }))).toEqual([400, "invalid_client_metadata"])
    expect(await problem(await post("/oauth2/register", { client_name: "x".repeat(161), redirect_uris: [redirect] }))).toEqual([400, "invalid_client_metadata"])
    expect(await problem(await post("/oauth2/register", { contacts: Array.from({ length: 11 }, () => "a@example.com"), redirect_uris: [redirect] }))).toEqual([400, "invalid_client_metadata"])
    expect(await problem(await post("/oauth2/register", { client_name: "big", logo_uri: "x".repeat(20_000), redirect_uris: [redirect] }))).toEqual([413, "invalid_client_metadata"])
    expect((await post("/oauth2/register", { client_name: "Cursor", redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"] })).status).toBe(201)
  })

  it("rejects DPoP registration while allowing bearer clients", async () => {
    const { post } = await setup()
    const registration = await post("/oauth2/register", { dpop_bound_access_tokens: true, redirect_uris: [redirect] })
    expect(registration.status).toBe(400)
    expect(await registration.json()).toMatchObject({ error: "invalid_client_metadata" })
    expect((await post("/oauth2/register", { dpop_bound_access_tokens: false, redirect_uris: [redirect] })).status).toBe(201)
  })

  it("rejects a DPoP-bound access token presented as a bearer token", async () => {
    const auth = await setup()
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const header = Buffer.from(JSON.stringify({ alg: "ES256", jwk: publicKey.export({ format: "jwk" }), typ: "dpop+jwt" })).toString("base64url")
    const payload = Buffer.from(JSON.stringify({ htm: "POST", htu: `${app}/api/auth/oauth2/token`, iat: Math.floor(Date.now() / 1000), jti: randomBytes(16).toString("base64url") })).toString("base64url")
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: privateKey }).toString("base64url")
    // Even a client registered for bearer tokens can opt into DPoP at the token endpoint.
    const { accessToken } = await signInAgent(auth, "ada@example.com", { DPoP: `${header}.${payload}.${signature}` })
    const claims: unknown = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString())
    expect(claims).toMatchObject({ cnf: { jkt: expect.any(String) } })
    expect((await verifyMcpRequest(mcpRequest(accessToken), { auth: auth.auth }))[0]?.code).toBe("AUTH_MCP_TOKEN_INVALID")
  })

  it.each(["signed out", "expired session", "disabled client", "deleted client"])("rejects a token after %s", async (reason) => {
    const auth = await setup()
    // Without offline_access the grant lasts as long as the person's session.
    const { accessToken, clientId, cookie } = await signInAgent(auth, "ada@example.com", {}, "openid profile email")
    expect((await verifyMcpRequest(mcpRequest(accessToken), { auth: auth.auth }))[0]).toBeUndefined()
    if (reason === "signed out") {
      expect((await auth.post("/sign-out", {}, { cookie })).status).toBe(200)
    }
    else if (reason === "expired session") {
      auth.database.prepare("update session set expiresAt = ?").run(new Date(Date.now() - 60_000).toISOString())
    }
    else if (reason === "disabled client") {
      auth.database.prepare("update oauthClient set disabled = 1 where clientId = ?").run(clientId)
    }
    else {
      for (const table of ["oauthConsent", "oauthAccessToken", "oauthRefreshToken", "oauthClientResource", "oauthClient"]) {
        auth.database.prepare(`delete from ${table} where clientId = ?`).run(clientId)
      }
    }
    expect((await verifyMcpRequest(mcpRequest(accessToken), { auth: auth.auth }))[0]?.code).toBe("AUTH_MCP_TOKEN_INVALID")
  })

  it.each(["signed out", "expired session"])("keeps an offline_access grant after %s, refreshed tokens included, without the ended session", async (reason) => {
    const auth = await setup()
    const { accessToken, clientId, cookie, refreshToken } = await signInAgent(auth)
    if (reason === "signed out") expect((await auth.post("/sign-out", {}, { cookie })).status).toBe(200)
    else auth.database.prepare("update session set expiresAt = ?").run(new Date(Date.now() - 60_000).toISOString())
    expect((await verifyMcpRequest(mcpRequest(accessToken), { auth: auth.auth }))[0]).toBeUndefined()
    const refreshed = await auth.call("/oauth2/token", {
      body: new URLSearchParams({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken ?? "" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
    expect(refreshed.status, await refreshed.clone().text()).toBe(200)
    const { access_token } = v.parse(v.object({ access_token: v.string() }), await refreshed.json())
    const { sid } = v.parse(v.object({ sid: v.nullish(v.string()) }), JSON.parse(Buffer.from(access_token.split(".")[1] ?? "", "base64url").toString()))
    expect(sid).toBeUndefined()
    const [error, caller] = await verifyMcpRequest(mcpRequest(access_token), { auth: auth.auth })
    expect(error).toBeUndefined()
    expect(caller).toMatchObject({ clientId, user: { email: "ada@example.com" } })
  })

  it("keeps the registration rate limit of Better Auth when its limiter is on", async () => {
    const { post } = await setup({}, true)
    const statuses: number[] = []
    for (let attempt = 0; attempt < 6; attempt++) statuses.push((await post("/oauth2/register", { redirect_uris: [redirect] }, { "x-forwarded-for": "203.0.113.7" })).status)
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429])
  })
})

describe("AUTH_MCP_TOKEN_INVALID reasons", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const refusal = async (auth: Setup, token: string, options: { auth?: McpOAuthAuth, resource?: string, url?: string } = {}) => {
    const [error] = await verifyMcpRequest(mcpRequest(token, options.url), { auth: options.auth ?? auth.auth, ...(options.resource ? { resource: options.resource } : {}) })
    expect(error?.code).toBe("AUTH_MCP_TOKEN_INVALID")
    return error?.data
  }

  it("names an expired token", async () => {
    const auth = await setup()
    const { accessToken } = await signInAgent(auth)
    vi.useFakeTimers({ now: Date.now() + 2 * 60 * 60 * 1000, toFake: ["Date"] })
    expect(await refusal(auth, accessToken)).toEqual({ clientId: undefined, reason: "expired" })
  })

  it("names a malformed or tampered token", async () => {
    const auth = await setup()
    const { accessToken } = await signInAgent(auth)
    expect(await refusal(auth, `${accessToken.slice(0, -4)}AAAA`)).toEqual({ clientId: undefined, reason: "malformed" })
    expect(await refusal(auth, "not-a-jwt")).toEqual({ clientId: undefined, reason: "malformed" })
  })

  it("names a token for another resource and a path that is no resource", async () => {
    const auth = await setup()
    const { accessToken } = await signInAgent(auth)
    expect(await refusal(auth, accessToken, { url: `${app}/api/drops` })).toEqual({ clientId: undefined, reason: "wrong_resource" })
    expect(await refusal(auth, accessToken, { resource: `${app}/other` })).toEqual({ clientId: undefined, reason: "wrong_resource" })
  })

  it("names an Auth without signing keys", async () => {
    const auth = await setup()
    const { accessToken } = await signInAgent(auth)
    const keyless: McpOAuthAuth = { ...auth.auth, api: { ...auth.auth.api, getJwks: async () => ({ keys: [] }) } }
    expect(await refusal(auth, accessToken, { auth: keyless })).toEqual({ clientId: undefined, reason: "no_keys" })
  })

  it("names a sender-constrained token with its client", async () => {
    const auth = await setup()
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const header = Buffer.from(JSON.stringify({ alg: "ES256", jwk: publicKey.export({ format: "jwk" }), typ: "dpop+jwt" })).toString("base64url")
    const payload = Buffer.from(JSON.stringify({ htm: "POST", htu: `${app}/api/auth/oauth2/token`, iat: Math.floor(Date.now() / 1000), jti: randomBytes(16).toString("base64url") })).toString("base64url")
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: privateKey }).toString("base64url")
    const { accessToken, clientId } = await signInAgent(auth, "ada@example.com", { DPoP: `${header}.${payload}.${signature}` })
    expect(await refusal(auth, accessToken)).toEqual({ clientId, reason: "sender_constrained" })
  })

  it("names a deleted user with the client", async () => {
    const auth = await setup()
    const { accessToken, clientId } = await signInAgent(auth)
    for (const table of ["session", "account", "user"]) auth.database.prepare(`delete from ${table}`).run()
    expect(await refusal(auth, accessToken)).toEqual({ clientId, reason: "user_gone" })
  })

  it("names a user that access.policy no longer allows, with the client", async () => {
    let member = true
    const auth = await setup({}, false, { allow: () => member, recheck: "0s" })
    const { accessToken, clientId } = await signInAgent(auth)
    member = false
    expect(await refusal(auth, accessToken)).toEqual({ clientId, reason: "not_allowed" })
  })

  it.each(["disabled", "deleted"])("names a %s client with its id", async (state) => {
    const auth = await setup()
    const { accessToken, clientId } = await signInAgent(auth)
    if (state === "disabled") auth.database.prepare("update oauthClient set disabled = 1 where clientId = ?").run(clientId)
    else for (const table of ["oauthConsent", "oauthAccessToken", "oauthRefreshToken", "oauthClientResource", "oauthClient"]) auth.database.prepare(`delete from ${table} where clientId = ?`).run(clientId)
    expect(await refusal(auth, accessToken)).toEqual({ clientId, reason: "client_disabled" })
  })

  it("names an ended session with the client", async () => {
    const auth = await setup()
    const { accessToken, clientId, cookie } = await signInAgent(auth, "ada@example.com", {}, "openid profile email")
    expect((await auth.post("/sign-out", {}, { cookie })).status).toBe(200)
    expect(await refusal(auth, accessToken)).toEqual({ clientId, reason: "session_ended" })
  })

  it("keeps the message and the reason in the exported set", async () => {
    const auth = await setup()
    const { accessToken } = await signInAgent(auth)
    const [error] = await verifyMcpRequest(mcpRequest(accessToken, `${app}/api/drops`), { auth: auth.auth })
    expect(error?.message).toBe("The access token is not valid: /api/drops is not a resource of `mcpOAuth()`.")
    expect(mcpTokenInvalidReasons).toContain<McpTokenInvalidReason>("wrong_resource")
  })
})

describe("serveMcpOAuthDiscovery", () => {
  it("selects resources by origin when their paths match", async () => {
    const resources = [resource, "https://second.example.com/mcp"]
    const { auth } = await setup({ resource: resources })
    for (const endpoint of resources) {
      for (const suffix of ["", "/mcp"]) {
        const response = await serveMcpOAuthDiscovery(new Request(`${new URL(endpoint).origin}/.well-known/oauth-protected-resource${suffix}`), { auth })
        expect(await response?.json()).toMatchObject({ resource: endpoint })
      }
    }
    expect(await serveMcpOAuthDiscovery(new Request("https://other.example.com/.well-known/oauth-protected-resource/mcp"), { auth })).toBeUndefined()
  })

  it("answers the root well-known documents for the resource and the issuer", async () => {
    const { auth } = await setup()
    const get = async (path: string) => serveMcpOAuthDiscovery(new Request(`${app}${path}`), { auth, resourceDocumentation: `${app}/docs/agents`, resourceName: "Drop" })
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      expect(await (await get(path))?.json()).toEqual({
        authorization_servers: [`${app}/api/auth`],
        bearer_methods_supported: ["header"],
        resource,
        resource_documentation: `${app}/docs/agents`,
        resource_name: "Drop",
        scopes_supported: ["openid", "profile", "email", "offline_access"],
      })
    }
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api/auth", "/.well-known/openid-configuration/api/auth"]) {
      const metadata = v.parse(v.object({ issuer: v.string(), registration_endpoint: v.string() }), await (await get(path))?.json())
      expect(metadata).toMatchObject({ issuer: `${app}/api/auth`, registration_endpoint: `${app}/api/auth/oauth2/register` })
    }
    for (const path of ["/.well-known/oauth-protected-resource/_vitehub/mcp", "/.well-known/oauth-authorization-server/other", "/.well-known/skills/index.json", "/mcp"]) {
      expect(await get(path), path).toBeUndefined()
    }
    expect(await serveMcpOAuthDiscovery(new Request(`${app}/.well-known/oauth-protected-resource`, { method: "POST" }), { auth })).toBeUndefined()
  })

  it("lets MCP clients in a browser read the documents from another origin", async () => {
    const { auth } = await setup()
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server/api/auth", "/.well-known/openid-configuration"]) {
      const response = await serveMcpOAuthDiscovery(new Request(`${app}${path}`, { headers: { origin: "https://inspector.example.com" } }), { auth })
      expect(response?.status, path).toBe(200)
      expect(response?.headers.get("access-control-allow-origin"), path).toBe("*")
      const preflight = await serveMcpOAuthDiscovery(new Request(`${app}${path}`, { headers: { "access-control-request-headers": "mcp-protocol-version", "access-control-request-method": "GET", "origin": "https://inspector.example.com" }, method: "OPTIONS" }), { auth })
      expect(preflight?.status, path).toBe(204)
      expect(Object.fromEntries(preflight?.headers ?? []), path).toMatchObject({ "access-control-allow-headers": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-origin": "*" })
    }
  })

  it("throws AUTH_MCP_OAUTH_MISSING for an Auth without mcpOAuth()", async () => {
    const database = new DatabaseSync(":memory:")
    databases.push(database)
    // SAFETY: The helper reads only `$context` before it throws.
    const auth = createAuthForRequest(defineAuth(() => ({ baseURL: app, database, secret: "test-secret-at-least-32-bytes-long" })), new Request(app)) as unknown as McpOAuthAuth
    await expect(serveMcpOAuthDiscovery(new Request(`${app}/.well-known/oauth-protected-resource`), { auth })).rejects.toMatchObject({ code: "AUTH_MCP_OAUTH_MISSING" })
  })
})

describe("deleteUnusedMcpClients", () => {
  it("deletes old clients that never got a consent or a token, and keeps the others", async () => {
    const auth = await setup()
    const { clientId: used } = await signInAgent(auth)
    const unused = await auth.post("/oauth2/register", { client_name: "Abandoned", redirect_uris: [redirect] })
    const fresh = await auth.post("/oauth2/register", { client_name: "Fresh", redirect_uris: [redirect] })
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const ids = [used, v.parse(v.object({ client_id: v.string() }), await unused.json()).client_id]
    for (const id of ids) auth.database.prepare("update oauthClient set createdAt = ? where clientId = ?").run(old, id)
    expect(fresh.status).toBe(201)

    expect(await deleteUnusedMcpClients({ auth: auth.auth })).toEqual([undefined, { deleted: 1 }])
    const names = auth.database.prepare("select name from oauthClient order by name").all() as Array<{ name: string }>
    expect(names.map(row => row.name)).toEqual(["Claude Code", "Fresh"])
  })
})

describe("requireCaller", () => {
  const apiRequest = (headers: Record<string, string>) => new Request(`${app}/api/notes`, { headers, method: "DELETE" })

  it("returns a person with a session as a browser caller", async () => {
    const auth = await setup()
    const { cookie } = await signInAgent(auth)

    const [error, caller] = await requireCaller(apiRequest({ cookie }), auth.definition)

    expect(error).toBeUndefined()
    expect(caller).toMatchObject({ kind: "browser", session: { userId: caller?.user.id }, user: { email: "ada@example.com", nickname: "public" } })
    expect(caller?.user).not.toHaveProperty("internalNote")
    expect(Object.isFrozen(caller)).toBe(true)
  })

  it("returns an MCP access token as an agent caller on any route of the app", async () => {
    const auth = await setup()
    const { accessToken, clientId } = await signInAgent(auth)

    const [error, caller] = await requireCaller(apiRequest({ authorization: `Bearer ${accessToken}` }), auth.definition)

    expect(error).toBeUndefined()
    expect(caller).toEqual({
      client: { id: clientId, name: "Claude Code" },
      kind: "agent",
      scopes: ["openid", "profile", "email", "offline_access"],
      user: expect.objectContaining({ email: "ada@example.com", nickname: "public" }),
    })
    expect(caller?.user).not.toHaveProperty("internalNote")
  })

  it.each([true, false])("uses the forwarded origin only with trustedProxyHeaders=%s", async (trusted) => {
    const auth = await setup({}, false, undefined, trusted)
    const { accessToken } = await signInAgent(auth)
    const request = new Request("http://internal.example.com/api/notes", { headers: {
      authorization: `Bearer ${accessToken}`,
      "x-forwarded-host": "app.example.com",
      "x-forwarded-proto": "https",
    } })
    const [error, caller] = await requireCaller(request, auth.definition)
    expect(error?.code).toBe(trusted ? undefined : "AUTH_MCP_TOKEN_INVALID")
    expect(caller?.kind).toBe(trusted ? "agent" : undefined)
  })

  it("returns AUTH_SIGNED_OUT without a session or a token, and AUTH_MCP_TOKEN_INVALID for a bad token", async () => {
    const auth = await setup()
    const { accessToken, cookie } = await signInAgent(auth)

    expect((await requireCaller(apiRequest({}), auth.definition))[0]?.code).toBe("AUTH_SIGNED_OUT")
    // A bearer token is checked as a token, and the cookie next to it does not count.
    const [invalid] = await requireCaller(apiRequest({ authorization: `Bearer ${accessToken.slice(0, -4)}AAAA`, cookie }), auth.definition)
    expect(invalid?.code).toBe("AUTH_MCP_TOKEN_INVALID")
    // A token of another origin is not a token of this app.
    const other = new Request("https://other.example.com/api/notes", { headers: { authorization: `Bearer ${accessToken}` } })
    expect((await requireCaller(other, auth.definition))[0]?.code).toBe("AUTH_MCP_TOKEN_INVALID")
  })

  const notes = `${app}/api/review/notes`
  const callerAt = async (auth: Setup, path: string, token: string) => {
    const [error] = await requireCaller(new Request(`${app}${path}`, { headers: { authorization: `Bearer ${token}` } }), auth.definition)
    if (!error) return "agent"
    return error.code === "AUTH_MCP_TOKEN_INVALID" ? error.data.reason : error.code
  }
  const signInToBoth = async (resources: string[]) => {
    const auth = await setup({ resource: resources })
    const mcp = await signInAgent(auth, "ada@example.com", {}, undefined, resource)
    const notesAgent = await signInAgent(auth, "grace@example.com", {}, undefined, notes)
    return { auth, mcpToken: mcp.accessToken, notesToken: notesAgent.accessToken }
  }

  it("with several resources, accepts on a resource path only the tokens of that resource", async () => {
    const { auth, mcpToken, notesToken } = await signInToBoth([resource, notes])

    for (const path of ["/api/review/notes", "/api/review/notes/", "/api/review/notes/n1/replies"]) {
      expect(await callerAt(auth, path, notesToken)).toBe("agent")
      expect(await callerAt(auth, path, mcpToken)).toBe("wrong_resource")
    }
    for (const path of ["/mcp", "/mcp/sessions"]) {
      expect(await callerAt(auth, path, mcpToken)).toBe("agent")
      expect(await callerAt(auth, path, notesToken)).toBe("wrong_resource")
    }
  })

  it("with several resources, accepts on a path outside every resource only the tokens of the first resource", async () => {
    const { auth, mcpToken, notesToken } = await signInToBoth([resource, notes])

    // A resource path matches whole path segments, so `/api/review/notesx` and `/mcpx` are outside every resource.
    for (const path of ["/api/drops", "/api/review", "/api/review/notesx", "/mcpx"]) {
      expect(await callerAt(auth, path, mcpToken)).toBe("agent")
      expect(await callerAt(auth, path, notesToken)).toBe("wrong_resource")
    }

    const reversed = await signInToBoth([notes, resource])
    expect(await callerAt(reversed.auth, "/api/drops", reversed.notesToken)).toBe("agent")
    expect(await callerAt(reversed.auth, "/api/drops", reversed.mcpToken)).toBe("wrong_resource")
  })

  it("with one resource, accepts its token on every path of the origin", async () => {
    const auth = await setup()
    const { accessToken } = await signInAgent(auth)

    for (const path of ["/mcp", "/mcp/sessions", "/api/drops", "/api/review/notes", "/"]) expect(await callerAt(auth, path, accessToken)).toBe("agent")
  })

  it("reads each request once", async () => {
    const auth = await setup()
    const request = apiRequest({})
    expect(requireCaller(request, auth.definition)).toBe(requireCaller(request, auth.definition))
  })

  it("reads only the session when the Auth has no mcpOAuth()", async () => {
    const database = new DatabaseSync(":memory:")
    databases.push(database)
    const definition = defineAuth(() => ({ baseURL: app, database, secret: "test-secret-at-least-32-bytes-long" }))
    await (await createAuthForRequest(definition, new Request(app)).$context).runMigrations()

    const [error] = await requireCaller(apiRequest({ authorization: "Bearer not-an-mcp-token" }), definition)

    expect(error?.code).toBe("AUTH_SIGNED_OUT")
  })

  /** Better Auth's own OAuth plugins with the `mcpOAuth()` resource, and `bearer()`, as an app adds them without `mcpOAuth()`. */
  const plainProvider = (options: { disableJwtPlugin?: boolean } = {}) => [
    ...(options.disableJwtPlugin ? [] : [jwt()]),
    oauthProvider({
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: "infer",
      clientRegistrationDefaultResources: [resource],
      consentPage: "/oauth",
      loginPage: "/oauth",
      resources: [resource],
      ...options,
    }),
    bearer(),
  ]

  async function sessionBearer({ post }: Setup) {
    const signup = await post("/sign-up/email", { email: "grace@example.com", name: "Grace", password: "test-password-123" })
    expect(signup.status).toBe(200)
    return signup.headers.get("set-auth-token") ?? ""
  }

  it("returns an agent caller for jwt() and a plain oauthProvider() with resources, as verifyMcpRequest() does", async () => {
    const auth = await setup({}, false, undefined, false, plainProvider())
    const { accessToken, clientId } = await signInAgent(auth)
    expect((await verifyMcpRequest(mcpRequest(accessToken), { auth: auth.auth }))[0]).toBeUndefined()

    const [error, caller] = await requireCaller(apiRequest({ authorization: `Bearer ${accessToken}` }), auth.definition)

    expect(error).toBeUndefined()
    expect(caller).toMatchObject({ client: { id: clientId, name: "Claude Code" }, kind: "agent", user: { email: "ada@example.com" } })
    // A tampered JWT stays an invalid MCP token, and the cookie next to it does not count.
    const { cookie } = await signInAgent(auth, "bob@example.com")
    const [invalid] = await requireCaller(apiRequest({ authorization: `Bearer ${accessToken.slice(0, -4)}AAAA`, cookie }), auth.definition)
    expect(invalid?.code).toBe("AUTH_MCP_TOKEN_INVALID")
  })

  it("reads a session bearer of bearer() as a session next to a plain oauthProvider() with resources", async () => {
    const auth = await setup({}, false, undefined, false, plainProvider())
    const token = await sessionBearer(auth)

    const [error, caller] = await requireCaller(apiRequest({ authorization: `Bearer ${token}` }), auth.definition)

    expect(error).toBeUndefined()
    expect(caller).toMatchObject({ kind: "browser", user: { email: "grace@example.com" } })
  })

  it("has no MCP OAuth with opaque access tokens (disableJwtPlugin), in verifyMcpRequest() and requireCaller()", async () => {
    const auth = await setup({}, false, undefined, false, plainProvider({ disableJwtPlugin: true }))
    const token = await sessionBearer(auth)

    await expect(verifyMcpRequest(mcpRequest("a.b.c"), { auth: auth.auth })).rejects.toMatchObject({ code: "AUTH_MCP_OAUTH_MISSING" })
    const [error, caller] = await requireCaller(apiRequest({ authorization: `Bearer ${token}` }), auth.definition)
    expect(error).toBeUndefined()
    expect(caller).toMatchObject({ kind: "browser", user: { email: "grace@example.com" } })
    expect((await requireCaller(apiRequest({ authorization: "Bearer a.b.c" }), auth.definition))[0]?.code).toBe("AUTH_SIGNED_OUT")
  })

  it("accepts a session bearer when the OAuth provider is not configured by mcpOAuth()", async () => {
    const database = new DatabaseSync(":memory:")
    databases.push(database)
    const definition = defineAuth(() => ({
      baseURL: app,
      database,
      emailAndPassword: { enabled: true },
      plugins: [jwt(), oauthProvider({ loginPage: "/login", consentPage: "/consent" }), bearer()],
      secret: "test-secret-at-least-32-bytes-long",
    }))
    const instance = createAuthForRequest(definition, new Request(app))
    await (await instance.$context).runMigrations()
    const signup = await instance.handler(new Request(`${app}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "test-password-123" }),
      headers: { "content-type": "application/json", origin: app },
      method: "POST",
    }))
    expect(signup.status).toBe(200)
    const token = signup.headers.get("set-auth-token")
    expect(token).toBeTruthy()
    const [error, caller] = await requireCaller(apiRequest({ authorization: `Bearer ${token}` }), definition)
    expect(error).toBeUndefined()
    expect(caller).toMatchObject({ kind: "browser", user: { email: "ada@example.com" } })
  })
})
