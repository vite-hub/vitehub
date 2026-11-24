import { getConsoleInvocations } from "../../console/runtime/server/invocations.ts"
import { viteHubErrorDiagnostics } from "../../error-diagnostics.ts"

import type { AgentInvocationRecord, AgentInvocationSummary } from "@vite-hub/agent"

export interface ConsoleSearchItem {
  agentName?: string
  context: string
  excerpt?: string
  id: string
  status: AgentInvocationSummary["status"]
  updatedAt: string
}

/** One page of `search.query`. `nextCursor` is the `cursor` of the next page, or `null` on the last page. */
export interface ConsoleSearchPage {
  items: ConsoleSearchItem[]
  nextCursor: string | null
}

const defaultSearchLimit = 12
const maxSearchLimit = 24
const maxSearchLength = 256

function searchableStrings(value: unknown, values: string[], ancestors = new WeakSet<object>()): void {
  if (Object.prototype.toString.call(value) === "[object String]") {
    values.push(String(value))
    return
  }
  if (!(value instanceof Object) || ancestors.has(value)) return
  ancestors.add(value)
  try {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      searchableStrings(child, values, ancestors)
    }
  }
  finally {
    ancestors.delete(value)
  }
}

export function consoleSearchExcerpt(record: AgentInvocationRecord, search: string | undefined): string | undefined {
  if (!search) return
  const values: string[] = []
  searchableStrings(record.observations, values)
  searchableStrings({
    annotations: record.annotations,
    error: record.error,
    origin: record.origin,
    threadId: record.threadId,
  }, values)
  const normalizedSearch = search.toLowerCase()
  const match = values.find(value => value.toLowerCase().includes(normalizedSearch))
  if (!match) return
  const text = match.replace(/\s+/g, " ").trim()
  const index = text.toLowerCase().indexOf(normalizedSearch)
  const start = Math.max(0, index - 56)
  const end = Math.min(text.length, index + search.length + 104)
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
}

function searchItem(summary: AgentInvocationSummary, excerpt: string | undefined): ConsoleSearchItem {
  const item: ConsoleSearchItem = {
    context: summary.threadId || summary.origin || summary.channelId || summary.id,
    id: summary.id,
    status: summary.status,
    updatedAt: summary.updatedAt || summary.startedAt || summary.createdAt,
  }
  if (summary.agentName) item.agentName = summary.agentName
  if (excerpt) item.excerpt = excerpt
  return item
}

function searchRequestError(message: string): Error {
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_R0052({ message }), { status: 400, statusCode: 400, statusMessage: message })
}

/** Search the Agent Invocations of the Console. A search adds the matching excerpt of each Invocation. */
export async function searchConsoleInvocations(input: { cursor?: string, limit?: number, search?: string }): Promise<ConsoleSearchPage> {
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) throw searchRequestError("Console search limit must be a positive integer.")
  const search = input.search?.trim()
  if (search && search.length > maxSearchLength) throw searchRequestError(`Console search must be at most ${maxSearchLength} characters.`)
  if (input.cursor === "") throw searchRequestError("Console search cursor must be the nextCursor of the last page.")
  const invocations = getConsoleInvocations()
  const listQuery: Parameters<typeof invocations.list>[0] = { limit: Math.min(input.limit ?? defaultSearchLimit, maxSearchLimit) }
  if (input.cursor !== undefined) listQuery.cursor = input.cursor
  if (search) listQuery.search = search
  const page = await invocations.list(listQuery).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "AGENT_R0621") throw searchRequestError("Console search cursor must be the nextCursor of the last page.")
    throw error
  })
  const items = await Promise.all(page.invocations.map(async (summary) => {
    const record = search ? await invocations.get(summary.id) : undefined
    return searchItem(summary, record ? consoleSearchExcerpt(record, search) : undefined)
  }))
  return { items, nextCursor: page.cursor ?? null }
}
