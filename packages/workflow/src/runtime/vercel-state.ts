import type { WorkflowRunStatus } from "../types.ts"

interface PersistedWorkflowRun {
  error?: unknown
  result?: unknown
  status: Exclude<WorkflowRunStatus, "unknown">
}

const RUNS_TTL_SECONDS = 5 * 60

function readEnv(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
  return value && value.trim() ? value : undefined
}

function getUpstashConfig(): { token: string, url: string } | undefined {
  const url = readEnv("KV_REST_API_URL") || readEnv("UPSTASH_REDIS_REST_URL")
  const token = readEnv("KV_REST_API_TOKEN") || readEnv("UPSTASH_REDIS_REST_TOKEN")
  return url && token ? { token, url } : undefined
}

function getRunKey(name: string, id: string): string {
  return `vitehub:workflow:runs:${encodeURIComponent(name)}:${encodeURIComponent(id)}`
}

async function command<T>(body: unknown[]): Promise<T | undefined> {
  const config = getUpstashConfig()
  if (!config || typeof fetch !== "function") {
    return undefined
  }

  const response = await fetch(config.url, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    method: "POST",
  })
  if (!response.ok) {
    return undefined
  }
  const payload = await response.json() as { result?: T }
  return payload.result
}

export async function setVercelWorkflowRunState(name: string, id: string, run: PersistedWorkflowRun): Promise<void> {
  const value = JSON.stringify(run)
  await command(["SET", getRunKey(name, id), value, "EX", RUNS_TTL_SECONDS])
}

export async function getVercelWorkflowRunState(name: string, id: string): Promise<PersistedWorkflowRun | undefined> {
  const value = await command<string | null>(["GET", getRunKey(name, id)])
  if (!value) {
    return undefined
  }
  try {
    const parsed = JSON.parse(value) as PersistedWorkflowRun
    return parsed && typeof parsed.status === "string" ? parsed : undefined
  }
  catch {
    return undefined
  }
}
