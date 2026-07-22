import { ViteHubError } from "@vite-hub/runtime"

import { useWorkspace } from "./core/use.ts"

import type { ReadonlyWorkspaceFacade } from "./core/use.ts"
import type { WorkspaceName } from "./core/types.ts"

export interface WorkspaceCollectionEmptyFilter {
  empty: true
}

export const workspaceCollectionEmpty: WorkspaceCollectionEmptyFilter = Object.freeze({ empty: true })

export type WorkspaceCollectionFilter = string | string[] | WorkspaceCollectionEmptyFilter

export interface WorkspaceCollectionSort {
  direction?: "asc" | "desc"
  field: string
}

export interface WorkspaceCollectionQuery {
  cursor?: string
  facets?: string[]
  filters?: Record<string, WorkspaceCollectionFilter | undefined>
  limit?: number
  search?: string
  searchFields?: string[]
  select?: string[]
  sort?: WorkspaceCollectionSort
}

export interface WorkspaceCollectionItemQuery {
  key: string
  select?: string[]
  value: string | number
}

export interface WorkspaceCollectionOptions<Name extends WorkspaceName = WorkspaceName> {
  defaultLimit?: number
  maxLimit?: number
  path: string
  workspace: Name | ReadonlyWorkspaceFacade<Name> | Promise<ReadonlyWorkspaceFacade<Name>>
}

export interface WorkspaceCollectionPageOptions<Name extends WorkspaceName = WorkspaceName> extends WorkspaceCollectionOptions<Name> {
  query?: WorkspaceCollectionQuery
}

export interface WorkspaceCollectionItemOptions<Name extends WorkspaceName = WorkspaceName> extends WorkspaceCollectionOptions<Name> {
  query: WorkspaceCollectionItemQuery
}

export interface WorkspaceCollectionFacetValue {
  count: number
  value: string
}

export interface WorkspaceCollectionPage<T = Record<string, unknown>> {
  digest: string
  facets: Record<string, WorkspaceCollectionFacetValue[]>
  items: T[]
  nextCursor: string | null
  total: number
}

export interface WorkspaceCollectionItem<T = Record<string, unknown>> {
  digest: string
  item: T | null
}

function workspaceCollectionCursorError(reason: "malformed" | "stale") {
  return new ViteHubError("WORKSPACE_COLLECTION_CURSOR_INVALID", reason === "stale" ? "Workspace collection cursor is stale." : "Workspace collection cursor is malformed.", {
    details: { reason },
  })
}

interface LoadedCollection {
  digest: string
  items: unknown[]
}

interface CollectionCursor {
  digest: string
  offset: number
  query: string
}

const defaultPageLimit = 50
const defaultMaxLimit = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function valueAt(value: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean)
  function visit(current: unknown, remaining: string[]): unknown {
    if (!remaining.length) return current
    if (Array.isArray(current)) {
      return current.map(item => visit(item, remaining)).filter(item => item !== undefined)
    }
    if (!isRecord(current)) return
    return visit(current[remaining[0]!], remaining.slice(1))
  }
  return visit(value, segments)
}

function scalarValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(scalarValues)
  if (value === null || value === undefined || typeof value === "object") return []
  return [String(value)]
}

function matchesFilter(value: unknown, expected: WorkspaceCollectionFilter | undefined): boolean {
  const values = scalarValues(value).map(item => item.toLocaleLowerCase())
  if (typeof expected === "object" && !Array.isArray(expected)) return expected.empty && values.length === 0
  const candidates = (Array.isArray(expected) ? expected : [expected])
    .filter((item): item is string => item !== undefined)
    .map(item => item.toLocaleLowerCase())
  if (!candidates.length) return true
  return candidates.some(candidate => values.includes(candidate))
}

function project<T>(item: unknown, select: string[] | undefined): T {
  if (!select?.length) return item as T
  return Object.fromEntries(select.map(field => [field, valueAt(item, field)])) as T
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

async function readCollection<Name extends WorkspaceName>(options: WorkspaceCollectionOptions<Name>): Promise<LoadedCollection> {
  const workspace = typeof options.workspace === "string" ? useWorkspace(options.workspace) : await options.workspace
  const stat = await workspace.fs.stat(options.path as never)
  if (stat.type !== "file") throw new TypeError(`Workspace collection ${options.path} must be a file.`)

  const raw = await workspace.fs.readFile(options.path as never, { encoding: "utf8" })
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new TypeError(`Workspace collection ${options.path} must contain a JSON array.`)
  const contentDigest = stat.digest || await digest(raw)
  return { digest: contentDigest, items: parsed }
}

function normalizedFilters(filters: WorkspaceCollectionQuery["filters"]): Record<string, string[]> {
  return Object.fromEntries(Object.entries(filters || {})
    .filter((entry): entry is [string, WorkspaceCollectionFilter] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, value]) => [field, typeof value === "object" && !Array.isArray(value)
      ? ["operator:empty"]
      : (Array.isArray(value) ? value : [value]).map(item => `value:${item.toLocaleLowerCase()}`).sort()]))
}

async function queryDigest(query: WorkspaceCollectionQuery, limit: number): Promise<string> {
  return await digest(JSON.stringify({
    facets: [...(query.facets || [])].sort(),
    filters: normalizedFilters(query.filters),
    limit,
    search: String(query.search || "").trim().toLocaleLowerCase(),
    searchFields: [...(query.searchFields || [])].sort(),
    select: query.select || [],
    sort: query.sort ? { direction: query.sort.direction || "asc", field: query.sort.field } : null,
  }))
}

function encodeCursor(cursor: CollectionCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function decodeCursor(cursor: string | undefined, expected: Omit<CollectionCursor, "offset">): number {
  if (!cursor) return 0
  let parsed: unknown
  try {
    const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/")
    parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")))
  }
  catch {
    throw workspaceCollectionCursorError("malformed")
  }
  if (!isRecord(parsed) || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || typeof parsed.digest !== "string" || typeof parsed.query !== "string") {
    throw workspaceCollectionCursorError("malformed")
  }
  if (parsed.digest !== expected.digest || parsed.query !== expected.query) {
    throw workspaceCollectionCursorError("stale")
  }
  return Number(parsed.offset)
}

function resolveLimit(query: WorkspaceCollectionQuery, options: WorkspaceCollectionOptions): number {
  const maxLimit = options.maxLimit ?? defaultMaxLimit
  const fallback = options.defaultLimit ?? defaultPageLimit
  if (!Number.isSafeInteger(maxLimit) || maxLimit < 1) throw new TypeError("Workspace collection maxLimit must be a positive integer.")
  if (!Number.isSafeInteger(fallback) || fallback < 1) throw new TypeError("Workspace collection defaultLimit must be a positive integer.")
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) {
    throw new TypeError("Workspace collection limit must be a positive integer.")
  }
  return Math.min(query.limit ?? fallback, maxLimit)
}

function filterItems(items: unknown[], query: WorkspaceCollectionQuery): unknown[] {
  const search = String(query.search || "").trim().toLocaleLowerCase()
  let filtered = items.filter(item => Object.entries(query.filters || {}).every(([field, expected]) => matchesFilter(valueAt(item, field), expected)))
  if (search) {
    filtered = filtered.filter(item => (query.searchFields || []).some(field => scalarValues(valueAt(item, field)).some(value => value.toLocaleLowerCase().includes(search))))
  }
  if (query.sort?.field) {
    const direction = query.sort.direction === "desc" ? -1 : 1
    filtered = [...filtered].sort((left, right) => {
      const leftValue = valueAt(left, query.sort!.field)
      const rightValue = valueAt(right, query.sort!.field)
      const leftScalar = Array.isArray(leftValue) ? leftValue.flat(Infinity).find(value => value !== null && value !== undefined && typeof value !== "object") : leftValue
      const rightScalar = Array.isArray(rightValue) ? rightValue.flat(Infinity).find(value => value !== null && value !== undefined && typeof value !== "object") : rightValue
      if (typeof leftScalar === "number" && typeof rightScalar === "number") return (leftScalar - rightScalar) * direction
      return String(leftScalar ?? "").localeCompare(String(rightScalar ?? "")) * direction
    })
  }
  return filtered
}

function buildFacets(items: unknown[], fields: string[] | undefined, maxValues: number): Record<string, WorkspaceCollectionFacetValue[]> {
  return Object.fromEntries((fields || []).map((field) => {
    const counts = new Map<string, number>()
    for (const item of items) {
      for (const value of new Set(scalarValues(valueAt(item, field)))) {
        counts.set(value, (counts.get(value) || 0) + 1)
      }
    }
    const values = [...counts].map(([value, count]) => ({ count, value }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
      .slice(0, maxValues)
    return [field, values]
  }))
}

export async function queryWorkspaceCollection<T = Record<string, unknown>, Name extends WorkspaceName = WorkspaceName>(
  options: WorkspaceCollectionPageOptions<Name>,
): Promise<WorkspaceCollectionPage<T>> {
  const collection = await readCollection(options)
  const query = options.query || {}
  const filtered = filterItems(collection.items, query)
  const limit = resolveLimit(query, options)
  const signature = await queryDigest(query, limit)
  const offset = decodeCursor(query.cursor, { digest: collection.digest, query: signature })
  if (offset > filtered.length) throw workspaceCollectionCursorError("malformed")
  const items = filtered.slice(offset, offset + limit).map(item => project<T>(item, query.select))
  const nextOffset = offset + items.length
  return {
    digest: collection.digest,
    facets: buildFacets(filtered, query.facets, options.maxLimit ?? defaultMaxLimit),
    items,
    nextCursor: nextOffset < filtered.length ? encodeCursor({ digest: collection.digest, offset: nextOffset, query: signature }) : null,
    total: filtered.length,
  }
}

export async function getWorkspaceCollectionItem<T = Record<string, unknown>, Name extends WorkspaceName = WorkspaceName>(
  options: WorkspaceCollectionItemOptions<Name>,
): Promise<WorkspaceCollectionItem<T>> {
  const collection = await readCollection(options)
  const expected = String(options.query.value)
  const item = collection.items.find(item => scalarValues(valueAt(item, options.query.key)).some(value => value === expected))
  return {
    digest: collection.digest,
    item: item === undefined ? null : project<T>(item, options.query.select),
  }
}
