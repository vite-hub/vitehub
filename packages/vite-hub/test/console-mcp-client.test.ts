import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
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
const seen = { grants: [] as string[], registeredScopes: [] as unknown[], registrations: 0, revoked: new Set<string>(), sessions: new Set<string>() }
const codes = new Map<string, { challenge: string, person: string, redirectUri: string, resource: string | null }>()
const tokens = new Map<string, string>()
const issued: string[] = []
let origin = ""
/** Whether the authorization server lists `offline_access`, as Better Auth does. */
let offersOfflineAccess = false
let resourceScopes: string[] | undefined = ["openid", "profile", "email"]

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
    return json(response, 200, { authorization_servers: [origin], resource: `${origin}/mcp`, resource_name: "Test Finance", ...(resourceScopes ? { scopes_supported: resourceScopes } : {}) })
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
      ...(offersOfflineAccess ? { scopes_supported: ["openid", "profile", "email", "offline_access"] } : {}),
      token_endpoint: `${origin}/token`,
      token_endpoint_auth_methods_supported: ["none"],
    })
  }
  if (url.pathname === "/register") {
    seen.registrations++
    const registration: Record<string, unknown> = JSON.parse(await body(request))
    seen.registeredScopes.push(registration.scope)
    return json(response, 201, { ...registration, client_id: "client-1" })
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
  offersOfflineAccess = false
  resourceScopes = ["openid", "profile", "email"]
  resetConsoleMcp()
  installConsoleAccess({ mode: "open" })
  installConsoleOperations([])
})

/** Console RPC calls, as the person in `user` when the access checks sessions. Every body is kept to check for tokens. */
const responses: string[] = []
async function rpc<T>(operation: string, input: unknown = {}, user?: string): Promise<{ status: number, value: T, failure?: { code: string, message: string } }> {
  const response = await handleConsoleRpcRequest(new Request(`${origin}/_vitehub/rpc/__call`, {
    body: JSON.stringify({ input, operation }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1", ...(user ? { "x-test-user": user } : {}) },
    method: "POST",
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
    expect(resolveConsoleSectionIds({ agent: true, console: { auth: false, mcpClient: true }, workflow: false })).toEqual(["agents", "usage", "channels", "mcp-client"])
    expect(resolveConsoleSectionIds({ console: { auth: false } })).toEqual([])
  })

  it("bundles the MCP client only into apps that turn the section on", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-mcp-client-"))
    try {
      const generated = async (sections: string[]) => {
        await writeConsoleNitroPlugin(join(root, "plugin.mjs"), root, sections, [], { agents: [], content: {} }, [])
        return readFile(join(root, "plugin.mjs"), "utf8")
      }
      const withMcp = await generated(["mcp-client"])
      expect(withMcp).toContain('import { consoleMcpClientOperations as vitehubConsoleMcpClientOperations } from "vite-hub/console/mcp-client"')
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

  it.each([
    { name: "lists scopes", scopes: ["openid", "profile", "email"], expected: "openid profile email offline_access" },
    { name: "omits scopes", scopes: undefined, expected: "offline_access" },
    { name: "lists no scopes", scopes: [], expected: "offline_access" },
  ])("asks for offline_access when the authorization server offers it and the resource $name", async ({ scopes, expected }) => {
    install()
    offersOfflineAccess = true
    resourceScopes = scopes
    const registered = seen.registeredScopes.length
    const started = await rpc<ConsoleMcpConnectResult>("mcp-client.connect", { prompt: "login", server: "/mcp" })
    const authorization = new URL(started.value.authorizationUrl!).searchParams
    expect(authorization.get("scope")).toBe(expected)
    // OpenID Connect asks for consent with offline_access. The Console keeps its own prompt.
    expect(authorization.getAll("prompt")).toEqual(["login consent"])
    // Better Auth allows only the scopes of the registration, so the registration asks for offline_access too.
    expect(seen.registeredScopes.slice(registered)).toEqual([expected])
    const connection = (await rpc<ConsoleMcpConnection>("mcp-client.complete", await signIn(started.value.authorizationUrl!, "maxi"))).value
    expect(connection).toMatchObject({ grant: { refreshable: true }, status: "connected" })
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
