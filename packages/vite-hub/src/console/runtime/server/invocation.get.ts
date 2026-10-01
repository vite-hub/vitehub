import { agentInvocationRerunInput } from "@vite-hub/agent"
import * as v from "valibot"

import { consoleAgentInvokerProfiles, getConsoleAgentDefinition } from "./agents.ts"
import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestJSON, consoleRequestURL } from "./request.ts"
import { invocationUsage } from "./usage.ts"

import type { ConsoleRequestEvent } from "./request.ts"
import type { AgentInvocationDeleteOutcome, AgentInvocationRecord, AgentInvocationRerunUnavailableReason, AgentInvocationSummary } from "@vite-hub/agent"
import type { TraceEventLogEntry } from "@vite-hub/runtime"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

type ConsoleInvocationRerun =
  | { available: true, invokerProfileId?: string, prompt: string }
  | { available: false, reason: AgentInvocationRerunUnavailableReason | "invoker-profile-unavailable" | "invocation-not-terminal" }

/** Record actions that Console invoke access allows. */
interface ConsoleInvocationActions {
  delete: { available: boolean, reason?: "store-delete-unavailable" }
  rerun: ConsoleInvocationRerun
}

interface ConsoleInvocationDetail {
  appendObservations?: boolean
  invocation: AgentInvocationSummary & { actions?: ConsoleInvocationActions, usage?: ReturnType<typeof invocationUsage> }
  observationCursor: string
  observations: readonly TraceEventLogEntry[]
}

function observationCursor(observations: readonly TraceEventLogEntry[], count = observations.length): string {
  let fnv = 2_166_136_261
  let djb = 5_381
  for (let index = 0; index < count; index++) {
    const serialized = JSON.stringify(observations[index])
    for (let offset = 0; offset <= serialized.length; offset++) {
      const code = offset === serialized.length ? 0 : serialized.charCodeAt(offset)
      fnv = Math.imul(fnv ^ code, 16_777_619)
      djb = Math.imul(djb, 33) ^ code
    }
  }
  return `${count.toString(36)}-${(fnv >>> 0).toString(36)}-${(djb >>> 0).toString(36)}`
}

const deleteActionSchema = v.strictObject({ action: v.literal("delete") })
const terminalStatuses: ReadonlySet<AgentInvocationSummary["status"]> = new Set(["cancelled", "completed", "failed"])

function notFound(): Error {
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_R0054({ message: "Invocation not found" }), {
    statusCode: 404,
    statusMessage: "Invocation not found",
  })
}

function actionError(statusCode: number, statusMessage: string): Error {
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_R0046({ message: statusMessage }), { statusCode, statusMessage })
}

// Console invoke access for the record's Agent allows these actions.
function invocationActions(invocation: AgentInvocationRecord): ConsoleInvocationActions | undefined {
  const agent = invocation.agentName ? getConsoleAgentDefinition(invocation.agentName) : undefined
  if (!agent) return
  const input = terminalStatuses.has(invocation.status)
    ? agentInvocationRerunInput(invocation)
    : { available: false, reason: "invocation-not-terminal" } as const
  const profile = input.available && input.invokerProfileId
    ? consoleAgentInvokerProfiles(agent).find(candidate => candidate.id === input.invokerProfileId)
    : undefined
  const rerun: ConsoleInvocationRerun = input.available && input.invokerProfileId && !profile
    ? { available: false, reason: "invoker-profile-unavailable" }
    : input
  return {
    delete: getConsoleInvocations().supportsDelete
      ? { available: terminalStatuses.has(invocation.status) }
      : { available: false, reason: "store-delete-unavailable" },
    rerun,
  }
}

function requestedInvocationId(event: ConsoleRequestEvent): string {
  const pathId = consoleRequestURL(event).pathname.split("/").at(-1)
  return event.context?.params?.id ?? (pathId ? decodeURIComponent(pathId) : "")
}

/** Delete one terminal invocation after the Console checks invoke access for its Agent. */
export async function deleteConsoleInvocation(event: ConsoleRequestEvent): Promise<{ id: string, outcome: AgentInvocationDeleteOutcome }> {
  assertConsoleRequest(event, ["POST"])
  const id = requestedInvocationId(event)
  let body: unknown
  try {
    body = await consoleRequestJSON(event)
  }
  catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error
    throw actionError(400, "Malformed invocation action.")
  }
  if (!v.safeParse(deleteActionSchema, body).success) throw actionError(400, "Unsupported invocation action.")
  const invocations = getConsoleInvocations()
  const summary = await invocations.getSummary(id)
  if (!summary) throw notFound()
  if (!summary.agentName || !getConsoleAgentDefinition(summary.agentName)) throw actionError(403, "Deleting this invocation requires Console invoke access for its Agent.")
  if (!invocations.supportsDelete) throw actionError(409, "This invocation store does not support deletion.")
  const outcome = await invocations.delete(id)
  if (outcome === "not-found") throw notFound()
  if (outcome === "not-terminal") throw actionError(409, "Only completed, failed, or cancelled invocations can be deleted.")
  return { id, outcome }
}

/** Read one invocation with its observations and the actions that Console access allows. */
export async function getConsoleInvocationDetail(event: ConsoleRequestEvent): Promise<ConsoleInvocationDetail> {
  assertConsoleRequest(event, ["GET"])
  const invocation = await getConsoleInvocations().get(requestedInvocationId(event))
  if (!invocation) throw notFound()
  const { observations, ...summary } = invocation
  const usage = invocationUsage(invocation)
  const actions = invocationActions(invocation)
  const requestURL = consoleRequestURL(event)
  const countValue = requestURL.searchParams.get("observationCount")
  const requestedCursor = requestURL.searchParams.get("observationCursor")
  const observationCount = countValue === null ? undefined : Number(countValue)
  const canAppend = invocation.observationsTruncated !== true
    && requestedCursor !== null
    && observationCount !== undefined
    && Number.isSafeInteger(observationCount)
    && observationCount >= 0
    && observationCount <= observations.length
    && requestedCursor === observationCursor(observations, observationCount)
  const detail: ConsoleInvocationDetail = {
    invocation: { ...summary, ...(actions ? { actions } : {}), ...(usage ? { usage } : {}) },
    observationCursor: observationCursor(observations),
    observations: canAppend
      ? observations.slice(observationCount)
      : observations,
  }
  if (canAppend) detail.appendObservations = true
  return detail
}

// The devframe `invocation` operation reads one record with GET and changes it with POST.
const invocationHandler = async (event: ConsoleRequestEvent): Promise<ConsoleInvocationDetail | Awaited<ReturnType<typeof deleteConsoleInvocation>>> => {
  assertConsoleRequest(event, ["GET", "POST"])
  return (event.method ?? event.req?.method ?? event.node?.req?.method) === "POST"
    ? await deleteConsoleInvocation(event)
    : await getConsoleInvocationDetail(event)
}

export default invocationHandler
