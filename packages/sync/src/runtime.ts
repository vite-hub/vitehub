import { isSyncDefinition } from "./define.ts"
import { syncErrors } from "./errors.ts"
import { handleSyncRequest } from "./handler.ts"

import type { SyncDatabase } from "./database.ts"
import type { SyncCaller, SyncServices } from "./handler.ts"
import type { SyncDefinition } from "./types.ts"

export { handleSyncRequest } from "./handler.ts"
export type { SyncCaller, SyncServices } from "./handler.ts"

/** What the generated route of a ViteHub app passes. */
export interface SyncRuntimeOptions {
  /** The default export of each `server/sync/<name>.ts`, by name. */
  definitions: Record<string, unknown>
  /**
   * The default Database of the app, else its only one, as `useDatabase().db` of `@vite-hub/database/runtime/registry`
   * gives it. Every definition uses it. A function, because the Database can connect for each request, as D1 does.
   */
  db: () => unknown
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

function selectDatabase(db: unknown): SyncDatabase {
  if (!hasBatch(db)) {
    throw syncErrors.SYNC_NO_DATABASE({ message: "[vitehub] The Database of Sync has no atomic `batch()`. Sync supports SQLite Databases (libSQL, D1, and the local default) only. Postgres support comes later." })
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
  const db = () => selectDatabase(options.db())
  // One services object for every definition: its `db` function is the key of the live streams of each table and of
  // the triggers that this process checked, also when two definitions sync one table.
  const services: SyncServices = { db, ...(options.session ? { identify: options.session } : {}) }
  Reflect.set(globalThis, installedKey, { names: [...definitions.keys()].sort(), definition: name => definitions.get(name), db } satisfies InstalledSync)
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
      return await handleSyncRequest(name, definition, request, services)
    },
  }
}
