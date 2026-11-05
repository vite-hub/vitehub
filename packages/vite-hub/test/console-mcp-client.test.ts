import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { isConsoleMcpClientEnabled, resolveConsoleSectionIds } from "../src/console/runtime/sections.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { resetConsoleMcp } from "../src/console/runtime/server/mcp-client.ts"
import { consoleMcpClientOperations } from "../src/console/runtime/server/mcp-client-operations.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { ConsoleMcpConnection, ConsoleMcpConnectResult, ConsoleMcpOutcome, ConsoleMcpOverview, ConsoleMcpPage } from "../src/console/runtime/mcp-client.ts"

const people: Record<string, { email: string, name: string }> = {
  lucia: { email: "lucia@example.com", name: "Lucía" },
  maxi: { email: "maxi@example.com", name: "Maxi" },
}

/** What the authorization server and the MCP server saw, so tests can check the protocol, not only the Console. */
const seen = { grants: [] as string[], registrations: 0, revoked: new Set<string>(), sessions: new Set<string>() }
const codes = new Map<string, { challenge: string, person: string, redirectUri: string, resource: string | null }>()
const tokens = new Map<string, string>()
const issued: string[] = []
let origin = ""

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function issue(person: string): Record<string, unknown> {
  const access = `at-${person}-${randomUUID()}`
  const refresh = `rt-${person}-${randomUUID()}`
  tokens.set(access, person)
  tokens.set(refresh, person)
  issued.push(access, refresh)
  // The Console reads the ID token without checking its signature, as it comes straight from the token endpoint.
  const idToken = `${base64url({ alg: "none" })}.${base64url({ aud: "client-1", iss: origin, sub: `user-${person}`, ...people[person] })}.`
  return { access_token: access, expires_in: 3_600, id_token: idToken, refresh_token: refresh, scope: "openid profile email", token_type: "Bearer" }
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value))
}

/** One MCP server per session, as a stateful Streamable HTTP server keeps them. Its tools answer as the caller. */
function mcpServer(person: () => string): Server {
  const server = new Server({ name: "test-finance", title: "Test Finance", version: "1.2.3" }, { capabilities: { prompts: {}, resources: {}, tools: {} }, instructions: "Read the household's money." })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { annotations: { readOnlyHint: true }, description: "Say who the token belongs to.", inputSchema: { properties: {}, type: "object" }, name: "whoami" },
      { description: "Repeat a text.", inputSchema: { properties: { text: { type: "string" } }, required: ["text"], type: "object" }, name: "echo" },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "whoami") return { content: [{ text: people[person()]!.name, type: "text" }], structuredContent: { email: people[person()]!.email } }
    if (request.params.name === "echo") return { content: [{ text: String(request.params.arguments?.text), type: "text" }] }
    throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${request.params.name}`)
  })
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ mimeType: "text/markdown", name: "profile", uri: "profile://me" }] }))
  server.setRequestHandler(ReadResourceRequestSchema, async request => ({ contents: [{ mimeType: "text/markdown", text: `# ${people[person()]!.name}`, uri: request.params.uri }] }))
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ arguments: [{ name: "topic", required: true }], name: "summarize" }] }))
  server.setRequestHandler(GetPromptRequestSchema, async request => ({ messages: [{ content: { text: `Summarize ${request.params.arguments?.topic}.`, type: "text" }, role: "user" }] }))
  return server
}

const transports = new Map<string, StreamableHTTPServerTransport>()
const sessionPeople = new Map<string, string>()

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", origin)
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return json(response, 200, { authorization_servers: [origin], resource: `${origin}/mcp`, resource_name: "Test Finance", scopes_supported: ["openid", "profile", "email"] })
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json(response, 200, {
      authorization_endpoint: `${origin}/authorize`,
      authorization_response_iss_parameter_supported: true,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      issuer: origin,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      revocation_endpoint: `${origin}/revoke`,
      token_endpoint: `${origin}/token`,
      token_endpoint_auth_methods_supported: ["none"],
    })
  }
  if (url.pathname === "/register") {
    seen.registrations++
    return json(response, 201, { ...JSON.parse(await body(request)), client_id: "client-1" })
  }
  if (url.pathname === "/authorize") {
    // The browser signs in as the person in its cookie. `prompt=login` would show a sign-in form first.
    const person = /person=(\w+)/.exec(request.headers.cookie ?? "")?.[1] ?? "maxi"
    const code = randomUUID()
    codes.set(code, { challenge: url.searchParams.get("code_challenge")!, person, redirectUri: url.searchParams.get("redirect_uri")!, resource: url.searchParams.get("resource") })
    const back = new URL(url.searchParams.get("redirect_uri")!)
    back.searchParams.set("code", code)
    back.searchParams.set("state", url.searchParams.get("state")!)
    back.searchParams.set("iss", origin)
    response.writeHead(302, { location: back.href }).end()
    return
  }
  if (url.pathname === "/token") {
    const form = new URLSearchParams(await body(request))
    seen.grants.push(form.get("grant_type")!)
    if (form.get("grant_type") === "refresh_token") {
      const person = tokens.get(form.get("refresh_token")!)
      // Rotate refresh tokens: a second use of the old token must fail.
      tokens.delete(form.get("refresh_token")!)
      return person && !seen.revoked.has(form.get("refresh_token")!) ? json(response, 200, issue(person)) : json(response, 400, { error: "invalid_grant" })
    }
    const grant = codes.get(form.get("code")!)
    codes.delete(form.get("code")!)
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url")
    if (!grant || grant.challenge !== challenge || grant.redirectUri !== form.get("redirect_uri") || grant.resource !== form.get("resource")) return json(response, 400, { error: "invalid_grant" })
    return json(response, 200, issue(grant.person))
  }
  if (url.pathname === "/revoke") {
    seen.revoked.add(new URLSearchParams(await body(request)).get("token")!)
    response.writeHead(200).end()
    return
  }
  if (url.pathname === "/mcp") {
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1]
    const person = token === "fin_lucia" ? "lucia" : token && !seen.revoked.has(token) ? tokens.get(token) : undefined
    if (!person) {
      response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end()
      return
    }
    const sessionId = request.headers["mcp-session-id"]
    const text = request.method === "POST" ? await body(request) : undefined
    const message: unknown = text ? JSON.parse(text) : undefined
    let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined
    if (!transport) {
      if (typeof sessionId === "string") return json(response, 404, { error: { code: -32001, message: "Session not found" }, id: null, jsonrpc: "2.0" })
      const created = new StreamableHTTPServerTransport({
        onsessioninitialized: (id) => {
          transports.set(id, created)
          seen.sessions.add(id)
        },
        sessionIdGenerator: () => randomUUID(),
      })
      await mcpServer(() => sessionPeople.get(created.sessionId ?? "") ?? person).connect(created)
      transport = created
    }
    // A session belongs to the token that opened it.
    if (transport.sessionId) sessionPeople.set(transport.sessionId, person)
    await transport.handleRequest(request, response, message)
    if (transport.sessionId) sessionPeople.set(transport.sessionId, person)
    return
  }
  response.writeHead(404).end()
}

const http = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    if (!response.headersSent) response.writeHead(500)
    response.end(String(error))
  })
})

beforeAll(async () => {
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})

afterAll(async () => {
  for (const transport of transports.values()) await transport.close()
  http.closeAllConnections()
  await new Promise(resolve => http.close(resolve))
})

afterEach(() => {
  vi.restoreAllMocks()
  resetConsoleMcp()
  installConsoleAccess({ mode: "open" })
  installConsoleOperations([])
})

/** Console RPC calls, as the person in `user` when the access checks sessions. Every body is kept to check for tokens. */
const responses: string[] = []
async function rpc<T>(operation: string, input: unknown = {}, user?: string, signal?: AbortSignal): Promise<{ status: number, value: T, failure?: { code: string, message: string } }> {
  const response = await handleConsoleRpcRequest(new Request(`${origin}/_vitehub/rpc/__call`, {
    body: JSON.stringify({ input, operation }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1", ...(user ? { "x-test-user": user } : {}) },
    method: "POST",
    signal,
  }))
  const text = await response.text()
  responses.push(text)
  const parsed = JSON.parse(text) as { code: string, message: string, ok: boolean, value: T }
  return { status: response.status, value: parsed.value, ...(parsed.ok ? {} : { failure: { code: parsed.code, message: parsed.message } }) }
}

/** Play the browser: open the authorization URL as `person` and return what the authorization server sent back. */
async function signIn(authorizationUrl: string, person: string): Promise<{ code: string, iss: string, state: string }> {
  const response = await fetch(authorizationUrl, { headers: { cookie: `person=${person}` }, redirect: "manual" })
  const back = new URL(response.headers.get("location")!)
  expect(back.origin + back.pathname).toBe(`${origin}/_vitehub/mcp-client/callback`)
  return { code: back.searchParams.get("code")!, iss: back.searchParams.get("iss")!, state: back.searchParams.get("state")! }
}

async function connectAs(person: string, options: { prompt?: "login", user?: string } = {}): Promise<ConsoleMcpConnection> {
  const started = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp", ...(options.prompt ? { prompt: options.prompt } : {}) }, options.user)
  expect(started.failure).toBeUndefined()
  expect(started.value.connection.status).toBe("authorizing")
  const completed = await rpc<ConsoleMcpConnection>("mcp-client.complete", await signIn(started.value.authorizationUrl!, person), options.user)
  expect(completed.failure).toBeUndefined()
  return completed.value
}

function install(): void {
  installConsoleOperations([{ operations: consoleMcpClientOperations, plugin: "vite-hub" }])
}

describe("MCP client section", () => {
  it("is a section only when console.mcpClient is on", () => {
    expect(isConsoleMcpClientEnabled({ auth: false, mcpClient: true })).toBe(true)
    expect(isConsoleMcpClientEnabled({ auth: "app" })).toBe(false)
    expect(resolveConsoleSectionIds({ console: { auth: false, mcpClient: true } })).toEqual(["mcp-client"])
    expect(resolveConsoleSectionIds({ agent: true, console: { auth: false, mcpClient: true }, workflow: false })).toEqual(["agents", "skills", "usage", "channels", "mcp-client"])
    expect(resolveConsoleSectionIds({ console: { auth: false } })).toEqual([])
  })

  it("loads the MCP client lazily only in apps that turn the section on", async () => {
    const { writeConsoleNitroPlugin } = await import("../src/console/plugin.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-mcp-client-"))
    try {
      const generated = async (sections: string[]) => {
        await writeConsoleNitroPlugin(join(root, "plugin.mjs"), root, sections, [], { agents: [], content: {} }, [])
        return readFile(join(root, "plugin.mjs"), "utf8")
      }
      const withMcp = await generated(["mcp-client"])
      expect(withMcp).toContain('import("vite-hub/console/mcp-client")')
      expect(withMcp).not.toMatch(/^import .* from "vite-hub\/console\/mcp-client"/m)
      expect(withMcp).toContain('installConsoleOperations([{ operations: vitehubConsoleMcpClientOperations, plugin: "vite-hub" }]')
      expect(await generated(["env"])).not.toContain("vite-hub/console/mcp-client")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("finds the app's own MCP server in its protected resource metadata", async () => {
    install()
    const overview = await rpc<ConsoleMcpOverview>("mcp-client.list")
    expect(overview.value).toEqual({ connections: [], servers: [{ authorizationServer: origin, label: "Test Finance", url: `${origin}/mcp` }], sharedSession: false })
  })

  it("preserves an MCP endpoint advertised at the app's root", async () => {
    install()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ resource: `${origin}/` }))
    const overview = await rpc<ConsoleMcpOverview>("mcp-client.list")
    expect(overview.value.servers).toEqual([{ label: "This app", url: `${origin}/` }])
  })

  it.each([
    { advertised: true, issuer: undefined, accepted: false },
    { advertised: true, issuer: "matching", accepted: true },
    { advertised: true, issuer: "https://another.example", accepted: false },
    { advertised: false, issuer: undefined, accepted: true },
    { advertised: false, issuer: "https://another.example", accepted: false },
  ])("validates the callback issuer before exchanging a code: %j", async ({ advertised, issuer, accepted }) => {
    install()
    const nativeFetch = globalThis.fetch
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init)
      const response = await nativeFetch(input, init)
      if (request.url === `${origin}/.well-known/oauth-authorization-server`) {
        return Response.json({ ...await response.json() as Record<string, unknown>, authorization_response_iss_parameter_supported: advertised })
      }
      return response
    })
    const started = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp" })
    const callback = await signIn(started.value.authorizationUrl!, "maxi")
    const grants = seen.grants.length
    const completed = await rpc<ConsoleMcpConnection>("mcp-client.complete", { ...callback, iss: issuer === "matching" ? origin : issuer })
    if (accepted) {
      expect(completed.failure).toBeUndefined()
      expect(completed.value.status).toBe("connected")
      expect(seen.grants).toHaveLength(grants + 1)
    }
    else {
      expect(completed.failure).toMatchObject({ code: "CONSOLE_MCP_AUTHORIZATION_FAILED" })
      expect(seen.grants).toHaveLength(grants)
    }
  })

  it.each([
    "http://external.example/authorize",
    "https://person:secret@oauth.example/authorize",
    "https://oauth.example/authorize#fragment",
  ])("rejects an unsafe authorization endpoint before returning it to the browser: %s", async (endpoint) => {
    install()
    const nativeFetch = globalThis.fetch
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init)
      const response = await nativeFetch(input, init)
      if (request.url === `${origin}/.well-known/oauth-authorization-server`) {
        return Response.json({ ...await response.json() as Record<string, unknown>, authorization_endpoint: endpoint })
      }
      return response
    })
    const started = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp" })
    expect(started.failure).toMatchObject({ code: "CONSOLE_MCP_AUTHORIZATION_FAILED" })
    expect(started.value?.authorizationUrl).toBeUndefined()
  })

  it("registers separately for two resources with different scopes at the same authorization server", async () => {
    install()
    const nativeFetch = globalThis.fetch
    const registrations: Record<string, unknown>[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init)
      if (request.url === `${origin}/register`) registrations.push(await request.json() as Record<string, unknown>)
      if (request.url === `${origin}/other-mcp`) {
        return new Response(null, { headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/other-mcp"` }, status: 401 })
      }
      const response = await nativeFetch(input, init)
      if (request.url === `${origin}/.well-known/oauth-protected-resource/other-mcp`) {
        return Response.json({ ...await response.json() as Record<string, unknown>, resource: `${origin}/other-mcp`, scopes_supported: ["other:read"] })
      }
      return response
    })
    const first = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp" })
    const second = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/other-mcp" })
    expect(first.failure).toBeUndefined()
    expect(second.failure).toBeUndefined()
    expect(new URL(second.value.authorizationUrl!).searchParams.get("scope")).toBe("other:read")
    expect(registrations.map(client => client.scope)).toEqual(["openid profile email", "other:read"])
  })

  it.each([
    "http://external.example/mcp",
    "https://person:secret@mcp.example/mcp",
    "https://mcp.example/mcp#fragment",
  ])("rejects an MCP redirect to %s before fetching it", async (target) => {
    install()
    const requests: Request[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(null, { headers: { location: target }, status: 307 })
    })
    const connected = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "https://mcp.example/mcp", token: "secret" })
    expect(connected.failure).toBeDefined()
    expect(requests.map(request => [request.url, request.redirect])).toEqual([["https://mcp.example/mcp", "manual"]])
  })

  it.each(["discovery", "token"])("rejects HTTPS to external HTTP redirects in OAuth %s traffic", async (stage) => {
    install()
    const nativeFetch = globalThis.fetch
    const redirected: Request[] = []
    const endpoint = `https://oauth.example/${stage === "discovery" ? ".well-known/oauth-authorization-server" : "token"}`
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init)
      if (request.url.startsWith("https://oauth.example/")) {
        redirected.push(request)
        return new Response(null, { headers: { location: "http://external.example/oauth" }, status: 307 })
      }
      // No test request may reach the external plaintext endpoint, even if discovery retries.
      expect(request.url).not.toBe("http://external.example/oauth")
      const response = await nativeFetch(input, init)
      if (stage === "discovery" && new URL(request.url).pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ ...await response.json() as Record<string, unknown>, authorization_servers: ["https://oauth.example"] })
      }
      if (stage === "token" && request.url === `${origin}/.well-known/oauth-authorization-server`) {
        return Response.json({ ...await response.json() as Record<string, unknown>, token_endpoint: endpoint })
      }
      return response
    })
    const started = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp" })
    if (stage === "token") {
      const completed = await rpc<ConsoleMcpConnection>("mcp-client.complete", await signIn(started.value.authorizationUrl!, "maxi"))
      expect(completed.failure).toBeDefined()
    }
    expect(redirected.some(request => request.url === endpoint)).toBe(true)
    expect(redirected.every(request => request.redirect === "manual")).toBe(true)
  })

  it("follows relative redirects while preserving an MCP POST body and bearer token", async () => {
    install()
    const nativeFetch = globalThis.fetch
    const redirected: Request[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init)
      if (request.url === `${origin}/mcp-redirect`) {
        redirected.push(request)
        return new Response(null, { headers: { location: "/mcp" }, status: 307 })
      }
      return nativeFetch(input, init)
    })
    const connected = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp-redirect", token: "fin_lucia" })
    expect(connected.failure).toBeUndefined()
    expect(connected.value.connection.status).toBe("connected")
    expect(redirected[0]!.method).toBe("POST")
    expect(redirected[0]!.headers.get("authorization")).toBe("Bearer fin_lucia")
    expect(await redirected[0]!.json()).toMatchObject({ method: "initialize" })
  })

  it.each([
    "http://external.example/revoke",
    "https://person:secret@oauth.example/revoke",
    "https://oauth.example/revoke#fragment",
  ])("rejects an OAuth revocation redirect to %s before fetching it", async (target) => {
    install()
    const nativeFetch = globalThis.fetch
    const redirected: Request[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init)
      if (request.url === "https://oauth.example/revoke") {
        redirected.push(request)
        return new Response(null, { headers: { location: target }, status: 307 })
      }
      // The invalid target must never be passed to fetch.
      expect(request.url).not.toBe(target)
      const response = await nativeFetch(input, init)
      if (request.url === `${origin}/.well-known/oauth-authorization-server`) {
        return Response.json({ ...await response.json() as Record<string, unknown>, revocation_endpoint: "https://oauth.example/revoke" })
      }
      return response
    })
    const connected = await connectAs("maxi")
    const disconnected = await rpc<{ revoked: boolean }>("mcp-client.disconnect", { id: connected.id })
    expect(disconnected.value.revoked).toBe(false)
    expect(redirected.map(request => request.redirect)).toEqual(["manual", "manual"])
  })

  it("bounds session deletion redirect loops", async () => {
    install()
    const connected = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp", token: "fin_lucia" })
    const nativeFetch = globalThis.fetch
    const redirected: Request[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init)
      if (request.method === "DELETE") {
        redirected.push(request)
        return new Response(null, { headers: { location: "/loop" }, status: 307 })
      }
      return nativeFetch(input, init)
    })
    const disconnected = await rpc<{ sessionEnded: boolean }>("mcp-client.disconnect", { id: connected.value.connection.id })
    expect(disconnected.value.sessionEnded).toBe(false)
    expect(redirected).toHaveLength(21)
    expect(redirected.every(request => request.redirect === "manual")).toBe(true)
  })

  it("does not forward a bearer token to another origin after a session deletion redirect", async () => {
    install()
    const connected = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp", token: "fin_lucia" })
    const forwarded: Request[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init)
      if (request.url === `${origin}/mcp`) return new Response(null, { headers: { location: "https://other.example/mcp" }, status: 307 })
      forwarded.push(request)
      return new Response(null, { status: 200 })
    })
    const disconnected = await rpc<{ sessionEnded: boolean }>("mcp-client.disconnect", { id: connected.value.connection.id })
    expect(disconnected.value.sessionEnded).toBe(true)
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]!.url).toBe("https://other.example/mcp")
    expect(forwarded[0]!.headers.has("authorization")).toBe(false)
  })

  it("keeps one deadline across redirect hops", async () => {
    install()
    const connected = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp", token: "fin_lucia" })
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
    const deadlines: number[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      deadlines.push(timeout.mock.calls.length)
      if (deadlines.length === 2) deadline.abort(new Error("Request deadline reached"))
      return new Response(null, { headers: { location: "/loop" }, status: 307 })
    })
    const disconnected = await rpc<{ sessionEnded: boolean }>("mcp-client.disconnect", { id: connected.value.connection.id })
    expect(disconnected.value.sessionEnded).toBe(false)
    expect(deadlines).toHaveLength(2)
    expect(deadlines[0]).toBe(deadlines[1])
  })

  it("says when the Console shares its session with the app's own sign-in", async () => {
    install()
    // With app Auth, signing in as someone else at an authorization server on this origin would switch the Console too.
    installConsoleAccess({ authBasePath: async () => "/api/auth", check: async () => undefined, mode: "auth", user: async () => ({ id: "admin-1" }) })
    expect((await rpc<ConsoleMcpOverview>("mcp-client.list")).value.sharedSession).toBe(true)
    installConsoleAccess({ check: async () => undefined, mode: "auth", user: async () => ({ id: "admin-1" }) })
    expect((await rpc<ConsoleMcpOverview>("mcp-client.list")).value.sharedSession).toBe(false)
  })

  it("signs in with OAuth as two people at once, each with their own token and MCP session", async () => {
    install()
    const registrations = seen.registrations
    const started = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp" })
    const authorization = new URL(started.value.authorizationUrl!)
    expect(authorization.origin + authorization.pathname).toBe(`${origin}/authorize`)
    expect(Object.fromEntries(authorization.searchParams)).toMatchObject({
      client_id: "client-1",
      code_challenge_method: "S256",
      redirect_uri: `${origin}/_vitehub/mcp-client/callback`,
      resource: `${origin}/mcp`,
      response_type: "code",
      scope: "openid profile email",
    })
    const maxi = (await rpc<ConsoleMcpConnection>("mcp-client.complete", await signIn(started.value.authorizationUrl!, "maxi"))).value
    expect(maxi).toMatchObject({ auth: "oauth", identity: { email: "maxi@example.com", name: "Maxi", subject: "user-maxi" }, label: "Maxi", sameOrigin: true, status: "connected" })
    expect(maxi.server).toMatchObject({ capabilities: { prompts: true, resources: true, tools: true }, instructions: "Read the household's money.", name: "test-finance", title: "Test Finance", version: "1.2.3" })
    expect(maxi.grant).toMatchObject({ issuer: origin, refreshable: true, scopes: ["openid", "profile", "email"] })
    expect(maxi.session).toHaveLength(8)

    const signInAgain = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { prompt: "login", server: "/mcp" })
    expect(new URL(signInAgain.value.authorizationUrl!).searchParams.get("prompt")).toBe("login")
    const lucia = (await rpc<ConsoleMcpConnection>("mcp-client.complete", await signIn(signInAgain.value.authorizationUrl!, "lucia"))).value
    expect(lucia).toMatchObject({ identity: { name: "Lucía" }, label: "Lucía", status: "connected" })
    // One client registration serves every sign-in with the same authorization server.
    expect(seen.registrations - registrations).toBe(1)

    const [asMaxi, asLucia] = await Promise.all([maxi, lucia].map(connection => rpc<ConsoleMcpOutcome>("mcp-client.call", { id: connection.id, tool: "whoami" })))
    expect(asMaxi!.value.result).toMatchObject({ content: [{ text: "Maxi", type: "text" }], structuredContent: { email: "maxi@example.com" } })
    expect(asLucia!.value.result).toMatchObject({ content: [{ text: "Lucía", type: "text" }] })
    expect(asMaxi!.value.durationMs).toBeGreaterThanOrEqual(0)
    expect(seen.sessions.size).toBeGreaterThanOrEqual(2)

    const listed = await rpc<ConsoleMcpOverview>("mcp-client.list")
    expect(listed.value.connections.map(connection => connection.label)).toEqual(["Maxi", "Lucía"])

    // The browser never gets a token.
    for (const token of issued) expect(responses.join("\n")).not.toContain(token)
  })

  it("lists tools, reads resources, gets prompts, and returns server errors as results", async () => {
    install()
    const maxi = await connectAs("maxi")
    const tools = await rpc<ConsoleMcpPage>("mcp-client.items", { id: maxi.id, kind: "tools" })
    expect(tools.value.items.map(tool => tool.name)).toEqual(["whoami", "echo"])
    expect(tools.value.items[0]).toMatchObject({ annotations: { readOnlyHint: true } })
    const resources = await rpc<ConsoleMcpPage>("mcp-client.items", { id: maxi.id, kind: "resources" })
    expect(resources.value.items).toEqual([{ mimeType: "text/markdown", name: "profile", uri: "profile://me" }])
    const resource = await rpc<ConsoleMcpOutcome>("mcp-client.read", { id: maxi.id, uri: "profile://me" })
    expect(resource.value.result).toMatchObject({ contents: [{ text: "# Maxi" }] })
    const prompt = await rpc<ConsoleMcpOutcome>("mcp-client.prompt", { arguments: { topic: "October" }, id: maxi.id, name: "summarize" })
    expect(prompt.value.result).toMatchObject({ messages: [{ content: { text: "Summarize October." }, role: "user" }] })
    const echo = await rpc<ConsoleMcpOutcome>("mcp-client.call", { arguments: { text: "hola" }, id: maxi.id, tool: "echo" })
    expect(echo.value.result).toMatchObject({ content: [{ text: "hola" }] })
    const unknown = await rpc<ConsoleMcpOutcome>("mcp-client.call", { id: maxi.id, tool: "missing" })
    expect(unknown.status).toBe(200)
    expect(unknown.value.error).toEqual({ code: ErrorCode.InvalidParams, message: "Unknown tool missing" })
  })

  it("refreshes a token that the server stops accepting, and starts a new session when the server forgets one", async () => {
    install()
    const maxi = await connectAs("maxi")
    for (const [token, person] of tokens) if (person === "maxi" && token.startsWith("at-")) seen.revoked.add(token)
    seen.grants.length = 0
    const tools = await rpc<ConsoleMcpPage>("mcp-client.items", { id: maxi.id, kind: "tools" })
    expect(tools.failure).toBeUndefined()
    expect(seen.grants).toEqual(["refresh_token"])
    for (const transport of transports.values()) await transport.close()
    transports.clear()
    const again = await rpc<ConsoleMcpOutcome>("mcp-client.call", { id: maxi.id, tool: "whoami" })
    expect(again.value.result).toMatchObject({ content: [{ text: "Maxi" }] })
  })

  it("serializes replacement loads after browser abort while other connections stay usable", async () => {
    install()
    const maxi = await connectAs("maxi")
    const lucia = (await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp", token: "fin_lucia" })).value.connection
    for (const [token, person] of tokens) if (person === "maxi" && token.startsWith("at-")) seen.revoked.add(token)
    const nativeFetch = globalThis.fetch
    const refreshTokens: string[] = []
    const refresh = deferred()
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init)
      const response = await nativeFetch(input, init)
      if (request.url === `${origin}/token`) {
        const form = new URLSearchParams(await request.text())
        if (form.get("grant_type") === "refresh_token") {
          refreshTokens.push(form.get("refresh_token")!)
          if (refreshTokens.length === 1) await refresh.promise
        }
      }
      return response
    })
    const controller = new AbortController()
    const first = rpc<ConsoleMcpPage>("mcp-client.items", { id: maxi.id, kind: "tools" }, undefined, controller.signal)
    let replacement: ReturnType<typeof rpc<ConsoleMcpPage>> | undefined
    try {
      await vi.waitFor(() => expect(refreshTokens).toHaveLength(1))
      controller.abort()
      replacement = rpc<ConsoleMcpPage>("mcp-client.items", { id: maxi.id, kind: "resources" })
      // A different account makes progress while the aborted browser's server operation is still active.
      const other = await rpc<ConsoleMcpPage>("mcp-client.items", { id: lucia.id, kind: "prompts" })
      expect(other.failure).toBeUndefined()
      refresh.resolve()
      const [original, replaced] = await Promise.all([first, replacement])
      expect(original.failure).toBeUndefined()
      expect(replaced.failure).toBeUndefined()
      expect(replaced.value.items).toMatchObject([{ name: "profile" }])
      expect(refreshTokens).toHaveLength(1)
      const again = await rpc<ConsoleMcpOutcome>("mcp-client.call", { id: maxi.id, tool: "whoami" })
      expect(again.value.result).toMatchObject({ content: [{ text: "Maxi" }] })
    }
    finally {
      refresh.resolve()
      await Promise.all([first, replacement])
    }
  })

  it("reserves a callback state while its single-use code is being exchanged", async () => {
    install()
    const started = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp" })
    const callback = await signIn(started.value.authorizationUrl!, "maxi")
    const nativeFetch = globalThis.fetch
    const exchange = deferred()
    let exchanges = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init)
      const response = await nativeFetch(input, init)
      if (request.url === `${origin}/token`) {
        exchanges++
        if (exchanges === 1) await exchange.promise
      }
      return response
    })
    const first = rpc<ConsoleMcpConnection>("mcp-client.complete", callback)
    try {
      await vi.waitFor(() => expect(exchanges).toBe(1))
      const duplicate = await rpc<ConsoleMcpConnection>("mcp-client.complete", callback)
      expect(duplicate.status).toBe(404)
      expect(exchanges).toBe(1)
      exchange.resolve()
      expect((await first).value.status).toBe("connected")
      expect((await rpc<ConsoleMcpOutcome>("mcp-client.call", { id: started.value.connection.id, tool: "whoami" })).value.result).toMatchObject({ content: [{ text: "Maxi" }] })
    }
    finally {
      exchange.resolve()
      await first
    }
  })

  it("marks a connection signed out when its grant is gone, and signs in again", async () => {
    install()
    const maxi = await connectAs("maxi")
    for (const [token, person] of tokens) if (person === "maxi") seen.revoked.add(token)
    const failed = await rpc<ConsoleMcpPage>("mcp-client.items", { id: maxi.id, kind: "tools" })
    expect(failed.failure).toMatchObject({ code: "CONSOLE_MCP_SIGNED_OUT" })
    expect((await rpc<ConsoleMcpOverview>("mcp-client.list")).value.connections[0]).toMatchObject({ error: "The server rejected the grant. Sign in again.", status: "signed-out" })
    const again = await rpc<ConsoleMcpConnectResult>("mcp-client.reconnect", { id: maxi.id })
    const completed = await rpc<ConsoleMcpConnection>("mcp-client.complete", await signIn(again.value.authorizationUrl!, "maxi"))
    expect(completed.value).toMatchObject({ id: maxi.id, status: "connected" })
  })

  it("revokes the tokens and ends the session on disconnect", async () => {
    install()
    const maxi = await connectAs("maxi")
    const disconnected = await rpc<{ revoked: boolean, sessionEnded: boolean }>("mcp-client.disconnect", { id: maxi.id })
    expect(disconnected.value).toEqual({ revoked: true, sessionEnded: true })
    expect([...seen.revoked].some(token => token.startsWith("rt-maxi"))).toBe(true)
    expect((await rpc<ConsoleMcpOverview>("mcp-client.list")).value.connections).toEqual([])
  })

  it("sends a pasted token as a bearer token, and refuses one the server rejects", async () => {
    install()
    const connected = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { label: "Lucía (API key)", server: `${origin}/mcp`, token: "fin_lucia" })
    expect(connected.value.authorizationUrl).toBeUndefined()
    expect(connected.value.connection).toMatchObject({ auth: "bearer", grant: { hint: "ucia", refreshable: false }, label: "Lucía (API key)", status: "connected" })
    const whoami = await rpc<ConsoleMcpOutcome>("mcp-client.call", { id: connected.value.connection.id, tool: "whoami" })
    expect(whoami.value.result).toMatchObject({ content: [{ text: "Lucía" }] })
    expect(responses.join("\n")).not.toContain("fin_lucia")
    const rejected = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp", token: "fin_nobody" })
    expect(rejected.failure).toEqual({ code: "CONSOLE_MCP_SIGNED_OUT", message: "The server rejected this token." })
    expect((await rpc<ConsoleMcpOverview>("mcp-client.list")).value.connections).toHaveLength(1)
  })

  it("keeps each person's connections and sign-ins to themselves", async () => {
    install()
    installConsoleAccess({
      check: async () => undefined,
      mode: "auth",
      user: async event => ({ id: event.req?.headers instanceof Headers ? event.req.headers.get("x-test-user") ?? "" : "" }),
    })
    const maxi = await connectAs("maxi", { user: "admin-1" })
    expect((await rpc<ConsoleMcpOverview>("mcp-client.list", {}, "admin-2")).value.connections).toEqual([])
    const call = await rpc<ConsoleMcpOutcome>("mcp-client.call", { id: maxi.id, tool: "whoami" }, "admin-2")
    expect(call.failure).toMatchObject({ code: "CONSOLE_NOT_FOUND" })
    const started = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "/mcp" }, "admin-1")
    const stolen = await rpc<ConsoleMcpConnection>("mcp-client.complete", await signIn(started.value.authorizationUrl!, "lucia"), "admin-2")
    expect(stolen.failure).toMatchObject({ code: "CONSOLE_MCP_AUTHORIZATION_FAILED" })
  })

  it("refuses plain HTTP to other hosts and unknown sign-ins", async () => {
    install()
    const insecure = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { server: "http://example.com/mcp" })
    expect(insecure.failure?.message).toBe("Use an HTTPS URL. Plain HTTP works only for this app and for localhost.")
    const unknown = await rpc<ConsoleMcpConnection>("mcp-client.complete", { code: "x", state: "never-started" })
    expect(unknown.failure).toMatchObject({ code: "CONSOLE_MCP_AUTHORIZATION_FAILED" })
  })
})
