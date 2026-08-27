import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"
import type { AgentInvocationListResult } from "@vite-hub/agent"

interface ConsoleInvocationCursor {
  active?: string | null
  terminal?: string | null
}

const defaultListLimit = 50

function decodeCursor(value: string | undefined): ConsoleInvocationCursor {
  if (!value) return {}
  try {
    const cursor = JSON.parse(value) as unknown
    if (
      typeof cursor !== "object"
      || cursor === null
      || Array.isArray(cursor)
      || !("active" in cursor || "terminal" in cursor)
      || ("active" in cursor && cursor.active !== null && typeof cursor.active !== "string")
      || ("terminal" in cursor && cursor.terminal !== null && typeof cursor.terminal !== "string")
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

function encodeCursor(cursor: ConsoleInvocationCursor): string | undefined {
  if (!("active" in cursor || "terminal" in cursor)) return
  return JSON.stringify(cursor)
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
  const pageLimit = limit ?? defaultListLimit
  const listOptions = agentName ? { agentName } : {}
  const emptyPage: AgentInvocationListResult = { invocations: [] }
  const initialPage = !("active" in cursor || "terminal" in cursor)
  const hasTerminalPage = initialPage || "terminal" in cursor
  const activeLimit = cursor.terminal === null
    ? 0
    : hasTerminalPage
      ? Math.ceil(pageLimit / 2)
      : pageLimit
  const active = activeLimit > 0 && (initialPage || "active" in cursor)
    ? await getConsoleInvocations().list({
        ...listOptions,
        ...(cursor.active ? { cursor: cursor.active } : {}),
        limit: activeLimit,
        status: ["pending", "running"],
      })
    : emptyPage
  const terminalLimit = pageLimit - active.invocations.length
  const terminal = terminalLimit > 0 && hasTerminalPage
    ? await getConsoleInvocations().list({
        ...listOptions,
        ...(cursor.terminal ? { cursor: cursor.terminal } : {}),
        limit: terminalLimit,
        status: ["cancelled", "completed", "failed"],
      })
    : emptyPage
  const nextCursor = encodeCursor({
    ...(active.cursor
      ? { active: active.cursor }
      : activeLimit === 0 && cursor.active
        ? { active: cursor.active }
        : {}),
    ...(terminal.cursor
      ? { terminal: terminal.cursor }
      : terminalLimit === 0 && hasTerminalPage
        ? { terminal: cursor.terminal ?? null }
        : {}),
  })
  return {
    ...(nextCursor ? { cursor: nextCursor } : {}),
    invocations: [...active.invocations, ...terminal.invocations],
  }
}

export default invocationsHandler
