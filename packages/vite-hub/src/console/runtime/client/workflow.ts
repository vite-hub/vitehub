import { requestConsole } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

/** One Workflow run as the Workflows page shows it. */
export interface ConsoleWorkflowRunView {
  error?: string
  id: string
  provider: string
  result?: string
  status: string
  workflow: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function text(value: unknown): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
  return typeof value === "string" ? value : undefined
}

export function parseConsoleWorkflowRun(value: unknown): ConsoleWorkflowRunView {
  const run = record(record(value)?.run)
  const id = text(run?.id)
  const status = text(run?.status)
  if (!run || !id || !status) throw viteHubErrorDiagnostics.VITE_HUB_R0098({ message: "The Console returned an invalid Workflow run." })
  const error = text(record(run.error)?.message)
  return {
    ...(error ? { error } : {}),
    id,
    provider: text(run.provider) ?? "",
    ...(run.result === undefined ? {} : { result: JSON.stringify(run.result, null, 2) }),
    status,
    workflow: text(run.workflow) ?? "",
  }
}

/** Reads the JSON text of a payload field. An empty field means no payload. */
export function parseConsoleWorkflowPayload(raw: string): unknown {
  if (raw.trim() === "") return undefined
  try {
    return JSON.parse(raw)
  }
  catch {
    throw new Error("The payload is not valid JSON.")
  }
}

/** Runs states that can still change, so the page keeps offering Refresh and Cancel. */
export function isConsoleWorkflowRunActive(status: string): boolean {
  return status === "queued" || status === "running"
}

export async function startConsoleWorkflow(base: string, workflow: string, payload: unknown): Promise<ConsoleWorkflowRunView> {
  return parseConsoleWorkflowRun(await requestConsole(base, { body: { action: "start", ...(payload === undefined ? {} : { payload }), workflow }, method: "POST" }))
}

export async function readConsoleWorkflow(base: string, run: Pick<ConsoleWorkflowRunView, "id" | "workflow">): Promise<ConsoleWorkflowRunView> {
  return parseConsoleWorkflowRun(await requestConsole(base, { body: { action: "get", runId: run.id, workflow: run.workflow }, method: "POST" }))
}

export async function cancelConsoleWorkflow(base: string, run: Pick<ConsoleWorkflowRunView, "id" | "workflow">): Promise<ConsoleWorkflowRunView> {
  return parseConsoleWorkflowRun(await requestConsole(base, { body: { action: "cancel", runId: run.id, workflow: run.workflow }, method: "POST" }))
}

export async function resumeConsoleWorkflow(base: string, token: string, payload: unknown): Promise<void> {
  await requestConsole(base, { body: { action: "resume", ...(payload === undefined ? {} : { payload }), token }, method: "POST" })
}
