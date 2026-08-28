import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"
import type { AgentInvocationListOptions, AgentInvocationListResult, AgentInvocationRecordStatus } from "@vite-hub/agent"

interface ConsoleInvocationCursor {
  done?: string | null
  queued?: string | null
  working?: string | null
}

const defaultListLimit = 50
const maximumListLimit = 100

function decodeCursor(value: string | undefined): ConsoleInvocationCursor {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (!(parsed instanceof Object) || Array.isArray(parsed)) throw new TypeError()
    const keys = ["working", "queued", "done"] as const
    if (!keys.some(key => Reflect.has(parsed, key))) throw new TypeError()
    const cursor: ConsoleInvocationCursor = {}
    for (const key of keys) {
      if (!Reflect.has(parsed, key)) continue
      const value = Reflect.get(parsed, key)
      if (value !== null && String(value) !== value) throw new TypeError()
      cursor[key] = value === null ? null : String(value)
    }
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
  if (!("working" in cursor || "queued" in cursor || "done" in cursor)) return
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
  if (cursor !== null && cursor !== undefined) options.cursor = cursor
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
  const initialPage = !("working" in cursor || "queued" in cursor || "done" in cursor)
  let remainingLimit = pageLimit
  let remainingGroups = initialPage ? 3 : Object.keys(cursor).length
  const deferredGroups = new Set<keyof ConsoleInvocationCursor>()
  const pages: Record<keyof ConsoleInvocationCursor, AgentInvocationListResult> = {
    done: emptyPage,
    queued: emptyPage,
    working: emptyPage,
  }
  const groups: readonly [keyof ConsoleInvocationCursor, readonly AgentInvocationRecordStatus[]][] = [
    ["queued", ["pending"]],
    ["working", ["running"]],
    ["done", ["cancelled", "completed", "failed"]],
  ]
  const pendingGroups = groups
    .filter(([key]) => initialPage || key in cursor)
    .sort(([left], [right]) => Number(cursor[right] === null) - Number(cursor[left] === null))
  for (const [key, statuses] of pendingGroups) {
    if (remainingLimit === 0) {
      deferredGroups.add(key)
      remainingGroups--
      continue
    }
    const limit = Math.ceil(remainingLimit / remainingGroups)
    const page = await listLifecyclePage(statuses, limit, cursor[key], agentName)
    pages[key] = page
    remainingLimit -= page.invocations.length
    remainingGroups--
  }
  const { done, queued, working } = pages
  const next: ConsoleInvocationCursor = {}
  if (working.cursor !== undefined) next.working = working.cursor
  else if (deferredGroups.has("working")) next.working = cursor.working ?? null
  if (queued.cursor !== undefined) next.queued = queued.cursor
  else if (deferredGroups.has("queued")) next.queued = cursor.queued ?? null
  if (done.cursor !== undefined) next.done = done.cursor
  else if (deferredGroups.has("done")) next.done = cursor.done ?? null
  const nextCursor = encodeCursor(next)
  const doneIds = new Set(done.invocations.map(invocation => invocation.id))
  const workingIds = new Set(working.invocations.map(invocation => invocation.id))
  const result: AgentInvocationListResult = {
    invocations: [
      ...working.invocations.filter(invocation => !doneIds.has(invocation.id)),
      ...queued.invocations.filter(invocation => !workingIds.has(invocation.id) && !doneIds.has(invocation.id)),
      ...done.invocations,
    ],
    remainingStatuses: [
      ...("working" in next ? ["running" as const] : []),
      ...("queued" in next ? ["pending" as const] : []),
      ...("done" in next ? ["cancelled" as const, "completed" as const, "failed" as const] : []),
    ],
  }
  if (nextCursor) result.cursor = nextCursor
  return result
}

export default invocationsHandler
