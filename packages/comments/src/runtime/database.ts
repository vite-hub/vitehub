import type { CommentsDatabase } from "../store.ts"

/** The runtime Database registry of `@vite-hub/database/drizzle`, as the generated Nitro plugin passes it. */
export type CommentsDatabaseRegistry = Record<string, { db: CommentsDatabase } | undefined>

/**
 * The Database that `defineComments({ database })` names, else `default`, else the only one. The plugin calls it when
 * the server starts. On Cloudflare that is before any request, so a D1 Database can't connect yet: its db throws until
 * a request brings the binding, and only the placeholder of an app without a default Database throws
 * `DATABASE_DISABLED`. The store reads the db per query, by which time the binding is there.
 */
export function selectCommentsDatabase(databases: CommentsDatabaseRegistry, name?: string): CommentsDatabase | undefined {
  if (name) return databases[name]?.db
  const fallback = databases.default?.db
  if (fallback && !isPlaceholder(fallback)) return fallback
  const names = Object.keys(databases).filter(key => key !== "default")
  return names.length === 1 ? databases[names[0]!]?.db : undefined
}

function isPlaceholder(db: CommentsDatabase): boolean {
  try {
    Reflect.get(db, "select")
    return false
  }
  catch (error) {
    return (error as { code?: unknown } | null)?.code === "DATABASE_DISABLED"
  }
}
