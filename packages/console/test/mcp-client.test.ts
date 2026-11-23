import { createServer } from "node:http"
import { resolve } from "node:path"

import { createClient } from "@libsql/client"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from "vitest"

import { resetConsoleMcp } from "../src/mcp-client.ts"
import { databaseConsoleMcpRecords } from "../src/mcp-client-records.ts"
import { answerConsoleMcpCall, consoleMcpCallProject } from "../src/mcp-client-rpc.ts"
import { consoleOutboundFetch } from "../src/outbound-fetch.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type * as AppWire from "../../vite-hub/src/console/runtime/mcp-client.ts"
import type { ConsoleMcpScope, connectConsoleMcp, listConsoleMcp } from "../src/mcp-client.ts"
import type * as ConsoleWire from "../src/mcp-client-types.ts"

const secret = "s".repeat(64)
const redirectUrl = "https://console.example.com/mcp-client/callback"
const migrations = resolve(import.meta.dirname, "../server/databases/default/migrations")

let origin = ""
let requireOAuth = false
const grants = new Map<string, string>()
const sessions = new Map<string, StreamableHTTPServerTransport>()
let initializeRequests = 0
let otherOriginRequests = 0

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value))
}

function fixtureServer(person: string): Server {
  const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { description: "Repeat a text.", inputSchema: { properties: { text: { type: "string" } }, required: ["text"], type: "object" }, name: "echo" },
      { description: "Say who signed in.", inputSchema: { properties: {}, type: "object" }, name: "whoami" },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => ({
    content: [{ text: request.params.name === "whoami" ? person : String(request.params.arguments?.text), type: "text" }],
  }))
  return server
}

async function handleSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = request.method === "POST" ? JSON.parse(await readBody(request)) as unknown : undefined
  const id = request.headers["mcp-session-id"]
  let transport = typeof id === "string" ? sessions.get(id) : undefined
  if (!transport) {
    if (typeof id === "string") return json(response, 404, { error: "unknown_session" })
    initializeRequests++
    const created = new StreamableHTTPServerTransport({ onsessioninitialized: (sessionId) => { sessions.set(sessionId, created) }, sessionIdGenerator: () => crypto.randomUUID() })
    await fixtureServer("anyone").connect(created)
    transport = created
  }
  await transport.handleRequest(request, response, body)
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", origin)
  if (request.headers.host?.startsWith("localhost:")) otherOriginRequests++
  if (url.pathname === "/moved") return void response.writeHead(307, { location: `http://localhost:${url.port}/revoke` }).end()
  if (url.pathname === "/session-mcp") return handleSession(request, response)
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(response, 200, { authorization_servers: [origin], resource: `${origin}/mcp`, resource_name: "Fixture" })
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json(response, 200, {
      authorization_endpoint: `${origin}/authorize`,
      code_challenge_methods_supported: ["S256"],
      issuer: origin,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      revocation_endpoint: `${origin}/moved`,
      token_endpoint: `${origin}/token`,
      token_endpoint_auth_methods_supported: ["none"],
    })
  }
  if (url.pathname === "/register") {
    const registration: unknown = JSON.parse(await readBody(request))
    return json(response, 201, { ...Object(registration), client_id: "client-1" })
  }
  if (url.pathname === "/token") {
    const form = new URLSearchParams(await readBody(request))
    const person = form.get("grant_type") === "authorization_code" ? grants.get(form.get("code") ?? "") : undefined
    if (!person || !form.get("code_verifier") || form.get("redirect_uri") !== redirectUrl) return json(response, 400, { error: "invalid_grant" })
    grants.set(`token-${person}`, person)
    return json(response, 200, { access_token: `token-${person}`, expires_in: 3_600, token_type: "Bearer" })
  }
  if (url.pathname !== "/mcp") return json(response, 404, { error: "not_found" })
  const bearer = request.headers.authorization?.replace(/^Bearer /, "")
  const person = bearer ? grants.get(bearer) ?? (bearer === "pasted-token" ? "pasted" : undefined) : requireOAuth ? undefined : "anyone"
  if (!person) return json(response, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await fixtureServer(person).connect(transport)
  const body = request.method === "POST" ? JSON.parse(await readBody(request)) as unknown : undefined
  await transport.handleRequest(request, response, body)
}

const http = createServer((request, response) => {
  handle(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500).end()
  })
})

beforeAll(async () => {
  await new Promise<void>(done => http.listen(0, "127.0.0.1", done))
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>(done => http.close(() => done())))

afterEach(async () => {
  requireOAuth = false
  grants.clear()
  initializeRequests = 0
  otherOriginRequests = 0
  await Promise.all(Array.from(sessions.values(), transport => transport.close()))
  sessions.clear()
  resetConsoleMcp()
})

async function database() {
  const client = createClient({ url: ":memory:" })
  const db = drizzle({ client })
  await migrate(db, { migrationsFolder: migrations })
  await client.execute("PRAGMA foreign_keys = ON")
  await client.execute("INSERT INTO organization (id, name, slug, created_at) VALUES ('team-1', 'Team', 'team', 0)")
  for (const id of ["user-1", "user-2"]) await client.execute({ args: [id, `${id}@example.com`], sql: "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Person', ?, 1, 0, 0)" })
  for (const id of ["project-1", "project-2"]) await client.execute({ args: [id, `https://${id}.example.com`], sql: "INSERT INTO console_projects (id, team_id, url, key_sealed, public_key, created_by, created_at) VALUES (?, 'team-1', ?, 'sealed', 'public', 'user-1', 0)" })
  return { client, db }
}

function scopeOf(db: Awaited<ReturnType<typeof database>>["db"], overrides: Partial<ConsoleMcpScope> = {}): ConsoleMcpScope {
  return { allowPrivate: true, appOrigin: origin, fetch, projectId: "project-1", records: databaseConsoleMcpRecords(db, secret), redirectUrl, userId: "user-1", ...overrides }
}

let calls = 0
async function call(scope: ConsoleMcpScope, name: string, input: unknown) {
  const reply = await answerConsoleMcpCall({ a: [input], i: String(++calls), m: name, t: "q" }, scope)
  if ("e" in reply) return { error: reply.e }
  return { value: reply.r }
}

function valueOf(result: { value?: unknown, error?: unknown }): Record<string, unknown> {
  if (!(result.value instanceof Object)) throw new Error(`The call failed: ${JSON.stringify(result.error)}`)
  return Object(result.value)
}

describe("Console MCP client", () => {
  it("connects to an MCP server from the Console server, lists its tools, and calls one", async () => {
    const { client, db } = await database()
    const scope = scopeOf(db)
    const connected = valueOf(await call(scope, "mcp-client.connect", { server: "/mcp", token: "pasted-token" }))
    const connection = Object(connected.connection)
    expect(connection).toMatchObject({ auth: "bearer", sameOrigin: true, status: "connected", url: `${origin}/mcp` })
    const tools = valueOf(await call(scope, "mcp-client.items", { id: connection.id, kind: "tools" }))
    expect(Array.from(Object(tools.items), item => Object(item).name)).toEqual(["echo", "whoami"])
    const echoed = valueOf(await call(scope, "mcp-client.call", { arguments: { text: "hello" }, id: connection.id, tool: "echo" }))
    expect(echoed.result).toMatchObject({ content: [{ text: "hello", type: "text" }] })
    const { rows } = await client.execute("SELECT user_id, project_id, sealed FROM console_mcp_connections")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ project_id: "project-1", user_id: "user-1" })
    expect(String(rows[0]!.sealed)).not.toContain("pasted-token")
    expect(String(rows[0]!.sealed)).not.toContain("127.0.0.1")
  })

  it("starts the OAuth sign-in with the callback on the Console origin and finishes it on the Console server", async () => {
    requireOAuth = true
    const { db } = await database()
    const scope = scopeOf(db)
    const started = valueOf(await call(scope, "mcp-client.connect", { server: `${origin}/mcp` }))
    const authorization = new URL(String(started.authorizationUrl))
    expect(authorization.origin + authorization.pathname).toBe(`${origin}/authorize`)
    expect(authorization.searchParams.get("redirect_uri")).toBe(redirectUrl)
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256")
    expect(Object(started.connection)).toMatchObject({ auth: "oauth", status: "authorizing" })
    grants.set("code-1", "Lucía")
    const state = authorization.searchParams.get("state")
    const other = await call(scopeOf(db, { userId: "user-2" }), "mcp-client.complete", { code: "code-1", state })
    expect(other.error).toMatchObject({ code: "CONSOLE_MCP_AUTHORIZATION_FAILED", status: 404 })
    const finished = valueOf(await call(scope, "mcp-client.complete", { code: "code-1", state }))
    expect(finished).toMatchObject({ auth: "oauth", status: "connected" })
    const answer = valueOf(await call(scope, "mcp-client.call", { id: finished.id, tool: "whoami" }))
    expect(answer.result).toMatchObject({ content: [{ text: "Lucía", type: "text" }] })
  })

  it("finishes a sign-in on the project in its state, when the browser opened another project since", async () => {
    requireOAuth = true
    const { db } = await database()
    const started = valueOf(await call(scopeOf(db), "mcp-client.connect", { server: `${origin}/mcp` }))
    const state = new URL(String(started.authorizationUrl)).searchParams.get("state")
    grants.set("code-2", "Lucía")
    const body = { a: [{ code: "code-2", state }], i: "complete", m: "mcp-client.complete", t: "q" }
    expect(consoleMcpCallProject(body, "project-2")).toBe("project-1")
    expect(consoleMcpCallProject({ ...body, m: "mcp-client.list" }, "project-2")).toBe("project-2")
    expect(await answerConsoleMcpCall(body, scopeOf(db, { projectId: consoleMcpCallProject(body, "project-2") }))).toMatchObject({ r: { status: "connected" } })
  })

  it("opens a new MCP session for each operation, so request ids never repeat in a session", async () => {
    const { db } = await database()
    const scope = scopeOf(db)
    const connection = Object(valueOf(await call(scope, "mcp-client.connect", { server: "/session-mcp" })).connection)
    valueOf(await call(scope, "mcp-client.items", { id: connection.id, kind: "tools" }))
    valueOf(await call(scope, "mcp-client.call", { arguments: { text: "hello" }, id: connection.id, tool: "echo" }))
    expect(initializeRequests).toBe(3)
  })

  it("does not send the token to another origin when the revocation endpoint redirects", async () => {
    requireOAuth = true
    const { db } = await database()
    const scope = scopeOf(db)
    const started = valueOf(await call(scope, "mcp-client.connect", { server: `${origin}/mcp` }))
    grants.set("code-3", "Lucía")
    const finished = valueOf(await call(scope, "mcp-client.complete", { code: "code-3", state: new URL(String(started.authorizationUrl)).searchParams.get("state") }))
    expect(valueOf(await call(scope, "mcp-client.disconnect", { id: finished.id }))).toMatchObject({ revoked: false })
    expect(otherOriginRequests).toBe(0)
  })

  it("refuses a private address when it connects, not only by host name", async () => {
    const metadata = `http://localhost:${new URL(origin).port}/.well-known/oauth-protected-resource`
    await expect(consoleOutboundFetch(false)(metadata)).rejects.toMatchObject({ cause: { message: expect.stringContaining("private address") } })
    expect((await consoleOutboundFetch(true)(metadata)).ok).toBe(true)
  })

  it("keeps each person's connections to their own project", async () => {
    const { db } = await database()
    const connection = Object(valueOf(await call(scopeOf(db), "mcp-client.connect", { server: "/mcp" })).connection)
    for (const scope of [scopeOf(db, { userId: "user-2" }), scopeOf(db, { projectId: "project-2" })]) {
      expect(valueOf(await call(scope, "mcp-client.list", {}))).toMatchObject({ connections: [], sharedSession: false })
      expect((await call(scope, "mcp-client.call", { id: connection.id, tool: "echo" })).error).toMatchObject({ code: "CONSOLE_NOT_FOUND", status: 404 })
    }
    const listed = valueOf(await call(scopeOf(db), "mcp-client.list", {}))
    expect(Array.from(Object(listed.connections), item => Object(item).id)).toEqual([connection.id])
  })

  it("refuses private hosts unless the Console allows them, and refuses unknown operations and bad input", async () => {
    const { db } = await database()
    const scope = scopeOf(db, { allowPrivate: false })
    expect((await call(scope, "mcp-client.connect", { server: `${origin}/mcp` })).error).toMatchObject({ code: "CONSOLE_REQUEST_INVALID", status: 400 })
    expect((await call(scope, "mcp-client.connect", { server: "http://example.com/mcp" })).error).toMatchObject({ code: "CONSOLE_REQUEST_INVALID", status: 400 })
    expect((await call(scope, "mcp-client.connect", { server: "https://user:pass@example.com/mcp" })).error).toMatchObject({ code: "CONSOLE_REQUEST_INVALID", status: 400 })
    expect((await call(scope, "mcp-client.connect", {})).error).toMatchObject({ code: "CONSOLE_REQUEST_INVALID", status: 400 })
    expect((await call(scope, "toString", {})).error).toMatchObject({ code: "CONSOLE_NOT_FOUND", status: 404 })
    expect(await answerConsoleMcpCall({ m: "mcp-client.list" }, scope)).toMatchObject({ e: { code: "CONSOLE_REQUEST_INVALID", status: 400 } })
  })
})

describe("Console MCP wire types", () => {
  it("match the types that the MCP client section of the Console page reads", () => {
    expectTypeOf<ConsoleWire.ConsoleMcpConnection>().toEqualTypeOf<AppWire.ConsoleMcpConnection>()
    expectTypeOf<ConsoleWire.ConsoleMcpOverview>().toEqualTypeOf<AppWire.ConsoleMcpOverview>()
    expectTypeOf<ConsoleWire.ConsoleMcpConnectResult>().toEqualTypeOf<AppWire.ConsoleMcpConnectResult>()
    expectTypeOf<ConsoleWire.ConsoleMcpOutcome>().toEqualTypeOf<AppWire.ConsoleMcpOutcome>()
    expectTypeOf<ConsoleWire.ConsoleMcpPage>().toEqualTypeOf<AppWire.ConsoleMcpPage>()
    expectTypeOf<Awaited<ReturnType<typeof listConsoleMcp>>>().toEqualTypeOf<AppWire.ConsoleMcpOverview>()
    expectTypeOf<Awaited<ReturnType<typeof connectConsoleMcp>>>().toEqualTypeOf<AppWire.ConsoleMcpConnectResult>()
  })
})

describe("Console MCP records", () => {
  it("open only with the same secret and in the row they were sealed for", async () => {
    const { client, db } = await database()
    const records = databaseConsoleMcpRecords(db, secret)
    const base = { auth: "bearer" as const, bearer: "secret-token", createdAt: 1, label: "A", labelled: true, projectId: "project-1", sameOrigin: false, status: "connected" as const, url: "https://mcp.example.com/mcp", userId: "user-1" }
    await records.save({ ...base, id: "mcp_a" })
    await records.save({ ...base, id: "mcp_b" })
    await expect(records.connection("user-1", "project-1", "mcp_a")).resolves.toMatchObject({ bearer: "secret-token", id: "mcp_a" })
    await expect(databaseConsoleMcpRecords(db, "t".repeat(64)).connection("user-1", "project-1", "mcp_a")).resolves.toBeUndefined()
    await client.execute("UPDATE console_mcp_connections SET sealed = (SELECT sealed FROM console_mcp_connections WHERE id = 'mcp_a') WHERE id = 'mcp_b'")
    await expect(records.connection("user-1", "project-1", "mcp_b")).resolves.toBeUndefined()
    await records.saveClient("issuer\nredirect\nserver", { client_id: "client-1" })
    await expect(records.client("issuer\nredirect\nserver")).resolves.toEqual({ client_id: "client-1" })
    const { rows } = await client.execute("SELECT id FROM console_mcp_clients")
    expect(String(rows[0]!.id)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("drop a stale save, and do not bring back a disconnected connection", async () => {
    const { client, db } = await database()
    const records = databaseConsoleMcpRecords(db, secret)
    await records.save({ auth: "bearer", bearer: "old-token", createdAt: 1, id: "mcp_a", label: "A", labelled: true, projectId: "project-1", sameOrigin: false, status: "connected", url: "https://mcp.example.com/mcp", userId: "user-1" })
    const first = (await records.connection("user-1", "project-1", "mcp_a"))!
    const stale = (await records.connection("user-1", "project-1", "mcp_a"))!
    first.bearer = "rotated-token"
    await records.save(first)
    stale.label = "Stale"
    await records.save(stale)
    await expect(records.connection("user-1", "project-1", "mcp_a")).resolves.toMatchObject({ bearer: "rotated-token", label: "A" })
    await records.remove(first)
    await records.save(first)
    expect((await client.execute("SELECT id FROM console_mcp_connections")).rows).toHaveLength(0)
  })
})
