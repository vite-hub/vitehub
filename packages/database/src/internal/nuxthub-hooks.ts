import { existsSync, readFileSync } from "node:fs"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createImportPath } from "@vite-hub/internal/build/paths"
import { dirname, isAbsolute, join, relative, resolve } from "pathe"

import type { DatabaseContributionContext, DatabaseContributionEntry } from "../contributions.ts"
import type { DatabaseDialect } from "../types.ts"

/** The plugin of the bridge. `vitehub inspect` names it as the contributor of the tables and migrations it adds. */
export const nuxthubDatabaseHooksPluginName = "@vite-hub/database/nuxthub-hooks"

/** Where the bridge writes the modules that collect the exports of each NuxtHub schema file, relative to the project root. */
export const nuxthubSchemaModulesDir = ".vitehub/database/nuxthub"

export interface NuxtHubDatabaseHooksOptions {
  /** `nuxt.callHook`. */
  callHook: (name: string, ...args: unknown[]) => unknown
  /** The project root. Relative paths from the hooks resolve from it, as NuxtHub resolves them from the working directory. */
  rootDir: string
  /** The dialect of the Database that receives the tables, which the hooks get as `dialect`. */
  resolveDialect: (context: DatabaseContributionContext) => Promise<DatabaseDialect>
  /** Receives a warning, for example about post-migration queries that ViteHub does not run. */
  warn?: (message: string) => void
}

const schemaDialect = /\.(postgresql|sqlite|mysql)(?:\.(?:ts|js|mjs))?$/

/**
 * Names a file by its package and its path in that package, such as `evlog/dist/runtime/db/schema/events.sqlite`, or
 * by its path in the project. The name stays the same when a package manager moves the package.
 */
function describePath(path: string, rootDir: string): string {
  for (let dir = path; dir !== dirname(dir) && dir !== rootDir; dir = dirname(dir)) {
    const manifest = join(dir, "package.json")
    if (!existsSync(manifest)) continue
    const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }
    if (typeof name === "string" && name) return `${name}/${relative(dir, path)}`
  }
  return relative(rootDir, path)
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

/**
 * The bridge from NuxtHub's database hooks to `vitehub.databases`. Nuxt modules written for NuxtHub add their database
 * parts with these hooks, and ViteHub calls them with NuxtHub's arguments:
 *
 * - `hub:db:schema:extend({ dialect, paths })`: each schema file becomes contributed tables for the default Database.
 * - `hub:db:migrations:dirs(dirs)`: each folder of `.sql` files becomes contributed `migrations`.
 * - `hub:db:queries:paths(queries, dialect)`: ViteHub does not run post-migration queries, so it warns about them.
 *
 * The plugin adds nothing when no hook adds anything.
 */
export function nuxthubDatabaseHooks(options: NuxtHubDatabaseHooksOptions) {
  // Nuxt removes its hooks when it closes, and the CLI inspects contributions after that. The first call, while Nuxt
  // runs, keeps what the hooks added.
  const calls = new Map<DatabaseDialect, Promise<{ dirs: string[], paths: string[] }>>()
  const callHooks = async (dialect: DatabaseDialect) => {
    const paths: string[] = []
    await options.callHook("hub:db:schema:extend", { dialect, paths })
    const dirs: string[] = []
    await options.callHook("hub:db:migrations:dirs", dirs)
    const queries: string[] = []
    await options.callHook("hub:db:queries:paths", queries, dialect)
    if (queries.length) {
      options.warn?.(`[vitehub] The NuxtHub hook \`hub:db:queries:paths\` added ${queries.join(", ")}. ViteHub does not run post-migration queries, so it skips them. Add their SQL as a migration with \`hub:db:migrations:dirs\` if it must run once.`)
    }
    return { dirs, paths }
  }
  return {
    name: nuxthubDatabaseHooksPluginName,
    vitehub: {
      databases: async (context: DatabaseContributionContext): Promise<DatabaseContributionEntry[]> => {
        const dialect = await options.resolveDialect(context)
        let call = calls.get(dialect)
        if (!call) calls.set(dialect, call = callHooks(dialect))
        const { dirs, paths } = await call
        const toAbsolute = (path: string) => isAbsolute(path) ? resolve(path) : resolve(options.rootDir, path)
        const entries: DatabaseContributionEntry[] = []
        // NuxtHub skips a schema file for another dialect, such as `events.postgresql.ts` on SQLite.
        const schemaFiles = [...new Set(paths.map(toAbsolute))].filter(file => (schemaDialect.exec(file)?.[1] ?? dialect) === dialect)
        for (const file of schemaFiles) {
          const name = `nuxthub:${describePath(file, options.rootDir)}`
          const module = join(options.rootDir, nuxthubSchemaModulesDir, `${slug(name)}.ts`)
          // NuxtHub exports every export of a schema file. ViteHub takes tables as one object, so collect them.
          await writeFileIfChanged(module, [
            "// Generated by @vite-hub/database for the NuxtHub hook `hub:db:schema:extend`.",
            `import * as schema from ${JSON.stringify(createImportPath(module, file))}`,
            "export default { ...schema }",
            "",
          ].join("\n"))
          entries.push({ definition: { export: "default", module }, dialect, name, reason: "Schema file from the NuxtHub hook `hub:db:schema:extend`." })
        }
        for (const dir of new Set(dirs.map(toAbsolute))) {
          entries.push({ dialect, migrations: dir, name: `nuxthub:${describePath(dir, options.rootDir)}`, reason: "Migrations folder from the NuxtHub hook `hub:db:migrations:dirs`." })
        }
        return entries
      },
    },
  }
}
