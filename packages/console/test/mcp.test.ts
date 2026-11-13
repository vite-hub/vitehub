import { createHash, randomBytes } from "node:crypto"
import { resolve } from "node:path"

import { createClient } from "@libsql/client"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { organization } from "better-auth/plugins"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { migrate as migrateDatabase } from "drizzle-orm/libsql/migrator"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { authSqliteSchema } from "vite-hub/auth/schema"
import { mcpOAuth, serveMcpOAuthDiscovery, verifyMcpRequest } from "vite-hub/auth/mcp"
import { createMcpHandler } from "@vite-hub/mcp/runtime"
import { readConsolePublicKeys, verifyConsoleSignature } from "@vite-hub/internal/console-signature"

import { consoleSchema } from "../src/projects.ts"
import { operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"

import type { ConsoleCaller } from "@vite-hub/internal/console-signature"
import type { McpOAuthAuth } from "vite-hub/auth/mcp"
import type { McpToolDefinition } from "vite-hub/mcp"
import type { H3Event } from "h3"

// The Console's tools read the Console Database with `useDatabase()`. The test gives them an in-memory one.
const state = vi.hoisted(() => ({ db: undefined as unknown }))
vi.mock("vite-hub/database", () => ({ useDatabase: () => ({ db: state.db }) }))

const origin = "https://console.example.com"
const resource = `${origin}/mcp/account`
const redirect = "http://127.0.0.1:53682/callback"
const appUrl = "https://app.example.com"
const secret = "s".repeat(64)
const schema = { ...authSqliteSchema, ...consoleSchema }

// The tool files as the generated server entries import them. The file name is the tool name.
const tools = Object.fromEntries(Object.entries(import.meta.glob<McpToolDefinition>("../server/mcp/tools/*.ts", { eager: true, import: "default" }))
  .map(([file, tool]) => [file.replace(/^.*\/(.*)\.ts$/, "$1"), tool]))

// What vitehub.dev/mcp answers today (one Server-Sent Event per answer).
const upstreamTools = [
  { name: "get-page", inputSchema: { type: "object", properties: { path: { type: "string", description: "Page path from list-pages, such as /docs/getting-started" } }, required: ["path"] } },
  { name: "list-pages", inputSchema: { type: "object", properties: {} } },
]

let auth: McpOAuthAuth & { handler: (request: Request) => Promise<Response> }
let teamId = ""
let tokens: Record<"ada" | "bob", string>
const appCalls: Array<{ caller: ConsoleCaller, headers: Headers, input: unknown, operation: string }> = []
/** The env line of the link, as the app keeps it: `VITEHUB_CONSOLE_KEY_<NAME>=<public key>`. */
let linkVariable = ""

async function migrate() {
  const client = createClient({ url: ":memory:" })
  const folder = resolve(import.meta.dirname, "../server/databases/default/migrations")
  const db = drizzle({ client, schema })
  await migrateDatabase(db, { migrationsFolder: folder })
  return db
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => auth.handler(new Request(`${origin}/api/auth${path}`, { body: JSON.stringify(body), headers: { "content-type": "application/json", origin, ...headers }, method: "POST" }))

/** The browser flow of an MCP client: register, authorize with PKCE, sign in, consent, and exchange the code. */
async function signInAgent(email: string): Promise<string> {
  const registration = await post("/oauth2/register", { client_name: "Claude Code", redirect_uris: [redirect], token_endpoint_auth_method: "none" })
  const { client_id } = await registration.json() as { client_id: string }
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const query = new URLSearchParams({ client_id, code_challenge: challenge, code_challenge_method: "S256", redirect_uri: redirect, resource, response_type: "code", scope: "openid profile email offline_access", state: "s" })
  const login = new URL((await auth.handler(new Request(`${origin}/api/auth/oauth2/authorize?${query}`))).headers.get("location") ?? "", origin)
  expect(login.pathname).toBe("/oauth")
  const signedIn = await post("/sign-in/email", { email, oauth_query: login.search.slice(1), password: "test-password-123" })
  const consent = new URL((await signedIn.json() as { url: string }).url, origin)
  expect(consent.pathname).toBe("/oauth")
  const cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
  const answer = await post("/oauth2/consent", { accept: true, oauth_query: consent.search.slice(1) }, { cookie })
  const code = new URL((await answer.json() as { url: string }).url).searchParams.get("code") ?? ""
  const token = await auth.handler(new Request(`${origin}/api/auth/oauth2/token`, {
    body: new URLSearchParams({ client_id, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirect, resource }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  }))
  expect(token.status).toBe(200)
  return (await token.json() as { access_token: string }).access_token
}

beforeAll(async () => {
  process.env.VITEHUB_CONSOLE_SECRET = secret
  const db = await migrate()
  state.db = db
  // The Console's Auth, with the plugins that the MCP needs. Email sign-in stands in for GitHub and passkeys.
  const instance = betterAuth({
    baseURL: origin,
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: { enabled: true },
    plugins: [organization({ creatorRole: "owner" }), ...mcpOAuth({ loginPage: "/oauth", resource })],
    secret: "test-secret-at-least-32-bytes-long",
  })
  // SAFETY: The instance has the JWT and OAuth provider endpoints of mcpOAuth().
  auth = instance as unknown as typeof auth
  const ids: Record<string, string> = {}
  for (const name of ["ada", "bob"]) {
    const response = await post("/sign-up/email", { email: `${name}@example.com`, name, password: "test-password-123" })
    ids[name] = (await response.json() as { user: { id: string } }).user.id
  }
  teamId = "team-acme"
  const now = new Date()
  await db.insert(authSqliteSchema.organization).values({ createdAt: now, id: teamId, name: "Acme", slug: "acme" })
  await db.insert(authSqliteSchema.member).values([
    { createdAt: now, id: "m-ada", organizationId: teamId, role: "owner", userId: ids.ada! },
    { createdAt: now, id: "m-bob", organizationId: teamId, role: "member", userId: ids.bob! },
  ])
  tokens = { ada: await signInAgent("ada@example.com"), bob: await signInAgent("bob@example.com") }

  vi.stubGlobal("fetch", vi.fn(async (target: Request | string | URL, init?: RequestInit) => {
    const url = String(target)
    // The forward sends the body as bytes.
    const body: unknown = JSON.parse(init?.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : String(init?.body ?? "{}"))
    if (url === "https://vitehub.dev/mcp") {
      const params = Reflect.get(Object(body), "params") as { name: string, arguments: Record<string, unknown> }
      const result = { content: [{ text: `# ${params.name} ${JSON.stringify(params.arguments)}`, type: "text" }], isError: false }
      return new Response(`event: message\ndata: ${JSON.stringify({ id: 1, jsonrpc: "2.0", result })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    }
    // A stand-in app: it checks the signature with the public key of the link, then applies the MCP rules of
    // vite-hub's Operations endpoint to a call that the Console MCP signed (see the vite-hub console-signature tests).
    expect(url).toBe(`${appUrl}/_vitehub/rpc`)
    const headers = new Headers(init?.headers)
    const [name, value] = linkVariable.split("=")
    const keys = readConsolePublicKeys({ [name!]: value })
    const verified = keys instanceof Map ? await verifyConsoleSignature({ headers, keys, method: "POST", origin: appUrl, url }) : keys
    const answer = (result: Parameters<typeof operationRpcResponse>[1]) => operationRpcResponse(body, result)
    if (!("caller" in verified)) return Response.json({ code: verified.code, message: verified.message, ok: false, status: 401 }, { status: 401 })
    const { input, operation } = operationRpcRequest(body)
    appCalls.push({ caller: verified.caller, headers, input, operation })
    const mcp = verified.caller.via === "console" && verified.caller.surface === "mcp"
    const confirmed = verified.caller.via === "console" && verified.caller.confirmed === true
    if (operation === "project.get") return answer({ ok: true, value: { name: "probe", operations: ["kv.list", "kv.del", "content.save"], protocol: 1, sections: ["kv", "content"], vitehub: "0.0.1" } })
    if (mcp && operation === "documents.action") return answer({ code: "CONSOLE_ACCESS_DENIED", message: "documents.action is not open to MCP clients. Use it from the Console.", ok: false, status: 403 })
    if (mcp && operation === "content.save" && Reflect.get(Object(input), "ifDigest") === undefined) return answer({ code: "CONTENT_R0009", message: "content.save requires ifDigest on MCP calls.", ok: false, status: 400 })
    if (mcp && operation === "kv.del" && !confirmed) return answer({ code: "INTERNAL_R0026", message: "Confirm the change.", ok: false, status: 409 })
    return answer({ ok: true, value: { deleted: 1 } })
  }))
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  appCalls.length = 0
})

const accountServer = createMcpHandler({ name: "ViteHub", route: "/mcp/account", tools, verify: request => verifyMcpRequest(request, { auth }) })
const publicServer = createMcpHandler({ name: "ViteHub", route: "/mcp", tools: Object.fromEntries(Object.entries(tools).filter(([, tool]) => tool.public === true)) })

interface Answer {
  result: { content: Array<{ text: string }>, isError: boolean, structuredContent?: Record<string, unknown>, tools: Array<{ name: string, inputSchema: Record<string, unknown> }> }
}

async function rpc(server: typeof publicServer, path: string, method: string, params?: unknown, token?: string) {
  const req = new Request(`${origin}${path}`, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    headers: { "accept": "application/json, text/event-stream", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    method: "POST",
  })
  // SAFETY: The MCP handler reads only `req` and `url`, and passes the event to the tools, which do not read it.
  const response = await server({ req, url: new URL(req.url) } as unknown as H3Event)
  return { response, body: response.status === 200 ? await response.json() as Answer : undefined }
}

const call = (name: string, args: Record<string, unknown>, token: string) => rpc(accountServer, "/mcp/account", "tools/call", { arguments: args, name }, token)

describe("ViteHub MCP at /mcp", () => {
  it("lists only the docs tools to anyone, with the names and input schemas of vitehub.dev/mcp", async () => {
    const { body, response } = await rpc(publicServer, "/mcp", "tools/list")
    expect(response.headers.has("www-authenticate")).toBe(false)
    const listed = body!.result.tools
    expect(listed.map(tool => tool.name).sort()).toEqual(["get-page", "list-pages"])
    for (const upstream of upstreamTools) {
      const ours = listed.find(tool => tool.name === upstream.name)!
      expect(ours.inputSchema).toMatchObject({ type: "object", ...(upstream.inputSchema.required ? { required: upstream.inputSchema.required } : {}) })
      expect(ours.inputSchema.properties ?? {}).toEqual(upstream.inputSchema.properties)
    }
  })

  it("forwards a docs tool call to vitehub.dev/mcp", async () => {
    const { body } = await rpc(publicServer, "/mcp", "tools/call", { arguments: { path: "/docs/kv" }, name: "get-page" })
    expect(body!.result).toEqual({ content: [{ text: "# get-page {\"path\":\"/docs/kv\"}", type: "text" }], isError: false })
  })

  it("advertises OAuth metadata for /mcp/account only", async () => {
    const discovery = (path: string) => serveMcpOAuthDiscovery(new Request(`${origin}${path}`), { auth })
    expect(await discovery("/.well-known/oauth-protected-resource/mcp")).toBeUndefined()
    const metadata = await discovery("/.well-known/oauth-protected-resource/mcp/account")
    expect(await metadata?.json()).toMatchObject({ authorization_servers: [`${origin}/api/auth`], resource })
  })
})

describe("ViteHub MCP at /mcp/account", () => {
  it("answers 401 with the resource metadata without a token", async () => {
    const { response } = await rpc(accountServer, "/mcp/account", "tools/list")
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/account"`)
  })

  it("lists the docs tools and the account tools to a signed-in member", async () => {
    const { body } = await rpc(accountServer, "/mcp/account", "tools/list", undefined, tokens.bob)
    expect(body!.result.tools.map(tool => tool.name).sort()).toEqual(["check_app", "get-page", "link_app", "list-pages", "list_apps", "list_operations", "run_operation", "unlink_app"])
    const { body: apps } = await call("list_apps", {}, tokens.bob)
    expect(apps!.result.structuredContent).toEqual({ apps: [], team: { id: teamId, name: "Acme", role: "member" } })
  })

  it("lets owners and admins link and unlink, as the Console does", async () => {
    const denied = await call("link_app", { url: appUrl }, tokens.bob)
    expect(denied.body!.result).toMatchObject({ content: [{ text: "CONSOLE_PROJECT_FORBIDDEN: Only owners and admins of the team link projects." }], isError: true })

    const { body } = await call("link_app", { label: "Probe", url: appUrl }, tokens.ada)
    const linked = body!.result.structuredContent as { app: { id: string, keyVariable: string, publicKey: string }, variable: string }
    expect(linked.variable).toBe(`${linked.app.keyVariable}=${linked.app.publicKey}`)
    expect(linked.variable).toMatch(/^VITEHUB_CONSOLE_KEY_CONSOLE_[0-9A-F]{8}=[\w-]{43}$/)

    const kept = await call("unlink_app", { id: linked.app.id }, tokens.bob)
    expect(kept.body!.result).toMatchObject({ content: [{ text: "CONSOLE_PROJECT_FORBIDDEN: Only owners and admins of the team unlink projects." }], isError: true })
    const removed = await call("unlink_app", { id: linked.app.id }, tokens.ada)
    expect(removed.body!.result.structuredContent).toMatchObject({ unlinked: linked.app.id })
    expect((await call("list_apps", {}, tokens.ada)).body!.result.structuredContent).toMatchObject({ apps: [] })
  })

  it("signs operations for the person as the mcp surface, and keeps the app's MCP rules", async () => {
    const { body } = await call("link_app", { url: appUrl }, tokens.ada)
    const { app, variable } = body!.result.structuredContent as { app: { id: string }, variable: string }
    const { id } = app
    linkVariable = variable

    expect((await call("check_app", { id }, tokens.bob)).body!.result.structuredContent).toMatchObject({ linked: true, status: 200 })
    expect((await call("list_operations", { id }, tokens.bob)).body!.result.structuredContent).toMatchObject({ operations: ["kv.list", "kv.del", "content.save"] })

    const refused = await call("run_operation", { id, input: { key: "a" }, operation: "kv.del" }, tokens.bob)
    expect(refused.body!.result.isError).toBe(true)
    expect(refused.body!.result.content[0]!.text).toContain("confirm: true")
    const confirmed = await call("run_operation", { confirm: true, id, input: { key: "a" }, operation: "kv.del" }, tokens.bob)
    expect(confirmed.body!.result).toMatchObject({ isError: false, structuredContent: { deleted: 1 } })

    const hidden = await call("run_operation", { confirm: true, id, input: { action: "remove", body: {}, section: "content" }, operation: "documents.action" }, tokens.bob)
    expect(hidden.body!.result).toMatchObject({ content: [{ text: expect.stringContaining("CONSOLE_ACCESS_DENIED: documents.action is not open to MCP clients") }], isError: true })
    const save = await call("run_operation", { id, input: { collection: "posts", id: "hello", text: "# Hi" }, operation: "content.save" }, tokens.bob)
    expect(save.body!.result).toMatchObject({ content: [{ text: expect.stringContaining("CONTENT_R0009") }], isError: true })

    // Every call is signed for the person as the MCP: no bearer token, no CLI surface, and the confirmation is signed.
    for (const { caller, headers } of appCalls) {
      expect(headers.has("authorization")).toBe(false)
      expect(headers.has("x-vitehub-surface")).toBe(false)
      expect(caller).toMatchObject({ team: { id: teamId, role: "member" }, user: { email: "bob@example.com" }, via: "console" })
    }
    const runs = appCalls.filter(entry => entry.operation !== "project.get")
    expect(runs.map(entry => entry.caller.via === "console" && [entry.caller.surface, entry.caller.confirmed])).toEqual([
      ["mcp", undefined],
      ["mcp", true],
      ["mcp", true],
      ["mcp", undefined],
    ])
    expect(appCalls.filter(entry => entry.operation === "project.get").map(entry => entry.caller.via === "console" && entry.caller.surface)).toEqual(["mcp", "mcp"])
  })

  it("acts on the team that the person opened last", async () => {
    const db = state.db as Awaited<ReturnType<typeof migrate>>
    const [bob] = await db.select().from(authSqliteSchema.user).where(eq(authSqliteSchema.user.email, "bob@example.com"))
    const now = new Date()
    await db.insert(authSqliteSchema.organization).values({ createdAt: now, id: "team-own", name: "Bob's", slug: "bob" })
    await db.insert(authSqliteSchema.member).values({ createdAt: now, id: "m-bob-own", organizationId: "team-own", role: "owner", userId: bob!.id })
    await db.update(authSqliteSchema.session).set({ activeOrganizationId: "team-own", updatedAt: new Date(Date.now() + 1000) }).where(eq(authSqliteSchema.session.userId, bob!.id))
    expect((await call("list_apps", {}, tokens.bob)).body!.result.structuredContent).toMatchObject({ team: { id: "team-own", role: "owner" } })
  })
})
