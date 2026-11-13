import { isSyncDefinition } from "./define.ts"
import { syncErrors } from "./errors.ts"
import { handleSyncRequest, recordChanges } from "./handler.ts"

import type { Result, ResultError } from "@vite-hub/runtime"
import type { SyncDatabase } from "./database.ts"
import type { SyncCaller, SyncChanges, SyncServices } from "./handler.ts"
import type { SyncDefinition } from "./types.ts"

export { handleSyncRequest } from "./handler.ts"
export type { SyncCaller, SyncChanges, SyncServices } from "./handler.ts"

/** The Database registry of `@vite-hub/database/runtime/registry`, as the generated handler passes it. */
export type SyncDatabaseRegistry = Record<string, { db: unknown } | undefined>

/** What the generated route of a ViteHub app passes. */
export interface SyncRuntimeOptions {
  /** The default export of each `server/sync/<name>.ts`, by name. */
  definitions: Record<string, unknown>
  /** The Database registry. Each definition uses its `database`, else `default`. */
  databases: SyncDatabaseRegistry
  /** The signed-in caller of a request, from ViteHub Auth. */
  session?: (request: Request) => Promise<SyncCaller | null>
}

/** The Sync definitions of the running app, for server code, the CLI, and MCP tools. */
export interface InstalledSync {
  names: string[]
  definition: (name: string) => SyncDefinition | undefined
  /** The Database of a definition. */
  db: (name: string) => SyncDatabase
}

const installedKey = Symbol.for("vitehub.sync.installed")

export function installedSync(): InstalledSync | undefined {
  const value: unknown = Reflect.get(globalThis, installedKey)
  // SAFETY: only createSyncHandler() writes this process slot.
  return value === undefined ? undefined : value as InstalledSync
}

function hasBatch(db: unknown): db is SyncDatabase {
  return typeof Reflect.get(Object(db), "batch") === "function"
}

function selectDatabase(databases: SyncDatabaseRegistry, name: string): SyncDatabase {
  const db = databases[name]?.db
  if (!db) throw syncErrors.SYNC_NO_DATABASE({ message: `[vitehub] Sync has no Database named ${JSON.stringify(name)}.` })
  if (!hasBatch(db)) {
    throw syncErrors.SYNC_NO_DATABASE({ message: `[vitehub] The Database ${JSON.stringify(name)} has no atomic \`batch()\`. Sync supports SQLite Databases (libSQL, D1, and the local default) only. Postgres support comes later.` })
  }
  return db
}

/**
 * The `{ fetch }` route of every Sync definition at `<base>api/_vitehub/sync/<name>`. The generated Nitro handler of a
 * ViteHub app calls it with the definitions of `server/sync/` when the server starts.
 */
export function createSyncHandler(options: SyncRuntimeOptions): { fetch: (request: Request) => Promise<Response> } {
  const definitions = new Map<string, SyncDefinition>()
  for (const [name, definition] of Object.entries(options.definitions)) {
    if (!isSyncDefinition(definition)) throw syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] server/sync/${name} must default-export defineSync({ table, where }).` })
    definitions.set(name, definition)
  }
  const db = (name: string) => selectDatabase(options.databases, definitions.get(name)?.options.database ?? "default")
  Reflect.set(globalThis, installedKey, { names: [...definitions.keys()].sort(), definition: name => definitions.get(name), db } satisfies InstalledSync)
  // One services object for each definition, so compaction runs at most once an hour for each name in this process.
  const services = new Map<string, SyncServices>()
  for (const name of definitions.keys()) {
    services.set(name, { db: () => db(name), ...(options.session ? { identify: options.session } : {}) })
  }
  return {
    async fetch(request) {
      const segment = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? ""
      let name = segment
      try {
        name = decodeURIComponent(segment)
      }
      catch {
        // A broken escape, such as `%E0`, names no definition: the lookup below answers 404.
      }
      const definition = definitions.get(name)
      if (!definition) {
        const error = syncErrors.SYNC_UNKNOWN_NAME({ name })
        return new Response(JSON.stringify({ code: error.code, message: error.message, fix: error.fix, docs: error.docs }), { status: 404, headers: { "content-type": "application/json", "cache-control": "private, no-store" } })
      }
      return await handleSyncRequest(name, definition, request, services.get(name)!)
    },
  }
}

function isSyncError(error: unknown): error is ResultError {
  const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined
  return typeof code === "string" && code.startsWith("SYNC_")
}

/**
 * Records writes that server code made to a Sync table directly, so clients get them on their next pull. Pass the
 * keys of inserted and updated rows in `put`, and the deleted rows, as they were before the delete, in `delete`.
 *
 * ```ts
 * await db.insert(todos).values(todo)
 * const [error] = await recordSyncChanges("todos", { put: [todo.id] })
 * ```
 */
export async function recordSyncChanges(name: string, changes: SyncChanges): Promise<Result<{ recorded: number }>> {
  try {
    const installed = installedSync()
    if (!installed) return [syncErrors.SYNC_NOT_INSTALLED(), undefined]
    const definition = installed.definition(name)
    if (!definition) return [syncErrors.SYNC_UNKNOWN_NAME({ name }), undefined]
    return [undefined, { recorded: await recordChanges(name, definition, installed.db(name), changes, Date.now()) }]
  }
  catch (error) {
    if (isSyncError(error)) return [error, undefined]
    return [syncErrors.SYNC_NO_DATABASE({ message: `[vitehub] recordSyncChanges("${name}") could not write the change log. Apply the Sync tables with \`vitehub database generate\` and \`vitehub database migrate\`.`, cause: error }), undefined]
  }
}
