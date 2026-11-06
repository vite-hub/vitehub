import { createHash, randomBytes } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { defineAuth } from "@vite-hub/auth"
import { createAuthForRequest } from "@vite-hub/auth/server"
import { defineOperation } from "@vite-hub/internal/operations"
import { admin, jwt } from "better-auth/plugins"
import { defineHandler } from "h3"
import * as v from "valibot"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { consoleMcpOAuth, consoleResourceOf } from "../src/console/auth.ts"
import { installConsoleAccess, resolveConsoleAppAuthIdentity } from "../src/console/runtime/server/access.ts"
import { installConsoleOrigins } from "../src/console/runtime/server/cors.ts"
import consoleMcpAuthorizationServerHandler from "../src/console/runtime/server/mcp-authorization-server.ts"
import consoleMcpMetadataHandler from "../src/console/runtime/server/mcp-metadata.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import consoleRpcHandler from "../src/console/runtime/server/rpc.ts"
import { resolveConsoleAccessBuild } from "../src/console/vite.ts"

import type { ConsoleOAuthAuth } from "../src/console/runtime/server/bearer.ts"

const app = "https://app.example.com"
const mcpResource = `${app}/_vitehub/mcp`
const consoleResource = `${app}/_vitehub`
const hosted = "https://console.vitehub.dev"
const local = "http://127.0.0.1:4801"
const clientId = `${hosted}/oauth-client.json`
const redirectUri = `${hosted}/callback`
const policyKey = Symbol.for("vitehub.console.access")
const originsKey = Symbol.for("vitehub.console.origins")

const greet = defineOperation({
  description: "Greet someone.",
  input: v.strictObject({ name: v.string() }),
  kind: "read",
  name: "fixture.greet",
  run: ({ name }, { user }) => ({ greeting: `Hello ${name}`, user: user?.email ?? null }),
  section: "fixture",
})

const save = defineOperation({
  description: "Save a value.",
  input: v.strictObject({ value: v.string() }),
  kind: "write",
  name: "fixture.save",
  run: ({ value }) => ({ saved: value }),
  section: "fixture",
})

/** Client ID Metadata Documents that the fake transport serves, by URL. */
const documents = new Map<string, Record<string, unknown>>()
const fetched: string[] = []

function document(id: string, redirects: string[]): Record<string, unknown> {
  return { client_id: id, client_name: "ViteHub Console", grant_types: ["authorization_code", "refresh_token"], redirect_uris: redirects, response_types: ["code"], token_endpoint_auth_method: "none" }
}

async function clientMetadataFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input)
  fetched.push(url)
  const body = documents.get(url)
  return body ? Response.json(body, { headers: { "cache-control": "max-age=300" } }) : new Response("Not found", { status: 404 })
}

let database: DatabaseSync
let real: (request: Pick<Request, "headers" | "url">) => ReturnType<typeof createAuthForRequest>

/** A real Better Auth with `consoleMcpOAuth()` on SQLite, and the Console access policy that generated output installs. */
beforeEach(async () => {
  documents.clear()
  fetched.length = 0
  documents.set(clientId, document(clientId, [redirectUri]))
  database = new DatabaseSync(":memory:")
  const definition = defineAuth(() => ({
    baseURL: app,
    database,
    emailAndPassword: { enabled: true },
    plugins: [admin(), ...consoleMcpOAuth({ clientMetadataFetch, resource: mcpResource })],
    secret: "test-secret-at-least-32-bytes-long",
  }))
  real = request => createAuthForRequest(definition, request)
  await (await real(new Request(app)).$context).runMigrations()
  // SAFETY: Better Auth's plugins add the OAuth endpoints to this instance at runtime.
  const auth = (request: Request) => real(request) as unknown as ConsoleOAuthAuth
  installConsoleAccess({ check: async () => Response.json({ message: "Sign in." }, { status: 401 }), mode: "auth", oauth: { auth, path: "/_vitehub/mcp", resource: mcpResource } })
  installConsoleOrigins([hosted, local])
  installConsoleOperations([{ operations: [greet, save], plugin: "fixture" }])
})

afterEach(() => {
  database.close()
  installConsoleOperations([])
  Reflect.deleteProperty(globalThis, originsKey)
  Reflect.deleteProperty(globalThis, policyKey)
})

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return real(new Request(app)).handler(new Request(`${app}/api/auth${path}`, init))
}

function post(path: string, body: Record<string, unknown>, cookie = ""): Promise<Response> {
  return call(path, { body: JSON.stringify(body), headers: { "content-type": "application/json", cookie, origin: app }, method: "POST" })
}

function form(path: string, body: Record<string, string>, origin = hosted): Promise<Response> {
  return call(path, { body: new URLSearchParams(body), headers: { "content-type": "application/x-www-form-urlencoded", origin }, method: "POST" })
}

async function signUp(email = "ada@example.com"): Promise<{ cookie: string, id: string }> {
  const response = await post("/sign-up/email", { email, name: "Ada", password: "test-password-123" })
  expect(response.status, await response.clone().text()).toBe(200)
  const { user } = v.parse(v.object({ user: v.object({ id: v.string() }) }), await response.json())
  return { cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; "), id: user.id }
}

function pkce(): { challenge: string, verifier: string } {
  const verifier = randomBytes(32).toString("base64url")
  return { challenge: createHash("sha256").update(verifier).digest("base64url"), verifier }
}

function authorizeQuery(overrides: Record<string, string | undefined> = {}, challenge = pkce().challenge): string {
  const query: Record<string, string | undefined> = {
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    resource: consoleResource,
    response_type: "code",
    scope: "offline_access vitehub:read vitehub:write",
    state: "console-test",
    ...overrides,
  }
  return new URLSearchParams(Object.entries(query).flatMap(([name, value]): Array<[string, string]> => value === undefined ? [] : [[name, value]])).toString()
}

/** Sign in, authorize, consent, and exchange the code with its verifier, as the Console does. */
async function consoleTokens(options: { cookie?: string, resource?: string, scope?: string } = {}): Promise<{ access_token: string, refresh_token?: string, response: Response }> {
  const cookie = options.cookie ?? (await signUp()).cookie
  const { challenge, verifier } = pkce()
  const authorization = await call(`/oauth2/authorize?${authorizeQuery({ resource: options.resource ?? consoleResource, scope: options.scope }, challenge)}`, { headers: { cookie } })
  expect(authorization.status, await authorization.clone().text()).toBe(302)
  const consent = new URL(authorization.headers.get("location") ?? "", app)
  const answer = await post("/oauth2/consent", { accept: true, oauth_query: consent.search.slice(1) }, cookie)
  expect(answer.status, await answer.clone().text()).toBe(200)
  const callback = new URL(v.parse(v.object({ url: v.string() }), await answer.json()).url)
  expect(callback.origin).toBe(hosted)
  const code = callback.searchParams.get("code") ?? ""
  const response = await form("/oauth2/token", { client_id: clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri, resource: options.resource ?? consoleResource })
  expect(response.status, await response.clone().text()).toBe(200)
  const tokens = v.parse(v.object({ access_token: v.string(), expires_in: v.number(), refresh_token: v.optional(v.string()) }), await response.clone().json())
  return { ...tokens, response }
}

function rpc(token: string | undefined, operation: string, input: Record<string, unknown>, origin = local): Promise<Response> {
  return defineHandler(consoleRpcHandler).fetch(new Request(`${app}/_vitehub/rpc/__call`, {
    body: JSON.stringify({ input, operation }),
    headers: { "content-type": "application/json", origin, "sec-fetch-site": "cross-site", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    method: "POST",
  }))
}

function claims(token: string): Record<string, unknown> {
  return v.parse(v.record(v.string(), v.unknown()), JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()))
}

describe("OAuth Console tokens", () => {
  it("issues a short token for the Console resource that calls the RPC from a listed origin", async () => {
    const { access_token, refresh_token, response } = await consoleTokens()
    expect(response.headers.get("access-control-allow-origin")).toBe(hosted)
    expect(response.headers.has("access-control-allow-credentials")).toBe(false)
    const payload = claims(access_token)
    expect([payload.aud].flat()).toContain(consoleResource)
    expect([payload.aud].flat()).not.toContain(mcpResource)
    expect(Number(payload.exp) - Number(payload.iat)).toBe(15 * 60)
    expect(refresh_token).toBeTruthy()
    // The client was read from its metadata document on a listed origin. It has no client secret.
    expect(new Set(fetched)).toEqual(new Set([clientId]))
    const answer = await rpc(access_token, "fixture.greet", { name: "Ada" })
    expect(answer.status, await answer.clone().text()).toBe(200)
    await expect(answer.json()).resolves.toMatchObject({ ok: true, value: { greeting: "Hello Ada", user: "ada@example.com" } })
    expect(answer.headers.get("access-control-allow-origin")).toBe(local)
    expect(answer.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate")
    // The same token from an origin that is not listed is refused.
    const foreign = await rpc(access_token, "fixture.greet", { name: "Ada" }, "https://evil.example")
    expect(foreign.status).toBe(403)
    expect(foreign.headers.has("access-control-allow-origin")).toBe(false)
  })

  it("rejects a token for the MCP resource on the RPC, and a Console token on MCP", async () => {
    const { access_token: mcp } = await consoleTokens({ resource: mcpResource })
    expect([claims(mcp).aud].flat()).toContain(mcpResource)
    const rejected = await rpc(mcp, "fixture.greet", { name: "Ada" })
    expect(rejected.status).toBe(401)
    expect(rejected.headers.get("www-authenticate")).toBe(`Bearer realm="vitehub-console", error="invalid_token", error_description="The access token is not valid.", resource_metadata="${app}/.well-known/oauth-protected-resource/_vitehub"`)
    expect(rejected.headers.get("access-control-allow-origin")).toBe(local)
    const { access_token: console } = await consoleTokens({ cookie: (await signUp("grace@example.com")).cookie })
    const identity = await resolveConsoleAppAuthIdentity(new Request(mcpResource, { headers: { authorization: `Bearer ${console}` }, method: "POST" }), {}, false)
    expect(identity).toBeInstanceOf(Response)
    expect((identity as Response).status).toBe(401)
  })

  it("rejects a Console resource request for an unrelated resource", async () => {
    const { cookie } = await signUp()
    const authorization = await call(`/oauth2/authorize?${authorizeQuery({ resource: `${app}/other-resource` })}`, { headers: { cookie } })
    expect(authorization.status).toBe(400)
    await expect(authorization.json()).resolves.toMatchObject({ error: "invalid_target" })
  })

  it("lets a read-only token read, and refuses a write", async () => {
    const { access_token } = await consoleTokens({ scope: "vitehub:read" })
    expect((await rpc(access_token, "fixture.greet", { name: "Ada" })).status).toBe(200)
    const write = await rpc(access_token, "fixture.save", { value: "x" })
    expect(write.status).toBe(403)
    await expect(write.json()).resolves.toMatchObject({ code: "CONSOLE_ACCESS_DENIED", message: expect.stringContaining("vitehub:write") })
  })

  it("refuses a client document on an origin that console.origins does not list, before it fetches the document", async () => {
    const other = "https://other-console.example.com/oauth-client.json"
    documents.set(other, document(other, ["https://other-console.example.com/callback"]))
    const { cookie } = await signUp()
    const authorization = await call(`/oauth2/authorize?${authorizeQuery({ client_id: other, redirect_uri: "https://other-console.example.com/callback" })}`, { headers: { cookie } })
    expect(authorization.status).toBe(400)
    await expect(authorization.json()).resolves.toMatchObject({ error: "invalid_client", error_description: expect.stringContaining("console.origins") })
    expect(fetched).toEqual([])
  })

  it.each([
    ["on another origin", "https://evil.example/callback"],
    ["on loopback", "http://127.0.0.1:4801/callback"],
  ])("refuses a redirect URI %s", async (_name, redirect) => {
    documents.set(clientId, document(clientId, [redirectUri, redirect]))
    const { cookie } = await signUp()
    const authorization = await call(`/oauth2/authorize?${authorizeQuery({ redirect_uri: redirect })}`, { headers: { cookie } })
    expect(authorization.status).toBe(400)
    await expect(authorization.json()).resolves.toMatchObject({ error: "invalid_request", error_description: expect.stringContaining(hosted) })
  })

  it("requires PKCE with S256", async () => {
    const { cookie } = await signUp()
    for (const overrides of [{ code_challenge: undefined, code_challenge_method: undefined }, { code_challenge_method: "plain" }]) {
      const authorization = await call(`/oauth2/authorize?${authorizeQuery(overrides)}`, { headers: { cookie } })
      expect(authorization.status).toBe(400)
      await expect(authorization.json()).resolves.toMatchObject({ error: "invalid_request" })
    }
  })

  it("refuses an expired token", async () => {
    const { id } = await signUp()
    const instance = real(new Request(app))
    const context = await instance.$context
    // SAFETY: The test reads the plugin endpoint that the jwt() plugin adds to the instance.
    const signed = await (instance.api as unknown as { signJWT: (input: { body: Record<string, unknown> }) => Promise<{ token: string }> }).signJWT({
      body: { payload: { aud: consoleResource, exp: Math.floor(Date.now() / 1000) - 120, iat: Math.floor(Date.now() / 1000) - 1000, iss: context.baseURL, scope: "vitehub:read", sub: id } },
    })
    const response = await rpc(signed.token, "fixture.greet", { name: "Ada" })
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("error=\"invalid_token\"")
  })

  it("refuses the token of a banned user at once", async () => {
    const { access_token } = await consoleTokens()
    const payload = claims(access_token)
    await (await real(new Request(app)).$context).internalAdapter.updateUser(String(payload.sub), { banned: true })
    expect((await rpc(access_token, "fixture.greet", { name: "Ada" })).status).toBe(401)
  })

  it("refreshes, and a revoked refresh token refreshes no more", async () => {
    const { access_token, refresh_token } = await consoleTokens()
    const refreshed = await form("/oauth2/token", { client_id: clientId, grant_type: "refresh_token", refresh_token: refresh_token ?? "", resource: consoleResource })
    expect(refreshed.status, await refreshed.clone().text()).toBe(200)
    expect(refreshed.headers.get("access-control-allow-origin")).toBe(hosted)
    const next = v.parse(v.object({ access_token: v.string(), refresh_token: v.string() }), await refreshed.json())
    expect(next.access_token).not.toBe(access_token)
    const revoked = await form("/oauth2/revoke", { client_id: clientId, token: next.refresh_token, token_type_hint: "refresh_token" })
    expect(revoked.status, await revoked.clone().text()).toBe(200)
    expect(revoked.headers.get("access-control-allow-origin")).toBe(hosted)
    const again = await form("/oauth2/token", { client_id: clientId, grant_type: "refresh_token", refresh_token: next.refresh_token, resource: consoleResource })
    expect(again.status).toBe(400)
    // A signed access token stays valid until it expires.
    expect((await rpc(next.access_token, "fixture.greet", { name: "Ada" })).status).toBe(200)
  })

  it("answers CORS on the token endpoint for a listed origin only", async () => {
    const preflight = (origin: string) => call("/oauth2/token", { headers: { "access-control-request-method": "POST", origin }, method: "OPTIONS" })
    const listed = await preflight(hosted)
    expect(listed.status).toBe(204)
    expect(listed.headers.get("access-control-allow-origin")).toBe(hosted)
    expect(listed.headers.has("access-control-allow-credentials")).toBe(false)
    const foreign = await preflight("https://evil.example")
    expect(foreign.headers.has("access-control-allow-origin")).toBe(false)
    const failed = await form("/oauth2/token", { client_id: clientId, code: "nope", code_verifier: "x".repeat(43), grant_type: "authorization_code", redirect_uri: redirectUri }, "https://evil.example")
    expect(failed.headers.has("access-control-allow-origin")).toBe(false)
  })

  it("announces the Console resource metadata in the challenge of a signed-out call, and serves it", async () => {
    const response = await rpc(undefined, "fixture.greet", { name: "Ada" })
    expect(response.status).toBe(401)
    const metadataUrl = `${app}/.well-known/oauth-protected-resource/_vitehub`
    expect(response.headers.get("www-authenticate")).toBe(`Bearer realm="vitehub-console", resource_metadata="${metadataUrl}"`)
    expect(response.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate")
    const metadata = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(metadataUrl, { headers: { origin: hosted } }))
    expect(metadata.status, await metadata.clone().text()).toBe(200)
    await expect(metadata.json()).resolves.toMatchObject({ authorization_servers: [`${app}/api/auth`], resource: consoleResource, scopes_supported: ["vitehub:read", "vitehub:write", "offline_access"] })
    expect(metadata.headers.get("access-control-allow-origin")).toBe(hosted)
    // The MCP document stays where MCP clients look.
    const mcp = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`))
    await expect(mcp.json()).resolves.toMatchObject({ resource: mcpResource })
    const server = await defineHandler(consoleMcpAuthorizationServerHandler).fetch(new Request(`${app}/.well-known/oauth-authorization-server/api/auth`, { headers: { origin: hosted } }))
    expect(server.status).toBe(200)
    await expect(server.json()).resolves.toMatchObject({ client_id_metadata_document_supported: true, code_challenge_methods_supported: ["S256"] })
    expect(server.headers.get("access-control-allow-origin")).toBe(hosted)
  })

  it("accepts a Console token at the app Auth middleware of a data route, and answers a signed-out call with the challenge", async () => {
    const { access_token } = await consoleTokens()
    const request = (authorization?: string) => new Request(`${app}/_vitehub/rpc/__call`, { headers: { origin: local, ...(authorization ? { authorization } : {}) }, method: "POST" })
    await expect(resolveConsoleAppAuthIdentity(request(`Bearer ${access_token}`), {}, false)).resolves.toMatchObject({ email: "ada@example.com" })
    const signedOut = await resolveConsoleAppAuthIdentity(request(), {}, false)
    expect(signedOut).toBeInstanceOf(Response)
    const response = signedOut as Response
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(`Bearer realm="vitehub-console", resource_metadata="${app}/.well-known/oauth-protected-resource/_vitehub"`)
    expect(response.headers.get("access-control-allow-origin")).toBe(local)
    // A session still passes to the app Auth checks.
    await expect(resolveConsoleAppAuthIdentity(request(), {}, true)).resolves.toBeUndefined()
  })

  it("keeps a bearer that is not a JWT for console.authorize, as before", async () => {
    installConsoleAccess({
      authorize: ({ request }) => request.headers.get("authorization") === "Bearer app-key",
      check: async () => undefined,
      mode: "auth",
      oauth: { auth: request => real(request) as unknown as ConsoleOAuthAuth, path: "/_vitehub/mcp", resource: mcpResource },
    })
    const response = await defineHandler(consoleRpcHandler).fetch(new Request(`${app}/_vitehub/rpc/__call`, {
      body: JSON.stringify({ input: { name: "Ada" }, operation: "fixture.greet" }),
      headers: { "authorization": "Bearer app-key", "content-type": "application/json", "x-vitehub-console": "1" },
      method: "POST",
    }))
    expect(response.status, await response.clone().text()).toBe(200)
  })

  it("installs console.origins for an app Auth that signs Consoles in", () => {
    expect(consoleResourceOf("https://app.example.com/portal/_vitehub/mcp/")).toBe("https://app.example.com/portal/_vitehub")
    const appAuth = { access: { routes: [] }, route: "/api/auth/**" }
    // SAFETY: The test passes the fields of a resolved Auth config that the access build reads.
    expect(resolveConsoleAccessBuild({ auth: "app", authorize: undefined }, { appAuth: appAuth as never, root: process.cwd() })).toMatchObject({ mode: "auth", oauth: { path: "/_vitehub/mcp" }, origins: [hosted] })
  })
})

describe("an Auth without the Console resource", () => {
  it("keeps MCP and ignores tokens on the data routes", async () => {
    database.close()
    database = new DatabaseSync(":memory:")
    const { oauthProvider } = await import("@better-auth/oauth-provider")
    const definition = defineAuth(() => ({
      baseURL: app,
      database,
      plugins: [jwt(), oauthProvider({ clientRegistrationDefaultResources: [mcpResource], consentPage: "/consent", loginPage: "/login", resources: [mcpResource], scopes: ["vitehub:read", "vitehub:write"] })],
      secret: "test-secret-at-least-32-bytes-long",
    }))
    real = request => createAuthForRequest(definition, request)
    await (await real(new Request(app)).$context).runMigrations()
    const metadata = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource/_vitehub`))
    expect(metadata.status).toBe(503)
    await expect(metadata.json()).resolves.toMatchObject({ message: expect.stringContaining(consoleResource) })
    expect((await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`))).status).toBe(200)
    const response = await rpc("aaa.bbb.ccc", "fixture.greet", { name: "Ada" })
    // The session check answers, without a resource_metadata that the app cannot serve.
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe("Bearer realm=\"vitehub-console\"")
  })
})
