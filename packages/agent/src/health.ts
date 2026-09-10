import { inspectAgentCapacity } from "./internal/agent-capacity.ts"
import { normalizeAgentDriver } from "./internal/agent-driver.ts"
import { hasRuntimeType } from "./internal/runtime-type.ts"
import type { AgentInput, AgentRuntimeContext, AgentSettings } from "./types.ts"

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

type AgentHealthTarget = Pick<AgentInput, "workspace" | "box" | "name" | "version">

function settingsOf(agent: AgentHealthTarget): AgentSettings | undefined {
  // SAFETY: defineAgent attaches this optional private settings field to its callable Agent definition.
  return (agent as AgentHealthTarget & { __vitehubAgentSettings?: AgentSettings }).__vitehubAgentSettings
}

export async function resolveAgentHealth(agent: AgentHealthTarget, options: AgentHealthHandlerOptions = {}): Promise<AgentHealthReport> {
  const settings = settingsOf(agent)
  const checks: AgentHealthReport["checks"] = {}
  let driver: ReturnType<typeof normalizeAgentDriver> | undefined
  try {
    driver = settings ? normalizeAgentDriver(settings) : undefined
    checks.driver = { status: driver ? "ready" : "unsupported" }
  }
  catch (error) {
    checks.driver = { status: "unavailable", detail: error instanceof Error ? error.message : String(error) }
  }
  const workspaceConfigured = Boolean(agent.workspace || settings?.workspace)
  checks.workspace = { status: workspaceConfigured ? "ready" : "unsupported" }
  const box = agent.box || settings?.box
  const integrations: AgentHealthReport["integrations"] = {}
  if (box && hasRuntimeType(box, "object")) {
    for (const key of Object.keys(box)) integrations[key] = { configured: true, status: "ready" }
  }
  const capacity = inspectAgentCapacity(agent)
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
    agent: { name: options.agentName || agent.name, version: agent.version },
    runtime: { node: Boolean(globalThis.process), ...(globalThis.process ? { pid: globalThis.process.pid } : {}) },
    ...(driver ? { driver: { kind: driver.kind, model: "model" in driver && hasRuntimeType(driver.model, "string") ? driver.model : undefined, provider: driver.kind === "provider" ? driver.provider : undefined } } : {}),
    ...(capacity ? { capacity } : {}),
    workspace: { configured: workspaceConfigured, ready: workspaceConfigured },
    integrations,
    checks,
  }
}

export function createAgentHealthHandler(agent: AgentHealthTarget, defaults: AgentHealthHandlerOptions = {}) {
  return async (request: Request, options: AgentHealthHandlerOptions = {}): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") return Response.json({ status: 405, message: "Method not allowed." }, { status: 405 })
    const report = await resolveAgentHealth(agent, { ...defaults, ...options })
    const response = Response.json(report, { status: report.ok ? 200 : 503, headers: { "cache-control": "no-store" } })
    return request.method === "HEAD" ? new Response(null, response) : response
  }
}
