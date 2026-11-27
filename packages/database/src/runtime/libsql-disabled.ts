import type { LocalSqlite } from "./drizzle-adapter.ts"

/** `#vitehub/database/libsql` in a Cloudflare build whose Databases have no remote libSQL URL. They reach D1 only. */
export const localSqlite: LocalSqlite | undefined = undefined
