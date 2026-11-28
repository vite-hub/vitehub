import { createServer } from "node:http"
import { resolve } from "node:path"

import { createClient } from "@libsql/client"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest"

import { resetConsoleMcp } from "../src/mcp-client.ts"
import { databaseConsoleMcpRecords } from "../src/mcp-client-records.ts"
import { answerConsoleMcpCall, consoleMcpCompletionProject, readConsoleMcpRequest } from "../src/mcp-client-rpc.ts"
import { consoleOutboundFetch } from "../src/outbound-fetch.ts"
import { memberConsoleProject } from "../src/projects.ts"

const session = vi.hoisted(() => ({ db: undefined as unknown, team: "team-1", user: "user-1" }))
vi.mock("vite-hub/database", () => ({ useDatabase: () => ({ db: session.db }) }))
vi.mock("vite-hub/auth/server", () => ({
  withAuthorization: (_required: boolean, handler: (request: Request, authorization: unknown) => Promise<Response>) => (request: Request) =>
    handler(request, { session: { activeOrganizationId: session.team }, user: { email: `${session.user}@example.com`, id: session.user, name: "Person" } }),
}))
vi.mock("#console-outbound-fetch", () => ({ consoleOutboundFetch: () => fetch }))
const { default: mcpRoute } = await import("../server/routes/p/[id]/mcp-client.ts")

import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type * as AppWire from "../../vite-hub/src/console/runtime/mcp-client.ts"
import type { ConsoleMcpScope, completeConsoleMcp, connectConsoleMcp, listConsoleMcp } from "../src/mcp-client.ts"
import type { ConsoleMcpRecords } from "../src/mcp-client-records.ts"
import type * as ConsoleWire from "../src/mcp-client-types.ts"

const secret = "s".repeat(64)
const redirectUrl = "https://console.example.com/mcp-client/callback"
const migrations = resolve(import.meta.dirname, "../server/databases/default/migrations")

let origin = ""
let requireOAuth = false
let toolPages = 2
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
  const tools = [
    { description: "Repeat a text.", inputSchema: { properties: { text: { type: "string" as const } }, required: ["text"], type: "object" as const }, name: "echo" },
    { description: "Say who signed in.", inputSchema: { properties: {}, type: "object" as const }, name: "whoami" },
  ]
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const sessionId = extra.sessionId
    if (!sessionId) return { tools }
    const cursor = request.params?.cursor
    if (cursor && !cursor.startsWith(`${sessionId}:`)) throw new McpError(ErrorCode.InvalidParams, "The cursor belongs to another session.")
    const page = cursor ? Number(cursor.slice(sessionId.length + 1)) : 0
    const tool = tools[page] ?? { ...tools[1], name: `tool-${page + 1}` }
    return { tools: [tool], ...(page + 1 < toolPages ? { nextCursor: `${sessionId}:${page + 1}` } : {}) }
  })
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
    const created = new StreamableHTTPServerTransport({ onsessionclosed: (sessionId) => { sessions.delete(sessionId) }, onsessioninitialized: (sessionId) => { sessions.set(sessionId, created) }, sessionIdGenerator: () => crypto.randomUUID() })
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
  toolPages = 2
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
  return { allowPrivate: true, appOrigin: origin, fetch, projectId: "project-1", records: databaseConsoleMcpRecords(db, secret), redirectUrl, teamId: "team-1", userId: "user-1", ...overrides }
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
    expect(finished).toMatchObject({ connection: { auth: "oauth", status: "connected" }, teamId: "team-1" })
    const answer = valueOf(await call(scope, "mcp-client.call", { id: Object(finished.connection).id, tool: "whoami" }))
    expect(answer.result).toMatchObject({ content: [{ text: "Lucía", type: "text" }] })
  })

  it("reads the project of a sign-in from its state, and no project for other calls", () => {
    const body = { a: [{ code: "code-2", state: "project-1.abc" }], i: "complete", m: "mcp-client.complete", t: "q" }
    expect(consoleMcpCompletionProject(body)).toBe("project-1")
    expect(consoleMcpCompletionProject({ ...body, a: [{ state: "abc" }] })).toBe("")
    expect(consoleMcpCompletionProject({ ...body, m: "mcp-client.list" })).toBeUndefined()
  })

  describe("POST /p/<id>/mcp-client", () => {
    async function signInStartedInTeamOne() {
      requireOAuth = true
      const { client, db } = await database()
      session.db = db
      await client.execute("INSERT INTO organization (id, name, slug, created_at) VALUES ('team-2', 'Other', 'other', 0), ('team-3', 'Empty', 'empty', 0)")
      await client.execute("INSERT INTO console_projects (id, team_id, url, key_sealed, public_key, created_by, created_at) VALUES ('project-3', 'team-2', 'https://project-3.example.com', 'sealed', 'public', 'user-1', 0)")
      await client.execute("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m-1', 'team-1', 'user-1', 'member', 0), ('m-2', 'team-2', 'user-1', 'owner', 0), ('m-3', 'team-3', 'user-1', 'owner', 0), ('m-4', 'team-2', 'user-2', 'owner', 0)")
      const started = valueOf(await call(scopeOf(db), "mcp-client.connect", { server: `${origin}/mcp` }))
      const state = new URL(String(started.authorizationUrl)).searchParams.get("state")
      grants.set("code-2", "Lucía")
      return { client, state }
    }

    function complete(project: string, state: string | null) {
      return mcpRoute.fetch(new Request(`https://console.example.com/p/${project}/mcp-client`, {
        body: JSON.stringify({ a: [{ code: "code-2", state }], i: "complete", m: "mcp-client.complete", t: "q" }),
        headers: { "content-type": "application/json", "x-vitehub-console": "1" },
        method: "POST",
      }))
    }

    beforeAll(() => {
      vi.stubEnv("VITEHUB_CONSOLE_SECRET", secret)
      vi.stubEnv("VITEHUB_CONSOLE_ALLOW_PRIVATE", "true")
    })
    afterAll(() => vi.unstubAllEnvs())
    afterEach(() => {
      session.team = "team-1"
      session.user = "user-1"
    })

    it.each([
      ["a team with a ready app", "team-2", "project-3"],
      ["a team without apps", "team-3", "project-1"],
    ])("finishes a sign-in that started in team 1 after a switch to %s, and names team 1", async (_name, team, routeProject) => {
      const { client, state } = await signInStartedInTeamOne()
      session.team = team
      const response = await complete(routeProject, state)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ r: { connection: { auth: "oauth", status: "connected" }, teamId: "team-1" } })
      const { rows } = await client.execute("SELECT project_id FROM console_mcp_connections")
      expect(rows).toEqual([expect.objectContaining({ project_id: "project-1" })])
    })

    it("refuses the state to a person who is not a member of its project, and does not use it up", async () => {
      const { state } = await signInStartedInTeamOne()
      session.user = "user-2"
      session.team = "team-2"
      const refused = await complete("project-1", state)
      expect(refused.status).toBe(404)
      expect(await refused.json()).toMatchObject({ code: "CONSOLE_PROJECT_NOT_FOUND" })
      session.user = "user-1"
      expect((await complete("project-1", state)).status).toBe(200)
    })

    it("refuses a state of a project that the person can open but did not start the sign-in on", async () => {
      const { client, state } = await signInStartedInTeamOne()
      await client.execute("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m-5', 'team-1', 'user-2', 'member', 0)")
      session.user = "user-2"
      const refused = await complete("project-1", state)
      expect(refused.status).toBe(404)
      expect(await refused.json()).toMatchObject({ e: { code: "CONSOLE_MCP_AUTHORIZATION_FAILED" } })
    })

    it("refuses a state without a project instead of finishing it on the project of the route", async () => {
      await signInStartedInTeamOne()
      expect((await complete("project-1", "no-project")).status).toBe(404)
    })
  })

  it("finds the project of a sign-in state through the person's membership of its team, not the open team", async () => {
    const { client, db } = await database()
    await client.execute("INSERT INTO organization (id, name, slug, created_at) VALUES ('team-2', 'Other', 'other', 0)")
    await client.execute("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m-1', 'team-1', 'user-1', 'member', 0), ('m-2', 'team-2', 'user-1', 'owner', 0), ('m-3', 'team-2', 'user-2', 'owner', 0)")
    await expect(memberConsoleProject(db, "user-1", "project-1")).resolves.toMatchObject({ id: "project-1", teamId: "team-1" })
    await expect(memberConsoleProject(db, "user-2", "project-1")).resolves.toBeUndefined()
    await expect(memberConsoleProject(db, "user-1", "project-3")).resolves.toBeUndefined()
  })

  it("does not return a sign-in URL whose state another request overwrote", async () => {
    requireOAuth = true
    const { db } = await database()
    const records = databaseConsoleMcpRecords(db, secret)
    const started = valueOf(await call(scopeOf(db), "mcp-client.connect", { server: `${origin}/mcp` }))
    const id = String(Object(started.connection).id)
    let raced = false
    const racing: ConsoleMcpRecords = {
      ...records,
      save: async (connection) => {
        if (!raced) {
          raced = true
          const other = (await records.connection("user-1", "project-1", id))!
          other.error = "Changed by another request."
          await records.save(other)
        }
        return records.save(connection)
      },
    }
    const reconnected = await call(scopeOf(db, { records: racing }), "mcp-client.reconnect", { id, prompt: "login" })
    expect(reconnected).toEqual({ error: expect.objectContaining({ code: "CONSOLE_CONFLICT", status: 409 }) })
    expect(raced).toBe(true)
    const stored = await records.connection("user-1", "project-1", id)
    expect(stored?.error).toBe("Changed by another request.")
  })

  it("reads all pages in one MCP session, and ends the session after the operation", async () => {
    const { db } = await database()
    const scope = scopeOf(db)
    const connection = Object(valueOf(await call(scope, "mcp-client.connect", { server: "/session-mcp" })).connection)
    expect(sessions.size).toBe(0)
    const tools = valueOf(await call(scope, "mcp-client.items", { id: connection.id, kind: "tools" }))
    expect(Array.from(Object(tools.items), item => Object(item).name)).toEqual(["echo", "whoami"])
    expect(Object.keys(tools)).toEqual(["connection", "items"])
    expect(sessions.size).toBe(0)
    expect(valueOf(await call(scope, "mcp-client.disconnect", { id: connection.id }))).toEqual({ revoked: false, sessionEnded: false })
    expect(sessions.size).toBe(0)
  })

  it("returns all items of a list of 20 pages, and refuses a list of 21 pages instead of a part of it", async () => {
    const { db } = await database()
    const scope = scopeOf(db)
    const connection = Object(valueOf(await call(scope, "mcp-client.connect", { server: "/session-mcp" })).connection)
    toolPages = 20
    const tools = valueOf(await call(scope, "mcp-client.items", { id: connection.id, kind: "tools" }))
    expect(Array.from(Object(tools.items), item => Object(item).name)).toEqual(["echo", "whoami", ...Array.from({ length: 18 }, (_, index) => `tool-${index + 3}`)])
    expect(Object.keys(tools)).toEqual(["connection", "items"])
    toolPages = 21
    expect(await call(scope, "mcp-client.items", { id: connection.id, kind: "tools" })).toEqual({ error: expect.objectContaining({ code: "CONSOLE_MCP_LIST_TOO_LONG", status: 502 }) })
    expect(sessions.size).toBe(0)
    expect(await call(scope, "mcp-client.items", { cursor: "next", id: connection.id, kind: "tools" })).toEqual({ error: expect.objectContaining({ code: "CONSOLE_REQUEST_INVALID" }) })
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
    expect(valueOf(await call(scope, "mcp-client.disconnect", { id: Object(finished.connection).id }))).toMatchObject({ revoked: false })
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

describe("readConsoleMcpRequest", () => {
  it("reads a body under the limit, and stops reading and cancels a larger one", async () => {
    const post = (body: string | null) => new Request("https://console.example.com/p/abc/mcp-client", { body, method: "POST" })
    expect(await readConsoleMcpRequest(post("{\"m\":\"ö\"}"), 12)).toBe("{\"m\":\"ö\"}")
    expect(await readConsoleMcpRequest(post(null))).toBe("")
    let pulls = 0
    let cancelled = false
    const endless = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true },
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(1_024)) },
    })
    expect(await readConsoleMcpRequest(new Request("https://console.example.com/p/abc/mcp-client", { body: endless, duplex: "half", method: "POST" } as RequestInit), 4 * 1_024)).toBeUndefined()
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(10)
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
    expectTypeOf<ConsoleWire.ConsoleMcpCompletion>().toEqualTypeOf<AppWire.ConsoleMcpCompletion>()
    expectTypeOf<Awaited<ReturnType<typeof completeConsoleMcp>>>().toEqualTypeOf<AppWire.ConsoleMcpCompletion>()
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
