import { inspectAgentCapacity } from "./internal/agent-capacity.ts"
import { normalizeAgentDriver } from "./internal/agent-driver.ts"
import type { AgentDefinition, AgentInput, AgentRuntimeContext, MaybePromise } from "./types.ts"

export type AgentHealthStatus = "ready" | "degraded" | "unsupported" | "unavailable" | "stale" | "missing-credentials" | "missing-executable" | "quota-exhausted" | "timeout"

export interface AgentHealthReport {
  status: AgentHealthStatus
  ok: boolean
  timestamp: string
  agent?: { name?: string, version?: string }
  runtime: { node: boolean, pid?: number }
  driver?: { kind?: string, model?: unknown, provider?: string }
  capacity?: ReturnType<typeof inspectAgentCapacity>
  workspace: { configured: boolean, ready: boolean }
  integrations: Record<string, { configured: boolean, status: AgentHealthStatus }>
  checks: Record<string, { status: AgentHealthStatus, detail?: string }>
}

export interface AgentHealthHandlerOptions {
  runtime?: AgentRuntimeContext
  agentName?: string
}

function settingsOf(agent: AgentInput): Record<string, any> {
  return ((agent as any).__vitehubAgentSettings || {}) as Record<string, any>
}

export async function resolveAgentHealth(agent: AgentInput, options: AgentHealthHandlerOptions = {}): Promise<AgentHealthReport> {
  const settings = settingsOf(agent)
  const checks: AgentHealthReport["checks"] = {}
  let driver: any
  try {
    driver = normalizeAgentDriver(settings as any)
    checks.driver = { status: driver ? "ready" : "unsupported" }
  }
  catch (error) {
    checks.driver = { status: "unavailable", detail: error instanceof Error ? error.message : String(error) }
  }
  const workspaceConfigured = Boolean(settings.workspace || (agent as any).__vitehubWorkspaceAgent)
  checks.workspace = { status: workspaceConfigured ? "ready" : "unsupported" }
  const box = settings.box
  const integrations: AgentHealthReport["integrations"] = {}
  if (box && typeof box === "object") {
    for (const key of Object.keys(box)) integrations[key] = { configured: true, status: "ready" }
  }
  const capacity = inspectAgentCapacity(agent as object)
  if (capacity && capacity.queue && capacity.pending >= capacity.queue.maxPending) {
    checks.capacity = { status: "quota-exhausted" }
  }
  else checks.capacity = { status: "ready" }
  const failed = Object.values(checks).find(check => check.status !== "ready" && check.status !== "unsupported")
  const status: AgentHealthStatus = failed?.status || "ready"
  return {
    status,
    ok: status === "ready" || status === "unsupported",
    timestamp: new Date().toISOString(),
    agent: { name: settings.name, version: settings.version },
    runtime: { node: typeof process !== "undefined", ...(typeof process !== "undefined" ? { pid: process.pid } : {}) },
    ...(driver ? { driver: { kind: driver.kind, model: typeof driver.model === "string" ? driver.model : undefined, provider: driver.provider } } : {}),
    ...(capacity ? { capacity } : {}),
    workspace: { configured: workspaceConfigured, ready: workspaceConfigured },
    integrations,
    checks,
  }
}

export function createAgentHealthHandler(agent: AgentInput, defaults: AgentHealthHandlerOptions = {}) {
  return async (request: Request, options: AgentHealthHandlerOptions = {}): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") return Response.json({ status: 405, message: "Method not allowed." }, { status: 405 })
    const report = await resolveAgentHealth(agent, { ...defaults, ...options })
    return Response.json(report, { status: report.ok ? 200 : 503, headers: { "cache-control": "no-store" } })
  }
}

