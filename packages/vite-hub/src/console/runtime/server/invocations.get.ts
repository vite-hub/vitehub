import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"
import type { AgentInvocationListResult } from "@vite-hub/agent"

interface ConsoleInvocationCursor {
  active?: string
  terminal?: string
}

function decodeCursor(value: string | undefined): ConsoleInvocationCursor {
  if (!value) return {}
  try {
    const cursor = JSON.parse(value) as unknown
    if (
      typeof cursor !== "object"
      || cursor === null
      || Array.isArray(cursor)
      || !("active" in cursor || "terminal" in cursor)
      || ("active" in cursor && typeof cursor.active !== "string")
      || ("terminal" in cursor && typeof cursor.terminal !== "string")
    ) throw new TypeError()
    return cursor as ConsoleInvocationCursor
  }
  catch {
    throw Object.assign(new Error("Invalid invocation cursor"), {
      statusCode: 400,
      statusMessage: "Invalid invocation cursor",
    })
  }
}

function encodeCursor(active: string | undefined, terminal: string | undefined): string | undefined {
  if (!active && !terminal) return
  return JSON.stringify({ ...(active ? { active } : {}), ...(terminal ? { terminal } : {}) })
}

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
  const cursor = decodeCursor(query.get("cursor") || undefined)
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
    ...(limit === undefined ? {} : { limit }),
  }
  const emptyPage: AgentInvocationListResult = { invocations: [] }
  const [active, terminal] = await Promise.all([
    cursor.terminal && !cursor.active
      ? Promise.resolve(emptyPage)
      : getConsoleInvocations().list({
          ...listOptions,
          ...(cursor.active ? { cursor: cursor.active } : {}),
          status: ["pending", "running"],
        }),
    cursor.active && !cursor.terminal
      ? Promise.resolve(emptyPage)
      : getConsoleInvocations().list({
          ...listOptions,
          ...(cursor.terminal ? { cursor: cursor.terminal } : {}),
          status: ["cancelled", "completed", "failed"],
        }),
  ])
  const nextCursor = encodeCursor(active.cursor, terminal.cursor)
  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    invocations: [...active.invocations, ...terminal.invocations],
  }
}

export default invocationsHandler
