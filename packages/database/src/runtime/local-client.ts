import { isWebContainer } from "@vite-hub/web-container/env"

import { deferLibsqlClient } from "./deferred-libsql-client.ts"
import { createLibsqlDrizzle } from "./libsql-drizzle.ts"

import type { Client, Config } from "@libsql/client"
import type { LibsqlClientFactory } from "./drizzle-adapter.ts"

/** The `protocol` that the Node.js `@libsql/client` reports for a URL. */
function libsqlProtocol(url: string) {
  const scheme = /^([a-z][\w+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  if (scheme === "http" || scheme === "https") return "http"
  if (scheme === "ws" || scheme === "wss" || scheme === "libsql") return "ws"
  return "file"
}

/**
 * Milliseconds that a local `file:` client waits for the SQLite lock that another connection or process holds. Without
 * a wait, SQLite returns `SQLITE_BUSY` at once, and `@libsql/client` 0.18 can lose committed writes when the connection
 * runs more statements after that. The wait blocks the calling thread, because the native client is synchronous, so it
 * stays short. Writes of a server hold the lock for milliseconds. Five seconds is also the default of better-sqlite3.
 */
const localSqliteBusyTimeoutMs = 5_000

/**
 * The libSQL client for a local SQLite database. It loads `@libsql/client` on the first query, so an app that reaches
 * its database through a D1 binding never loads libSQL. A StackBlitz WebContainer cannot load native libSQL or
 * `node:sqlite`, so there a local file opens with SQLite WASM, which keeps the database in memory and writes the file
 * after each committed write. It logs that once, and Database inspection shows it. A `file:` client waits up to
 * `localSqliteBusyTimeoutMs` for the lock of another process, unless `config.timeout` sets another wait.
 */
export function createLocalSqliteClient(config: Config): Client {
  const protocol = libsqlProtocol(config.url)
  return deferLibsqlClient(protocol, async () => {
    if (isWebContainer()) {
      const { createWasmSqliteClient, localSqliteFilePath } = await import("@vite-hub/internal/runtime/sqlite-wasm")
      // SAFETY: The SQLite WASM client implements the libSQL `Client` methods that Drizzle and ViteHub call.
      if (localSqliteFilePath(config.url)) return createWasmSqliteClient({ intMode: config.intMode, url: config.url }) as unknown as Client
    }
    const { createClient } = await import("@libsql/client")
    return createClient(protocol === "file" ? { ...config, timeout: config.timeout ?? localSqliteBusyTimeoutMs } : config)
  })
}

/** The libSQL factory for `createDrizzleSqliteAdapter()` on a local SQLite database. */
export const localLibsql: LibsqlClientFactory = { createClient: createLocalSqliteClient, drizzle: createLibsqlDrizzle }
