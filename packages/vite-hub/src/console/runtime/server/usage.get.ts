import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { createUsageSummary, parseConsoleUsageWindow } from "./usage.ts"

import type { ConsoleRequestEvent } from "./request.ts"
import type { AgentInvocations } from "@vite-hub/agent"

const caches = new WeakMap<AgentInvocations, Map<string, { expiresAt: number, value: Promise<Record<string, unknown>> }>>()

function cached(
  invocations: AgentInvocations,
  key: string,
  resolve: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const cache = caches.get(invocations) ?? new Map()
  caches.set(invocations, cache)
  const now = Date.now()
  for (const [cachedKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(cachedKey)
  }
  const current = cache.get(key)
  if (current && current.expiresAt > now) return current.value
  const value = Promise.resolve().then(resolve).catch((error) => {
    if (cache.get(key)?.value === value) cache.delete(key)
    throw error
  })
  cache.set(key, { expiresAt: now + 5_000, value })
  return value
}

const usageHandler = async (event: ConsoleRequestEvent): Promise<Record<string, unknown>> => {
  assertConsoleRequest(event)
  const query = consoleRequestURL(event).searchParams
  const agentName = query.get("agent")?.trim() || undefined
  if (agentName && agentName.length > 512) {
    throw Object.assign(new Error("Invalid Agent name"), {
      statusCode: 400,
      statusMessage: "Invalid Agent name",
    })
  }
  const windowValue = query.get("window")
  const window = windowValue === null ? "30d" : parseConsoleUsageWindow(windowValue)
  if (!window) {
    throw Object.assign(new Error("Invalid usage window"), {
      statusCode: 400,
      statusMessage: "Invalid usage window",
    })
  }
  const invocations = getConsoleInvocations()
  return cached(invocations, JSON.stringify([agentName ?? null, window]), () => createUsageSummary(
    invocations,
    { agentName, window },
  ))
}

export default usageHandler
