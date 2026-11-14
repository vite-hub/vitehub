import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"

import { defineAuth } from "../src/index.ts"
import { deleteUnusedMcpClients, mcpOAuth, serveMcpOAuthDiscovery, verifyMcpRequest } from "../src/mcp.ts"
import { createAuthForRequest } from "../src/internal/server.ts"

import type { AuthAccessPolicy } from "../src/index.ts"
import type { McpOAuthAuth, McpOAuthOptions } from "../src/mcp.ts"

const app = "https://app.example.com"
const resource = `${app}/mcp`
const redirect = "http://127.0.0.1:53682/callback"
const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

/** A real Better Auth on SQLite with `mcpOAuth()`, as an app's `server/auth.ts` defines it. */
async function setup(options: Partial<McpOAuthOptions> = {}, rateLimit = false, policy?: AuthAccessPolicy) {
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  const definition = defineAuth(() => ({
    baseURL: app,
    database,
    emailAndPassword: { enabled: true },
    plugins: mcpOAuth({ loginPage: "/oauth", resource, ...options }),
    ...(rateLimit ? { rateLimit: { enabled: true } } : {}),
    ...(policy ? { access: { policy } } : {}),
    secret: "test-secret-at-least-32-bytes-long",
  }))
  // One instance, as a server keeps it: memory rate limits live in the instance.
  const instance = createAuthForRequest(definition, new Request(resource))
  // SAFETY: The registered Auth type does not know the endpoints that jwt() and oauthProvider() add at runtime.
  const auth = instance as unknown as McpOAuthAuth
  await (await instance.$context).runMigrations()
  const call = (path: string, init: RequestInit = {}) => instance.handler(new Request(`${app}/api/auth${path}`, init))
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => call(path, { body: JSON.stringify(body), headers: { "content-type": "application/json", origin: app, ...headers }, method: "POST" })
  return { auth, call, database, post }
}

type Setup = Awaited<ReturnType<typeof setup>>

const Url = v.object({ url: v.string() })

/** The browser flow of an MCP client: register, authorize with PKCE, sign in, consent, and exchange the code. */
async function signInAgent({ call, post }: Setup, email = "ada@example.com", tokenHeaders: Record<string, string> = {}, scope = "openid profile email offline_access") {
  expect((await post("/sign-up/email", { email, name: "Ada", password: "test-password-123" })).status).toBe(200)
  const registration = await post("/oauth2/register", { client_name: "Claude Code", redirect_uris: [redirect], token_endpoint_auth_method: "none" })
  expect(registration.status, await registration.clone().text()).toBe(201)
  const { client_id } = v.parse(v.object({ client_id: v.string() }), await registration.json())
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const query = new URLSearchParams({ client_id, code_challenge: challenge, code_challenge_method: "S256", redirect_uri: redirect, resource, response_type: "code", scope, state: "s" })
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
    body: new URLSearchParams({ client_id, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirect, resource }),
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
    const auth = await setup({}, false, { allow: () => member, recheck: 0 })
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

  it.each(["signed out", "expired session"])("keeps an offline_access grant after %s, refreshed tokens included", async (reason) => {
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
    // Sign-out deletes the session and unlinks the refresh token. An expired session stays, and Better Auth's refresh grant
    // copies its id into every new token.
    const { sid } = v.parse(v.object({ sid: v.nullish(v.string()) }), JSON.parse(Buffer.from(access_token.split(".")[1] ?? "", "base64url").toString()))
    expect(typeof sid).toBe(reason === "expired session" ? "string" : "object")
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
