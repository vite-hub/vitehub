import { createLogBuffer } from "../../packages/vite-hub/src/logs/memory.ts"
import type { IncomingMessage, ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import * as v from "valibot"

import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../../packages/agent/src/invocations.ts"
import {
  createUsageSummary,
  invocationUsage,
  parseConsoleUsageStatus,
  parseConsoleUsageWindow,
} from "../../packages/vite-hub/src/console/runtime/server/usage.ts"
import { consoleSearchExcerpt } from "../../packages/vite-hub/src/console/runtime/server/search.ts"
import { createEmail } from "../../packages/email/src/client.ts"
import { readEmailOutboxConsoleRecords } from "../../packages/email/src/runtime/console.ts"
import { createEmailDevOutboxDriver } from "../../packages/email/src/runtime/outbox.ts"
import { emailProviderError } from "../../packages/email/src/provider.ts"

import type { Plugin } from "vite"
import type { AgentInvocationStoreCreateInput } from "../../packages/agent/src/invocations.ts"
import databaseFixture from "./database.fixture.json" with { type: "json" }
import fixtureDocument from "./console.fixture.json" with { type: "json" }
import manifest from "./package.json" with { type: "json" }
import { playgroundSkillFiles } from "./skills.ts"
import { servedSkillsConsoleSection } from "../../packages/vite-hub/src/skills/console.ts"
import { playgroundCommentsSection, playgroundConsoleContributions } from "./sections.ts"

// SAFETY: console.fixture.json holds Agent Invocation records in the shape that the journal store creates.
const fixture = fixtureDocument as { invocations: AgentInvocationStoreCreateInput[] }
const invocationAgents = [...new Set(fixture.invocations.map(invocation => invocation.agentName))].sort()
// `meal-logger` stands for a retired Agent. Its sessions stay in invocation history, but the application no longer registers it.
const agents = invocationAgents.filter(agent => agent !== "meal-logger")
const store = createMemoryAgentInvocationStore()
for (const record of fixture.invocations) store.create(record)
const invocations = defineAgentInvocations({ content: "content", store })
const logs = createLogBuffer({ maxEntries: 256 })
for (let index = 0; index < 120; index++) {
 const failed = index % 13 === 0
 logs.append({ id: `evt_${index}`, timestamp: new Date(Date.UTC(2026, 9, 28, 14, 32, index)).toISOString(), level: failed ? "error" : index % 9 === 0 ? "warn" : "info", service: index % 3 === 0 ? "agent" : "api", message: failed ? "Payment provider request failed" : index % 3 === 0 ? "Agent invocation completed" : "HTTP request completed", data: { requestId: `req_${index}`, method: "POST", path: failed ? "/api/checkout" : "/api/agents/support", status: failed ? 502 : 200, duration: 42 + index, ...(failed ? { error: { code: "PAYMENT_UNAVAILABLE", why: "The payment provider did not respond before the deadline.", fix: "Check the provider status, then retry with the same idempotency key.", docs: "https://vitehub.dev", data: { provider: "payments", attempt: 1 } } } : { agent: { name: "support", tokens: 234 + index } }) } })
}
const sections = [
  "logs",
  "auth",
  "env",
  "agents",
  "skills",
  "served-skills",
  "usage",
  "channels",
  "mcp-client",
  "blob",
  "databases",
  "email",
  "kv",
  "rate-limits",
  "sandbox-tasks",
  "workspaces",
  "workflows",
  "queues",
  "schedules",
  "comments",
  "site",
] as const;
const definitions = {
  "rate-limits": [
    {
      fields: [
        { label: "Limit", value: "60" },
        { label: "Window", value: "1m" },
        { label: "Enforcement", value: "Strict" },
        { label: "Provider failure", value: "Deny" },
        { label: "Source location", value: "12:3" },
      ],
      file: "server/api/search.get.ts",
      name: "api-search",
      source: "require-rate-limit",
    },
    {
      fields: [
        { label: "Limit", value: "5" },
        { label: "Window", value: "1h" },
        { label: "Enforcement", value: "Best effort" },
        { label: "Provider failure", value: "Allow" },
        { label: "Source location", value: "8:3" },
      ],
      file: "server/api/invite.post.ts",
      name: "invite",
      source: "require-rate-limit",
    },
  ],
  "sandbox-tasks": [
    {
      fields: [{ label: "Kind", value: "Definition" }],
      file: "server/sandbox-tasks/release-check.ts",
      name: "release-check",
      source: "server-sandbox-tasks",
    },
    {
      fields: [{ label: "Kind", value: "Package entry" }],
      file: "node_modules/@vite-hub/sandbox/dist/task/providers/node.js",
      name: "node",
      source: "server-sandbox-tasks",
    },
  ],
  workspaces: [
    {
      fields: [
        { label: "Kind", value: "Agent workspace" },
        { label: "Source root", value: "." },
      ],
      file: "server/agents/interface-engineer.ts",
      name: "vitehub",
      source: "server-agent-workspaces",
    },
    {
      fields: [
        { label: "Kind", value: "Workspace Definition" },
        { label: "Source root", value: "docs/content" },
      ],
      file: "server/workspaces/docs.ts",
      name: "docs",
      source: "workspace",
    },
  ],
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
// Synthetic Email outbox. The real outbox driver captures the messages and the real Console reader maps them.
let emailOutbox: Promise<void> | undefined

async function captureEmailOutbox(): Promise<void> {
  const capture = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: false, driver: () => {
    throw new Error("The playground never creates a provider driver.")
  }, provider: "resend" }) })
  const failing = createEmail({ driver: () => createEmailDevOutboxDriver({ deliver: true, driver: {
    name: "resend",
    send: () => ({ data: null, error: emailProviderError("resend", "AUTH", "Resend rejected the API key.") }),
  }, provider: "resend" }) })
  await capture.send({
    attachments: [{ content: "date,amount\n2026-09-01,42.00\n", contentType: "text/csv", filename: "usage-september.csv" }],
    from: { email: "billing@acme.test", name: "Acme Billing" },
    headers: { "X-Entity-Ref-ID": "inv_2026_09" },
    html: "<h1>Your September invoice</h1>\n<p>Total: <strong>$42.00</strong></p>",
    subject: "Your September invoice",
    text: "Your September invoice\n\nTotal: $42.00",
    to: "ada@example.test",
  })
  await failing.send({
    from: "hello@acme.test",
    html: "<p>Reset your password.</p>",
    subject: "Reset your password",
    text: "Reset your password.",
    to: "grace@example.test",
  }).catch(() => undefined)
  await capture.send({
    from: "hello@acme.test",
    headers: { Authorization: "Bearer re_playground_secret" },
    html: '<p onclick="steal()">Welcome, Linus <img src=x onerror=alert(1)></p>\n<script>alert("xss")</script>',
    subject: "Welcome to Acme",
    text: "Welcome, Linus.",
    to: ["linus@example.test"],
    unsubscribe: { url: "https://acme.test/unsubscribe?token=playground-token" },
  })
}

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

const scheduleRecords = [
  {
    cells: { manual: "Enabled", schedule: "nightly-digest", timing: "0 6 * * *" },
    fields: [
      { label: "Kind", value: "Static schedule" },
      { label: "Cron", value: "0 6 * * *" },
      { label: "Time zone", value: "UTC" },
      { label: "Manual", value: "Enabled" },
      { label: "File", value: "server/schedules/nightly-digest.ts" },
      { label: "Source", value: "schedule" },
      { label: "Runs", value: "Use `vitehub schedule runs nightly-digest` to list runs that this runtime recorded." },
    ],
    id: "definition:nightly-digest",
    runnable: true,
  },
]
let scheduleRunCount = 0

const blobStores = {
  default: [
    {
      contentType: "image/png",
      customMetadata: { agent: "interface-engineer", invocation: "ainv_console_empty_states" },
      httpEtag: '"7d3f1c9a"',
      httpMetadata: { cacheControl: "public, max-age=31536000" },
      pathname: "screenshots/console-empty-states/kv-dark.png",
      size: 184_320,
      uploadedAt: "2026-08-30T16:41:12.000Z",
      urlAvailable: true as const,
    },
    {
      contentType: "image/png",
      customMetadata: { agent: "interface-engineer", invocation: "ainv_console_empty_states" },
      httpEtag: '"5b2e0a44"',
      httpMetadata: { cacheControl: "public, max-age=31536000" },
      pathname: "screenshots/console-empty-states/kv-light.png",
      size: 176_128,
      uploadedAt: "2026-08-30T16:41:13.000Z",
      urlAvailable: true as const,
    },
    {
      contentType: "application/json",
      customMetadata: {},
      httpEtag: '"c01d2e3f"',
      httpMetadata: {},
      pathname: "exports/usage-2026-08.json",
      size: 24_576,
      uploadedAt: "2026-08-29T06:00:00.000Z",
    },
    {
      contentType: "text/csv",
      customMetadata: { source: "billing" },
      httpEtag: '"9a8b7c6d"',
      httpMetadata: { contentDisposition: 'attachment; filename="usage-september.csv"' },
      pathname: "exports/usage-september.csv",
      size: 2_048,
      uploadedAt: "2026-09-01T06:00:00.000Z",
    },
    {
      contentType: "application/pdf",
      customMetadata: {},
      httpEtag: '"e4f5a6b7"',
      httpMetadata: {},
      pathname: "invoices/inv_2026_09.pdf",
      size: 96_201,
      uploadedAt: "2026-09-01T06:00:04.000Z",
      urlAvailable: true as const,
    },
  ],
  uploads: [
    {
      contentType: "image/svg+xml",
      customMetadata: { attachment: "desktop-layout.svg" },
      httpEtag: '"11aa22bb"',
      httpMetadata: {},
      pathname: "attachments/ainv_image_previews/desktop-layout.svg",
      size: 1_842,
      uploadedAt: "2026-09-05T18:00:00.000Z",
      urlAvailable: true as const,
    },
    {
      contentType: "image/svg+xml",
      customMetadata: { attachment: "mobile-layout.svg" },
      httpEtag: '"33cc44dd"',
      httpMetadata: {},
      pathname: "attachments/ainv_image_previews/mobile-layout.svg",
      size: 1_311,
      uploadedAt: "2026-09-05T18:00:00.000Z",
      urlAvailable: true as const,
    },
  ],
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

/** Requests per Rate Limit counter, so the page has something to peek at and reset. */
const rateLimitUsed = new Map<string, number>([["api-search:192.0.2.1", 42], ["invite:ada@example.test", 5]])

function storeName(value: string | null): keyof typeof kvStores | undefined {
  const name = value || "default"
  return name === "default" || name === "cache" ? name : undefined
}

function formattedKVValue(key: string, name: keyof typeof kvStores, value: unknown): Record<string, unknown> {
  if (!kvStores[name].has(key)) return { found: false, key, store: name }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  return {
    editable: true,
    expiry: "unknown",
    format: typeof value === "string" ? "text" : "json",
    found: true,
    key,
    store: name,
    type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    value: text,
  }
}

function databaseCell(value: unknown): { kind: string, value: string } {
  if (value === null || value === undefined) return { kind: "null", value: "NULL" }
  if (typeof value === "boolean") return { kind: "boolean", value: value ? "true" : "false" }
  if (typeof value === "number") return { kind: "number", value: String(value) }
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

/**
 * Fails chosen Console routes, so a contributor can see each error state. Set the `playground-fail` cookie to
 * `<route>=<status>` pairs, such as `agents=401,invocations=401` or `sections=503`. A route matches the path after
 * `/_vitehub/api/`, so `agents` also fails `agents/<name>/invocations`.
 */
function playgroundFailure(request: IncomingMessage, path: string): number | undefined {
  const cookie = request.headers?.cookie?.split(/;\s*/).find(entry => entry.startsWith("playground-fail="))
  if (!cookie) return undefined
  const route = path.slice("/_vitehub/api/".length)
  for (const pair of decodeURIComponent(cookie.slice("playground-fail=".length)).split(",")) {
    const [name, status] = pair.split("=")
    if (name && (route === name || route.startsWith(`${name}/`)) && Number(status) >= 400) return Number(status)
  }
  return undefined
}

/**
 * Keeps only some sections, so a contributor can see the Console of a smaller app, such as the "Add a primitive" list.
 * Set the `playground-sections` cookie to section ids, such as `comments,databases`.
 */
function playgroundSections(request: IncomingMessage): readonly string[] {
  const cookie = request.headers?.cookie?.split(/;\s*/).find(entry => entry.startsWith("playground-sections="))
  if (!cookie) return sections
  const kept = new Set(decodeURIComponent(cookie.slice("playground-sections=".length)).split(","))
  return sections.filter(section => kept.has(section))
}

const playgroundFailureMessages: Record<number, string> = {
  401: "The app does not accept the signature of this Console.",
  403: "This account cannot read this Console section.",
  500: "The Console handler threw an error.",
  503: "The Console server is restarting.",
}

async function handleAPI(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname
  if (!path.startsWith("/_vitehub/api/")) return false

  const failure = playgroundFailure(request, path)
  if (failure) {
    response.statusCode = failure
    response.setHeader("content-type", "text/plain; charset=utf-8")
    response.end(playgroundFailureMessages[failure] ?? `Playground failure ${failure}.`)
    return true
  }

  if (path === "/_vitehub/api/env") {
    // Grouped by namespace like a real app: providers, nested literals, top-level values, and undisclosed names.
    const envEntries = [
      { path: "env.server.typesafe.apiKey", source: "env", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.typesafe.model", source: "env", secret: false, required: false, hasDefault: true, type: "string" },
      { path: "env.server.typesafe.provider", source: "literal", secret: false, required: false, hasDefault: false },
      { path: "env.server.executor.url", source: "env", secret: false, required: true, hasDefault: false, type: "string" },
      { path: "env.server.executor.apiKey", source: "provider", provider: "personal-vault", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.executor.accessClientId", source: "env", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.executor.accessClientSecret", source: "env", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.github.token", source: "provider", provider: "personal-vault", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.openai.apiKey", source: "provider", provider: "personal-vault", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.pubsub.topic", source: "env", secret: false, required: true, hasDefault: false, type: "string" },
      { path: "env.server.pubsub.audience", source: "env", secret: false, required: true, hasDefault: false, type: "string" },
      { path: "env.server.pubsub.serviceAccount", source: "env", secret: false, required: true, hasDefault: false, type: "string" },
      { path: "env.server.labeller.adminToken", source: "env", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.labeller.dryRun", source: "env", secret: false, required: true, hasDefault: true, type: "boolean" },
      { path: "env.server.labeller.minConfidence", source: "env", secret: false, required: true, hasDefault: true, type: "number" },
      { path: "env.server.labeller.labels.GitHub.color.textColor", source: "literal", secret: false, required: false, hasDefault: false },
      { path: "env.server.labeller.labels.GitHub.color.backgroundColor", source: "literal", secret: false, required: false, hasDefault: false },
      { path: "env.server.webhookSecret", source: "env", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.logLevel", source: "env", secret: false, required: false, hasDefault: true, type: '"debug" | "info" | "warn"' },
      { path: "env.server.appName", source: "literal", secret: false, required: false, hasDefault: false },
      { source: "literal", secret: false, required: false, hasDefault: false },
      { source: "literal", secret: false, required: false, hasDefault: false },
    ]
    // `?status=1` answers like inspectServerEnv: two required values are missing and the vault fails once.
    const missing = new Set(["env.server.pubsub.audience", "env.server.labeller.adminToken"])
    json(response, { entries: envEntries, status: url.searchParams.has("status") ? envEntries.map(entry => ({
      blocking: missing.has(entry.path ?? "") || entry.path === "env.server.openai.apiKey",
      path: entry.path,
      status: missing.has(entry.path ?? "") ? "missing" : entry.path === "env.server.openai.apiKey" ? "error" : entry.hasDefault && entry.path === "env.server.typesafe.model" ? "defaulted" : "available",
    })) : undefined })
    return true
  }
  if (path === "/_vitehub/api/logs") {
    const page = await logs.source.query({ text: url.searchParams.get("text") ?? undefined, level: (await import("../../packages/vite-hub/src/logs/source.ts")).parseLogQuery({ level: url.searchParams.get("level") ?? undefined }).level, cursor: url.searchParams.get("cursor") ?? undefined })
    json(response, { source: logs.source.info, page })
    return true
  }
  if (path === "/_vitehub/api/sections") {
    // A fixed build id, so the Console starts its update check. A test that answers another id shows "Update ready".
    json(response, { build: "playground", contributions: [...playgroundConsoleContributions, playgroundCommentsSection, servedSkillsConsoleSection], projectName: manifest.name, sections: playgroundSections(request) })
    return true
  }

  if (path === "/_vitehub/api/skills") {
    const agent = url.searchParams.get("agent") ?? "interface-engineer"
    const files = agent === "interface-engineer" ? playgroundSkillFiles : {}
    const filePath = url.searchParams.get("path")
    if (!agents.includes(agent)) {
      response.statusCode = 404
      response.setHeader("content-type", "text/plain; charset=utf-8")
      response.end("Agent not found.")
    }
    else if (filePath !== null) {
      const content = files[filePath]
      // The RPC bridge shows a failed body as its message, so failures answer with text, as the real handler words them.
      const failure = content === undefined ? [404, "This file is not bundled with this Agent."] as const : content.includes("\0") ? [415, "Binary files cannot be previewed as text."] as const : undefined
      if (failure) {
        response.statusCode = failure[0]
        response.setHeader("content-type", "text/plain; charset=utf-8")
        response.end(failure[1])
      }
      else json(response, { path: filePath, content, size: new TextEncoder().encode(content).byteLength })
    }
    else json(response, { agents, agent, files: Object.entries(files).map(([path, content]) => ({ path, size: new TextEncoder().encode(content).byteLength })) })
    return true
  }

  if (path === "/_vitehub/api/agents") {
    json(response, {
      agents,
      invocationAgents,
      // Every Agent accepts a new chat from the Console composer. The profiles are synthetic Invoker Profiles.
      invocation: Object.fromEntries(agents.map(agent => [agent, { profiles: agent === "product-reviewer"
        ? [{ id: "reviewer", label: "Reviewer" }, { id: "maintainer", label: "Maintainer" }]
        : [{ id: "default" }] }])),
    })
    return true
  }

  const newInvocation = /^\/_vitehub\/api\/agents\/([^/]+)\/invocations$/.exec(path)
  if (newInvocation && request.method === "POST") {
    const agentName = decodeURIComponent(newInvocation[1]!)
    if (!agents.includes(agentName)) {
      json(response, { error: "Agent invocation is not available." }, 404)
      return true
    }
    const input = v.safeParse(v.object({
      files: v.optional(v.pipe(v.array(v.object({ url: v.string(), filename: v.optional(v.string(), "image") })), v.maxLength(10)), []),
      invokerProfileId: v.optional(v.string()),
      prompt: v.optional(v.string(), ""),
    }), await body(request))
    if (!input.success) {
      json(response, { error: "Invalid Console input." }, 400)
      return true
    }
    const invokerProfileId = input.output.invokerProfileId?.trim()
    const profiles = agentName === "product-reviewer" ? ["reviewer", "maintainer"] : ["default"]
    if (input.output.invokerProfileId !== undefined && (!invokerProfileId || !profiles.includes(invokerProfileId))) {
      json(response, { error: "Unknown Agent invocation profile." }, 400)
      return true
    }
    const prompt = input.output.prompt.trim()
    const images = []
    let totalBytes = 0
    for (const file of input.output.files) {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.url)
      const bytes = match ? Buffer.from(match[2]!, "base64") : undefined
      if (!match || !bytes?.length || bytes.toString("base64") !== match[2]) {
        json(response, { error: "Provide a valid PNG, JPEG, WebP, or GIF data URL." }, 400)
        return true
      }
      totalBytes += bytes.length
      if (totalBytes > 10 * 1024 * 1024) {
        json(response, { error: "Images must total at most 10 MiB." }, 413)
        return true
      }
      // Synthetic sessions retain data URLs without writing to a Blob provider.
      images.push({ type: "image", url: file.url, name: file.filename.slice(0, 255), mediaType: match[1]!, size: bytes.length })
    }
    if (!prompt && !images.length) {
      json(response, { error: "A prompt or image is required." }, 400)
      return true
    }
    const inputMessages = images.length
      ? [{ id: "user-1", role: "user", parts: [...(prompt ? [{ type: "text", text: prompt }] : []), ...images] }]
      : undefined
    const id = `ainv_console_${randomUUID()}`
    const now = new Date().toISOString()
    store.create({
      agentName,
      annotations: { triggeredBy: "you" },
      createdAt: now,
      id,
      observations: [
        {
          attributes: {
            "input.hasPrompt": Boolean(prompt),
            "input.prompt": prompt,
            "input.hasMessages": images.length > 0,
            "input.messages": inputMessages,
            ...(invokerProfileId ? { "input.invokerProfileId": invokerProfileId } : {}),
          },
          name: "agent.invocation.start", sequence: 0, timestamp: now, type: "lifecycle",
        },
        { attributes: { "vitehub.activity.body": `Loaded ${agentName} for a Console chat. The playground never runs a model, so this session stays live.` }, name: "vitehub.agent.configured", sequence: 1, timestamp: now, type: "lifecycle" },
        ...(images.length ? [] : [{ attributes: { "message.content": prompt, "message.id": "user-1", "message.role": "user" }, name: "agent.message.recorded", sequence: 2, timestamp: now, type: "run" as const }]),
      ],
      origin: "console",
      startedAt: now,
      status: "running",
      title: prompt.length > 48 ? `${prompt.slice(0, 47)}…` : prompt || images[0]?.name || "Image chat",
      traceId: `trace_${id}`,
      updatedAt: now,
    })
    json(response, { id })
    return true
  }

  if (path === "/_vitehub/api/invocation-capabilities") {
    const agentName = url.searchParams.get("agent") || undefined
    const [capabilities, triggeredBy] = await Promise.all([
      invocations.listCapabilityIds(agentName),
      invocations.listTriggeredBy(agentName),
    ])
    json(response, { capabilities, triggeredBy })
    return true
  }

  if (path === "/_vitehub/api/status") {
    json(response, { agents: [...new Set(fixture.invocations.map(record => record.agentName).filter(Boolean))].map(agent => ({
      agent,
      checkedAt: "2026-08-30T18:00:00.000Z",
      readiness: "unsupported",
      stale: false,
      reason: "Synthetic playground data",
    })) })
    return true
  }

  if (path === "/_vitehub/api/invocations") {
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

  if (path.startsWith("/_vitehub/api/invocations/")) {
    const id = decodeURIComponent(path.slice("/_vitehub/api/invocations/".length))
    if (request.method === "POST") {
      let input: unknown
      try {
        input = await body(request)
      }
      catch {
        json(response, { error: "Malformed invocation action." }, 400)
        return true
      }
      if (!(input instanceof Object) || Array.isArray(input) || Object.keys(input).length !== 1 || !["cancel", "delete"].includes(String(Reflect.get(input, "action")))) {
        json(response, { error: "Unsupported invocation action." }, 400)
        return true
      }
      if (Reflect.get(input, "action") === "cancel") {
        const cancelOutcome = await invocations.cancel(id)
        if (cancelOutcome.outcome === "not-found") {
          json(response, { error: "Invocation not found" }, 404)
          return true
        }
        if (cancelOutcome.outcome === "terminal") {
          json(response, { error: "Only pending or running invocations can be cancelled." }, 409)
          return true
        }
        json(response, { id, outcome: cancelOutcome.outcome })
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

  if (path === "/_vitehub/api/usage") {
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

  if (path === "/_vitehub/api/database") {
    json(response, databaseInspection(url))
    return true
  }

  if (path === "/_vitehub/api/search") {
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

  if (path === "/_vitehub/api/definitions") {
    const section = url.searchParams.get("section")
    if (section === "email") {
      emailOutbox ??= captureEmailOutbox()
      await emailOutbox
      json(response, { kind: "record-table", records: readEmailOutboxConsoleRecords(), section })
      return true
    }
    if (section === "databases") {
      // Console search reads the Database catalog, like the real definitions route.
      json(response, {
        definitions: [{
          fields: [
            { label: "Mode", value: "Default" },
            { label: "Tables", value: databaseFixture.tables.map(table => table.name).join(", ") },
          ],
          file: "server/database/schema.ts",
          name: databaseFixture.schema,
          source: "database",
        }],
        kind: "definition-catalog",
        section,
      })
      return true
    }
    if (section === "schedules") {
      json(response, { kind: "record-table", records: scheduleRecords, section })
      return true
    }
    if (section !== "queues" && section !== "workflows" && section !== "rate-limits" && section !== "sandbox-tasks" && section !== "workspaces") {
      json(response, { error: "A valid definition section is required" }, 400)
      return true
    }
    json(response, { definitions: definitions[section], kind: "definition-catalog", section })
    return true
  }

  if (path === "/_vitehub/api/schedule-run" && request.method === "POST") {
    // SAFETY: The playground validates the name immediately after decoding this local JSON request.
    const input: unknown = await body(request)
    const requestedName = input instanceof Object && "name" in input ? input.name : undefined
    const name = typeof requestedName === "string" && requestedName ? requestedName : undefined
    if (!name) {
      json(response, { message: "Schedule run requires a Schedule Definition name." }, 400)
      return true
    }
    const runnable = scheduleRecords.some(record => record.cells.schedule === name
      && record.fields.some(field => field.label === "Manual" && field.value === "Enabled"))
    if (!runnable) {
      json(response, { message: "Schedule run is not available. Set manual: true on the Schedule Definition and enable Console invocation." }, 404)
      return true
    }
    const startedAt = new Date()
    json(response, { run: {
      completedAt: new Date(startedAt.getTime() + 1_250).toISOString(),
      id: `run_playground_${++scheduleRunCount}`,
      scheduleId: name,
      startedAt: startedAt.toISOString(),
      status: "succeeded",
    } })
    return true
  }

  if (path === "/_vitehub/api/rate-limit" && request.method === "POST") {
    // SAFETY: The playground checks every field right after it decodes this local JSON request.
    const input = await body(request) as { action?: unknown, key?: unknown, name?: unknown }
    const policy = definitions["rate-limits"].find(definition => definition.name === input.name)
    if (!policy || typeof input.key !== "string" || !input.key) {
      json(response, { message: "Rate Limit or key not found" }, 404)
      return true
    }
    const counterKey = `${policy.name}:${input.key}`
    const target = { key: input.key, name: policy.name, provider: "memory" }
    if (input.action === "reset") {
      rateLimitUsed.delete(counterKey)
      json(response, { ...target, scope: "process", status: "reset" })
      return true
    }
    const used = rateLimitUsed.get(counterKey)
    if (used === undefined) {
      json(response, { ...target, reason: "No request used this Rate Limit in this process since it started, so no counter exists.", status: "unused" })
      return true
    }
    const limit = Number(policy.fields.find(field => field.label === "Limit")?.value)
    const window = policy.fields.find(field => field.label === "Window")?.value
    json(response, { ...target, counters: [{ limit, remaining: Math.max(limit - used, 0), resetAt: Date.now() + 45_000, used, window, windowMs: 60_000 }], scope: "process", status: "known" })
    return true
  }

  if (path === "/_vitehub/api/blob" && request.method === "POST") {
    // SAFETY: The playground checks every field right after it decodes this local JSON request.
    const input = await body(request) as { action?: unknown, contentType?: unknown, data?: unknown, overwrite?: unknown, pathname?: unknown, store?: unknown }
    const requested = typeof input.store === "string" ? input.store : "default"
    const store = requested === "default" || requested === "uploads" ? requested : undefined
    if (!store || typeof input.pathname !== "string" || !input.pathname) {
      json(response, { message: "Blob store or pathname not found" }, 404)
      return true
    }
    const pathname = input.pathname
    if (pathname.startsWith("_vitehub/")) {
      json(response, { code: "BLOB_RESERVED_PATH", message: `ViteHub keeps ${pathname} for itself.`, status: 403 }, 403)
      return true
    }
    const blobs: Array<(typeof blobStores)["default"][number]> = blobStores[store]
    const index = blobs.findIndex(blob => blob.pathname === pathname)
    if (input.action === "delete") {
      if (index !== -1) blobs.splice(index, 1)
      json(response, { deleted: index !== -1, pathname, store })
      return true
    }
    if (index !== -1 && input.overwrite === false) {
      json(response, { code: "BLOB_EXISTS", message: `Blob ${pathname} already exists.`, status: 409 }, 409)
      return true
    }
    const object = {
      contentType: typeof input.contentType === "string" ? input.contentType : "application/octet-stream",
      customMetadata: {},
      httpEtag: '"playground"',
      httpMetadata: {},
      pathname,
      size: typeof input.data === "string" ? Math.floor(input.data.length * 3 / 4) : 0,
      uploadedAt: new Date().toISOString(),
      urlAvailable: true as const,
    }
    if (index === -1) blobs.push(object)
    else blobs[index] = object
    json(response, { created: index === -1, object, store })
    return true
  }

  if (path === "/_vitehub/api/blob") {
    const requested = url.searchParams.get("store") || "default"
    const store = requested === "default" || requested === "uploads" ? requested : undefined
    if (!store) {
      json(response, { error: "Blob store not found." }, 404)
      return true
    }
    const prefix = url.searchParams.get("prefix") || ""
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 3, 1), 250)
    const offset = Math.max(Number(url.searchParams.get("cursor")) || 0, 0)
    const matching = blobStores[store].filter(blob => blob.pathname.startsWith(prefix))
    const page = matching.slice(offset, offset + limit)
    const hasMore = offset + limit < matching.length
    const result: Record<string, unknown> = { blobs: page, hasMore, limit, prefix, store, stores: Object.keys(blobStores) }
    if (hasMore) result.cursor = String(offset + limit)
    json(response, result)
    return true
  }

  if (path === "/_vitehub/api/kv") {
    if (request.method === "POST") {
      // SAFETY: The playground handler validates both fields immediately after decoding this local JSON request.
      const input = await body(request) as { action?: unknown, key?: unknown, store?: unknown, value?: unknown }
      const name = storeName(typeof input.store === "string" ? input.store : null)
      if (!name || typeof input.key !== "string") {
        json(response, { error: "KV store or key not found" }, 404)
        return true
      }
      if ((input.action === "set" || input.action === "delete") && input.key.toLowerCase().startsWith("vitehub:")) {
        json(response, { code: "KV_RESERVED_KEY", message: `ViteHub owns the keys that start with vitehub:.`, status: 403 }, 403)
        return true
      }
      if (input.action === "set") {
        const created = !kvStores[name].has(input.key)
        kvStores[name].set(input.key, input.value)
        json(response, { created, key: input.key, store: name, type: typeof input.value })
        return true
      }
      if (input.action === "delete") {
        const deleted = kvStores[name].delete(input.key)
        json(response, { deleted, key: input.key, store: name })
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
