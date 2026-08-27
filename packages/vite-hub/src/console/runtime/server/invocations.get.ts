import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"
import type { AgentInvocationListOptions, AgentInvocationListResult, AgentInvocationRecordStatus } from "@vite-hub/agent"

interface ConsoleInvocationCursor {
  active?: string | null
  terminal?: string | null
}

const defaultListLimit = 50
const maximumListLimit = 100

function decodeCursor(value: string | undefined): ConsoleInvocationCursor {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (!(parsed instanceof Object) || Array.isArray(parsed)) throw new TypeError()
    const hasActive = Reflect.has(parsed, "active")
    const hasTerminal = Reflect.has(parsed, "terminal")
    if (!hasActive && !hasTerminal) throw new TypeError()
    const active = Reflect.get(parsed, "active")
    const terminal = Reflect.get(parsed, "terminal")
    if ((hasActive && active !== null && String(active) !== active)
      || (hasTerminal && terminal !== null && String(terminal) !== terminal)) throw new TypeError()
    const cursor: ConsoleInvocationCursor = {}
    if (hasActive) cursor.active = active === null ? null : String(active)
    if (hasTerminal) cursor.terminal = terminal === null ? null : String(terminal)
    return cursor
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

async function listLifecyclePage(
  status: readonly AgentInvocationRecordStatus[],
  limit: number,
  cursor: string | null | undefined,
  agentName: string | undefined,
): Promise<AgentInvocationListResult> {
  const options: AgentInvocationListOptions = { limit, status }
  if (agentName) options.agentName = agentName
  if (cursor) options.cursor = cursor
  return getConsoleInvocations().list(options)
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
  const pageLimit = Math.min(limit ?? defaultListLimit, maximumListLimit)
  const emptyPage: AgentInvocationListResult = { invocations: [] }
  const initialPage = !("active" in cursor || "terminal" in cursor)
  const hasTerminalPage = initialPage || "terminal" in cursor
  const activeLimit = cursor.terminal === null
    ? 0
    : hasTerminalPage
      ? Math.ceil(pageLimit / 2)
      : pageLimit
  const active = activeLimit > 0 && (initialPage || "active" in cursor)
    ? await listLifecyclePage(["pending", "running"], activeLimit, cursor.active, agentName)
    : emptyPage
  const terminalLimit = pageLimit - active.invocations.length
  const terminal = terminalLimit > 0 && hasTerminalPage
    ? await listLifecyclePage(["cancelled", "completed", "failed"], terminalLimit, cursor.terminal, agentName)
    : emptyPage
  const next: ConsoleInvocationCursor = {}
  if (active.cursor) next.active = active.cursor
  else if (activeLimit === 0 && cursor.active) next.active = cursor.active
  if (terminal.cursor) next.terminal = terminal.cursor
  else if (terminalLimit === 0 && hasTerminalPage) next.terminal = cursor.terminal ?? null
  const nextCursor = encodeCursor(next)
  const terminalIds = new Set(terminal.invocations.map(invocation => invocation.id))
  const result: AgentInvocationListResult = {
    invocations: [...active.invocations.filter(invocation => !terminalIds.has(invocation.id)), ...terminal.invocations],
  }
  if (nextCursor) result.cursor = nextCursor
  return result
}

export default invocationsHandler
