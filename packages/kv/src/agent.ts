import { defineTool } from "@vitehub/agent"

import type { AgentToolDefinition, AgentToolSet } from "@vitehub/agent"

export type KvAgentToolAccess = "read" | "write"

export type KvAgentToolDefinition<TInput = unknown, TOutput = unknown> = AgentToolDefinition<TInput, TOutput>
export type KvAgentToolSet = AgentToolSet

export interface KvAgentStorage {
  del(key: string, options?: unknown): Promise<void>
  get(key: string, options?: unknown): Promise<unknown | null>
  has(key: string, options?: unknown): Promise<boolean>
  keys(base?: string, options?: unknown): Promise<string[]>
  set(key: string, value: unknown, options?: unknown): Promise<void>
}

export interface CreateKvToolsOptions {
  access?: KvAgentToolAccess
  kv?: KvAgentStorage
}

interface KeyInput {
  key: string
  options?: unknown
}

interface KeysInput {
  base?: string
  options?: unknown
}

interface SetInput extends KeyInput {
  value: unknown
}

const metadata = {
  category: "kv",
  preset: "vitehub-kv",
}

async function getKv(options: CreateKvToolsOptions) {
  if (options.kv) return options.kv
  const module = await import("./index.ts")
  return module.kv
}

function keyProperties() {
  return {
    key: { description: "Storage key to read or write.", type: "string" },
    options: { description: "Optional driver-specific options." },
  }
}

function readTools(options: CreateKvToolsOptions): KvAgentToolSet {
  return {
    kv_get: defineTool<KeyInput, { key: string, value: unknown }>({
      description: "Read one KV value by key.",
      execute: async ({ key, options: driverOptions }) => ({ key, value: await (await getKv(options)).get(key, driverOptions) }),
      inputSchema: {
        additionalProperties: false,
        properties: keyProperties(),
        required: ["key"],
        type: "object",
      },
      metadata,
      name: "kv_get",
    }),
    kv_has: defineTool<KeyInput, { exists: boolean, key: string }>({
      description: "Check whether one KV key exists.",
      execute: async ({ key, options: driverOptions }) => ({ exists: await (await getKv(options)).has(key, driverOptions), key }),
      inputSchema: {
        additionalProperties: false,
        properties: keyProperties(),
        required: ["key"],
        type: "object",
      },
      metadata,
      name: "kv_has",
    }),
    kv_keys: defineTool<KeysInput, { keys: string[] }>({
      description: "List KV keys, optionally under a prefix.",
      execute: async ({ base, options: driverOptions }) => ({ keys: await (await getKv(options)).keys(base, driverOptions) }),
      inputSchema: {
        additionalProperties: false,
        properties: {
          base: { description: "Optional key prefix to list under.", type: "string" },
          options: { description: "Optional driver-specific options." },
        },
        type: "object",
      },
      metadata,
      name: "kv_keys",
    }),
  }
}

function writeTools(options: CreateKvToolsOptions): KvAgentToolSet {
  return {
    kv_set: defineTool<SetInput, { key: string }>({
      description: "Write one JSON-serializable KV value by key.",
      execute: async ({ key, options: driverOptions, value }) => {
        await (await getKv(options)).set(key, value, driverOptions)
        return { key }
      },
      inputSchema: {
        additionalProperties: false,
        properties: {
          ...keyProperties(),
          value: { description: "JSON-serializable value to store." },
        },
        required: ["key", "value"],
        type: "object",
      },
      metadata,
      name: "kv_set",
    }),
    kv_delete: defineTool<KeyInput, { key: string }>({
      description: "Delete one KV key.",
      execute: async ({ key, options: driverOptions }) => {
        await (await getKv(options)).del(key, driverOptions)
        return { key }
      },
      inputSchema: {
        additionalProperties: false,
        properties: keyProperties(),
        required: ["key"],
        type: "object",
      },
      metadata,
      name: "kv_delete",
    }),
  }
}

export function createKvTools(options: CreateKvToolsOptions = {}): KvAgentToolSet {
  const access = options.access || "read"
  if (access === "read") return readTools(options)
  if (access === "write") return { ...readTools(options), ...writeTools(options) }
  throw new TypeError(`[vitehub] Unknown KV agent tool access: ${String(access)}`)
}
