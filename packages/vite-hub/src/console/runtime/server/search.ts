import { defineCollection } from "@vite-hub/source"

import { getConsoleInvocations } from "./invocations.ts"

import type { AgentInvocationRecord, AgentInvocationSummary } from "@vite-hub/agent"
import type { StandardSchemaV1 } from "@standard-schema/spec"

export interface ConsoleSearchItem {
  agentName?: string
  context: string
  excerpt?: string
  id: string
  status: AgentInvocationSummary["status"]
  updatedAt: string
}

interface ConsoleSearchQuery {
  search?: string
}

interface ConsoleSearchRow {
  excerpt?: string
  summary: AgentInvocationSummary
}

const cursorSchema: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "vitehub-console",
    validate(value) {
      return String(value) === value
        ? { value }
        : { issues: [{ message: "Console search cursor must be a string." }] }
    },
  },
}

const querySchema: StandardSchemaV1<ConsoleSearchQuery, ConsoleSearchQuery> = {
  "~standard": {
    version: 1,
    vendor: "vitehub-console",
    validate(value) {
      if (Object(value) !== value || Array.isArray(value)) {
        return { issues: [{ message: "Console search query must be an object." }] }
      }
      const query = value as Record<string, unknown>
      if (Reflect.ownKeys(query).some(key => key !== "search")) {
        return { issues: [{ message: "Console search only accepts a search query." }] }
      }
      if (query.search === undefined) return { value: {} }
      if (String(query.search) !== query.search) {
        return { issues: [{ message: "Console search must have one string value." }] }
      }
      const search = query.search.trim()
      if (search.length > 256) {
        return { issues: [{ message: "Console search must be at most 256 characters." }] }
      }
      return { value: search ? { search } : {} }
    },
  },
}

function searchableStrings(value: unknown, values: string[], ancestors = new WeakSet<object>()): void {
  if (typeof value === "string") {
    values.push(value)
    return
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) return
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

export const consoleSearch = defineCollection(
  async ({ cursor, limit, query, signal }): Promise<ConsoleSearchRow[]> => {
    signal?.throwIfAborted()
    const invocations = getConsoleInvocations()
    const page = await invocations.list({
      ...(cursor ? { cursor } : {}),
      limit,
      ...(query.search ? { search: query.search } : {}),
    })
    const rows = await Promise.all(page.invocations.map(async (summary) => {
      const record = query.search ? await invocations.get(summary.id) : undefined
      return {
        ...(record ? { excerpt: consoleSearchExcerpt(record, query.search) } : {}),
        summary,
      }
    }))
    signal?.throwIfAborted()
    return rows
  },
  {
    cursor: row => row.summary.cursor,
    cursorSchema,
    defaultLimit: 12,
    maxLimit: 24,
    querySchema,
    transform(row): ConsoleSearchItem {
      return {
        ...(row.summary.agentName ? { agentName: row.summary.agentName } : {}),
        context: row.summary.threadId || row.summary.origin || row.summary.channelId || row.summary.id,
        ...(row.excerpt ? { excerpt: row.excerpt } : {}),
        id: row.summary.id,
        status: row.summary.status,
        updatedAt: row.summary.updatedAt || row.summary.startedAt || row.summary.createdAt,
      }
    },
  },
)
