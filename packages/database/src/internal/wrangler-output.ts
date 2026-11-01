import { collapseWranglerConfigFile } from "@vite-hub/internal/build/cloudflare"
import type { WranglerEntrySpec } from "@vite-hub/internal/build/cloudflare"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

/**
 * One entry per D1 binding name. ViteHub's entry comes first and wins, and the project entry only fills fields it
 * lacks, so Nitro's array concatenation of a project wrangler.json never leaves Wrangler with two bindings of one name.
 * A real id replaces an all-zero placeholder. Unresolved primary IDs are left out for provisioning; preview IDs stay
 * to prevent remote development from falling back to production. ViteHub stages its migrations
 * in its own directory, so a project `migrations_dir` or `migrations_pattern` is dropped when ViteHub sets one.
 */
const d1EntrySpec: WranglerEntrySpec = {
  path: ["d1_databases"],
  identity: "binding",
  resource: ["database_id", "database_name", "preview_database_id"],
  ids: ["database_id", "preview_database_id"],
  preservePlaceholderIds: ["preview_database_id"],
  groups: [["migrations_dir", "migrations_pattern"]],
}

/** The `compiled` hook step: collapses `d1_databases` in the wrangler.json in `serverDir`, at the top level and in each `env`. */
export function collapseGeneratedWranglerD1Bindings(serverDir: string): Promise<void> {
  return collapseWranglerConfigFile(serverDir, {
    conflict: ({ field, generated, name, project, scope }) => databaseErrorDiagnostics.DATABASE_WRANGLER_BINDING_CONFLICT({ binding: name, field, generated: String(generated), project: String(project), scope }),
    specs: [d1EntrySpec],
  })
}
