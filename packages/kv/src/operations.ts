import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { kvDevMaximumListLimit } from "./results.ts"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { KVDevDeleteResult, KVDevGetResult, KVDevHasResult, KVDevListResult, KVDevSetResult } from "./runtime/operations.ts"

// The runtime module imports the KV storage of the app, which only exists in the Nitro runtime. The operations load it
// when they run, so the CLI and `vitehub inspect` can list them without it.
const runtime = () => import("./runtime/operations.ts")

const store = v.optional(v.pipe(v.string(), v.check(name => name.trim() !== "", "Name a store.")))
const key = v.string()

function defineKVOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  // The stores answer for the section. The operations never read the signed-in user.
  return defineOperation({ ...definition, section: "kv", user: false })
}

const list = defineKVOperation<{ cursor?: string, limit?: number, prefix?: string, store?: string }, KVDevListResult>({
  cli: { command: "list" },
  description: "List the keys of a KV store, one page at a time.",
  input: v.object({
    cursor: v.optional(v.string()),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(kvDevMaximumListLimit))),
    prefix: v.optional(v.string()),
    store,
  }),
  kind: "read",
  name: "kv.list",
  run: async input => await (await runtime()).runKVOperation("list", input) as KVDevListResult,
})

const get = defineKVOperation<{ key: string, preview?: boolean, store?: string }, KVDevGetResult>({
  cli: { positional: ["key"] },
  description: "Read the value of one key. `preview` returns it as text of at most 256 KiB.",
  input: v.object({ key, preview: v.optional(v.boolean()), store }),
  kind: "read",
  name: "kv.get",
  run: async input => await (await runtime()).runKVOperation("get", input) as KVDevGetResult,
})

const has = defineKVOperation<{ key: string, store?: string }, KVDevHasResult>({
  cli: { positional: ["key"] },
  description: "Check if a key exists.",
  input: v.object({ key, store }),
  kind: "read",
  name: "kv.has",
  run: async input => await (await runtime()).runKVOperation("has", input) as KVDevHasResult,
})

const set = defineKVOperation<{ key: string, store?: string, ttl?: number, value: unknown }, KVDevSetResult>({
  cli: { positional: ["key", "value"] },
  description: "Write the value of one key. A string, or any JSON value.",
  input: v.object({ key, store, ttl: v.optional(v.pipe(v.number(), v.finite(), v.gtValue(0))), value: v.unknown() }),
  kind: "write",
  // A value can be larger than the default request limit of a call.
  maxRequestBytes: 4 * 1_024 * 1_024,
  name: "kv.set",
  run: async input => await (await runtime()).runKVOperation("set", input) as KVDevSetResult,
})

const del = defineKVOperation<{ key: string, store?: string }, KVDevDeleteResult>({
  cli: { command: "del", positional: ["key"] },
  description: "Delete one key. There is no operation that clears a store.",
  input: v.object({ key, store }),
  kind: "destructive",
  name: "kv.del",
  run: async input => await (await runtime()).runKVOperation("del", input) as KVDevDeleteResult,
})

/** The `kv.*` operations: list, get, has, set, and del. The Console, `vitehub kv`, and agents run them. */
export const kvOperations: readonly AnyOperation[] = [list, get, has, set, del]

export type { KVDevDeleteResult, KVDevGetResult, KVDevHasResult, KVDevListResult, KVDevSetResult }

export { createStandaloneOperationHandler } from "@vite-hub/internal/operations-dev"
