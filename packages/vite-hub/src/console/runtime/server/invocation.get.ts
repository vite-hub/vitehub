import { getConsoleInvocations } from "./invocations.ts"
import { assertLocalConsoleRequest, consoleRequestURL } from "./local-request.ts"

import type { ConsoleRequestEvent } from "./local-request.ts"
import type { AgentInvocationSummary } from "@vite-hub/agent"
import type { TraceEventLogEntry } from "@vite-hub/runtime"

interface ConsoleInvocationDetail {
  invocation: AgentInvocationSummary
  observations: readonly TraceEventLogEntry[]
}

const invocationHandler: (event: ConsoleRequestEvent) => Promise<ConsoleInvocationDetail> = async (event) => {
  assertLocalConsoleRequest(event)
  const pathId = consoleRequestURL(event).pathname.split("/").at(-1)
  const id = event.context?.params?.id ?? (pathId ? decodeURIComponent(pathId) : "")
  const invocation = await getConsoleInvocations().get(id)
  if (!invocation) {
    throw Object.assign(new Error("Invocation not found"), {
      statusCode: 404,
      statusMessage: "Invocation not found",
    })
  }
  const { observations, ...summary } = invocation
  return { invocation: summary, observations }
}

export default invocationHandler
