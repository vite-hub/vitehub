import { H3, createError, getQuery, getRequestURL, readBody, readValidatedBody } from "h3"
import { desc, sql } from "drizzle-orm"
import * as v from "valibot"

import { blob } from "@vite-hub/blob"
import { useDatabase } from "@vite-hub/database/drizzle"
import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { kv } from "@vite-hub/kv"
import { deferQueue, runQueue } from "@vite-hub/queue"
import { requireRateLimit } from "@vite-hub/rate-limit"
import { runSandbox } from "@vite-hub/sandbox"
import { useWorkspace } from "@vite-hub/workspace"
import { getWorkspaceRuntimeConfig, resetWorkspaceStoreCache } from "@vite-hub/workspace/runtime"
import { deferWorkflow, getWorkflowRun, runWorkflow } from "@vite-hub/workflow"
import { resolveTrustedMarkerCallbackUrl } from "../../_shared/queue-test"

const app = new H3()
const analytics = useDatabase("analytics")
const queueName = "welcome-email"
const primary = useDatabase("primary")
const workflowName = "welcome"

declare global {
  var __vitehubScheduleMarker: { id: string, provider: string, ranAt: string, schedule: string } | undefined
}

const blobDeleteBody = v.object({
  pathname: v.string(),
})
const blobPutBody = v.optional(v.object({
  pathname: v.optional(v.string()),
  value: v.optional(v.string()),
}), {})
const markerBody = v.object({
  marker: v.string(),
})
const noteBody = v.object({
  title: v.string(),
})
const analyticsEventBody = v.object({
  name: v.string(),
})
const queueBody = v.optional(v.object({
  callbackUrl: v.optional(v.string()),
  email: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})
const workflowBody = v.optional(v.object({
  email: v.optional(v.string()),
  id: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})
const workspaceWriteBody = v.optional(v.object({
  content: v.optional(v.string()),
  path: v.optional(v.string()),
}), {})

function resolveMarker<T extends { marker?: string }>(body: T | undefined, event: Parameters<typeof readValidatedBody>[0]) {
  return typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
}

function resolveWorkflowId(body: { id?: string, marker?: string } | undefined, marker: string | undefined) {
  return body?.id || marker
}

function resolveKVProvider(event: unknown) {
  return getCloudflareEnv(event) ? "cloudflare-kv-binding" : "upstash"
}

function resolveWorkspaceProvider(_event: unknown) {
  return getWorkspaceRuntimeConfig()?.store.provider ?? "memory"
}

function resolveSandboxHosting(event: { req: { runtime?: { name?: string }, waitUntil?: unknown } }) {
  const hasWaitUntil = typeof event.req.waitUntil === "function"
  if (getCloudflareEnv(event)) {
    return {
      hasWaitUntil,
      hosting: "cloudflare-module",
      provider: "cloudflare",
      runtime: event.req.runtime?.name || "cloudflare",
    }
  }

  return {
    hasWaitUntil,
    hosting: "vercel",
    provider: "vercel",
    runtime: event.req.runtime?.name || (process.env.VERCEL ? "vercel" : null),
  }
}

function assertCloudflareRateLimit(event: unknown) {
  if (!getCloudflareEnv(event)) {
    throw createError({ statusCode: 501, statusMessage: "Rate Limit has no native provider for this host" })
  }
}

async function ensureNotesTable() {
  await primary.db.run(sql`
    create table if not exists notes (
      id integer primary key autoincrement,
      title text not null
    )
  `)
}

async function ensureAnalyticsEventsTable() {
  await analytics.db.run(sql`
    create table if not exists analytics_events (
      id integer primary key autoincrement,
      name text not null
    )
  `)
}

app.get("/", () => ({
  blob: true,
  db: true,
  kv: true,
  ok: true,
  queue: queueName,
  schedule: "daily-marker",
  sandbox: true,
  workflow: workflowName,
}))

app.get("/api/blob", async (event) => {
  const query = getQuery(event)
  const [error, result] = await blob.list({
    folded: query.folded === "true",
    limit: typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : undefined,
    prefix: typeof query.prefix === "string" ? query.prefix : undefined,
  })
  if (error) throw error
  return result
})

app.put("/api/blob", async (event) => {
  const body = await readValidatedBody(event, blobPutBody)
  const [error, object] = await blob.put(body?.pathname || "notes/hello.txt", body?.value || "hello world", {
    contentType: "text/plain; charset=utf-8",
  })
  if (error) throw error
  return object
})

app.delete("/api/blob", async (event) => {
  const body = await readValidatedBody(event, blobDeleteBody)
  const [error] = await blob.del(body.pathname)
  if (error) throw error
  return { ok: true }
})

app.get("/api/blob/head", async (event) => {
  const pathname = getQuery(event).pathname
  if (typeof pathname !== "string" || pathname.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "Missing pathname" })
  }

  const [error, object] = await blob.head(pathname)
  if (error) throw error
  return object
})

app.get("/api/blob/body", async (event) => {
  const pathname = getQuery(event).pathname
  if (typeof pathname !== "string" || pathname.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "Missing pathname" })
  }

  const [error, file] = await blob.get(pathname)
  if (error) throw error
  return {
    ok: true,
    text: file ? await file.text() : null,
  }
})

app.get("/api/blob/serve", async (event) => {
  const pathname = getQuery(event).pathname
  if (typeof pathname !== "string" || pathname.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "Missing pathname" })
  }

  const [error, stream] = await blob.serve(event, pathname)
  if (error) throw error
  return stream
})

app.get("/api/database", async () => {
  await ensureNotesTable()
  const notes = await primary.db.select().from(primary.schema.notes).orderBy(desc(primary.schema.notes.id))
  return { notes, ok: true }
})

app.post("/api/database", async (event) => {
  await ensureNotesTable()
  const body = await readValidatedBody(event, noteBody)
  const result = await primary.db.insert(primary.schema.notes).values({ title: body.title }).returning()
  return { note: result[0], ok: true }
})

app.get("/api/database/analytics", async () => {
  await ensureAnalyticsEventsTable()
  const events = await analytics.db
    .select()
    .from(analytics.schema.analyticsEvents)
    .orderBy(desc(analytics.schema.analyticsEvents.id))
  return { events, ok: true }
})

app.post("/api/database/analytics", async (event) => {
  await ensureAnalyticsEventsTable()
  const body = await readValidatedBody(event, analyticsEventBody)
  const result = await analytics.db
    .insert(analytics.schema.analyticsEvents)
    .values({ name: body.name })
    .returning()
  return { event: result[0], ok: true }
})

app.get("/api/queues/welcome", () => ({ ok: true, queue: queueName }))

app.post("/api/queues/welcome", async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = resolveMarker(body, event)
  const callbackUrl = marker ? resolveTrustedMarkerCallbackUrl(getRequestURL(event), body?.callbackUrl) : undefined

  return {
    ok: true,
    result: await runQueue(queueName, {
      email: body?.email || "ava@example.com",
      callbackUrl,
      marker,
    }),
  }
})

app.post("/api/queues/welcome-defer", async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = resolveMarker(body, event)
  const callbackUrl = marker ? resolveTrustedMarkerCallbackUrl(getRequestURL(event), body?.callbackUrl) : undefined
  const payload = {
    email: body?.email || "ava@example.com",
    callbackUrl,
    marker,
  }

  deferQueue(queueName, payload)

  return { ok: true }
})

app.post("/api/tests/kv", async () => {
  const key = "smoke"
  const [writeError] = await kv.set(key, { key, store: "kv" })
  if (writeError) throw writeError
  const [readError, value] = await kv.get(key)
  if (readError) throw readError
  return { ok: true, value }
})

app.get("/api/tests/probe", (event) => {
  if (getQuery(event).sandbox) {
    return {
      feature: "sandbox",
      ok: true,
      ...resolveSandboxHosting(event),
    }
  }

  return {
    ok: true,
    provider: resolveKVProvider(event),
  }
})

app.get("/api/tests/queue", async (event) => {
  const marker = getQuery(event).marker
  const key = typeof marker === "string" && marker.length > 0
    ? `queue-e2e:${marker}`
    : ""

  const [error, seen] = key ? await kv.has(key) : [null, false] as const
  if (error) throw error
  return {
    ok: true,
    seen,
  }
})

app.post("/api/tests/queue", async (event) => {
  const body = await readValidatedBody(event, markerBody)
  const [error] = await kv.set(`queue-e2e:${body.marker}`, true)
  if (error) throw error
  return { ok: true }
})

app.post("/api/tests/rate-limit", async (event) => {
  assertCloudflareRateLimit(event)
  const key = getQuery(event).key
  await requireRateLimit(event, "e2e-rate-limit-key", {
    enforcement: "best-effort",
    key: typeof key === "string" && key.length > 0 ? key : undefined,
    limit: 5,
    window: "10s",
  })
  return { ok: true }
})

app.post("/api/tests/rate-limit/address", async (event) => {
  assertCloudflareRateLimit(event)
  await requireRateLimit(event, "e2e-rate-limit-address", {
    enforcement: "best-effort",
    limit: 1_000,
    window: "10s",
  })
  return { ok: true }
})

app.get("/api/tests/schedule", async () => {
  const [error, storedMarker] = await kv.get("schedule-e2e:daily-marker")
  if (error) throw error
  const marker = storedMarker ?? globalThis.__vitehubScheduleMarker
  return {
    ok: true,
    marker,
    seen: Boolean(marker),
  }
})

app.get("/api/workspace", async (event) => {
  const workspace = useWorkspace("docs", { mode: "write" })
  return {
    ok: true,
    provider: resolveWorkspaceProvider(event),
    files: await workspace.fs.list("", { recursive: true }),
    markdown: await workspace.fs.glob("**/*.md"),
    readme: await workspace.fs.readFile("README.md"),
  }
})

app.post("/api/workspace/write", async (event) => {
  const body = await readValidatedBody(event, workspaceWriteBody)
  const workspace = useWorkspace("docs", { mode: "write" })
  const path = body?.path || "generated/e2e-notes.md"
  await workspace.fs.writeFile(path, body?.content || "Generated by Vite e2e\n")
  return {
    ok: true,
    provider: resolveWorkspaceProvider(event),
    path,
    readBack: await workspace.fs.readFile(path),
  }
})

app.get("/api/workspace/read-fresh", async (event) => {
  const query = getQuery(event)
  const path = typeof query.path === "string" ? query.path : "generated/e2e-notes.md"
  resetWorkspaceStoreCache()
  const workspace = useWorkspace("docs", { mode: "write" })
  return {
    ok: true,
    provider: resolveWorkspaceProvider(event),
    path,
    readBack: await workspace.fs.exists(path) ? await workspace.fs.readFile(path) : null,
  }
})

app.post("/api/sandboxes/release-notes", async (event) => {
  const [error, result] = await runSandbox("release-notes", await readBody(event))

  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error.message,
      data: {
        code: error.code,
        provider: error.provider,
      },
    })
  }

  return { result }
})

app.get("/api/workflows/welcome", () => ({ ok: true, workflow: workflowName }))

app.post("/api/workflows/welcome", async (event) => {
  const body = await readValidatedBody(event, workflowBody)
  const marker = resolveMarker(body, event)

  return {
    ok: true,
    result: await runWorkflow(workflowName, { email: body?.email || "ava@example.com", marker }, { id: resolveWorkflowId(body, marker) }),
  }
})

app.post("/api/workflows/welcome-defer", async (event) => {
  const body = await readValidatedBody(event, workflowBody)
  const marker = resolveMarker(body, event)

  return {
    ok: true,
    result: await deferWorkflow(workflowName, { email: body?.email || "ava@example.com", marker }, { id: resolveWorkflowId(body, marker) }),
  }
})

app.get("/api/workflows/welcome/:id", async (event) => {
  const id = event.context.params?.id
  return id ? await getWorkflowRun(workflowName, id) : { status: "unknown" }
})

export default app
