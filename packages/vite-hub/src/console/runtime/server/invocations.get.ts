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
  const agentName = query.get("agent")?.trim() || undefined
  if (agentName && agentName.length > 512) {
    throw Object.assign(new Error("Invalid Agent name"), {
      statusCode: 400,
      statusMessage: "Invalid Agent name",
    })
  }
  const limitValue = query.get("limit")
  const limit = limitValue === null ? undefined : Number(limitValue)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw Object.assign(new Error("Invalid invocation limit"), {
      statusCode: 400,
      statusMessage: "Invalid invocation limit",
    })
  }
  const listOptions = {
    ...(agentName ? { agentName } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
  const terminal = await getConsoleInvocations().list({
    ...listOptions,
    status: ["cancelled", "completed", "failed"],
  })
  if (cursor) return terminal

  const activeInvocations: AgentInvocationListResult["invocations"][number][] = []
  let activeCursor: string | undefined
  do {
    const active = await getConsoleInvocations().list({
      ...(activeCursor ? { cursor: activeCursor } : {}),
      ...(agentName ? { agentName } : {}),
      status: ["pending", "running"],
    })
    activeInvocations.push(...active.invocations)
    activeCursor = active.cursor
  } while (activeCursor)
  return {
    ...terminal,
    invocations: [...activeInvocations, ...terminal.invocations],
  }
}

export default invocationsHandler
