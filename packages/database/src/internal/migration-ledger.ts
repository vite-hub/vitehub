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

/**
 * The statements with which Drizzle 1.0 upgrades a Drizzle Kit 0.x ledger: they add `name` and `applied_at`, and
 * write the name of each matched row. Check `ledgerUpgradeProblem()` first.
 */
export function ledgerUpgradeStatements(table: string, { backfill }: LedgerMatch): Array<string | { args: Array<number | string>, sql: string }> {
  return [
    `ALTER TABLE "${table}" ADD COLUMN "name" text`,
    `ALTER TABLE "${table}" ADD COLUMN "applied_at" TEXT`,
    ...backfill.map(({ column, name, value }) => ({ args: [name, value], sql: `UPDATE "${table}" SET "name" = ?, "applied_at" = NULL WHERE "${column}" = ?` })),
  ]
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

/** Ledgers that other tools keep by migration name: NuxtHub's, and Wrangler's default. */
export const nameLedgerTables = ["_hub_migrations", "d1_migrations"] as const

/** A migration with the Wrangler file name that `listD1Migrations()` gives it. */
export interface NamedMigration {
  /** The Wrangler file name, such as `0000_init.sql`. */
  name: string
  /** The Drizzle Kit folder, or the flat file name without `.sql`. */
  tag: string
}

/**
 * The names that other tools record for one migration, most exact first: the Wrangler file name, NuxtHub's name (the
 * file name without `.sql`), the Drizzle Kit folder, and the old flat file that a folder keeps in its name, such as
 * `0003_auth_events.sql` for `20261027095640_0003_auth_events`.
 */
function recordedNames({ name, tag }: NamedMigration): string[] {
  const kept = /^\d{14}_(.+)$/.exec(tag)?.[1]
  return [name, name.replace(/\.sql$/, ""), tag, ...(kept ? [`${kept}.sql`, kept] : [])]
}

export interface RecordedNamesMatch {
  /** The tag of each migration that the ledger lists, and the name that the ledger lists it under. */
  applied: Map<string, string>
  /** Ledger names that match no migration. */
  unmatched: string[]
}

/** Matches the names of a ledger to migrations. Each name matches one migration, and a more exact name form wins. */
export function matchRecordedNames(names: Iterable<string>, migrations: readonly NamedMigration[]): RecordedNamesMatch {
  const left = new Set(names)
  const applied = new Map<string, string>()
  const forms = migrations.map(migration => ({ names: recordedNames(migration), tag: migration.tag }))
  for (let level = 0; level < 5; level++) {
    for (const { names, tag } of forms) {
      const name = names[level]
      if (name === undefined || applied.has(tag) || !left.has(name)) continue
      applied.set(tag, name)
      left.delete(name)
    }
  }
  return { applied, unmatched: [...left] }
}

/**
 * Finds a ledger name whose migration now has another number, for example when `d1-migrations.json` is missing and a
 * folder sorts before applied ones. A runner that matches exact names would apply it again.
 */
export function findRenumbered(unmatched: readonly string[], migrations: readonly NamedMigration[], applied: ReadonlySet<string>): { moved: NamedMigration, name: string } | undefined {
  for (const name of unmatched) {
    const suffix = /^\d+_(.+?)(?:\.sql)?$/.exec(name)?.[1]
    const moved = suffix && migrations.find(migration => !applied.has(migration.tag) && migration.name.endsWith(`_${suffix}.sql`))
    if (moved) return { moved, name }
  }
  return undefined
}

/**
 * Matches named Drizzle rows whose folder no longer exists to unapplied migrations with the same SQL hash, such as a
 * renamed folder. Returns the tag of each match and the folder name that the row lists. The caller renames the row, so
 * it cannot match a later migration with the same SQL.
 */
export function matchRenamedRows(rows: readonly LedgerRow[], migrations: readonly LedgerMigration[], applied: ReadonlySet<string>): Map<string, string> {
  const tags = new Set(migrations.map(migration => migration.tag))
  const ordered = [...migrations].sort((a, b) => a.when - b.when || a.tag.localeCompare(b.tag))
  const renamed = new Map<string, string>()
  for (const row of rows) {
    if (typeof row.name !== "string" || tags.has(row.name)) continue
    const match = ordered.find(migration => migration.hash === row.hash && !applied.has(migration.tag) && !renamed.has(migration.tag))
    if (match) renamed.set(match.tag, row.name)
  }
  return renamed
}
