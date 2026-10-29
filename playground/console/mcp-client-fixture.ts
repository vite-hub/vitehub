import { consoleDiagnosticBody } from "../../packages/vite-hub/src/console/runtime/diagnostics.ts"
import type { ConsoleDiagnosticCode } from "../../packages/vite-hub/src/console/runtime/diagnostics.ts"
import type { ConsoleMcpCandidate, ConsoleMcpConnection, ConsoleMcpListKind, ConsoleMcpServerInfo } from "../../packages/vite-hub/src/console/runtime/mcp-client.ts"
import type { ConsoleRpcResult } from "../../packages/vite-hub/src/console/runtime/rpc.ts"

/**
 * The MCP client section without MCP servers. The app's own `/mcp` (Northwind Ledger) has Maxi and Lucía through
 * OAuth, Lucía's API key, and Sam, who is signed out. ViteHub MCP runs on the Console session, and a remote docs server
 * needs no sign-in. Connect, sign-in, Run as, and disconnect change this state until the playground restarts.
 */

type Person = "lucia" | "maxi" | "sam"

const people: Record<Person, { email: string, name: string }> = {
  lucia: { email: "lucia@example.com", name: "Lucía Romero" },
  maxi: { email: "maxi@example.com", name: "Maxi García" },
  sam: { email: "sam@example.com", name: "Sam Rivera" },
}

const capabilities = (prompts: boolean, resources: boolean): ConsoleMcpServerInfo["capabilities"] => ({ completions: false, logging: false, prompts, resources, tools: true })

const servers = {
  docs: { capabilities: capabilities(false, false), name: "docs-search", protocolVersion: "2025-06-18", title: "Docs Search", version: "0.4.0" },
  ledger: {
    capabilities: capabilities(true, true),
    description: "The household's accounts, transactions, and budgets.",
    instructions: "Every tool answers as the person who signed in. Private accounts of other members stay hidden.",
    name: "northwind-ledger",
    protocolVersion: "2025-11-25",
    title: "Northwind Ledger",
    version: "2.3.0",
    websiteUrl: "https://example.com/ledger",
  },
  vitehub: { capabilities: capabilities(false, false), instructions: "ViteHub MCP gives Agents the server primitives of this app.", name: "vitehub", protocolVersion: "2025-11-25", title: "ViteHub MCP", version: "1" },
} satisfies Record<string, ConsoleMcpServerInfo>

const accounts: Record<Person, { balance: string, name: string, owner: string }[]> = {
  lucia: [{ balance: "2,410.00 EUR", name: "Joint checking", owner: "household" }, { balance: "-312.40 EUR", name: "Lucía card", owner: "Lucía Romero" }],
  maxi: [{ balance: "2,410.00 EUR", name: "Joint checking", owner: "household" }, { balance: "8,950.00 EUR", name: "Maxi savings", owner: "Maxi García" }],
  sam: [],
}

const ledgerItems: Record<ConsoleMcpListKind, Record<string, unknown>[]> = {
  "prompts": [{ arguments: [{ description: "A month, such as 2026-10.", name: "month", required: true }], description: "Summarize the household's spending for one month.", name: "monthly_summary", title: "Monthly summary" }],
  "resource-templates": [{ description: "One account by id.", mimeType: "application/json", name: "account", uriTemplate: "ledger://accounts/{id}" }],
  "resources": [{ description: "Who this connection acts as.", mimeType: "text/markdown", name: "profile", title: "Your profile", uri: "ledger://me" }],
  "tools": [
    {
      annotations: { readOnlyHint: true },
      description: "List the accounts and balances that you can see. Private accounts of other members stay hidden.",
      inputSchema: { properties: { scope: { default: "me", enum: ["me", "household"], type: "string" } }, type: "object" },
      name: "get_finances",
      title: "Get finances",
    },
    {
      annotations: { destructiveHint: false, readOnlyHint: false },
      description: "Add a manual transaction to an account that you may edit.",
      inputSchema: { properties: { account: { type: "string" }, amount: { type: "number" }, note: { type: "string" } }, required: ["account", "amount"], type: "object" },
      name: "add_transaction",
      title: "Add transaction",
    },
  ],
}

const itemsByServer: Record<keyof typeof servers, Record<ConsoleMcpListKind, Record<string, unknown>[]>> = {
  docs: { "prompts": [], "resource-templates": [], "resources": [], "tools": [{ annotations: { openWorldHint: true, readOnlyHint: true }, description: "Search the public docs.", inputSchema: { properties: { query: { type: "string" } }, required: ["query"], type: "object" }, name: "search_docs" }] },
  ledger: ledgerItems,
  vitehub: {
    "prompts": [],
    "resource-templates": [],
    "resources": [],
    "tools": [
      { annotations: { readOnlyHint: true }, description: "List keys in a Console KV store.", inputSchema: { properties: { prefix: { type: "string" }, store: { type: "string" } }, type: "object" }, name: "kv_list_keys", title: "List KV keys" },
      { annotations: { readOnlyHint: true }, description: "List the Database names installed in the Console.", inputSchema: { properties: {}, type: "object" }, name: "database_list_databases", title: "List databases" },
    ],
  },
}

interface FixtureConnection extends ConsoleMcpConnection {
  person?: Person
  serverId: keyof typeof servers
  state?: string
}

const listKinds: readonly ConsoleMcpListKind[] = ["prompts", "resource-templates", "resources", "tools"]

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

let state: FixtureConnection[] | undefined
let nextId = 1

function initial(origin: string): FixtureConnection[] {
  const ledger = `${origin}/mcp`
  const issuer = `${origin}/api/auth`
  const oauth = (person: Person, minutes: number): FixtureConnection => ({
    auth: "oauth",
    createdAt: new Date(Date.UTC(2026, 9, 29, 9, minutes)).toISOString(),
    grant: { expiresAt: new Date(Date.now() + 52 * 60_000).toISOString(), issuer, refreshable: true, scopes: ["openid", "profile", "email", "offline_access"] },
    id: `mcp_${person}`,
    identity: { ...people[person], subject: `user_${person}` },
    label: people[person].name,
    person,
    sameOrigin: true,
    server: servers.ledger,
    serverId: "ledger",
    session: { lucia: "b2d7e4a0", maxi: "9f3a1c58", sam: "e61d0f37" }[person],
    status: "connected",
    url: ledger,
    usedAt: new Date(Date.UTC(2026, 9, 29, 9, minutes + 4)).toISOString(),
  })
  return [
    oauth("maxi", 2),
    oauth("lucia", 6),
    { auth: "bearer", createdAt: new Date(Date.UTC(2026, 9, 29, 9, 8)).toISOString(), grant: { hint: "4f2a", refreshable: false, scopes: [] }, id: "mcp_lucia_key", label: "Lucía (API key)", person: "lucia", sameOrigin: true, server: servers.ledger, serverId: "ledger", session: "c71e0b52", status: "connected", url: ledger },
    { ...oauth("sam", 10), error: "The server rejected the grant. Sign in again.", grant: { issuer, refreshable: false, scopes: ["openid", "profile", "email"] }, session: undefined, status: "signed-out" },
    { auth: "console", createdAt: new Date(Date.UTC(2026, 9, 29, 9, 12)).toISOString(), id: "mcp_console", identity: { name: "You", subject: "local" }, label: "You", sameOrigin: true, server: servers.vitehub, serverId: "vitehub", status: "connected", url: `${origin}/_vitehub/mcp` },
    { auth: "none", createdAt: new Date(Date.UTC(2026, 9, 29, 9, 14)).toISOString(), id: "mcp_docs", label: "docs.example.com/mcp", sameOrigin: false, server: servers.docs, serverId: "docs", session: "0d4c2e19", status: "connected", url: "https://docs.example.com/mcp" },
  ]
}

function connections(origin: string): FixtureConnection[] {
  return state ??= initial(origin)
}

/** Restore the starting connections. Tests use it. */
export function resetMcpClientFixture(): void {
  state = undefined
  nextId = 1
}

function describe(connection: FixtureConnection): ConsoleMcpConnection {
  const { person: _person, serverId: _serverId, state: _state, ...described } = connection
  return described
}

function failure(status: number, code: ConsoleDiagnosticCode, message: string): ConsoleRpcResult {
  return { ...consoleDiagnosticBody(code, message), ok: false, status }
}

function answer(connection: FixtureConnection, request: { arguments?: Record<string, unknown>, name?: string, uri?: string }, kind: "call" | "prompt" | "read"): Record<string, unknown> | { error: { code: number, message: string } } {
  if (kind === "read") return { contents: [{ mimeType: "text/markdown", text: `# ${connection.identity?.name ?? connection.label}\n\nSigned in as ${connection.identity?.email ?? "an API key"}.`, uri: request.uri }] }
  if (kind === "prompt") return { messages: [{ content: { text: `Summarize the household's spending for ${String(request.arguments?.month ?? "this month")}.`, type: "text" }, role: "user" }] }
  if (request.name === "get_finances") {
    const visible = accounts[connection.person ?? "maxi"].filter(account => request.arguments?.scope === "household" || account.owner !== "household")
    return { content: [{ text: visible.map(account => `${account.name}: ${account.balance}`).join("\n") || "No accounts.", type: "text" }], structuredContent: { accounts: visible } }
  }
  if (request.name === "add_transaction") {
    // An API key of this server only reads, so the tool reports the error as its result.
    if (connection.auth === "bearer") return { content: [{ text: "This API key can only read. Connect with OAuth to add transactions.", type: "text" }], isError: true }
    if (typeof request.arguments?.amount !== "number") return { error: { code: -32602, message: "Invalid arguments for add_transaction: amount must be a number." } }
    return { content: [{ text: `Added ${request.arguments.amount} EUR to ${String(request.arguments.account)}.`, type: "text" }] }
  }
  if (request.name === "database_list_databases") return { content: [{ text: JSON.stringify({ databases: ["content", "auth"] }, null, 2), type: "text" }], structuredContent: { databases: ["content", "auth"] } }
  if (request.name === "kv_list_keys") return { content: [{ text: JSON.stringify({ keys: ["flags:beta", "session:7f3a"], store: "default" }, null, 2), type: "text" }], structuredContent: { keys: ["flags:beta", "session:7f3a"], store: "default" } }
  if (request.name === "search_docs") return { content: [{ text: `3 pages match "${String(request.arguments?.query ?? "")}".`, type: "text" }, { description: "Configure the Console", name: "console", type: "resource_link", uri: "https://docs.example.com/console" }] }
  return { error: { code: -32602, message: `Unknown tool: ${String(request.name)}.` } }
}

/** Answer one `mcp-client.*` operation. `cookie` may hold `playground-mcp=shared`, the `auth: "app"` case. */
export function mcpClientFixture(serverUrl: string, payload: { input?: Record<string, unknown>, operation: string }, cookie?: string): ConsoleRpcResult {
  // Vite's local URL includes the playground's base path. The MCP URLs start at the origin.
  const origin = new URL(serverUrl).origin
  const input = payload.input ?? {}
  const all = connections(origin)
  const find = () => all.find(connection => connection.id === input.id)
  const operation = payload.operation.slice("mcp-client.".length)
  if (operation === "list") {
    const candidates: ConsoleMcpCandidate[] = [
      { authorizationServer: `${origin}/api/auth`, label: "Northwind Ledger", url: `${origin}/mcp` },
      { auth: "console", label: "ViteHub MCP", url: `${origin}/_vitehub/mcp` },
    ]
    return { ok: true, value: { connections: all.map(describe), servers: candidates, sharedSession: /(?:^|; )playground-mcp=shared/.test(cookie ?? "") } }
  }
  if (operation === "connect") {
    const url = new URL(String(input.server ?? ""), origin).href
    const serverId = url === `${origin}/_vitehub/mcp` ? "vitehub" : url === `${origin}/mcp` ? "ledger" : url.includes("docs.example.com") ? "docs" : undefined
    if (!serverId) return failure(502, "CONSOLE_MCP_UNREACHABLE", "The server cannot be reached. The playground knows /mcp, /_vitehub/mcp, and https://docs.example.com/mcp.")
    const existing = serverId === "vitehub" ? all.find(connection => connection.serverId === "vitehub") : undefined
    if (existing) return { ok: true, value: { connection: describe(existing) } }
    const base = { createdAt: new Date().toISOString(), id: `mcp_new_${nextId++}`, sameOrigin: new URL(url).origin === origin, server: servers[serverId], serverId, url }
    if (typeof input.token === "string" && input.token) {
      const connection: FixtureConnection = { ...base, auth: "bearer", grant: { hint: input.token.slice(-4), refreshable: false, scopes: [] }, label: String(input.label ?? "API key"), person: "lucia", status: "connected" }
      all.push(connection)
      return { ok: true, value: { connection: describe(connection) } }
    }
    if (serverId !== "ledger") {
      const connection: FixtureConnection = { ...base, auth: serverId === "vitehub" ? "console" : "none", label: serverId === "vitehub" ? "You" : "docs.example.com/mcp", status: "connected", ...(serverId === "vitehub" ? { identity: { name: "You", subject: "local" } } : {}) }
      all.push(connection)
      return { ok: true, value: { connection: describe(connection) } }
    }
    // The authorization server of the playground signs in at once and sends the browser to the callback page.
    const signInState = `state_${nextId}`
    const connection: FixtureConnection = { ...base, auth: "oauth", label: String(input.label ?? `${new URL(url).host}/mcp`), person: input.prompt === "login" ? "sam" : "maxi", state: signInState, status: "authorizing" }
    all.push(connection)
    return { ok: true, value: { authorizationUrl: `${origin}/_vitehub/mcp-client/callback?code=playground&state=${signInState}&iss=${encodeURIComponent(`${origin}/api/auth`)}`, connection: describe(connection) } }
  }
  if (operation === "complete") {
    const connection = all.find(candidate => candidate.state === input.state)
    if (!connection) return failure(404, "CONSOLE_MCP_AUTHORIZATION_FAILED", "This sign-in is not known. It expired, finished already, or was started by someone else. Start it again.")
    const person = connection.person ?? "maxi"
    Object.assign(connection, { error: undefined, grant: { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), issuer: `${origin}/api/auth`, refreshable: true, scopes: ["openid", "profile", "email", "offline_access"] }, identity: { ...people[person], subject: `user_${person}` }, label: people[person].name, session: "5e8b20d4", state: undefined, status: "connected" })
    return { ok: true, value: describe(connection) }
  }
  const connection = find()
  if (!connection) return failure(404, "CONSOLE_REQUEST_INVALID", "This MCP connection does not exist. It ends when the server restarts.")
  if (operation === "disconnect") {
    all.splice(all.indexOf(connection), 1)
    return { ok: true, value: { revoked: connection.auth === "oauth", sessionEnded: Boolean(connection.session) } }
  }
  if (operation === "reconnect") {
    if (connection.auth === "oauth" && (connection.status !== "connected" || input.prompt)) {
      connection.state = `state_${nextId++}`
      connection.status = "authorizing"
      return { ok: true, value: { authorizationUrl: `${origin}/_vitehub/mcp-client/callback?code=playground&state=${connection.state}`, connection: describe(connection) } }
    }
    return { ok: true, value: { connection: describe(connection) } }
  }
  if (connection.status === "signed-out") return failure(409, "CONSOLE_MCP_SIGNED_OUT", connection.error ?? "Sign in again.")
  connection.usedAt = new Date().toISOString()
  if (operation === "items") {
    const kind = listKinds.find(candidate => candidate === input.kind) ?? "tools"
    return { ok: true, value: { connection: describe(connection), items: itemsByServer[connection.serverId][kind] } }
  }
  const kind = operation === "call" ? "call" : operation === "read" ? "read" : operation === "prompt" ? "prompt" : undefined
  if (!kind) return failure(404, "CONSOLE_REQUEST_INVALID", `The playground has no fixture for ${payload.operation}.`)
  const parameters = record(input.arguments)
  const request = { ...(parameters ? { arguments: parameters } : {}), name: String(input.tool ?? input.name ?? ""), uri: String(input.uri ?? "") }
  const outcome = answer(connection, request, kind)
  const durationMs = 40 + (connection.id.length * 7) % 60
  return { ok: true, value: "error" in outcome ? { connection: describe(connection), durationMs, error: outcome.error } : { connection: describe(connection), durationMs, result: outcome } }
}
