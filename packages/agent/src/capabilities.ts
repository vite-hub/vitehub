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

export interface VoiceInputOptions extends CapabilityInstructionsOption {
  transcribe: (audio: AudioPart) => Promise<string> | string
}

function isAudioPart(part: unknown): part is AudioPart {
  return typeof part === "object"
    && part !== null
    && (part as { type?: unknown }).type === "audio"
}

export function voiceInput(options: VoiceInputOptions): AgentCapabilityDefinition<VoiceInputOptions> {
  return defineCapability({
    id: "voiceInput",
    options,
    async input(context) {
      const messages = []
      for (const message of context.input.messages()) {
        const audioParts = message.parts.filter(isAudioPart)
        if (!audioParts.length) {
          messages.push(message)
          continue
        }
        const transcripts = await Promise.all(audioParts.map(part => options.transcribe(part)))
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
      })
    },
  })
}

export interface McpServerConfig {
  headers?: Record<string, string>
  name?: string
  tools?: AgentToolSet | (() => Promise<AgentToolSet> | AgentToolSet)
  transport?: "http" | "stdio"
  url?: string
  [key: string]: unknown
}

export interface McpCapabilityOptions extends CapabilityInstructionsOption {
  servers: Record<string, McpServerConfig>
}

function redactSecret(value: string) {
  return value.length <= 6 ? "***" : `${value.slice(0, 2)}***${value.slice(-2)}`
}

function sanitizeMcpMetadata(config: McpServerConfig) {
  const headers = Object.fromEntries(Object.entries(config.headers || {}).map(([key, value]) => [key, redactSecret(value)]))
  return {
    ...config,
    ...(Object.keys(headers).length ? { headers } : {}),
    tools: undefined,
  }
}

export function mcp(options: McpCapabilityOptions): AgentCapabilityDefinition<McpCapabilityOptions> {
  return defineCapability({
    id: "mcp",
    options,
    async resolve(context) {
      const tools: AgentToolSet = {}
      for (const [serverName, server] of Object.entries(options.servers)) {
        const serverTools = typeof server.tools === "function" ? await server.tools() : server.tools
        for (const [toolName, tool] of Object.entries(serverTools || {})) {
          const name = `mcp_${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_")
          tools[name] = {
            ...tool,
            metadata: {
              ...(tool.metadata || {}),
              mcp: sanitizeMcpMetadata(server),
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
  })
}

export function httpMcpServer(url: string, options: Omit<McpServerConfig, "transport" | "url"> = {}): McpServerConfig {
  return { ...options, transport: "http", url }
}

export function stdioMcpServer(command: string, args: string[] = [], options: Omit<McpServerConfig, "args" | "command" | "transport"> = {}): McpServerConfig {
  return { ...options, args, command, transport: "stdio" }
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

function createTool<TInput = unknown, TOutput = unknown>(tool: AgentToolDefinition<TInput, TOutput>): AgentToolDefinition {
  return tool as AgentToolDefinition
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

function base64ToBlob(data: string, mediaType: string) {
  const buffer = typeof Buffer !== "undefined"
    ? Buffer.from(data, "base64")
    : Uint8Array.from(atob(data), character => character.charCodeAt(0))
  return new Blob([buffer], { type: mediaType })
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

export function blob(options: StorageCapabilityOptions = {}): AgentCapabilityDefinition<StorageCapabilityOptions> {
  return defineCapability({
    id: "blob",
    options,
    async resolve(context) {
      const runtime = await import("@vitehub/blob")
      const store = (runtime as { blob?: unknown }).blob as {
        del: (path: string) => Promise<unknown>
        get: (path: string) => Promise<Blob | string | undefined>
        head: (path: string) => Promise<unknown>
        list: (options?: Record<string, unknown>) => Promise<unknown>
        put: (path: string, value: string | Blob, options?: Record<string, unknown>) => Promise<unknown>
      }
      const tools: AgentToolSet = {
        blob_read: createTool({
          description: "List blobs or read one blob as text, JSON, or metadata.",
          execute: async ({ format = "text", operation, pathname, ...listOptions }: { format?: "json" | "metadata" | "text", operation: "list" | "read", pathname?: string } & Record<string, unknown>) => {
            if (operation === "list") return await store.list(listOptions)
            if (operation !== "read") throw new Error(`[vitehub:agent] Unsupported blob_read operation: ${String(operation)}`)
            if (!pathname) throw new Error("[vitehub:agent] blob_read requires pathname for read operations.")
            if (format === "metadata") return await store.head(pathname)
            const value = await store.get(pathname)
            const text = value instanceof Blob ? await value.text() : value
            return format === "json" && typeof text === "string" ? JSON.parse(text) : text
          },
          name: "blob_read",
        }),
      }
      if (options.access === "write") {
        tools.blob_edit = createTool({
          description: "Write or delete one blob. Writes support text, JSON, and base64 media content.",
          execute: ({ content, contentType, format = "text", mediaType, operation, pathname }: { content?: unknown, contentType?: string, format?: "base64" | "json" | "text", mediaType?: string, operation: "delete" | "write", pathname: string }) => {
            if (operation === "delete") return store.del(pathname)
            if (operation !== "write") throw new Error(`[vitehub:agent] Unsupported blob_edit operation: ${String(operation)}`)
            if (format === "base64") {
              if (typeof content !== "string") throw new Error("[vitehub:agent] blob_edit base64 writes require string content.")
              if (!mediaType) throw new Error("[vitehub:agent] blob_edit base64 writes require mediaType.")
              return store.put(pathname, base64ToBlob(content, mediaType), { contentType: mediaType })
            }
            if (format === "json") return store.put(pathname, JSON.stringify(content), { contentType: contentType || "application/json; charset=utf-8" })
            return store.put(pathname, String(content ?? ""), { contentType: contentType || "text/plain; charset=utf-8" })
          },
          name: "blob_edit",
        })
      }
      context.tools.add(tools)
      if (options.instructions !== false) context.instructions.add(options.instructions || `Blob storage tools are available with ${options.access || "read"} access.`)
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
