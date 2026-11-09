/** A row of Drizzle's `__drizzle_migrations` ledger. Rows that Drizzle Kit 0.x wrote have no `name`. */
export interface LedgerRow {
  createdAt: number | undefined
  hash: string
  id: number
  name: string | undefined
}

export interface LedgerMigration {
  hash: string
  tag: string
  when: number
}

export interface LedgerMatch {
  /** Folder names of the local migrations that the ledger lists. */
  applied: Set<string>
  /** Rows without `name` and the local migration that each one matches. Drizzle 1.0 writes these names when it upgrades the ledger. */
  backfill: Array<{ id: number, name: string }>
  /** Ids of rows without `name` that match no local migration. Drizzle 1.0 refuses to upgrade such a ledger. */
  unmatched: number[]
}

/**
 * Matches ledger rows to local migrations as Drizzle 1.0 does. A row with `name` matches the migration folder of that
 * name. A row without `name` matches the migration of the same `created_at` second, then the migration of the same
 * hash, like Drizzle's upgrade of a ledger from Drizzle Kit 0.x.
 */
export function matchLedger(rows: readonly LedgerRow[], migrations: readonly LedgerMigration[]): LedgerMatch {
  const applied = new Set<string>()
  const backfill: LedgerMatch["backfill"] = []
  const unmatched: number[] = []
  const tags = new Set(migrations.map(migration => migration.tag))
  for (const row of rows) {
    if (row.name !== undefined) {
      if (tags.has(row.name)) applied.add(row.name)
      continue
    }
    const second = row.createdAt === undefined ? undefined : Math.floor(row.createdAt / 1000) * 1000
    const sameSecond = migrations.filter(migration => migration.when === second)
    const match = sameSecond.length === 1 ? sameSecond[0] : sameSecond.length > 1 ? sameSecond.find(migration => migration.hash === row.hash) : migrations.find(migration => migration.hash === row.hash)
    if (!match) {
      unmatched.push(row.id)
      continue
    }
    applied.add(match.tag)
    backfill.push({ id: row.id, name: match.tag })
  }
  return { applied, backfill, unmatched }
}

/** Reads one ledger row from an object row, such as a libSQL or postgres.js row. */
export function toLedgerRow(row: Record<string, unknown>): LedgerRow {
  const createdAt = row.created_at === null || row.created_at === undefined ? Number.NaN : Number(row.created_at)
  return {
    createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
    hash: String(row.hash ?? ""),
    id: Number(row.id),
    name: typeof row.name === "string" ? row.name : undefined,
  }
}
