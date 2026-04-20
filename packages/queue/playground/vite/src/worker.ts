import { createApp, defineEventHandler, readBody } from "h3"

import { deferQueue, runQueue } from "@vitehub/queue"
import { readQueueState, resetQueueState } from "../queue-state.ts"

const queueName = "welcome-email"

function detectRuntime(event: { context?: { cloudflare?: unknown, _platform?: { cloudflare?: unknown } }, req?: { runtime?: { cloudflare?: unknown } }, waitUntil?: unknown }) {
  if (event.context?.cloudflare || event.context?._platform?.cloudflare || event.req?.runtime?.cloudflare) {
    return "cloudflare"
  }

  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    return "vercel"
  }

  return "node"
}

function readHeader(headers: Headers | Record<string, unknown> | undefined, name: string) {
  if (!headers) {
    return undefined
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }

  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : typeof value === "string" ? value : undefined
}

const app = createApp()

app.get("/api/tests/probe", defineEventHandler((event) => {
  return {
    hasWaitUntil: typeof event.waitUntil === "function",
    ok: true,
    queue: queueName,
    runtime: detectRuntime(event),
  }
}))

app.get("/api/tests/queue-state", defineEventHandler(async () => ({
  jobs: await readQueueState(),
  ok: true,
})))

app.delete("/api/tests/queue-state", defineEventHandler(async () => {
  await resetQueueState()
  return { ok: true }
}))

app.get("/api/queues/welcome", defineEventHandler((event) => ({
  hasWaitUntil: typeof event.waitUntil === "function",
  ok: true,
  queue: queueName,
  runtime: detectRuntime(event),
})))

app.post("/api/queues/welcome", defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string, marker?: string }>(event).catch(() => ({}))
  const marker = typeof body?.marker === "string" ? body.marker : readHeader(event.headers, "x-vitehub-e2e-marker")
  return {
    ok: true,
    result: await runQueue(queueName, {
      email: body?.email || "ava@example.com",
      marker,
    }),
  }
}))

app.post("/api/queues/welcome-defer", defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string, marker?: string }>(event).catch(() => ({}))
  const marker = typeof body?.marker === "string" ? body.marker : readHeader(event.headers, "x-vitehub-e2e-marker")
  deferQueue(queueName, {
    email: body?.email || "ava@example.com",
    marker,
  })
  return { ok: true }
}))

export default app
