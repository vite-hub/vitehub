import { getConsoleInvocations } from "./invocations.ts"
import { assertLocalConsoleRequest, consoleRequestURL } from "./local-request.ts"

import type { ConsoleRequestEvent } from "./local-request.ts"
import type { AgentInvocationListResult } from "@vite-hub/agent"

const invocationsHandler: (event: ConsoleRequestEvent) => Promise<AgentInvocationListResult> = (event) => {
  assertLocalConsoleRequest(event)
  const query = consoleRequestURL(event).searchParams
  const cursor = query.get("cursor") || undefined
  const limitValue = query.get("limit")
  const limit = limitValue === null ? undefined : Number(limitValue)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw Object.assign(new Error("Invalid invocation limit"), {
      statusCode: 400,
      statusMessage: "Invalid invocation limit",
    })
  }
  return getConsoleInvocations().list({
    ...(cursor ? { cursor } : {}),
    ...(limit === undefined ? {} : { limit }),
  })
}

export default invocationsHandler
