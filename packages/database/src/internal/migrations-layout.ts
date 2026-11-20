import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The layout of a migrations folder that Drizzle Kit 1.0 cannot read, which `vitehub database up` converts:
 * - `journal`: the `meta/_journal.json` of Drizzle Kit 0.x, beside flat `.sql` files.
 * - `flat`: only flat `.sql` files, such as the ones that `wrangler d1 migrations create` writes. Drizzle Kit 1.0 skips
 *   them, so a local database would start without tables.
 * A folder with migration folders and some flat files is not old: Wrangler applies both.
 */
export type OldMigrationsLayout = "journal" | "flat"

export function readOldMigrationsLayout(migrationsDir: string): OldMigrationsLayout | undefined {
  if (!existsSync(migrationsDir)) return
  if (existsSync(join(migrationsDir, "meta", "_journal.json"))) return "journal"
  const entries = readdirSync(migrationsDir, { withFileTypes: true })
  const flat = entries.some(entry => entry.isFile() && entry.name.endsWith(".sql"))
  const folders = entries.some(entry => entry.isDirectory() && existsSync(join(migrationsDir, entry.name, "migration.sql")))
  return flat && !folders ? "flat" : undefined
}

/**
 * Reports whether `drizzle-kit up` can convert a folder with a Drizzle Kit 0.x journal: the journal lists every flat
 * `.sql` file, and each entry has its snapshot. Otherwise Drizzle Kit stops with "No snapshot was found", or converts
 * the listed files and leaves the hand-written ones behind, which Drizzle Kit 1.0 then skips.
 */
export function canDrizzleKitConvert(migrationsDir: string): boolean {
  const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as { entries?: Array<{ tag?: unknown }> }
  const tags = (journal.entries ?? []).map(entry => String(entry.tag))
  const flat = readdirSync(migrationsDir).filter(name => name.endsWith(".sql"))
  return flat.every(name => tags.includes(name.slice(0, -".sql".length)))
    && tags.every(tag => flat.includes(`${tag}.sql`) && existsSync(join(migrationsDir, "meta", `${tag.split("_")[0]}_snapshot.json`)))
}
