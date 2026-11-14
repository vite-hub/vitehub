import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { cacheMaximumListLimit } from "./entries.ts"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { CacheDeleteResult, CacheGetResult, CacheListResult } from "./entries.ts"

// The runtime module reads Nitro's storage, which only exists in the Nitro runtime. The operations load it when they
// run, so the CLI and `vitehub inspect` can list them without it.
const runtime = () => import("./runtime.ts")

function defineCacheOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "cli" | "section" | "user"> & { cli?: Omit<NonNullable<OperationDefinition<Input, Output>["cli"]>, "namespace"> }): OperationDefinition<Input, Output> {
  // The cache answers for the section. The operations never read the signed-in user.
  return defineOperation({ ...definition, cli: { ...definition.cli, namespace: "cache" }, section: "cache", user: false })
}

const key = v.pipe(v.string(), v.minLength(1))

const list = defineCacheOperation<{ cursor?: string, limit?: number, prefix?: string }, CacheListResult>({
  description: "List the entries of Nitro's cache, one page at a time, with group, name, size, and expiry. `prefix` matches the start of the key.",
  input: v.strictObject({
    cursor: v.optional(v.string()),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(cacheMaximumListLimit))),
    prefix: v.optional(v.string()),
  }),
  kind: "read",
  name: "cache.list",
  run: async input => (await runtime()).listCache(input),
})

const get = defineCacheOperation<{ key: string }, CacheGetResult>({
  cli: { positional: ["key"] },
  description: "Read one entry of Nitro's cache with its value as JSON text of at most 256 KiB.",
  input: v.strictObject({ key }),
  kind: "read",
  name: "cache.get",
  run: async input => (await runtime()).getCache(input),
})

const deleteEntries = defineCacheOperation<{ key?: string, prefix?: string }, CacheDeleteResult>({
  cli: { positional: ["key"] },
  description: "Invalidate one entry of Nitro's cache by key, or at most 1,000 entries whose keys start with `prefix`. The app computes the value again on the next call.",
  input: v.strictObject({ key: v.optional(key), prefix: v.optional(key) }),
  kind: "destructive",
  name: "cache.delete",
  run: async input => (await runtime()).deleteCache(input),
})

/** The `cache.*` operations: list, get, and delete. The Console, `vitehub cache`, and agents run them. */
export const cacheOperations: readonly AnyOperation[] = [list, get, deleteEntries]
