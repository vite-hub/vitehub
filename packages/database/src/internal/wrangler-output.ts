import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { collapseWranglerConfigFile } from "@vite-hub/internal/build/cloudflare"
import type { WranglerEntrySpec } from "@vite-hub/internal/build/cloudflare"
import { isPlainObject } from "@vite-hub/internal/object"

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
export async function collapseGeneratedWranglerD1Bindings(serverDir: string, warn: (message: string) => void = console.warn): Promise<void> {
  await collapseWranglerConfigFile(serverDir, {
    conflict: ({ field, generated, name, project, scope }) => databaseErrorDiagnostics.DATABASE_WRANGLER_BINDING_CONFLICT({ binding: name, field, generated: String(generated), project: String(project), scope }),
    specs: [d1EntrySpec],
  })
  for (const binding of await nuxtHubHistoryBindings(serverDir)) {
    warn(`[vitehub] The D1 binding "${binding}" uses NuxtHub's \`_hub_migrations\` table as its Wrangler migration history, from the project's Wrangler config. NuxtHub records other names than Wrangler, so Wrangler treats every ViteHub migration as new. Remove \`migrations_table\` from the project's Wrangler config before you apply the first ViteHub migration. Keep it only when ViteHub migrations were already applied with it. Read https://vitehub.dev/docs/getting-started/migrate-from-nuxthub#baseline-an-existing-cloudflare-d1-database`)
  }
}

/** D1 bindings, at the top level and in each `env`, whose Wrangler history table is NuxtHub's. */
async function nuxtHubHistoryBindings(serverDir: string): Promise<string[]> {
  const text = await readFile(resolve(serverDir, "wrangler.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return []
  const wrangler: unknown = JSON.parse(text)
  if (!isPlainObject(wrangler)) return []
  const scopes = [{ config: wrangler, suffix: "" }, ...(isPlainObject(wrangler.env) ? Object.entries(wrangler.env).map(([name, config]) => ({ config, suffix: ` in env.${name}` })) : [])]
  return scopes.flatMap(({ config, suffix }) => {
    const databases = isPlainObject(config) && Array.isArray(config.d1_databases) ? config.d1_databases : []
    return databases.flatMap(entry => isPlainObject(entry) && entry.migrations_table === "_hub_migrations" ? [`${String(entry.binding)}${suffix}`] : [])
  })
}
