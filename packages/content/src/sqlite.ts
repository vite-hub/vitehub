import type { RelationalDatabase } from "comark-content"
import sqliteNode from "comark-content/database/sqlite-node"

/**
 * An in-memory SQLite database for Comark index plugins, such as `sqlite-full-text-search`. Each server instance builds
 * its own index from the Content Sources when Content loads.
 *
 * Node runtimes use built-in Node SQLite. On Cloudflare Workers the package resolves to SQLite WASM instead, which ViteHub
 * loads while the Worker starts.
 */
export function sqlite(): RelationalDatabase {
  return sqliteNode()
}
