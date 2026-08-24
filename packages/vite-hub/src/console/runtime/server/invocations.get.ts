import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"
import type { AgentInvocationListResult } from "@vite-hub/agent"

const invocationsHandler: (event: ConsoleRequestEvent) => Promise<AgentInvocationListResult> = async (event) => {
  assertConsoleRequest(event)
  const query = consoleRequestURL(event).searchParams
  const ids = query.getAll("id")
  if (ids.length > 100) {
    throw Object.assign(new Error("Too many invocation ids"), {
      statusCode: 400,
      statusMessage: "Too many invocation ids",
    })
  }
  if (ids.length > 0) {
    const records = await Promise.all(ids.map(id => getConsoleInvocations().get(id)))
    return {
      invocations: records.flatMap((record) => {
        if (!record) return []
        const { observations: _observations, ...summary } = record
        return [summary]
      }),
    }
  }
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
