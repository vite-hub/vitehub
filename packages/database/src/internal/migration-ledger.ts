/** A row of Drizzle's `__drizzle_migrations` ledger. Rows that Drizzle Kit 0.x wrote have no `name`. */
export interface LedgerRow {
  createdAt: number | undefined
  hash: string
  id: number | null
  /** Undefined means the column is absent; null is an unnamed row in an already upgraded ledger. */
  name: string | null | undefined
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
  backfill: Array<{ column: "id" | "created_at" | "hash", name: string, row: LedgerRow, value: number | string }>
  /** Ids of rows without `name` that match no local migration. Drizzle 1.0 refuses to upgrade such a ledger. */
  unmatched: Array<number | null>
}

/**
 * Matches ledger rows to local migrations as Drizzle 1.0 does. A row with `name` matches the migration folder of that
 * name. A row without `name` matches the migration of the same `created_at` second, then the migration of the same
 * hash, like Drizzle's upgrade of a ledger from Drizzle Kit 0.x.
 */
export function matchLedger(rows: readonly LedgerRow[], migrations: readonly LedgerMigration[]): LedgerMatch {
  const applied = new Set<string>()
  const backfill: LedgerMatch["backfill"] = []
  const unmatched: LedgerMatch["unmatched"] = []
  const ordered = [...migrations].sort((a, b) => a.when - b.when || a.tag.localeCompare(b.tag))
  // Drizzle's hash fallback uses the last migration in folder order, not the first one.
  const byHash = new Map(ordered.map(migration => [migration.hash, migration]))
  const tags = new Set(migrations.map(migration => migration.tag))
  for (const row of rows) {
    if (row.name !== undefined) {
      if (row.name !== null && tags.has(row.name)) applied.add(row.name)
      continue
    }
    const second = row.createdAt === undefined ? undefined : Math.floor(row.createdAt / 1000) * 1000
    const sameSecond = ordered.filter(migration => migration.when === second)
    const match = sameSecond.length === 1 ? sameSecond[0] : sameSecond.length > 1 ? sameSecond.find(migration => migration.hash === row.hash) : byHash.get(row.hash)
    if (!match) {
      unmatched.push(row.id)
      continue
    }
    applied.add(match.tag)
    // SQLite's old SERIAL PRIMARY KEY does not assign IDs. RC.5 falls back to the timestamp
    // for a unique-second match and to the hash otherwise, so NULL-ID rows remain distinct.
    const predicate = row.id
      ? { column: "id" as const, value: row.id }
      : sameSecond.length === 1
        ? { column: "created_at" as const, value: row.createdAt! }
        : { column: "hash" as const, value: row.hash }
    backfill.push({ ...predicate, name: match.tag, row })
  }
  return { applied, backfill, unmatched }
}

/** Reports updates that would invalidate per-row matches. D1 adoption does not run these updates. */
export function ledgerUpgradeProblem({ backfill }: LedgerMatch): string | undefined {
  for (const { column, name, value } of backfill) {
    // A hash update can overwrite a different row's timestamp match. Independent matches
    // then overstate the applied set and hide SQL that Kit will replay. Refuse before any write.
    if (backfill.some(({ row, name: other }) => (column === "created_at" ? row.createdAt : row[column]) === value && other !== name)) {
      return "The Drizzle Kit 0.x ledger has overlapping backfill predicates for different migration names. Verify and upgrade the ledger on a database copy before retrying; Drizzle Kit could replay applied migrations."
    }
  }
  return undefined
}

/** Reads one ledger row from an object row, such as a libSQL or postgres.js row. */
export function toLedgerRow(row: Record<string, unknown>): LedgerRow {
  const createdAt = row.created_at === null || row.created_at === undefined ? Number.NaN : Number(row.created_at)
  return {
    createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
    hash: String(row.hash ?? ""),
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    name: row.name === null ? null : typeof row.name === "string" ? row.name : undefined,
  }
}
