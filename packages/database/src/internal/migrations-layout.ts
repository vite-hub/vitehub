import { join } from "pathe"

import type * as fs from "node:fs"

/**
 * The layout of a migrations folder that Drizzle Kit 1.0 cannot read, which `vitehub database up` converts:
 * - `journal`: the `meta/_journal.json` of Drizzle Kit 0.x, beside flat `.sql` files.
 * - `flat`: only flat `.sql` files, such as the ones that `wrangler d1 migrations create` writes. Drizzle Kit 1.0 skips
 *   them, so a local database would start without tables.
 * A folder with migration folders and some flat files is not old: Wrangler applies both.
 */
export type OldMigrationsLayout = "journal" | "flat"

export function readOldMigrationsLayout(migrationsDir: string, { existsSync, readdirSync }: Pick<typeof fs, "existsSync" | "readdirSync">): OldMigrationsLayout | undefined {
  if (!existsSync(migrationsDir)) return
  if (existsSync(join(migrationsDir, "meta", "_journal.json"))) return "journal"
  const entries = readdirSync(migrationsDir, { withFileTypes: true })
  const flat = entries.some(entry => entry.isFile() && entry.name.endsWith(".sql"))
  const folders = entries.some(entry => entry.isDirectory() && existsSync(join(migrationsDir, entry.name, "migration.sql")))
  return flat && !folders ? "flat" : undefined
}
