import { defineCapability } from "../capability-runtime.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentToolDefinition,
  AgentToolPolicyDecision,
  AgentToolSet,
  MaybePromise,
} from "../types.ts"
import type { WritableWorkspaceFacade } from "@vite-hub/workspace"

export interface MemoryCapabilityInstructionsOption {
  instructions?: string | false
}

export type MemoryKind = "episodic" | "procedural" | "profile" | "semantic" | (string & {})

export interface MemoryScope {
  agent?: string
  environment?: string
  project?: string
  session?: string
  tenant?: string
  thread?: string
  user?: string
  workspace?: string
}

export interface MemoryProvenance {
  messageIds?: string[]
  runId?: string
  source?: "assistant" | "background" | "import" | "system" | "tool" | "user" | (string & {})
  threadId?: string
  toolName?: string
}

export interface MemoryRecord {
  confidence?: number
  content: string
  createdAt: string
  digest: string
  id: string
  kind: MemoryKind
  metadata?: Record<string, unknown>
  pinned?: boolean
  provenance?: MemoryProvenance
  scope: MemoryScope
  status: "active" | "deleted" | "superseded"
  store: string
  supersedes?: string[]
  tags?: string[]
  title?: string
  updatedAt: string
  version: number
}

export interface MemorySearchRequest {
  after?: string
  before?: string
  kinds?: MemoryKind[]
  limit?: number
  query: string
  scope: MemoryScope
  store: string
  tags?: string[]
}

export interface MemorySearchResult {
  items: Array<{
    createdAt: string
    id: string
    kind: MemoryKind
    provenance?: MemoryProvenance
    score?: number
    snippet: string
    tags?: string[]
    title?: string
    updatedAt: string
  }>
}

export interface MemoryReadRequest {
  id: string
  scope: MemoryScope
  store: string
}

export interface MemoryAppendRequest {
  confidence?: number
  content: string
  kind: MemoryKind
  metadata?: Record<string, unknown>
  pinned?: boolean
  provenance?: MemoryProvenance
  scope: MemoryScope
  store: string
  supersedes?: string[]
  tags?: string[]
  title?: string
}

export interface MemoryDeleteRequest {
  id: string
  reason?: string
  scope: MemoryScope
  store: string
}

export interface MemoryExportRequest {
  scope: MemoryScope
  store: string
}

export interface MemoryStoreAdapter {
  append: (request: MemoryAppendRequest) => MaybePromise<{ action: "created" | "superseded", item: MemoryRecord }>
  delete: (request: MemoryDeleteRequest) => MaybePromise<{ deletedId: string, ok: true, tombstoneId: string }>
  export: (request: MemoryExportRequest) => MaybePromise<{ items: MemoryRecord[] }>
  read: (request: MemoryReadRequest) => MaybePromise<{ item: MemoryRecord | null }>
  search: (request: MemorySearchRequest) => MaybePromise<MemorySearchResult>
}

export interface MemoryStoreFactory {
  create: (context: AgentCapabilityContext) => MaybePromise<MemoryStoreAdapter>
  kind: string
}

export interface MemoryStoreOptions {
  adapter: MemoryStoreAdapter | MemoryStoreFactory
  allowKinds?: MemoryKind[]
  read?: {
    preload?: Array<{
      inject?: "instructions" | false
      kind?: MemoryKind | MemoryKind[]
      maxItems?: number
      pinned?: boolean
    }>
    tools?: {
      read?: boolean
      search?: boolean
    }
  }
  retention?: {
    export?: boolean
    hardDelete?: boolean
  }
  scope: MemoryScope | ((context: AgentCapabilityContext) => MemoryScope)
  write?: {
    mode?: "off" | "tool"
    policy?: AgentToolPolicyDecision
  }
}

export interface MemoryCapabilityOptions extends MemoryCapabilityInstructionsOption {
  stores: Record<string, MemoryStoreOptions>
}

export interface WorkspaceJsonlMemoryStoreOptions {
  path?: string
}

type JsonSchema = Record<string, unknown>
type MemoryEvent = MemoryUpsertEvent | MemorySupersedeEvent | MemoryDeleteEvent

interface MemoryUpsertEvent extends Omit<MemoryRecord, "status"> {
  op: "upsert"
  status: "active" | "superseded"
}

interface MemorySupersedeEvent {
  digest: string
  id: string
  op: "supersede"
  scope: MemoryScope
  store: string
  supersededAt: string
  supersededBy: string
  version: number
}

interface MemoryDeleteEvent {
  deletedAt: string
  digest: string
  id: string
  op: "delete"
  reason?: string
  scope: MemoryScope
  store: string
  tombstoneId: string
  version: number
}

function createTool<TInput = unknown, TOutput = unknown>(tool: AgentToolDefinition<TInput, TOutput>): AgentToolDefinition {
  return tool as AgentToolDefinition
}

function jsonObjectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
    type: "object",
  }
}

const storePropertySchema: JsonSchema = {
  description: "Memory store name. Omit only when the capability has one store or an `agent` store.",
  type: "string",
}

const stringArraySchema: JsonSchema = {
  items: { type: "string" },
  type: "array",
}

const memorySearchInputSchema = jsonObjectSchema({
  after: { description: "Include records updated at or after this ISO timestamp.", type: "string" },
  before: { description: "Include records updated at or before this ISO timestamp.", type: "string" },
  kinds: stringArraySchema,
  limit: { minimum: 1, type: "number" },
  query: { type: "string" },
  store: storePropertySchema,
  tags: stringArraySchema,
}, ["query"])

const memoryReadInputSchema = jsonObjectSchema({
  id: { type: "string" },
  store: storePropertySchema,
}, ["id"])

const memoryRememberInputSchema = jsonObjectSchema({
  confidence: { maximum: 1, minimum: 0, type: "number" },
  content: { type: "string" },
  kind: { type: "string" },
  metadata: { additionalProperties: true, type: "object" },
  pinned: { type: "boolean" },
  provenance: { additionalProperties: true, type: "object" },
  store: storePropertySchema,
  supersedes: stringArraySchema,
  tags: stringArraySchema,
  title: { type: "string" },
}, ["content", "kind"])

const memoryDeleteInputSchema = jsonObjectSchema({
  id: { type: "string" },
  reason: { type: "string" },
  store: storePropertySchema,
}, ["id"])

function createMemoryId(prefix = "mem") {
  return `${prefix}_${globalThis.crypto?.randomUUID?.().replace(/-/g, "") || Math.random().toString(36).slice(2)}`
}

async function digestMemoryValue(value: unknown): Promise<string> {
  const input = JSON.stringify(value)
  if (globalThis.crypto?.subtle) {
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
    return `sha256:${Array.from(new Uint8Array(bytes)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`
  }
  let hash = 5381
  for (let index = 0; index < input.length; index++) hash = ((hash << 5) + hash) ^ input.charCodeAt(index)
  return `djb2:${(hash >>> 0).toString(16)}`
}

function normalizeMemoryScope(scope: MemoryScope | undefined): MemoryScope {
  const normalized: MemoryScope = {}
  for (const [key, value] of Object.entries(scope || {}) as Array<[keyof MemoryScope, string | undefined]>) {
    if (value) normalized[key] = value
  }
  return normalized
}

function memoryScopeMatches(record: MemoryRecord | MemorySupersedeEvent | MemoryDeleteEvent, scope: MemoryScope) {
  return Object.entries(scope).every(([key, value]) => (record.scope as Record<string, unknown>)[key] === value)
}

function normalizeMemoryKinds(kind: MemoryKind | MemoryKind[] | undefined): MemoryKind[] | undefined {
  return kind ? Array.isArray(kind) ? kind : [kind] : undefined
}

function createMemorySnippet(record: MemoryRecord, query: string) {
  const text = [record.title, record.content].filter(Boolean).join("\n")
  const normalized = text.toLowerCase()
  const needle = query.toLowerCase()
  const index = needle ? normalized.indexOf(needle) : -1
  if (index < 0) return text.slice(0, 300)
  return text.slice(Math.max(0, index - 80), index + Math.max(needle.length, 1) + 220)
}

function scoreMemoryRecord(record: MemoryRecord, query: string) {
  const needle = query.toLowerCase()
  if (!needle) return 1
  const haystack = [record.title, record.content, ...(record.tags || [])].filter(Boolean).join("\n").toLowerCase()
  let score = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    score++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return score
}

function getWritableWorkspace(context: AgentCapabilityContext): WritableWorkspaceFacade | undefined {
  const workspace = context.workspace as WritableWorkspaceFacade | undefined
  return workspace?.fs && "appendFile" in workspace.fs && "writeFile" in workspace.fs ? workspace : undefined
}

async function appendWorkspaceJsonl(path: string, context: AgentCapabilityContext, line: string) {
  const workspace = getWritableWorkspace(context)
  if (!workspace) throw new Error("[vitehub:agent] workspaceJsonlMemoryStore() requires an agent workspace with write access.")
  const parent = path.split("/").slice(0, -1).join("/")
  if (parent) {
    await workspace.fs.mkdir(parent, { recursive: true })
  }
  await workspace.fs.appendFile(path, `${line}\n`)
}

async function readWorkspaceJsonl(path: string, context: AgentCapabilityContext): Promise<MemoryEvent[]> {
  const workspace = context.workspace
  if (!workspace) throw new Error("[vitehub:agent] workspaceJsonlMemoryStore() requires an agent workspace.")
  let contents = ""
  try {
    contents = await workspace.fs.readFile(path, { encoding: "utf8" })
  }
  catch {
    return []
  }
  const events: MemoryEvent[] = []
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as MemoryEvent
      if (event && typeof event === "object" && "op" in event) events.push(event)
    }
    catch {
      continue
    }
  }
  return events
}

function reduceMemoryEvents(events: MemoryEvent[], scope: MemoryScope, store: string): MemoryRecord[] {
  const records = new Map<string, MemoryRecord>()
  for (const event of events) {
    if (event.store !== store || !memoryScopeMatches(event, scope)) continue
    if (event.op === "delete") {
      const existing = records.get(event.id)
      if (existing) records.set(event.id, { ...existing, status: "deleted", updatedAt: event.deletedAt, version: event.version })
      continue
    }
    if (event.op === "supersede") {
      const existing = records.get(event.id)
      if (existing) {
        records.set(event.id, {
          ...existing,
          status: "superseded",
          supersedes: [...(existing.supersedes || []), event.supersededBy],
          updatedAt: event.supersededAt,
          version: event.version,
        })
      }
      continue
    }
    const { op: _op, ...record } = event
    records.set(event.id, {
      ...record,
      status: event.status || "active",
    })
  }
  return [...records.values()].filter(record => record.status === "active")
}

function filterMemoryRecords(records: MemoryRecord[], request: Omit<MemorySearchRequest, "scope" | "store">) {
  const kinds = request.kinds ? new Set(request.kinds) : undefined
  const tags = request.tags ? new Set(request.tags) : undefined
  const after = request.after ? Date.parse(request.after) : undefined
  const before = request.before ? Date.parse(request.before) : undefined
  return records
    .filter(record => !kinds || kinds.has(record.kind))
    .filter(record => !tags || record.tags?.some(tag => tags.has(tag)))
    .filter(record => after === undefined || Date.parse(record.updatedAt) >= after)
    .filter(record => before === undefined || Date.parse(record.updatedAt) <= before)
}

export function workspaceJsonlMemoryStore(options: WorkspaceJsonlMemoryStoreOptions = {}): MemoryStoreFactory {
  const path = options.path || "memory/memory.jsonl"
  return {
    kind: "workspace-jsonl",
    create(context) {
      return {
        async append(request) {
          const now = new Date().toISOString()
          const base = {
            confidence: request.confidence,
            content: request.content,
            createdAt: now,
            id: createMemoryId(),
            kind: request.kind,
            metadata: request.metadata,
            pinned: request.pinned,
            provenance: request.provenance,
            scope: request.scope,
            store: request.store,
            supersedes: request.supersedes,
            tags: request.tags,
            title: request.title,
            updatedAt: now,
            version: 1,
          }
          const event: MemoryUpsertEvent = {
            ...base,
            digest: await digestMemoryValue(base),
            op: "upsert",
            status: "active",
          }
          const supersedeEvents = await Promise.all((request.supersedes || []).map(async id => ({
            digest: await digestMemoryValue({ id, supersededAt: now, supersededBy: event.id }),
            id,
            op: "supersede" as const,
            scope: request.scope,
            store: request.store,
            supersededAt: now,
            supersededBy: event.id,
            version: 1,
          })))
          await appendWorkspaceJsonl(path, context, JSON.stringify(event))
          for (const supersedeEvent of supersedeEvents) {
            await appendWorkspaceJsonl(path, context, JSON.stringify(supersedeEvent))
          }
          return { action: request.supersedes?.length ? "superseded" : "created", item: { ...event, status: "active" } }
        },
        async delete(request) {
          const event: MemoryDeleteEvent = {
            deletedAt: new Date().toISOString(),
            digest: await digestMemoryValue(request),
            id: request.id,
            op: "delete",
            reason: request.reason,
            scope: request.scope,
            store: request.store,
            tombstoneId: createMemoryId("mem_del"),
            version: 1,
          }
          await appendWorkspaceJsonl(path, context, JSON.stringify(event))
          return { deletedId: request.id, ok: true, tombstoneId: event.tombstoneId }
        },
        async export(request) {
          return { items: reduceMemoryEvents(await readWorkspaceJsonl(path, context), request.scope, request.store) }
        },
        async read(request) {
          return { item: reduceMemoryEvents(await readWorkspaceJsonl(path, context), request.scope, request.store).find(record => record.id === request.id) || null }
        },
        async search(request) {
          const matches = filterMemoryRecords(reduceMemoryEvents(await readWorkspaceJsonl(path, context), request.scope, request.store), request)
            .map(record => ({ record, score: scoreMemoryRecord(record, request.query) }))
            .filter(match => !request.query || match.score > 0)
            .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
            .slice(0, request.limit || 10)
          return {
            items: matches.map(({ record, score }) => ({
              createdAt: record.createdAt,
              id: record.id,
              kind: record.kind,
              provenance: record.provenance,
              score,
              snippet: createMemorySnippet(record, request.query),
              tags: record.tags,
              title: record.title,
              updatedAt: record.updatedAt,
            })),
          }
        },
      }
    },
  }
}

function resolveMemoryStore(adapter: MemoryStoreAdapter | MemoryStoreFactory, context: AgentCapabilityContext): MaybePromise<MemoryStoreAdapter> {
  return "create" in adapter ? adapter.create(context) : adapter
}

function resolveMemoryScope(options: MemoryStoreOptions, context: AgentCapabilityContext): MemoryScope {
  const scope = typeof options.scope === "function" ? options.scope(context) : options.scope
  if (!scope || !Object.values(scope).some(Boolean)) {
    throw new Error("[vitehub:agent] memory() stores require an explicit scope.")
  }
  return normalizeMemoryScope(scope)
}

function assertMemoryKind(options: MemoryStoreOptions, kind: MemoryKind) {
  if (options.allowKinds?.length && !options.allowKinds.includes(kind)) {
    throw new Error(`[vitehub:agent] Memory kind "${kind}" is not allowed for this store.`)
  }
}

function renderMemoryPreload(items: MemoryRecord[]) {
  if (!items.length) return false
  return [
    "Durable memory is available as scoped records. Treat memory as advisory context that can be stale or superseded by the current request.",
    ...items.map(item => `- [${item.kind}] ${item.title ? `${item.title}: ` : ""}${item.content}`),
  ].join("\n")
}

function sortMemoryPreloadRecords(left: MemoryRecord, right: MemoryRecord) {
  const pinned = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
  return pinned || right.updatedAt.localeCompare(left.updatedAt)
}

export function memory(options: MemoryCapabilityOptions): AgentCapabilityDefinition {
  return defineCapability({
    id: "memory",
    async input(context) {
      for (const [storeName, storeOptions] of Object.entries(options.stores)) {
        const adapter = await resolveMemoryStore(storeOptions.adapter, context)
        const scope = resolveMemoryScope(storeOptions, context)
        for (const preload of storeOptions.read?.preload || []) {
          if (preload.inject === false) continue
          const exported = await adapter.export({ scope, store: storeName })
          const kinds = normalizeMemoryKinds(preload.kind)
          const items = exported.items
            .filter(item => !kinds || kinds.includes(item.kind))
            .filter(item => preload.pinned === undefined || item.pinned === preload.pinned)
            .sort(sortMemoryPreloadRecords)
            .slice(0, preload.maxItems || 5)
          context.instructions.add(renderMemoryPreload(items), { id: `memory.${storeName}` })
        }
      }
    },
    async resolve(context) {
      const resolved = new Map<string, { adapter: MemoryStoreAdapter, options: MemoryStoreOptions, scope: MemoryScope }>()
      for (const [storeName, storeOptions] of Object.entries(options.stores)) {
        resolved.set(storeName, {
          adapter: await resolveMemoryStore(storeOptions.adapter, context),
          options: storeOptions,
          scope: resolveMemoryScope(storeOptions, context),
        })
      }
      const defaultStoreName = resolved.has("agent")
        ? "agent"
        : resolved.size === 1
          ? [...resolved.keys()][0]
          : undefined
      const getStore = (name?: string) => {
        const storeName = name || defaultStoreName
        if (!storeName) throw new Error("[vitehub:agent] Multiple memory stores are configured; pass `store` explicitly.")
        const store = resolved.get(storeName)
        if (!store) throw new Error(`[vitehub:agent] Unknown memory store "${storeName}".`)
        return { storeName, ...store }
      }
      const readSearchAllowed = (options: MemoryStoreOptions) => options.read?.tools?.search !== false
      const readOneAllowed = (options: MemoryStoreOptions) => options.read?.tools?.read !== false
      const assertReadAllowed = (selected: ReturnType<typeof getStore>, tool: "read" | "search") => {
        const allowed = tool === "search" ? readSearchAllowed(selected.options) : readOneAllowed(selected.options)
        if (!allowed) throw new Error(`[vitehub:agent] Memory store "${selected.storeName}" does not allow ${tool}.`)
      }
      const assertWriteAllowed = (selected: ReturnType<typeof getStore>) => {
        if (selected.options.write?.mode !== "tool") {
          throw new Error(`[vitehub:agent] Memory store "${selected.storeName}" does not allow writes.`)
        }
      }
      const writePolicy = ({ input }: { input?: unknown }) => {
        const selected = getStore((input as { store?: string } | undefined)?.store)
        assertWriteAllowed(selected)
        return selected.options.write?.policy || "require-approval"
      }
      const tools: AgentToolSet = {}
      if ([...resolved.values()].some(store => readSearchAllowed(store.options))) {
        tools.memory_search = createTool({
          description: "Search durable scoped memory records.",
          execute: ({ after, before, kinds, limit, query, store, tags }: MemorySearchRequest & { store?: string }) => {
            const selected = getStore(store)
            assertReadAllowed(selected, "search")
            return selected.adapter.search({ after, before, kinds, limit, query, scope: selected.scope, store: selected.storeName, tags })
          },
          inputSchema: memorySearchInputSchema,
          name: "memory_search",
        })
      }
      if ([...resolved.values()].some(store => readOneAllowed(store.options))) {
        tools.memory_read = createTool({
          description: "Read one durable memory record by id.",
          execute: ({ id, store }: { id: string, store?: string }) => {
            const selected = getStore(store)
            assertReadAllowed(selected, "read")
            return selected.adapter.read({ id, scope: selected.scope, store: selected.storeName })
          },
          inputSchema: memoryReadInputSchema,
          name: "memory_read",
        })
      }
      if ([...resolved.values()].some(store => store.options.write?.mode === "tool")) {
        tools.memory_remember = createTool({
          description: "Create a durable scoped memory record. Use only for information that should persist across future agent invocations.",
          execute: ({ confidence, content, kind, metadata, pinned, provenance, store, supersedes, tags, title }: MemoryAppendRequest & { store?: string }) => {
            const selected = getStore(store)
            assertWriteAllowed(selected)
            assertMemoryKind(selected.options, kind)
            return selected.adapter.append({
              confidence,
              content,
              kind,
              metadata,
              pinned,
              provenance: {
                runId: context.run?.runId,
                source: "tool",
                threadId: context.run?.threadId,
                toolName: "memory_remember",
                ...provenance,
              },
              scope: selected.scope,
              store: selected.storeName,
              supersedes,
              tags,
              title,
            })
          },
          inputSchema: memoryRememberInputSchema,
          name: "memory_remember",
          policy: writePolicy,
        })
        tools.memory_delete = createTool({
          description: "Soft-delete one durable memory record.",
          execute: ({ id, reason, store }: { id: string, reason?: string, store?: string }) => {
            const selected = getStore(store)
            assertWriteAllowed(selected)
            return selected.adapter.delete({ id, reason, scope: selected.scope, store: selected.storeName })
          },
          inputSchema: memoryDeleteInputSchema,
          name: "memory_delete",
          policy: writePolicy,
        })
      }
      context.tools.add(tools)
      if (options.instructions !== false) {
        context.instructions.add(options.instructions || "Use memory for durable facts that may matter later. Current requests win when memory conflicts.", { id: "memory" })
      }
    },
  })
}
