/**
 * A SQLite, libSQL, or D1 Drizzle database, such as `db` from `vite-hub/database`. The uses of a sealed value live
 * there, because every instance of the app must see the same count. KV cannot take a use atomically.
 */
export interface SealUsesDatabase {
  all: (query: string) => unknown[] | PromiseLike<unknown[]>
}

const table = "vitehub_env_seal_uses"
const ready = new WeakMap<SealUsesDatabase, Promise<void>>()

// The queries embed only a hex id and integers that this module checks, so no input reaches the SQL text.
function checkId(id: string): string {
  if (!/^[\da-f]{32}$/.test(id)) throw new TypeError("A seal id must be 32 lowercase hex characters.")
  return id
}

function initialize(db: SealUsesDatabase): Promise<void> {
  let promise = ready.get(db)
  if (!promise) {
    promise = (async () => {
      await db.all(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, uses INTEGER NOT NULL, expires_at INTEGER)`)
      await db.all(`CREATE INDEX IF NOT EXISTS ${table}_expires_at ON ${table} (expires_at)`)
    })()
    promise.catch(() => ready.delete(db))
    ready.set(db, promise)
  }
  return promise
}

/** Keeps `uses` for a new id. The row holds no part of the value. */
export async function createSealUses(db: SealUsesDatabase, id: string, uses: number, expiresAt: number | undefined): Promise<void> {
  if (!Number.isSafeInteger(uses) || uses < 1) throw new TypeError("`uses` must be a positive integer.")
  await initialize(db)
  const now = Date.now()
  await db.all(`DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= ${now}`)
  await db.all(`INSERT INTO ${table} (id, uses, expires_at) VALUES ('${checkId(id)}', ${uses}, ${expiresAt === undefined ? "NULL" : Math.ceil(expiresAt)})`)
}

/** Takes one use in one statement, so of two calls on the last use, one gets it. Returns false when no use is left. */
export async function takeSealUse(db: SealUsesDatabase, id: string): Promise<boolean> {
  await initialize(db)
  const key = checkId(id)
  const rows = await db.all(`UPDATE ${table} SET uses = uses - 1 WHERE id = '${key}' AND uses > 0 RETURNING uses`)
  if (!rows.length) return false
  await db.all(`DELETE FROM ${table} WHERE id = '${key}' AND uses <= 0`)
  return true
}

/** Deletes the uses of an id, such as one whose value expired. */
export async function deleteSealUses(db: SealUsesDatabase, id: string): Promise<void> {
  await initialize(db)
  await db.all(`DELETE FROM ${table} WHERE id = '${checkId(id)}'`)
}
