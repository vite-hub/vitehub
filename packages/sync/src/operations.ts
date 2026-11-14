import { defineOperation, table } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { SyncChangeEntry, SyncSummary } from "./inspect.ts"

export type { SyncChangeEntry, SyncSummary } from "./inspect.ts"

// The definitions live in the Nitro runtime. The operations load them when they run, so the CLI can list the
// operations without them.
async function installed() {
  const [{ installedSync }, inspect] = await Promise.all([import("./runtime.ts"), import("./inspect.ts")])
  const sync = installedSync()
  if (!sync) throw (await import("./errors.ts")).syncErrors.SYNC_NOT_INSTALLED()
  return { sync, inspect }
}

function defineSyncOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  // Access to the Sync section of the Console decides. The operations never read the signed-in user.
  return defineOperation({ ...definition, cli: { namespace: "sync", ...definition.cli }, section: "sync", user: false })
}

function formatList(rows: SyncSummary[]): string {
  if (!rows.length) return "No Sync definitions.\n"
  return `${table([
    ["NAME", "TABLE", "KEY", "WRITE", "LIVE", "ACTIONS", "ROWS", "CHANGES", "EXITS", "FLOOR", "LAST SEQ"],
    ...rows.map(row => [row.name, row.table, row.key, row.write, row.live ? "yes" : "no", row.actions.join(",") || "-", String(row.rows), String(row.changes), String(row.exits), String(row.floor), String(row.lastSeq)]),
  ])}\n`
}

function formatChanges(rows: SyncChangeEntry[]): string {
  if (!rows.length) return "No changes.\n"
  return `${table([
    ["SEQ", "OP", "KEY", "AT"],
    ...rows.map(row => [String(row.seq), row.op, row.key, new Date(row.createdAt).toISOString()]),
  ])}\n`
}

const list = defineSyncOperation<Record<string, never>, SyncSummary[]>({
  cli: { default: true, format: formatList },
  description: "List the Sync definitions with their write mode, live streams, action names, row count, change count, exit count, floor, and last seq.",
  input: v.object({}),
  kind: "read",
  name: "sync.list",
  run: async () => {
    const { sync, inspect } = await installed()
    return await inspect.summarizeSync(sync)
  },
})

const changes = defineSyncOperation<{ name: string, limit?: number, before?: number }, SyncChangeEntry[]>({
  cli: { format: formatChanges, positional: ["name"] },
  description: "List the newest changes of one Sync definition: seq, op (put, delete, or move), key, and time, without row data.",
  input: v.object({
    name: v.pipe(v.string(), v.minLength(1), v.description("The Sync name, such as todos.")),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500))),
    before: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.description("Only changes with a lower seq."))),
  }),
  kind: "read",
  name: "sync.changes",
  run: async (input) => {
    const { sync, inspect } = await installed()
    return await inspect.listSyncChanges(sync, input.name, input)
  },
})

/** The `sync.*` operations: list and changes. The Console, `vitehub sync`, and MCP run them. */
export const syncOperations: readonly AnyOperation[] = [list, changes]

export { createStandaloneOperationHandler } from "@vite-hub/internal/operations-dev"
