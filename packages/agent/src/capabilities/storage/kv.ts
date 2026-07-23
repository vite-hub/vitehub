import { defineCapability, normalizeMode } from "../../capability-runtime.ts"
import {
  assertString,
  createTool,
  jsonObjectSchema,
  method,
  requirePrimitive,
  selectStore,
  storageValue,
} from "./shared.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolSet,
  MaybePromise,
} from "../../types.ts"
import type { PrimitiveStorageCapabilityOptions } from "./shared.ts"

export interface KVCapabilityOptions extends PrimitiveStorageCapabilityOptions {}

export function kv(options: KVCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "KV")
  return defineCapability({ id: "kv", mode, requires: [{ primitive: "kv" }], tools: kvTools(mode, options) })
}

interface KVReadInput {
  key?: string
  prefix?: string
}

interface KVEditInput {
  key: string
  operation: "delete" | "put"
  value?: unknown
}

const kvReadInputSchema = jsonObjectSchema({
  key: { description: "Read one KV value by exact key.", type: "string" },
  prefix: { description: "List KV keys under this developer-provided prefix.", type: "string" },
})

const kvEditInputSchema = jsonObjectSchema({
  key: { type: "string" },
  operation: { enum: ["delete", "put"], type: "string" },
  value: {},
}, ["key", "operation"])

function hasExactlyOne(...values: unknown[]) {
  return values.filter(value => typeof value === "string" && value.trim()).length === 1
}

function kvTools(mode: AgentCapabilityMode, options: KVCapabilityOptions): AgentCapabilityDefinition["tools"] {
  return (context) => {
    const store = selectStore(requirePrimitive(context as never, "kv"), "KV", options.store)
    const tools: AgentToolSet = {
      kv_read: createTool<KVReadInput>({
        description: "Read one KV value by exact key or list KV keys under a developer-provided prefix.",
        execute: ({ key, prefix }: KVReadInput = {}) => {
          if (!hasExactlyOne(key, prefix)) throw new Error("[vitehub] kv_read requires exactly one of key or prefix.")
          if (typeof key === "string" && key.trim()) return storageValue(method<(key: string) => MaybePromise<unknown>>(store, "kv", "get")(key))
          return storageValue<string[]>(method<(prefix: string) => MaybePromise<string[]>>(store, "kv", "keys")(assertString(prefix, "kv_read prefix")))
        },
        inputSchema: kvReadInputSchema,
        name: "kv_read",
      }),
    }
    if (mode === "write") {
      tools.kv_edit = createTool<KVEditInput>({
        description: "Put or delete one KV key.",
        execute: ({ key, operation, value }) => {
          assertString(key, "kv_edit key")
          if (operation === "put") return storageValue(method<(key: string, value: unknown) => MaybePromise<unknown>>(store, "kv", "set")(key, value))
          if (operation === "delete") return storageValue(method<(key: string) => MaybePromise<unknown>>(store, "kv", "del")(key))
          throw new Error(`[vitehub] Unsupported kv_edit operation: ${String(operation)}`)
        },
        inputSchema: kvEditInputSchema,
        name: "kv_edit",
        policy: options.policy,
      })
    }
    return tools
  }
}
