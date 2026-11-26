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

/** NuxtHub's ledger. It lists each applied migration by its file name without `.sql`, such as `0000_init`. */
export const hubMigrationsTable = nameLedgerTables[0]

const folderTag = /^\d{14}_(.+)$/

function migrationNumber(name: string): number {
  const number = Number.parseInt(name.split("_")[0]!, 10)
  return Number.isFinite(number) ? number : -1
}

/**
 * Gives each migration folder its Wrangler file name. A folder that `recorded` lists keeps that name. Another folder
 * gets the next number, `NNNN_<name>.sql`, after the recorded names and the `flat` file names. Without `recorded`, the
 * numbers follow the folder order from 0000, as Drizzle Kit 0.x numbered the same migrations.
 */
export function numberMigrationFolders(folders: readonly string[], recorded: Readonly<Record<string, string>> = {}, flat: readonly string[] = []): NamedMigration[] {
  let next = Math.max(-1, ...Object.values(recorded).map(migrationNumber), ...flat.map(migrationNumber)) + 1
  if (!Object.keys(recorded).length) next = 0
  return [...folders].sort((a, b) => a.localeCompare(b)).map(tag => ({
    name: recorded[tag] ?? `${String(next++).padStart(4, "0")}_${folderTag.exec(tag)?.[1] ?? tag}.sql`,
    tag,
  }))
}

/** A migration with the Wrangler file name that `listD1Migrations()` gives it. */
export interface NamedMigration {
  /** The Wrangler file name, such as `0000_init.sql`. */
  name: string
  /** The Drizzle Kit folder, or the flat file name without `.sql`. */
  tag: string
}

function nuxtHubMigrationName(file: string, dialect: "postgresql" | "sqlite"): string {
  return file.replace(/\.sql$/, "").replace(dialect === "postgresql" ? /\.postgresql$/ : /\.sqlite$/, "")
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

export interface HubMigrationsMatch {
  /** Tags of the migrations that only `_hub_migrations` lists. */
  adopted: string[]
  /** Names in `_hub_migrations` that match no migration. They do not block, because the files can be gone. */
  unmatched: string[]
}

/**
 * Matches the names of NuxtHub's `_hub_migrations` to the migrations that the other ledgers do not list. A name matches
 * the folder of that name, then the folder that keeps the NuxtHub file name, then the Wrangler name of the same number.
 * `files` has the Wrangler names of each migrations folder. Returns the problem when a name matches more than one
 * migration, or when a listed migration now has another number, because ViteHub would apply it again.
 */
export function matchHubMigrations(names: readonly string[], files: readonly (NamedMigration & { database: string })[], applied: ReadonlySet<string>, dialect: "postgresql" | "sqlite"): HubMigrationsMatch | { problem: string } {
  const adopted = new Set<string>()
  const unmatched: string[] = []
  for (const name of names) {
    const stem = name.replace(/\.sql$/, "")
    const exact = files.filter(({ tag }) => tag === stem)
    const preserved = exact.length ? exact : files.filter(({ tag }) => {
      const kept = folderTag.exec(tag)?.[1]
      return kept !== undefined && nuxtHubMigrationName(kept, dialect) === stem
    })
    const candidates = preserved.length ? preserved : files.filter(file => file.name === `${stem}.sql`)
    if (candidates.length > 1) {
      const folders = candidates.map(({ database, tag }) => `${database}/${tag}`).sort().join(", ")
      return { problem: `The migrations table ${hubMigrationsTable} lists ${name}, which matches more than one migration: ${folders}. Verify which SQL ran and give the row its exact migration folder name before retrying.` }
    }
    const match = candidates[0]
    if (!match) unmatched.push(name)
    else if (!applied.has(match.tag)) adopted.add(match.tag)
  }
  const renumbered = findRenumbered(unmatched, files, new Set([...applied, ...adopted]))
  if (renumbered) {
    const { moved, name } = renumbered
    if (dialect === "sqlite") return { problem: `The migrations table ${hubMigrationsTable} lists ${name}, but that migration is now ${moved.name} (${moved.tag}), so ViteHub would apply it again. Restore d1-migrations.json next to the migrations, or set "${moved.tag}": "${name.replace(/\.sql$/, "")}.sql" in it.` }
    const current = moved.name.replace(/\.sql$/, "")
    return { problem: `The migrations table ${hubMigrationsTable} lists ${name}, but that migration is now ${current} (${moved.tag}), so ViteHub would apply it again. If ${moved.tag} is the migration that NuxtHub applied, select the affected database and run \`UPDATE ${hubMigrationsTable} SET name = '${moved.tag.replaceAll("'", "''")}' WHERE name = '${name.replaceAll("'", "''")}'\` using a SQL client with the same search_path.` }
  }
  return { adopted: [...adopted], unmatched }
}
