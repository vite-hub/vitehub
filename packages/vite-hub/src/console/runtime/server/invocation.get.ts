import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { invocationUsage } from "./usage.ts"

import type { ConsoleRequestEvent } from "./request.ts"
import type { AgentInvocationSummary } from "@vite-hub/agent"
import type { TraceEventLogEntry } from "@vite-hub/runtime"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

interface ConsoleInvocationDetail {
  appendObservations?: boolean
  invocation: AgentInvocationSummary & { usage?: ReturnType<typeof invocationUsage> }
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

const invocationHandler: (event: ConsoleRequestEvent) => Promise<ConsoleInvocationDetail> = async (event) => {
  assertConsoleRequest(event)
  const pathId = consoleRequestURL(event).pathname.split("/").at(-1)
  const id = event.context?.params?.id ?? (pathId ? decodeURIComponent(pathId) : "")
  const invocation = await getConsoleInvocations().get(id)
  if (!invocation) {
    throw Object.assign(viteHubErrorDiagnostics.VITE_HUB_R0054({ message: "Invocation not found" }), {
      statusCode: 404,
      statusMessage: "Invocation not found",
    })
  }
  const { observations, ...summary } = invocation
  const usage = invocationUsage(invocation)
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
    invocation: { ...summary, ...(usage ? { usage } : {}) },
    observationCursor: observationCursor(observations),
    observations: canAppend
      ? observations.slice(observationCount)
      : observations,
  }
  if (canAppend) detail.appendObservations = true
  return detail
}

export default invocationHandler
