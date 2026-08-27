import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { createUsageSummary } from "./usage.ts"

import type { ConsoleUsageWindow } from "./usage.ts"
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
  const window = (query.get("window") || "30d") as ConsoleUsageWindow
  const invocations = getConsoleInvocations()
  return cached(invocations, `${agentName || "*"}:${window}`, () => createUsageSummary(
    invocations,
    { agentName, window },
  ))
}

export default usageHandler
