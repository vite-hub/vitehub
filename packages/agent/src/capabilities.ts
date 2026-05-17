import { appendMessageText, defineCapability } from "./capability-runtime.ts"
import {
  mergeAgentToolSets,
  normalizeAgentSkillsOptions,
  resolveSkillsInstructions,
  withSkillWriteValidation,
} from "./skills.ts"

import type { AgentCapabilityDefinition } from "./capability-runtime.ts"
import type { AgentToolDefinition, AgentToolSet } from "./types.ts"
import type { AudioPart } from "@vitehub/messages"

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
  AgentInstructionBlock,
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
}

export interface StorageCapabilityOptions extends CapabilityInstructionsOption {
  access?: StorageAccess
}

function createTool<TInput = unknown, TOutput = unknown>(tool: AgentToolDefinition<TInput, TOutput>): AgentToolDefinition {
  return tool as AgentToolDefinition
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
        has: (key: string) => Promise<boolean>
        keys: (prefix?: string) => Promise<string[]>
        set: (key: string, value: unknown) => Promise<unknown>
      }
      const tools: AgentToolSet = {
        kv_get: createTool({
          description: "Read a value from ViteHub KV.",
          execute: ({ key }: { key: string }) => store.get(key),
          name: "kv_get",
        }),
        kv_has: createTool({
          description: "Check whether a ViteHub KV key exists.",
          execute: ({ key }: { key: string }) => store.has(key),
          name: "kv_has",
        }),
        kv_keys: createTool({
          description: "List ViteHub KV keys, optionally filtered by prefix.",
          execute: ({ prefix }: { prefix?: string } = {}) => store.keys(prefix),
          name: "kv_keys",
        }),
      }
      if (options.access === "write") {
        tools.kv_set = createTool({
          description: "Write a JSON-serializable value to ViteHub KV.",
          execute: ({ key, value }: { key: string, value: unknown }) => store.set(key, value),
          name: "kv_set",
        })
        tools.kv_delete = createTool({
          description: "Delete a key from ViteHub KV.",
          execute: ({ key }: { key: string }) => store.del(key),
          name: "kv_delete",
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
        list: (prefix?: string) => Promise<unknown>
        put: (path: string, value: string | Blob, options?: Record<string, unknown>) => Promise<unknown>
      }
      const tools: AgentToolSet = {
        blob_get_text: createTool({
          description: "Read a text blob from ViteHub Blob storage.",
          execute: async ({ path }: { path: string }) => {
            const value = await store.get(path)
            if (value instanceof Blob) return await value.text()
            return value
          },
          name: "blob_get_text",
        }),
        blob_head: createTool({
          description: "Read metadata for a ViteHub Blob path.",
          execute: ({ path }: { path: string }) => store.head(path),
          name: "blob_head",
        }),
        blob_list: createTool({
          description: "List blobs, optionally filtered by prefix.",
          execute: ({ prefix }: { prefix?: string } = {}) => store.list(prefix),
          name: "blob_list",
        }),
      }
      if (options.access === "write") {
        tools.blob_put_text = createTool({
          description: "Write text to ViteHub Blob storage.",
          execute: ({ contentType, path, text }: { contentType?: string, path: string, text: string }) => store.put(path, text, contentType ? { contentType } : undefined),
          name: "blob_put_text",
        })
        tools.blob_delete = createTool({
          description: "Delete a ViteHub Blob path.",
          execute: ({ path }: { path: string }) => store.del(path),
          name: "blob_delete",
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
        db_query: createTool({
          description: "Run a read-only SQL query against a ViteHub database.",
          execute: async ({ sql }: { sql: string }) => {
            if (!database?.db?.execute) throw new Error(`[vitehub:agent] Database "${databaseName}" is not available.`)
            if (!/^\s*(select|with|pragma)\b/i.test(sql)) throw new Error("[vitehub:agent] db_query only accepts read-only SQL.")
            return await database.db.execute(sql)
          },
          name: "db_query",
        }),
      }
      if (options.access === "schema" || options.access === "write") {
        tools.db_schema = createTool({
          description: "Describe the configured ViteHub database capability.",
          execute: () => ({ access: options.access || "read", database: databaseName, prefix: options.prefix }),
          name: "db_schema",
        })
      }
      if (options.access === "write") {
        tools.db_execute = createTool({
          description: "Run a SQL statement against a ViteHub database.",
          execute: async ({ sql }: { sql: string }) => {
            if (!database?.db?.run && !database?.db?.execute) throw new Error(`[vitehub:agent] Database "${databaseName}" is not available.`)
            return await (database.db.run || database.db.execute)!.call(database.db, sql)
          },
          name: "db_execute",
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
