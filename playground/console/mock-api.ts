import type { IncomingMessage, ServerResponse } from "node:http"

import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../../packages/agent/src/invocations.ts"
import { parseConsoleFixture } from "../../packages/vite-hub/src/console/fixture.ts"
import {
  createUsageSummary,
  invocationUsage,
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
const sections = ["agents", "usage", "database", "kv", "workflows", "queues"] as const
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
  const rows = table
    ? (table.rows as Array<Record<string, unknown>>)
        .filter(row => !search || Object.values(row).some(value => JSON.stringify(value)?.toLowerCase().includes(search)))
        .toSorted((left, right) => {
          if (!sort) return 0
          const compared = String(left[sort] ?? "").localeCompare(String(right[sort] ?? ""), undefined, { numeric: true })
          return direction === "desc" ? -compared : compared
        })
    : []
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

  if (path === "/api/_vitehub/console/invocations") {
    const ids = url.searchParams.getAll("id")
    if (ids.length) {
      const records = await Promise.all(ids.map(id => invocations.get(id)))
      json(response, { invocations: records.flatMap(record => summary(record) ?? []) })
      return true
    }
    const page = await invocations.list({
      agentName: url.searchParams.get("agent") || undefined,
      cursor: url.searchParams.get("cursor") || undefined,
      limit: Number(url.searchParams.get("limit")) || 50,
    })
    json(response, page)
    return true
  }

  if (path.startsWith("/api/_vitehub/console/invocations/")) {
    const id = decodeURIComponent(path.slice("/api/_vitehub/console/invocations/".length))
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
