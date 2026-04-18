import type { H3Event } from "h3"
import { defineEventHandler, readBody } from "h3"
import { runQueue } from "@vitehub/queue"

function readHeader(event: H3Event, name: string) {
  const headers = event.node?.req?.headers as Headers | Record<string, string | string[] | undefined> | undefined
  if (!headers) return undefined
  if ("get" in headers && typeof headers.get === "function") return headers.get(name) ?? undefined

  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

export function createWelcomeHandler(queueName: string) {
  return defineEventHandler(async (event) => {
    const body = await readBody<{ email?: string, marker?: string }>(event).catch(() => ({}))
    const marker = typeof body.marker === "string"
      ? body.marker
      : readHeader(event, "x-vitehub-e2e-marker")
    const result = await runQueue(queueName, {
      email: body.email || "ava@example.com",
      marker,
    })
    return { ok: true, result }
  })
}

export default createWelcomeHandler("welcome-email")
