import { createClient } from "@libsql/client"
import { createWasmSqliteClient, localSqliteFilePath } from "@vite-hub/internal/runtime/sqlite-wasm"
import { isWebContainer } from "@vite-hub/web-container/env"

import type { Client, Config } from "@libsql/client"

/**
 * The libSQL client for a local SQLite database. A StackBlitz WebContainer cannot load native libSQL or `node:sqlite`, so
 * there a local file opens with SQLite WASM, which keeps the database in memory and writes the file after each committed
 * write. It logs that once, and Database inspection shows it.
 */
export function createLocalSqliteClient(config: Config): Client {
  if (isWebContainer() && localSqliteFilePath(config.url)) {
    // SAFETY: The SQLite WASM client implements the libSQL `Client` methods that Drizzle and ViteHub call.
    return createWasmSqliteClient({ intMode: config.intMode, url: config.url }) as unknown as Client
  }
  return createClient(config)
}
