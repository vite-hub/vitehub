import type { IncomingMessage, ServerResponse } from "node:http"

import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../../packages/agent/src/invocations.ts"
import { parseConsoleFixture } from "../../packages/vite-hub/src/console/fixture.ts"
import {
  createUsageSummary,
  invocationUsage,
  parseConsoleUsageStatus,
  parseConsoleUsageWindow,
} from "../../packages/vite-hub/src/console/runtime/server/usage.ts"
import { consoleSearchExcerpt } from "../../packages/vite-hub/src/console/runtime/server/search.ts"

import type { Plugin } from "vite"
import databaseFixture from "./database.fixture.json" with { type: "json" }
import fixtureDocument from "./console.fixture.json" with { type: "json" }
import manifest from "./package.json" with { type: "json" }

const fixture = parseConsoleFixture(fixtureDocument)
const store = createMemoryAgentInvocationStore()
for (const record of fixture.invocations) {
  const { cursor: _cursor, ...input } = record
  store.create(input)
}
const invocations = defineAgentInvocations({ content: "content", store })
const sections = ["env", "connections", "agents", "usage", "database", "kv", "workflows", "queues"] as const
const definitions = {
  queues: [
    {
      fields: [],
      file: "server/queues/console-index.ts",
      name: "console-index",
      source: "queue",
    },
    {
      fields: [],
      file: "server/queues/release-notes.ts",
      name: "release-notes",
      source: "queue",
    },
  ],
  workflows: [
    {
      fields: [
        { label: "Agent identity", value: "release-engineer" },
        {
          label: "Steps",
          value: "server/workflows/release/collect.ts, server/workflows/release/publish.ts",
        },
      ],
      file: "server/workflows/release.ts",
      name: "release",
      source: "workflow",
    },
    {
      fields: [
        { label: "Steps", value: "server/workflows/index/sync.ts" },
      ],
      file: "server/workflows/rebuild-console-index.ts",
      name: "rebuild-console-index",
      source: "workflow",
    },
  ],
} as const
const kvStores = {
  cache: new Map<string, unknown>([
    ["console:sections", sections],
    ["docs:last-build", { commit: "937d2ca", durationMs: 18422, status: "passed" }],
  ]),
  default: new Map<string, unknown>([
    ["app:config", { console: true, environment: "playground", readOnly: true }],
    ["feature:console-theme", { density: "compact", navigation: "primitive-first" }],
    ["release:latest", { commit: "937d2ca", packages: 27, version: "0.0.1" }],
    ["session:interface-engineer", { active: true, invocationId: "ainv_console_navigation" }],
  ]),
} as const

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status
  response.setHeader("cache-control", "no-store")
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
}

const googleScopes = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"]
const connections = new Map([
  ["gmail", {
    account: { email: "ada@example.com", id: "108230129837" },
    actions: [
      { highRisk: false, id: "gmail.users.messages.list", method: "GET", write: false },
      { highRisk: false, id: "gmail.users.messages.modify", method: "POST", write: true },
      { highRisk: true, id: "gmail.users.messages.send", method: "POST", write: true },
    ],
    connectedAt: "2026-09-21T08:12:00.000Z",
    name: "gmail",
    provider: "google",
    refreshedAt: "2026-09-29T07:58:00.000Z",
    scopes: { declared: googleScopes, granted: googleScopes, missing: [] },
    status: "connected",
  }],
  ["calendar", {
    account: { email: "ada@example.com", id: "108230129837" },
    actions: [{ highRisk: false, id: "calendar.events.list", method: "GET", write: false }],
    connectedAt: "2026-08-02T10:40:00.000Z",
    name: "calendar",
    provider: "google",
    scopes: {
      declared: ["https://www.googleapis.com/auth/calendar.events"],
      granted: [],
      missing: ["https://www.googleapis.com/auth/calendar.events"],
    },
    status: "reauth_required",
  }],
  ["support-inbox", {
    actions: [{ highRisk: false, id: "gmail.users.threads.list", method: "GET", write: false }],
    name: "support-inbox",
    provider: "google",
    scopes: { declared: ["https://www.googleapis.com/auth/gmail.readonly"], granted: [], missing: ["https://www.googleapis.com/auth/gmail.readonly"] },
    status: "disconnected",
  }],
])
const connectionActivity = [
  { action: "use", actor: { id: "email-labeller", kind: "agent" }, id: "cact_004", invocationId: "ainv_email_labeller", key: "connection/gmail", operation: "gmail.users.messages.send", operationId: "cop_004", outcome: "denied", timestamp: "2026-09-29T08:03:00.000Z" },
  { action: "use", actor: { id: "email-labeller", kind: "agent" }, id: "cact_003", invocationId: "ainv_email_labeller", key: "connection/gmail", operation: "gmail.users.messages.modify", operationId: "cop_003", outcome: "succeeded", timestamp: "2026-09-29T08:02:00.000Z" },
  { action: "resolve", actor: { id: "email-labeller", kind: "agent" }, id: "cact_002", key: "connection/gmail", operationId: "cop_002", outcome: "succeeded", timestamp: "2026-09-29T08:01:00.000Z" },
  { action: "replace", actor: { id: "ada", kind: "user" }, id: "cact_001", key: "connection/gmail", operationId: "cop_001", outcome: "succeeded", timestamp: "2026-09-21T08:12:00.000Z" },
]
const connectionApprovals = [
  { action: "gmail.users.messages.send", actor: "agent:email-labeller", createdAt: "2026-09-29T08:03:00.000Z", id: "capr_002", input: { to: "team@example.com" }, invocationId: "ainv_email_labeller", name: "gmail", status: "pending" },
  { action: "gmail.users.messages.send", actor: "agent:email-labeller", createdAt: "2026-09-28T16:20:00.000Z", decidedAt: "2026-09-28T16:24:00.000Z", decidedBy: "user:ada", id: "capr_001", input: { to: "ada@example.com" }, name: "gmail", status: "executed" },
]

// Synthetic Connections management API. It accepts the same JSON actions as `/_vitehub/connections`.
async function handleConnections(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // SAFETY: This synthetic API receives the fixed JSON action shapes from the Console fixture client.
  const input = await body(request) as { action?: string, before?: string, id?: string, name?: string, status?: string }
  const approvalView = ({ input: _input, ...approval }: typeof connectionApprovals[number]) => approval
  const connection = input.name ? connections.get(input.name) : undefined
  const approval = connectionApprovals.find(entry => entry.id === input.id)
  switch (input.action) {
    case "list": return json(response, { connections: [...connections.values()] })
    case "inspect": return connection ? json(response, { connection }) : json(response, { error: { code: "CONNECTION_INVALID", message: `No Connection Definition was discovered for "${input.name}".` } }, 400)
    case "revoke":
      if (!connection) return json(response, { error: { code: "CONNECTION_INVALID", message: "Unknown Connection." } }, 400)
      Object.assign(connection, { scopes: { ...connection.scopes, granted: [], missing: connection.scopes.declared }, status: "revoked" })
      return json(response, { connection })
    case "activity": return json(response, { activity: input.before ? [] : connectionActivity.filter(event => event.key === `connection/${input.name}`) })
    case "approval-counts": return json(response, { counts: Object.fromEntries([...connections.keys()].map(name => [name, connectionApprovals.filter(entry => entry.name === name && entry.status === "pending").length])) })
    case "approvals":
    case "approval-summaries": {
      const approvals = connectionApprovals.filter(entry => (!input.name || entry.name === input.name) && (!input.status || entry.status === input.status))
      return json(response, { approvals: input.action === "approval-summaries" ? approvals.map(approvalView) : approvals })
    }
    case "approve":
    case "approve-summary":
    case "deny":
    case "deny-summary":
      if (!approval || approval.status !== "pending") return json(response, { error: { code: "CONNECTION_INVALID", message: "This approval is not pending." } }, 400)
      Object.assign(approval, { decidedAt: new Date().toISOString(), decidedBy: "user:local", status: input.action === "approve" || input.action === "approve-summary" ? "executed" : "denied" })
      if (input.action === "approve-summary" || input.action === "deny-summary") return json(response, { approval: approvalView(approval) })
      return json(response, input.action === "approve" ? { approval, result: { id: "msg_synthetic" } } : { approval })
    default: return json(response, { error: { code: "CONNECTION_INVALID", message: "Invalid Connections request." } }, 400)
  }
}

function summary(record: Awaited<ReturnType<typeof invocations.get>>): Record<string, unknown> | undefined {
  if (!record) return
  const { observations: _observations, ...value } = record
  return value
}

function storeName(value: string | null): keyof typeof kvStores | undefined {
  const name = value || "default"
  return name === "default" || name === "cache" ? name : undefined
}

function formattedKVValue(key: string, name: keyof typeof kvStores, value: unknown): Record<string, unknown> {
  if (!kvStores[name].has(key)) return { found: false, key, store: name }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The playground formats arbitrary fixture values for display.
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  return {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The playground reports whether arbitrary fixture values are text or JSON.
    format: typeof value === "string" ? "text" : "json",
    found: true,
    key,
    store: name,
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The playground reports the runtime type of arbitrary fixture values.
    type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    value: text,
  }
}

function databaseCell(value: unknown): { kind: string, value: string } {
  if (value === null || value === undefined) return { kind: "null", value: "NULL" }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The playground formats arbitrary fixture values for display.
  if (typeof value === "boolean") return { kind: "boolean", value: value ? "true" : "false" }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The playground formats arbitrary fixture values for display.
  if (typeof value === "number") return { kind: "number", value: String(value) }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The playground formats arbitrary fixture values for display.
  if (typeof value === "string") return { kind: "text", value }
  return { kind: "json", value: JSON.stringify(value) }
}

function databaseInspection(url: URL): Record<string, unknown> {
  const requestedTable = url.searchParams.get("table") || undefined
  const table = requestedTable
    ? databaseFixture.tables.find(entry => entry.name === requestedTable)
    : undefined
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100)
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0)
  const search = (url.searchParams.get("search") || "").trim().toLowerCase()
  const sort = table?.columns.some(column => column.name === url.searchParams.get("sort"))
    ? url.searchParams.get("sort") || undefined
    : undefined
  const direction = url.searchParams.get("direction") === "desc" ? "desc" : "asc"
  const rows = (table?.rows ?? [])
    .filter(row => !search || Object.values(row).some(value => JSON.stringify(value)?.toLowerCase().includes(search)))
    .toSorted((left, right) => {
      if (!sort) return 0
      const compared = String(left[sort] ?? "").localeCompare(String(right[sort] ?? ""), undefined, { numeric: true })
      return direction === "desc" ? -compared : compared
    })
  return {
    database: databaseFixture.schema,
    databases: [databaseFixture.schema],
    direction,
    limit,
    offset,
    relationships: databaseFixture.relationships,
    rows: rows.slice(offset, offset + limit).map(row => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, databaseCell(value)]),
    )),
    search,
    ...(sort ? { sort } : {}),
    ...(table ? { table: table.name } : {}),
    tables: databaseFixture.tables.map(entry => ({
      columns: entry.columns.map(column => ({
        ...(column.foreignKey ? { foreignKey: column.foreignKey } : {}),
        key: column.name,
        name: column.name,
        nullable: column.nullable === true,
        primary: column.primary === true,
        type: column.type,
        unique: column.unique === true,
      })),
      name: entry.name,
    })),
    total: rows.length,
  }
}

async function handleAPI(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname
  if (!path.startsWith("/api/_vitehub/console/")) return false

  if (path === "/api/_vitehub/console/env") {
    json(response, { entries: [
      { path: "env.server.github.token", source: "provider", provider: "personal-vault", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.openai.apiKey", source: "provider", provider: "personal-vault", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.codex.auth", source: "provider", provider: "personal-vault", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.webhookSecret", source: "env", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.logLevel", source: "env", secret: false, required: false, hasDefault: true, type: '"debug" | "info" | "warn"' },
      { path: "env.server.labeller.dryRun", source: "env", secret: false, required: true, hasDefault: true, type: "boolean" },
      { path: "env.server.labeller.minConfidence", source: "env", secret: false, required: true, hasDefault: true, type: "number" },
      { path: "env.server.appName", source: "literal", secret: false, required: false, hasDefault: false },
    ] })
    return true
  }
  if (path === "/api/_vitehub/console/sections") {
    json(response, { projectName: manifest.name, sections })
    return true
  }

  if (path === "/api/_vitehub/console/agents") {
    json(response, {
      agents: [...new Set(fixture.invocations.map(invocation => invocation.agentName))].sort(),
    })
    return true
  }

  if (path === "/api/_vitehub/console/invocation-capabilities") {
    const agentName = url.searchParams.get("agent") || undefined
    const [capabilities, triggeredBy] = await Promise.all([
      invocations.listCapabilityIds(agentName),
      invocations.listTriggeredBy(agentName),
    ])
    json(response, { capabilities, triggeredBy })
    return true
  }

  if (path === "/api/_vitehub/console/status") {
    json(response, { agents: [...new Set(fixture.invocations.map(record => record.agentName).filter(Boolean))].map(agent => ({
      agent,
      checkedAt: "2026-08-30T18:00:00.000Z",
      readiness: "unsupported",
      stale: false,
      reason: "Synthetic playground data",
    })) })
    return true
  }

  if (path === "/api/_vitehub/console/invocations") {
    const ids = url.searchParams.getAll("id")
    if (ids.length) {
      const records = await Promise.all(ids.map(id => invocations.get(id)))
      json(response, { invocations: records.flatMap(record => summary(record) ?? []) })
      return true
    }
    const page = await invocations.list({
      agentName: url.searchParams.get("agent") || undefined,
      capabilityId: url.searchParams.get("capability") || undefined,
      triggeredBy: url.searchParams.get("triggeredBy") || undefined,
      cursor: url.searchParams.get("cursor") || undefined,
      limit: Number(url.searchParams.get("limit")) || 50,
    })
    json(response, {
      ...page,
      invocations: await Promise.all(page.invocations.map(async (item) => {
        const record = await invocations.get(item.id)
        const usage = record ? invocationUsage(record) : undefined
        return { ...item, ...(usage ? { usage } : {}) }
      })),
    })
    return true
  }

  if (path.startsWith("/api/_vitehub/console/invocations/")) {
    const id = decodeURIComponent(path.slice("/api/_vitehub/console/invocations/".length))
    if (request.method === "POST") {
      let input: unknown
      try {
        input = await body(request)
      }
      catch {
        json(response, { error: "Malformed invocation action." }, 400)
        return true
      }
      if (!(input instanceof Object) || Array.isArray(input) || Object.keys(input).length !== 1 || Reflect.get(input, "action") !== "delete") {
        json(response, { error: "Unsupported invocation action." }, 400)
        return true
      }
      const outcome = await invocations.delete(id)
      if (outcome === "not-found") {
        json(response, { error: "Invocation not found" }, 404)
        return true
      }
      if (outcome === "not-terminal") {
        json(response, { error: "Only completed, failed, or cancelled invocations can be deleted." }, 409)
        return true
      }
      json(response, { id, outcome: "deleted" })
      return true
    }
    const record = await invocations.get(id)
    const invocation = summary(record)
    if (!record || !invocation) {
      json(response, { error: "Invocation not found" }, 404)
      return true
    }
    const usage = invocationUsage(record)
    json(response, {
      invocation: { ...invocation, ...(usage ? { usage } : {}) },
      observations: record.observations,
    })
    return true
  }

  if (path === "/api/_vitehub/console/usage") {
    const requestedWindow = url.searchParams.get("window") || "30d"
    const window = parseConsoleUsageWindow(requestedWindow)
    if (!window) {
      json(response, { error: "Invalid usage window" }, 400)
      return true
    }
    json(response, await createUsageSummary(invocations, {
      agentName: url.searchParams.get("agent") || undefined,
      cursor: url.searchParams.get("cursor") || undefined,
      search: url.searchParams.get("search") || undefined,
      status: parseConsoleUsageStatus(url.searchParams.get("status") || ""),
      now: "2026-08-30T18:00:00.000Z",
      window,
    }))
    return true
  }

  if (path === "/api/_vitehub/console/database") {
    json(response, databaseInspection(url))
    return true
  }

  if (path === "/api/_vitehub/console/search") {
    const search = url.searchParams.get("search")?.trim() || undefined
    const page = await invocations.list({
      cursor: url.searchParams.get("cursor") || undefined,
      limit: Number(url.searchParams.get("limit")) || 12,
      search,
    })
    const items = await Promise.all(page.invocations.map(async (item) => {
      const record = search ? await invocations.get(item.id) : undefined
      return {
        agentName: item.agentName,
        context: item.threadId || item.origin || item.channelId || item.id,
        ...(record && search ? { excerpt: consoleSearchExcerpt(record, search) } : {}),
        id: item.id,
        status: item.status,
        updatedAt: item.updatedAt || item.startedAt || item.createdAt,
      }
    }))
    json(response, { items, nextCursor: page.cursor ?? null })
    return true
  }

  if (path === "/api/_vitehub/console/definitions") {
    const section = url.searchParams.get("section")
    if (section !== "queues" && section !== "workflows") {
      json(response, { error: "A valid definition section is required" }, 400)
      return true
    }
    json(response, { definitions: definitions[section], section })
    return true
  }

  if (path === "/api/_vitehub/console/kv") {
    if (request.method === "POST") {
      // SAFETY: The playground handler validates both fields immediately after decoding this local JSON request.
      const input = await body(request) as { key?: unknown, store?: unknown }
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The playground validates the untrusted request store before lookup.
      const name = storeName(typeof input.store === "string" ? input.store : null)
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The playground validates the untrusted request key before lookup.
      if (!name || typeof input.key !== "string") {
        json(response, { error: "KV store or key not found" }, 404)
        return true
      }
      json(response, formattedKVValue(input.key, name, kvStores[name].get(input.key)))
      return true
    }
    const name = storeName(url.searchParams.get("store"))
    if (!name) {
      json(response, { error: "KV store not found" }, 404)
      return true
    }
    const prefix = url.searchParams.get("prefix") || ""
    json(response, {
      keys: [...kvStores[name].keys()].filter(key => key.startsWith(prefix)).sort(),
      limit: Number(url.searchParams.get("limit")) || 200,
      prefix,
      store: name,
      stores: Object.keys(kvStores),
    })
    return true
  }

  json(response, { error: "Console playground route not found" }, 404)
  return true
}

export function consoleMockAPI(): Plugin {
  return {
    name: "vitehub-console-playground-api",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        try {
          const url = new URL(request.url || "/", "http://vitehub.local")
          if (url.pathname === "/") {
            response.statusCode = 302
            response.setHeader("location", "/_vitehub/")
            response.end()
            return
          }
          if (request.method === "POST" && url.pathname === "/_vitehub/connections") {
            await handleConnections(request, response)
            return
          }
          if (request.method === "GET" && url.pathname.startsWith("/_vitehub/connections/connect/")) {
            response.setHeader("content-type", "text/html; charset=utf-8")
            response.end("<!doctype html><title>Connected</title><p>Synthetic playground. No provider was contacted. You can close this tab.</p>")
            return
          }
          if (await handleAPI(request, response, url)) return
          next()
        }
        catch (error) {
          json(response, {
            error: error instanceof Error ? error.message : "Console playground request failed",
          }, 500)
        }
      })
    },
  }
}
