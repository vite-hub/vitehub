import { createHash, randomBytes } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { defineAuth } from "@vite-hub/auth"
import { createAuthForRequest } from "@vite-hub/auth/server"
import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { requestEvent } from "./console-event.ts"

import { consoleMcpOAuth } from "../src/console/auth.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess, resolveConsoleAppAuthIdentity } from "../src/console/runtime/server/access.ts"
import consoleAuthManageHandler from "../src/console/runtime/server/auth-manage.ts"
import { verifyConsoleJwt } from "../src/console/runtime/server/bearer-jwt.ts"
import { installConsoleOrigins } from "../src/console/runtime/server/cors.ts"
import consoleEnvManageHandler from "../src/console/runtime/server/env-manage.ts"
import consoleMcpHandler from "../src/console/runtime/server/mcp.ts"
import consoleMcpAuthorizationServerHandler from "../src/console/runtime/server/mcp-authorization-server.ts"
import consoleMcpMetadataHandler from "../src/console/runtime/server/mcp-metadata.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import consoleRpcHandler from "../src/console/runtime/server/rpc.ts"
import consoleScheduleRunHandler from "../src/console/runtime/server/schedule-run.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"

import type { ConsoleOAuthAuth } from "../src/console/runtime/server/bearer.ts"

const app = "https://app.example.com"
const mcpResource = `${app}/_vitehub/mcp`
const consoleResource = `${app}/_vitehub`
const hosted = "https://console.vitehub.dev"
const callback = `${hosted}/oauth/callback`
const clientId = `${hosted}/oauth-client.json`
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

const rename = defineOperation({
  description: "Rename someone.",
  input: v.strictObject({}),
  kind: "write",
  name: "fixture.rename",
  run: () => ({ renamed: true }),
  section: "fixture",
})

const database = new DatabaseSync(":memory:")
const definition = defineAuth(() => ({
  baseURL: app,
  database,
  emailAndPassword: { enabled: true },
  plugins: consoleMcpOAuth({
    clientMetadataFetch: async (url) => {
      expect(url).toBe(clientId)
      return Response.json({
        client_id: clientId,
        client_name: "ViteHub Console",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [callback],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      })
    },
    resource: mcpResource,
  }),
  secret: "test-secret-at-least-32-bytes-long",
}))
const real = (request: Pick<Request, "headers" | "url">) => createAuthForRequest(definition, request)
// SAFETY: Better Auth's plugins add the OAuth endpoints to this instance at runtime.
const auth = (request: Request) => real(request) as unknown as ConsoleOAuthAuth
const authCall = (path: string, init: RequestInit = {}) => real(new Request(mcpResource)).handler(new Request(`${app}/api/auth${path}`, init))
const post = (path: string, body: Record<string, unknown>, cookie = "") => authCall(path, { body: JSON.stringify(body), headers: { "content-type": "application/json", cookie, origin: app }, method: "POST" })

let mcpClientId = ""
const tokens = { console: "", mcp: "", mcpReadOnly: "", readOnly: "" }
const exchangeHeaders: Headers[] = []

/** Sign in and consent on the app Auth as the hosted Console does, then exchange the code with PKCE for an access token. */
async function issue(resource: string, scope: string, client = clientId): Promise<string> {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const query = new URLSearchParams({ client_id: client, code_challenge: challenge, code_challenge_method: "S256", redirect_uri: callback, resource, response_type: "code", scope, state: "hosted-console" })
  const login = new URL((await authCall(`/oauth2/authorize?${query}`)).headers.get("location") ?? "", app)
  expect(login.pathname).toBe("/_vitehub/sign-in")
  const signedIn = await post("/sign-in/email", { email: "ada@example.com", oauth_query: login.search.slice(1), password: "test-password-123" })
  expect(signedIn.status, await signedIn.clone().text()).toBe(200)
  const next = new URL(v.parse(v.object({ url: v.string() }), await signedIn.json()).url, app)
  // A later sign-in for scopes that the person already granted skips the consent step.
  let redirect = next
  if (next.pathname === "/_vitehub/sign-in") {
    const cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
    const answer = await post("/oauth2/consent", { accept: true, oauth_query: next.search.slice(1) }, cookie)
    expect(answer.status, await answer.clone().text()).toBe(200)
    redirect = new URL(v.parse(v.object({ url: v.string() }), await answer.json()).url)
  }
  expect(redirect.origin + redirect.pathname).toBe(callback)
  const code = redirect.searchParams.get("code")
  if (!code) throw new Error(`Expected an authorization code: ${redirect}`)
  const exchange = await authCall("/oauth2/token", {
    body: new URLSearchParams({ client_id: client, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: callback, resource }),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: hosted },
    method: "POST",
  })
  expect(exchange.status, await exchange.clone().text()).toBe(200)
  exchangeHeaders.push(exchange.headers)
  const { access_token } = v.parse(v.object({ access_token: v.string() }), await exchange.json())
  // A JWT access token, not an opaque one: the Console verifies it in-process with the Auth's keys.
  expect(access_token.split(".")).toHaveLength(3)
  const claims = v.parse(v.object({ aud: v.union([v.string(), v.array(v.string())]), scope: v.string() }), JSON.parse(Buffer.from(access_token.split(".")[1] ?? "", "base64url").toString()))
  expect([claims.aud].flat()).toContain(resource)
  return access_token
}

beforeAll(async () => {
  installConsoleOrigins([hosted])
  await (await real(new Request(mcpResource)).$context).runMigrations()
  expect((await post("/sign-up/email", { email: "ada@example.com", name: "Ada", password: "test-password-123" })).status).toBe(200)
  // Dynamic registration remains available to MCP clients, without granting the Console resource.
  const registration = await post("/oauth2/register", { client_name: "MCP client", redirect_uris: [callback], token_endpoint_auth_method: "none" })
  expect(registration.status, await registration.clone().text()).toBe(201)
  mcpClientId = v.parse(v.object({ client_id: v.string() }), await registration.json()).client_id
  tokens.console = await issue(consoleResource, "vitehub:read vitehub:write")
  tokens.readOnly = await issue(consoleResource, "vitehub:read")
  tokens.mcp = await issue(mcpResource, "vitehub:read vitehub:write", mcpClientId)
  tokens.mcpReadOnly = await issue(mcpResource, "vitehub:read", mcpClientId)
})

afterAll(() => {
  database.close()
})

afterEach(() => {
  installConsoleOperations([])
  installConsoleSections("/tmp/console-hosted-oauth", [])
  Reflect.deleteProperty(globalThis, originsKey)
  Reflect.deleteProperty(globalThis, policyKey)
})

/** The session check of the app Auth: this test never has a session. */
const noSession = async () => Response.json({ code: "TEST_NO_SESSION" }, { status: 401 })

function install(): void {
  installConsoleAccess({ check: noSession, mode: "auth", oauth: { auth, path: "/_vitehub/mcp", resource: mcpResource, verify: verifyConsoleJwt } })
  installConsoleOrigins([hosted])
  installConsoleOperations([{ operations: [greet, rename], plugin: "fixture" }])
  installConsoleSections("/tmp/console-hosted-oauth", ["fixture", "env"])
}

function rpc(operation: string, headers: Record<string, string>, input: unknown = {}): Promise<Response> {
  return consoleRpcHandler.fetch(new Request(`${app}/_vitehub/rpc/__call`, {
    body: JSON.stringify({ input, operation }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  }))
}

describe("hosted Console sign-in with app Auth OAuth", () => {
  it("refuses the Console resource to a dynamically registered MCP client", async () => {
    install()
    const challenge = createHash("sha256").update(randomBytes(32)).digest("base64url")
    const query = new URLSearchParams({
      client_id: mcpClientId,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: callback,
      resource: consoleResource,
      response_type: "code",
      scope: "vitehub:read",
      state: "mcp-client",
    })
    const response = await authCall(`/oauth2/authorize?${query}`)
    expect(response.status).toBe(302)
    const redirect = new URL(response.headers.get("location") ?? "", app)
    expect(redirect.origin + redirect.pathname).toBe(callback)
    expect(redirect.searchParams.get("error")).toBe("invalid_target")
    expect(redirect.searchParams.get("state")).toBe("mcp-client")
    expect(redirect.searchParams.has("code")).toBe(false)
  })

  it("makes discovery and cookie-free token responses readable by the hosted browser", async () => {
    install()
    for (const [handler, path] of [
      [consoleMcpMetadataHandler, "/.well-known/oauth-protected-resource/_vitehub"],
      [consoleMcpAuthorizationServerHandler, "/.well-known/oauth-authorization-server/api/auth"],
    ] as const) {
      const response = await handler.fetch(new Request(`${app}${path}`, { headers: { origin: hosted } }))
      expect(response.status, await response.clone().text()).toBe(200)
      expect(response.headers.get("access-control-allow-origin")).toBe(hosted)
      expect(response.headers.get("vary")).toContain("Origin")
      expect(response.headers.has("access-control-allow-credentials")).toBe(false)
      const unlisted = await handler.fetch(new Request(`${app}${path}`, { headers: { origin: "https://evil.example.com" } }))
      expect(unlisted.headers.has("access-control-allow-origin")).toBe(false)
      expect(unlisted.headers.get("vary")).toContain("Origin")
    }
    for (const headers of exchangeHeaders) {
      expect(headers.get("access-control-allow-origin")).toBe(hosted)
      expect(headers.get("vary")).toContain("Origin")
      expect(headers.has("access-control-allow-credentials")).toBe(false)
    }
    const invalid = await authCall("/oauth2/token", {
      body: new URLSearchParams({ grant_type: "authorization_code", code: "invalid", client_id: clientId, redirect_uri: callback }),
      headers: { origin: hosted },
      method: "POST",
    })
    expect(invalid.status).toBe(400)
    expect(invalid.headers.get("access-control-allow-origin")).toBe(hosted)
    const unlisted = await authCall("/oauth2/token", {
      body: new URLSearchParams({ grant_type: "authorization_code", code: "invalid", client_id: clientId, redirect_uri: callback }),
      headers: { origin: "https://evil.example.com" },
      method: "POST",
    })
    expect(unlisted.headers.has("access-control-allow-origin")).toBe(false)
    const session = await post("/sign-in/email", { email: "ada@example.com", password: "test-password-123" })
    expect(session.headers.has("access-control-allow-origin")).toBe(false)
  })

  it("requires write scope for mutations on direct management routes", async () => {
    install()
    installConsoleSections("/tmp/console-hosted-oauth", ["fixture", "env", "auth", "agents", "schedules"])
    for (const [handler, path, body] of [
      [consoleAuthManageHandler, "/_vitehub/auth/manage", { action: "ban", userId: "someone" }],
      [consoleEnvManageHandler, "/_vitehub/env/manage", {}],
      [consoleScheduleRunHandler, "/_vitehub/schedules/run", {}],
    ] as const) {
      const response = await handler.fetch(new Request(`${app}${path}`, {
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${tokens.readOnly}`, origin: hosted, "content-type": "application/json", [consoleRpcHeader]: "1" },
        method: "POST",
      }))
      expect(response.status, await response.clone().text()).toBe(403)
      expect(response.headers.get("access-control-allow-origin")).toBe(hosted)
      expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope", scope="vitehub:write"')
      await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_ACCESS_DENIED" })
    }
  })

  it("checks upload scopes before loading the optional media library", async () => {
    install()
    for (const [token, status] of [[tokens.readOnly, 403], [tokens.console, 404]] as const) {
      const response = await consoleRpcHandler.fetch(new Request(`${app}/_vitehub/rpc/__call`, {
        body: JSON.stringify({ operation: "media.upload", input: { data: "eA==", filename: "a.txt", section: "content" } }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: hosted, [consoleRpcHeader]: "1" },
        method: "POST",
      }))
      expect(response.status, await response.clone().text()).toBe(status)
      expect(response.headers.get("access-control-allow-origin")).toBe(hosted)
      await expect(response.json()).resolves.toMatchObject(status === 403
        ? { code: "CONSOLE_ACCESS_DENIED" }
        : { message: "The media library needs Blob. Enable Blob in the ViteHub config." })
    }
  })

  it("lets read-only tokens reach built-in reads through nested section guards", async () => {
    install()
    for (const token of [tokens.console, tokens.readOnly]) {
      const read = await rpc("env.get", { authorization: `Bearer ${token}`, origin: hosted })
      expect(read.status, await read.clone().text()).toBe(200)
      await expect(read.json()).resolves.toMatchObject({ ok: true, value: { entries: [] } })
    }
    const read = await consoleMcpHandler.fetch(new Request(mcpResource, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { name: "env_get", arguments: {} } }),
      headers: { authorization: `Bearer ${tokens.mcpReadOnly}`, "content-type": "application/json" },
      method: "POST",
    }))
    expect(read.status, await read.clone().text()).toBe(200)
    await expect(read.json()).resolves.toMatchObject({ result: { isError: false, structuredContent: { entries: [] } } })
  })

  it("serves the protected resource metadata of the Console resource", async () => {
    install()
    const response = await consoleMcpMetadataHandler.fetch(new Request(`${app}/.well-known/oauth-protected-resource/_vitehub`))
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ authorization_servers: [`${app}/api/auth`], resource: consoleResource })
    const mcp = await consoleMcpMetadataHandler.fetch(new Request(`${app}/.well-known/oauth-protected-resource/_vitehub/mcp`))
    await expect(mcp.json()).resolves.toMatchObject({ resource: mcpResource })
  })

  it("calls the RPC from a listed origin with a Console access token", async () => {
    install()
    const response = await rpc("project.get", { authorization: `Bearer ${tokens.console}`, origin: hosted })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(hosted)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    const greeting = await rpc("fixture.greet", { authorization: `Bearer ${tokens.console}`, origin: hosted }, { name: "Ada" })
    expect(greeting.status, await greeting.clone().text()).toBe(200)
    await expect(greeting.json()).resolves.toMatchObject({ ok: true, value: { greeting: "Hello Ada", user: "ada@example.com" } })
    const write = await rpc("fixture.rename", { authorization: `Bearer ${tokens.console}`, origin: hosted })
    expect(write.status, await write.clone().text()).toBe(200)
  })

  it("asks a listed origin without a token or a session to sign in for the Console resource", async () => {
    install()
    const request = new Request(`${app}/_vitehub/rpc/__call`, { headers: { origin: hosted }, method: "POST" })
    const response = await resolveConsoleAppAuthIdentity(request, requestEvent(request), false)
    if (!(response instanceof Response)) throw new Error("Expected a challenge.")
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${app}/.well-known/oauth-protected-resource/_vitehub"`)
    expect(response.headers.get("access-control-allow-origin")).toBe(hosted)
    await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_SIGN_IN_REQUIRED" })
    // A session lets the app Auth go on to its own route policies.
    await expect(resolveConsoleAppAuthIdentity(request, requestEvent(request), true)).resolves.toBeUndefined()
  })

  it("resolves the token user at the app Auth middleware before the route checks origins", async () => {
    install()
    const listed = new Request(`${app}/_vitehub/rpc/__call`, { headers: { authorization: `Bearer ${tokens.console}`, origin: hosted }, method: "POST" })
    await expect(resolveConsoleAppAuthIdentity(listed, requestEvent(listed), false)).resolves.toMatchObject({ email: "ada@example.com" })
    const unlisted = new Request(`${app}/_vitehub/rpc/__call`, { headers: { authorization: `Bearer ${tokens.console}`, origin: "https://evil.example.com" }, method: "POST" })
    await expect(resolveConsoleAppAuthIdentity(unlisted, requestEvent(unlisted), false)).resolves.toMatchObject({ email: "ada@example.com" })
  })

  it("does not accept the token from an unlisted origin", async () => {
    install()
    const response = await rpc("project.get", { authorization: `Bearer ${tokens.console}`, origin: "https://evil.example.com" })
    expect(response.status, await response.clone().text()).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_ORIGIN_REJECTED" })
    expect(response.headers.has("access-control-allow-origin")).toBe(false)
  })

  it("accepts a Console bearer without an Origin header or app session", async () => {
    install()
    const response = await rpc("project.get", { authorization: `Bearer ${tokens.console}`, [consoleRpcHeader]: "1" })
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
  })

  it("rejects an MCP token on the RPC, and a Console token on MCP", async () => {
    install()
    const onRpc = await rpc("project.get", { authorization: `Bearer ${tokens.mcp}`, origin: hosted })
    expect(onRpc.status, await onRpc.clone().text()).toBe(401)
    expect(onRpc.headers.get("www-authenticate")).toContain("error=\"invalid_token\"")
    expect(onRpc.headers.get("www-authenticate")).toContain(`${app}/.well-known/oauth-protected-resource/_vitehub"`)
    expect(onRpc.headers.get("access-control-allow-origin")).toBe(hosted)
    const onMcp = await consoleMcpHandler.fetch(new Request(mcpResource, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      headers: { "authorization": `Bearer ${tokens.console}`, "content-type": "application/json" },
      method: "POST",
    }))
    expect(onMcp.status, await onMcp.clone().text()).toBe(401)
    expect(onMcp.headers.get("www-authenticate")).toContain("error=\"invalid_token\"")
    // The MCP token still works on MCP.
    const mcp = await consoleMcpHandler.fetch(new Request(mcpResource, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      headers: { "authorization": `Bearer ${tokens.mcp}`, "content-type": "application/json" },
      method: "POST",
    }))
    expect(mcp.status, await mcp.clone().text()).toBe(200)
  })

  it("limits a token with only vitehub:read to read operations", async () => {
    install()
    const read = await rpc("fixture.greet", { authorization: `Bearer ${tokens.readOnly}`, origin: hosted }, { name: "Ada" })
    expect(read.status, await read.clone().text()).toBe(200)
    const write = await rpc("fixture.rename", { authorization: `Bearer ${tokens.readOnly}`, origin: hosted })
    expect(write.status, await write.clone().text()).toBe(403)
    expect(write.headers.get("access-control-allow-origin")).toBe(hosted)
    await expect(write.json()).resolves.toMatchObject({ code: "CONSOLE_ACCESS_DENIED" })
  })
})
