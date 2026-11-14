import { isSyncDefinition } from "./define.ts"
import { syncErrors } from "./errors.ts"
import { handleSyncRequest, recordChanges } from "./handler.ts"
import { wakeLiveStreams } from "./live.ts"

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
  /** Wakes the live streams of a definition in this process, after server code recorded changes. */
  wake: (name: string) => void
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
  // One services object for each definition, so compaction runs at most once an hour for each name in this process,
  // and its `db` function is the key that wakes the live streams of the name.
  const services = new Map<string, SyncServices>()
  for (const name of definitions.keys()) {
    services.set(name, { db: () => db(name), ...(options.session ? { identify: options.session } : {}) })
  }
  const wake = (name: string) => {
    const found = services.get(name)
    if (found) wakeLiveStreams(found.db, name)
  }
  Reflect.set(globalThis, installedKey, { names: [...definitions.keys()].sort(), definition: name => definitions.get(name), db, wake } satisfies InstalledSync)
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
 * Records writes that server code made to a Sync table directly, so clients get them on their next pull, and open live
 * streams of this process at once. Pass the keys of inserted and updated rows in `put`, the deleted rows, as they were
 * before the delete, in `delete`, and the rows whose `where` column changed, as they were before the change, in
 * `moved`.
 *
 * ```ts
 * await db.insert(todos).values(todo)
 * const [error] = await recordSyncChanges("todos", { put: [todo.id] })
 *
 * // A move to another team: send the row as it was before.
 * const [before] = await db.select().from(issues).where(eq(issues.id, id))
 * await db.update(issues).set({ teamId: "t2" }).where(eq(issues.id, id))
 * await recordSyncChanges("issues", { moved: [before] })
 * ```
 */
export async function recordSyncChanges(name: string, changes: SyncChanges): Promise<Result<{ recorded: number }>> {
  try {
    const installed = installedSync()
    if (!installed) return [syncErrors.SYNC_NOT_INSTALLED(), undefined]
    const definition = installed.definition(name)
    if (!definition) return [syncErrors.SYNC_UNKNOWN_NAME({ name }), undefined]
    const recorded = await recordChanges(name, definition, installed.db(name), changes, Date.now())
    installed.wake(name)
    return [undefined, { recorded }]
  }
  catch (error) {
    if (isSyncError(error)) return [error, undefined]
    return [syncErrors.SYNC_NO_DATABASE({ message: `[vitehub] recordSyncChanges("${name}") could not write the change log. Apply the Sync tables with \`vitehub database generate\` and \`vitehub database migrate\`.`, cause: error }), undefined]
  }
}
