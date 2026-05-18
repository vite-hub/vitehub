import { appendMessageText, defineCapability } from "./capability-runtime.ts"
import { createAgentMessage, getAgentMessageText } from "./messages.ts"
import {
  mergeAgentToolSets,
  normalizeAgentSkillsOptions,
  resolveSkillsInstructions,
  withSkillWriteValidation,
} from "./skills.ts"

import type { AgentCapabilityContext, AgentCapabilityDefinition } from "./capability-runtime.ts"
import type { AgentRunInput, AgentToolDefinition, AgentToolPolicyDecision, AgentToolSet, MaybePromise } from "./types.ts"
import type { AgentMessage, AudioPart } from "./messages.ts"
import type { Experimental_TranscriptionResult, experimental_transcribe as aiTranscribe } from "ai"
import type { MCPClient, MCPClientConfig } from "@ai-sdk/mcp"
import type { WritableWorkspaceFacade } from "@vitehub/workspace"

export { chat } from "./chat/capability.ts"
export type {
  ChatActionHookInput,
  ChatAgentAfterRunArgs,
  ChatAgentBeforeRunArgs,
  ChatAgentErrorArgs,
  ChatAgentHookArgs,
  ChatAgentHooks,
  ChatCapabilityOptions,
  ChatDirectMessageHook,
  ChatEventHook,
  ChatEventHooks,
  ChatHistory,
  ChatMessageHook,
  ChatModalSubmitHookInput,
  ChatNewMessageHook,
  ChatReactionHookInput,
  ChatStreamingPlaceholder,
} from "./chat/capability.ts"

export {
  applyCapabilityInstructionSlots,
  applyCapabilityToolTransforms,
  defineCapability,
} from "./capability-runtime.ts"

export type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityHooks,
  AgentCapabilityHookName,
  AgentCapabilityPhase,
  AgentCapabilityInvocationContribution,
  AgentCapabilityRegistries,
  AgentCapabilityRouteContribution,
  AgentCapabilityRuntimeAliasContribution,
  AgentCapabilityRuntimeFileContribution,
  AgentCapabilityStateRequirement,
  AgentInstructionBlock,
  AgentOutputRenderer,
  AgentToolTransform,
} from "./capability-runtime.ts"

export interface CapabilityInstructionsOption {
  instructions?: string | false
}

export interface SkillsCapabilityOptions extends CapabilityInstructionsOption {
  authoring?: boolean
  path?: string
}

export function skills(options: SkillsCapabilityOptions = {}): AgentCapabilityDefinition<SkillsCapabilityOptions> {
  return defineCapability({
    id: "skills",
    options,
    async resolve(context) {
      if (!context.workspace) throw new Error("[vitehub:agent] skills() requires an agent workspace.")
      const skillOptions = normalizeAgentSkillsOptions({
        authoring: options.authoring,
        dir: options.path || "skills",
      })
      if (!skillOptions) return
      const instructions = options.instructions === false
        ? false
        : options.instructions || await resolveSkillsInstructions(context.workspace, skillOptions)
      context.instructions.add(instructions)
      context.tools.transform(tools => withSkillWriteValidation(tools, skillOptions))
    },
  })
}

type AiSdkTranscribeOptions = Omit<Parameters<typeof aiTranscribe>[0], "abortSignal" | "audio">

export interface TranscribeExecuteInput {
  audio: AudioPart
}

export type TranscribeExecuteResult = Experimental_TranscriptionResult | string

export type TranscribeOptions = CapabilityInstructionsOption & (
  | (AiSdkTranscribeOptions & { execute?: never })
  | {
      execute: (input: TranscribeExecuteInput) => MaybePromise<TranscribeExecuteResult>
      model?: never
    }
)

function isAudioPart(part: unknown): part is AudioPart {
  return typeof part === "object"
    && part !== null
    && (part as { type?: unknown }).type === "audio"
}

function toAiSdkAudio(audio: AudioPart): Parameters<typeof aiTranscribe>[0]["audio"] {
  if (audio.url) return new URL(audio.url)
  if (audio.data) return audio.data
  throw new Error("[vitehub:agent] transcribe() requires audio input with data or url.")
}

function transcriptText(result: TranscribeExecuteResult): string {
  return typeof result === "string" ? result : result.text
}

async function runTranscription(options: TranscribeOptions, audio: AudioPart, abortSignal?: AbortSignal): Promise<string> {
  if ("execute" in options && options.execute) {
    return transcriptText(await options.execute({ audio }))
  }
  const { instructions: _instructions, ...transcribeOptions } = options
  const { experimental_transcribe } = await import("ai")
  const result = await experimental_transcribe({
    ...transcribeOptions,
    abortSignal,
    audio: toAiSdkAudio(audio),
  })
  return result.text
}

export function transcribe(options: TranscribeOptions): AgentCapabilityDefinition<TranscribeOptions> {
  return defineCapability({
    id: "transcribe",
    options,
    async input(context) {
      const messages = []
      for (const message of context.input.messages()) {
        const audioParts = message.parts.filter(isAudioPart)
        if (!audioParts.length) {
          messages.push(message)
          continue
        }
        const transcripts = await Promise.all(audioParts.map(part => runTranscription(options, part, context.input.get().abortSignal)))
        messages.push(appendMessageText(message, transcripts.filter(Boolean).join("\n")))
      }
      context.input.setMessages(messages)
    },
    instructions: options.instructions ?? false,
  })
}

export interface InputCommand {
  description?: string
  run: (input: InputCommandRunInput) => MaybePromise<Partial<AgentRunInput> | string | void>
}

export interface InputCommandRunInput {
  args: string
  command: InputCommand
  context: AgentCapabilityContext
  input: AgentRunInput
  message: AgentMessage
  name: string
  text: string
}

export interface InputCommandsOptions {
  commands: Record<string, InputCommand>
}

function assertInputCommandName(name: string) {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new TypeError(`[vitehub:agent] Input command "${name}" must be a lowercase stable identifier.`)
  }
}

function parseInputCommand(text: string): { args: string, name: string, text: string } | undefined {
  const match = /^\s*\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text)
  return match
    ? { args: match[2]?.trim() || "", name: match[1]!.toLowerCase(), text }
    : undefined
}

function replaceMessageText(message: AgentMessage, text: string): AgentMessage {
  return createAgentMessage({
    createdAt: message.createdAt,
    id: message.id,
    metadata: message.metadata,
    role: message.role,
    text,
  })
}

function latestUserMessageIndex(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return index
  }
  return -1
}

function replaceCurrentInputCommandText(input: AgentRunInput, messages: AgentMessage[], messageIndex: number, text: string): AgentRunInput {
  if (typeof input.prompt === "string" && !input.messages) {
    return { ...input, prompt: text }
  }
  const next = [...messages]
  next[messageIndex] = replaceMessageText(next[messageIndex]!, text)
  return Array.isArray(input.prompt) && !input.messages
    ? { ...input, prompt: next }
    : { ...input, messages: next }
}

function getCurrentInputCommandTarget(input: AgentRunInput): { message: AgentMessage, messageIndex: number, messages: AgentMessage[], text: string } | undefined {
  if (typeof input.prompt === "string" && !input.messages) {
    const text = input.prompt
    return {
      message: createAgentMessage({ role: "user", text }),
      messageIndex: 0,
      messages: [],
      text,
    }
  }
  const messages = input.messages || (Array.isArray(input.prompt) ? input.prompt : [])
  const messageIndex = latestUserMessageIndex(messages)
  if (messageIndex < 0) return
  const message = messages[messageIndex]!
  return {
    message,
    messageIndex,
    messages,
    text: getAgentMessageText(message),
  }
}

export function inputCommands(options: InputCommandsOptions): AgentCapabilityDefinition<InputCommandsOptions> {
  const commands = Object.fromEntries(Object.entries(options.commands).map(([name, command]) => {
    assertInputCommandName(name)
    return [name, command]
  }))

  return defineCapability({
    id: "inputCommands",
    options: { ...options, commands },
    async input(context) {
      const currentInput = context.input.get()
      const target = getCurrentInputCommandTarget(currentInput)
      if (!target) return
      const parsed = parseInputCommand(target.text)
      if (!parsed) return
      const command = commands[parsed.name]
      if (!command) return

      const result = await command.run({
        args: parsed.args,
        command,
        context: context as AgentCapabilityContext,
        input: currentInput,
        message: target.message,
        name: parsed.name,
        text: parsed.text,
      })

      if (result === undefined) return
      if (typeof result === "string") {
        context.input.set(replaceCurrentInputCommandText(currentInput, target.messages, target.messageIndex, result))
        return
      }

      context.input.set({
        ...currentInput,
        ...result,
        context: {
          ...(currentInput.context || {}),
          ...(result.context || {}),
        },
        ...("prompt" in result && !("messages" in result) ? { messages: undefined } : {}),
      })
    },
  })
}

export type McpServerConfig = MCPClient | MCPClientConfig | (() => MaybePromise<MCPClient | MCPClientConfig>)

export interface McpCapabilityOptions extends CapabilityInstructionsOption {
  servers: Record<string, McpServerConfig>
}

type McpModule = typeof import("@ai-sdk/mcp")

async function importMcpModule(): Promise<McpModule> {
  const specifier = ["@ai-sdk", "mcp"].join("/")
  return import(specifier) as Promise<McpModule>
}

function redactSecret(value: string) {
  return value.length <= 6 ? "***" : `${value.slice(0, 2)}***${value.slice(-2)}`
}

function isMcpClient(value: unknown): value is MCPClient {
  return typeof value === "object"
    && value !== null
    && typeof (value as { close?: unknown }).close === "function"
    && typeof (value as { tools?: unknown }).tools === "function"
}

function sanitizeMcpMetadata(config: MCPClientConfig | MCPClient) {
  if (isMcpClient(config)) return { serverInfo: config.serverInfo }
  const transport = config.transport
  const headers = typeof transport === "object" && transport && "headers" in transport
    ? Object.fromEntries(Object.entries((transport as { headers?: Record<string, string> }).headers || {}).map(([key, value]) => [key, redactSecret(value)]))
    : {}
  return {
    ...config,
    transport: typeof transport === "object" && transport && "type" in transport
      ? {
          ...transport,
          ...(Object.keys(headers).length ? { headers } : {}),
        }
      : transport,
  }
}

async function resolveMcpClient(config: McpServerConfig): Promise<{ client: MCPClient, metadata: MCPClient | MCPClientConfig }> {
  const resolved = typeof config === "function" ? await config() : config
  if (isMcpClient(resolved)) return { client: resolved, metadata: resolved }
  const { createMCPClient } = await importMcpModule()
  return { client: await createMCPClient(resolved), metadata: resolved }
}

export function mcp(options: McpCapabilityOptions): AgentCapabilityDefinition<McpCapabilityOptions> {
  const clientsByContext = new WeakMap<AgentCapabilityContext, MCPClient[]>()
  return defineCapability({
    id: "mcp",
    options,
    async resolve(context) {
      const tools: AgentToolSet = {}
      const clients: MCPClient[] = []
      clientsByContext.set(context as AgentCapabilityContext, clients)
      for (const [serverName, server] of Object.entries(options.servers)) {
        const { client, metadata } = await resolveMcpClient(server)
        clients.push(client)
        const serverTools = await client.tools()
        for (const [toolName, tool] of Object.entries(serverTools || {})) {
          const definition = tool as AgentToolDefinition & { metadata?: Record<string, unknown> }
          const name = `mcp_${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_")
          if (tools[name]) {
            throw new Error(`[vitehub:agent] Duplicate MCP tool name "${name}" after normalization.`)
          }
          tools[name] = {
            ...definition,
            metadata: {
              ...(definition.metadata || {}),
              mcp: sanitizeMcpMetadata(metadata),
              mcpServer: serverName,
              originalName: toolName,
            },
            name,
          }
        }
      }
      context.tools.add(tools)
      if (options.instructions !== false) {
        const serverNames = Object.keys(options.servers)
        context.instructions.add(options.instructions || [
          "MCP servers may provide external tools and resources.",
          `Configured MCP servers: ${serverNames.length ? serverNames.join(", ") : "none"}.`,
        ].join("\n"))
      }
    },
    async close(context) {
      const clients = clientsByContext.get(context as AgentCapabilityContext) || []
      clientsByContext.delete(context as AgentCapabilityContext)
      await Promise.all(clients.splice(0).map(client => client.close()))
    },
  })
}

export type StorageAccess = "read" | "write"

export interface DbCapabilityOptions extends CapabilityInstructionsOption {
  access?: "read" | "schema" | "write"
  database?: string
  prefix?: string
  policy?: AgentToolPolicyDecision
}

export interface StorageCapabilityOptions extends CapabilityInstructionsOption {
  access?: StorageAccess
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

export interface MemoryCapabilityOptions extends CapabilityInstructionsOption {
  stores: Record<string, MemoryStoreOptions>
}

export interface WorkspaceJsonlMemoryStoreOptions {
  path?: string
}

type MemoryEvent = MemoryUpsertEvent | MemoryDeleteEvent

interface MemoryUpsertEvent extends Omit<MemoryRecord, "status"> {
  op: "upsert"
  status: "active" | "superseded"
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

function memoryScopeMatches(record: MemoryRecord | MemoryDeleteEvent, scope: MemoryScope) {
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
  await workspace.fs.mkdir(path.split("/").slice(0, -1).join("/") || ".", { recursive: true })
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
  const path = options.path || ".vitehub/memory/agent.jsonl"
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
          await appendWorkspaceJsonl(path, context, JSON.stringify(event))
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
  return normalizeMemoryScope({
    thread: context.run?.threadId,
    ...scope,
  })
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

export function memory(options: MemoryCapabilityOptions): AgentCapabilityDefinition<MemoryCapabilityOptions> {
  return defineCapability({
    id: "memory",
    options,
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
      const getStore = (name?: string) => {
        const storeName = name || "agent"
        const store = resolved.get(storeName)
        if (!store) throw new Error(`[vitehub:agent] Unknown memory store "${storeName}".`)
        return { storeName, ...store }
      }
      const assertWriteAllowed = (selected: ReturnType<typeof getStore>) => {
        if (selected.options.write?.mode === "off") {
          throw new Error(`[vitehub:agent] Memory store "${selected.storeName}" does not allow writes.`)
        }
      }
      const writePolicy = ({ input }: { input?: unknown }) => {
        const selected = getStore((input as { store?: string } | undefined)?.store)
        assertWriteAllowed(selected)
        return selected.options.write?.policy || "require-approval"
      }
      const tools: AgentToolSet = {}
      if ([...resolved.values()].some(store => store.options.read?.tools?.search !== false)) {
        tools.memory_search = createTool({
          description: "Search durable scoped memory records.",
          execute: ({ after, before, kinds, limit, query, store, tags }: MemorySearchRequest & { store?: string }) => {
            const selected = getStore(store)
            return selected.adapter.search({ after, before, kinds, limit, query, scope: selected.scope, store: selected.storeName, tags })
          },
          name: "memory_search",
        })
      }
      if ([...resolved.values()].some(store => store.options.read?.tools?.read !== false)) {
        tools.memory_read = createTool({
          description: "Read one durable memory record by id.",
          execute: ({ id, store }: { id: string, store?: string }) => {
            const selected = getStore(store)
            return selected.adapter.read({ id, scope: selected.scope, store: selected.storeName })
          },
          name: "memory_read",
        })
      }
      if ([...resolved.values()].some(store => store.options.write?.mode !== "off")) {
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
          name: "memory_delete",
          policy: writePolicy,
        })
      }
      context.tools.add(tools)
      if (options.instructions !== false) {
        context.instructions.add(options.instructions || "Memory tools operate on durable scoped records. Treat recalled memory as advisory and prefer the current user request when they conflict.", { id: "memory" })
      }
    },
  })
}

function hasExactlyOne(...values: unknown[]) {
  return values.filter(value => value !== undefined && value !== "").length === 1
}

function hasOnlyTrailingComments(value: string) {
  let index = 0
  while (index < value.length) {
    const char = value[index]
    const next = value[index + 1]

    if (/\s/.test(char || "")) {
      index++
      continue
    }
    if (char === "-" && next === "-") {
      index += 2
      while (index < value.length && value[index] !== "\n" && value[index] !== "\r") index++
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index++
      if (index >= value.length) return false
      index += 2
      continue
    }
    return false
  }
  return true
}

function splitSingleSqlStatement(statement: string): string | undefined {
  let quote: "\"" | "'" | "`" | undefined
  let bracketIdentifier = false
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index]
    const next = statement[index + 1]

    if (quote) {
      if (char === quote && next === quote) {
        index++
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (bracketIdentifier) {
      if (char === "]") bracketIdentifier = false
      continue
    }
    if (char === "-" && next === "-") {
      index += 2
      while (index < statement.length && statement[index] !== "\n" && statement[index] !== "\r") index++
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < statement.length && !(statement[index] === "*" && statement[index + 1] === "/")) index++
      if (index >= statement.length) return
      index++
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "[") {
      bracketIdentifier = true
      continue
    }
    if (char === ";") {
      return hasOnlyTrailingComments(statement.slice(index + 1))
        ? statement.slice(0, index).trim()
        : undefined
    }
  }
  return quote || bracketIdentifier ? undefined : statement.trim()
}

function stripSqlComments(statement: string) {
  let output = ""
  let quote: "\"" | "'" | "`" | undefined
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index]
    const next = statement[index + 1]
    if (quote) {
      output += char
      if (char === quote && next === quote) {
        output += next
        index++
      }
      else if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      output += char
      continue
    }
    if (char === "-" && next === "-") {
      index += 2
      while (index < statement.length && statement[index] !== "\n" && statement[index] !== "\r") index++
      output += " "
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < statement.length && !(statement[index] === "*" && statement[index + 1] === "/")) index++
      if (index < statement.length) index++
      output += " "
      continue
    }
    output += char
  }
  return output
}

function isReadOnlyPragma(statement: string) {
  const match = /^\s*pragma\s+(?:(?:main|temp)\.)?([a-z_]+)\s*(?:\([^)]*\))?\s*$/i.exec(statement)
  return match ? ["foreign_key_list", "index_list", "table_info"].includes(match[1]!.toLowerCase()) : false
}

function normalizeReadSql(statement: string) {
  const single = splitSingleSqlStatement(statement)
  if (!single) return
  if (isReadOnlyPragma(single)) return single
  const normalized = stripSqlComments(single).trim()
  if (/^select\b/i.test(normalized)) return single
  if (!/^with\b/i.test(normalized)) return
  if (/\b(insert|update|delete|replace|create|drop|alter|vacuum|pragma)\b/i.test(normalized)) return
  return /\bselect\b/i.test(normalized) ? single : undefined
}

function isDdlSql(statement: string) {
  const single = splitSingleSqlStatement(statement)
  return Boolean(single && /^\s*(alter|create|drop|reindex|vacuum)\b/i.test(stripSqlComments(single)))
}

export function kv(options: StorageCapabilityOptions = {}): AgentCapabilityDefinition<StorageCapabilityOptions> {
  return defineCapability({
    id: "kv",
    options,
    async resolve(context) {
      const runtime = await import("@vitehub/kv")
      const store = (runtime as { kv?: unknown }).kv as {
        del: (key: string) => Promise<unknown>
        get: (key: string) => Promise<unknown>
        keys: (prefix?: string) => Promise<string[]>
        set: (key: string, value: unknown) => Promise<unknown>
      }
      const tools: AgentToolSet = {
        kv_read: createTool({
          description: "Read one ViteHub KV value by key or list KV keys by prefix.",
          execute: ({ key, prefix }: { key?: string, prefix?: string } = {}) => {
            if (!hasExactlyOne(key, prefix)) throw new Error("[vitehub:agent] kv_read requires exactly one of key or prefix.")
            return key ? store.get(key) : store.keys(prefix)
          },
          name: "kv_read",
        }),
      }
      if (options.access === "write") {
        tools.kv_edit = createTool({
          description: "Put or delete one ViteHub KV key.",
          execute: ({ key, operation, value }: { key: string, operation: "delete" | "put", value?: unknown }) => {
            if (operation === "put") return store.set(key, value)
            if (operation === "delete") return store.del(key)
            throw new Error(`[vitehub:agent] Unsupported kv_edit operation: ${String(operation)}`)
          },
          name: "kv_edit",
        })
      }
      context.tools.add(tools)
      if (options.instructions !== false) context.instructions.add(options.instructions || `KV storage tools are available with ${options.access || "read"} access.`)
    },
  })
}

export function db(options: DbCapabilityOptions = {}): AgentCapabilityDefinition<DbCapabilityOptions> {
  return defineCapability({
    id: "db",
    options,
    async resolve(context) {
      const runtime = await import("@vitehub/db/drizzle")
      const databaseName = options.database || "default"
      const databases = (runtime as { databases?: Record<string, unknown> }).databases || {}
      const database = databases[databaseName] as {
        db?: { execute?: (query: string) => Promise<unknown>, run?: (query: string) => Promise<unknown> }
      } | undefined
      const tools: AgentToolSet = {
        db_schema: createTool({
          description: "Describe the configured ViteHub database capability.",
          execute: () => ({ access: options.access || "read", database: databaseName, prefix: options.prefix }),
          name: "db_schema",
        }),
        db_query: createTool({
          description: "Run a read-only SQL query against a ViteHub database.",
          execute: async ({ statement }: { statement: string }) => {
            if (!database?.db?.execute) throw new Error(`[vitehub:agent] Database "${databaseName}" is not available.`)
            const sql = normalizeReadSql(statement)
            if (!sql) throw new Error("[vitehub:agent] db_query only accepts SELECT, WITH ... SELECT, and read-only introspection PRAGMA statements.")
            return await database.db.execute(sql)
          },
          name: "db_query",
        }),
      }
      if (options.access === "write" || options.access === "schema") {
        tools.db_exec = createTool({
          description: "Run a SQL statement against a ViteHub database.",
          execute: async ({ rationale, statement }: { rationale: string, statement: string }) => {
            if (!rationale?.trim()) throw new Error("[vitehub:agent] db_exec requires a rationale.")
            if (!database?.db?.run && !database?.db?.execute) throw new Error(`[vitehub:agent] Database "${databaseName}" is not available.`)
            if (options.access !== "schema" && isDdlSql(statement)) throw new Error("[vitehub:agent] db_exec requires schema access for DDL statements.")
            const sql = splitSingleSqlStatement(statement)
            if (!sql) throw new Error("[vitehub:agent] db_exec accepts exactly one SQL statement.")
            return await (database.db.run || database.db.execute)!.call(database.db, sql)
          },
          name: "db_exec",
          policy: options.policy || "require-approval",
        })
      }
      context.tools.add(tools)
      if (options.instructions !== false) context.instructions.add(options.instructions || `Database tools are available with ${options.access || "read"} access.`)
    },
  })
}

export function mergeCapabilityTools(base: AgentToolSet | undefined, extra: AgentToolSet | undefined): AgentToolSet | undefined {
  return mergeAgentToolSets(base, extra)
}
