import { isWebContainer } from "@vite-hub/web-container/env"
import { construct } from "drizzle-orm/libsql/driver-core"

import { deferLibsqlClient } from "./deferred-libsql-client.ts"

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
 * The libSQL client for a local SQLite database. It loads `@libsql/client` on the first query, so an app that reaches
 * its database through a D1 binding never loads libSQL. A StackBlitz WebContainer cannot load native libSQL or
 * `node:sqlite`, so there a local file opens with SQLite WASM, which keeps the database in memory and writes the file
 * after each committed write. It logs that once, and Database inspection shows it.
 */
export function createLocalSqliteClient(config: Config): Client {
  return deferLibsqlClient(libsqlProtocol(config.url), async () => {
    if (isWebContainer()) {
      const { createWasmSqliteClient, localSqliteFilePath } = await import("@vite-hub/internal/runtime/sqlite-wasm")
      // SAFETY: The SQLite WASM client implements the libSQL `Client` methods that Drizzle and ViteHub call.
      if (localSqliteFilePath(config.url)) return createWasmSqliteClient({ intMode: config.intMode, url: config.url }) as unknown as Client
    }
    const { createClient } = await import("@libsql/client")
    return createClient(config)
  })
}

/** The libSQL factory for `createDrizzleSqliteAdapter()` on a local SQLite database. */
export const localLibsql: LibsqlClientFactory = { createClient: createLocalSqliteClient, drizzle: construct }
