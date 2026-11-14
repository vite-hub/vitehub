import { defineCapability, normalizeMode } from "../../capability-runtime.ts"
import { defineInternalTool, jsonObjectSchema, requirePrimitive } from "../internal.ts"
import {
  assertString,
  method,
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
import { agentDiagnostics } from "../../agent-diagnostics.ts"

export interface KVCapabilityOptions extends PrimitiveStorageCapabilityOptions {
  /** Limits `kv_read` and `kv_edit` to keys under this prefix, such as `support:`. */
  prefix?: string
}

export function kv(options: KVCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "KV")
  const scope = kvScope(options.prefix)
  return defineCapability({ id: "kv", mode, requires: [{ primitive: "kv" }], tools: kvTools(mode, options, scope) })
}

// Match unstorage: discard the query, normalize separators, and trim the root separator.
function normalizeKVKey(key: string): string {
  return (key.split("?")[0] || "").replace(/[/\\]/g, ":").replace(/:+/g, ":").replace(/^:|:$/g, "")
}

function hasDotSegment(key: string): boolean {
  return key.split(":").some(segment => segment === "." || segment === "..")
}

function kvScope(prefix: string | undefined): string | undefined {
  if (prefix === undefined) return
  const scope = typeof prefix === "string" ? normalizeKVKey(prefix.trim()) : ""
  if (!scope || hasDotSegment(scope)) throw agentDiagnostics.AGENT_R1055({ capability: "kv", prefix })
  return scope
}

function inKVScope(key: string, scope: string): boolean {
  const normalized = normalizeKVKey(key)
  return normalized.startsWith(`${scope}:`) && !hasDotSegment(normalized)
}

function scopedKVKey(key: string, scope: string | undefined, label: string): string {
  if (scope !== undefined && !inKVScope(key, scope)) throw agentDiagnostics.AGENT_R1056({ label, prefix: `${scope}:`, value: key })
  return key
}

function scopeNote(scope: string | undefined): string {
  return scope === undefined ? "" : ` Every key must start with "${scope}:".`
}

/** Returns the prefix to list. Inside a scope, the prefix must be the scope or a prefix under it. */
function scopedKVListPrefix(prefix: string, scope: string | undefined): string {
  if (scope === undefined) return prefix
  const normalized = normalizeKVKey(prefix)
  if (normalized === scope) return `${scope}:`
  return scopedKVKey(prefix, scope, "kv_read prefix")
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
  prefix: { description: "List KV keys under this prefix.", type: "string" },
})

const kvEditInputSchema = jsonObjectSchema({
  key: { type: "string" },
  operation: { enum: ["delete", "put"], type: "string" },
  value: {},
}, ["key", "operation"])

function hasExactlyOne(...values: unknown[]) {
  return values.filter(value => typeof value === "string" && value.trim()).length === 1
}

function kvTools(mode: AgentCapabilityMode, options: KVCapabilityOptions, scope: string | undefined): AgentCapabilityDefinition["tools"] {
  return (context) => {
    const store = selectStore(requirePrimitive(context as never, "kv"), "KV", options.store)
    const tools: AgentToolSet = {
      kv_read: defineInternalTool<KVReadInput>({
        description: `Read one KV value by exact key or list KV keys under a prefix.${scopeNote(scope)}`,
        execute: async ({ key, prefix }: KVReadInput = {}) => {
          if (!hasExactlyOne(key, prefix)) throw agentDiagnostics.AGENT_R0224({ message: "[vitehub] kv_read requires exactly one of key or prefix." })
          if (typeof key === "string" && key.trim()) return storageValue(method<(key: string) => MaybePromise<unknown>>(store, "kv", "get")(scopedKVKey(key, scope, "kv_read key")))
          const listPrefix = scopedKVListPrefix(assertString(prefix, "kv_read prefix"), scope)
          const keys = await storageValue<string[]>(method<(prefix: string) => MaybePromise<string[]>>(store, "kv", "keys")(listPrefix))
          return scope === undefined ? keys : keys.filter(key => inKVScope(key, scope))
        },
        icon: "i-lucide-key-round",
        inputSchema: kvReadInputSchema,
        name: "kv_read",
        title: "Read KV",
      }),
    }
    if (mode === "write") {
      tools.kv_edit = defineInternalTool<KVEditInput>({
        description: `Put or delete one KV key.${scopeNote(scope)}`,
        execute: ({ key, operation, value }) => {
          scopedKVKey(assertString(key, "kv_edit key"), scope, "kv_edit key")
          if (operation === "put") return storageValue(method<(key: string, value: unknown) => MaybePromise<unknown>>(store, "kv", "set")(key, value))
          if (operation === "delete") return storageValue(method<(key: string) => MaybePromise<unknown>>(store, "kv", "delete")(key))
          throw agentDiagnostics.AGENT_R0225({ message: `[vitehub] Unsupported kv_edit operation: ${String(operation)}` })
        },
        icon: "i-lucide-key-round",
        inputSchema: kvEditInputSchema,
        name: "kv_edit",
        policy: options.policy,
        title: "Changed KV",
      })
    }
    return tools
  }
}
