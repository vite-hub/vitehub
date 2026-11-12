import { existsSync, readFileSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire, findPackageJSON } from "node:module"
import { pathToFileURL } from "node:url"

import type { DatabaseOptions } from "./types.ts"
import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "./types.ts"
import type { ViteHubCliContributor as SharedViteHubCliContributor } from "@vite-hub/internal/cli"
import type { MigrationPlan } from "./internal/migration-plan.ts"

import { dirname, isAbsolute, join, relative, resolve } from "pathe"

import { formatRuntimeDiagnosticError } from "@vite-hub/runtime"

import { resolveConfigValue } from "./config-value.ts"
import { databaseErrorDiagnostics } from "./error-diagnostics.ts"
import { resolveLocalSqlitePath } from "./runtime/local-path.ts"

/** Refreshes generated artifacts. `strict` fails when a Database Definition cannot load to list its tables. */
type ResolvedDBViteConfigProvider = (options: { strict: boolean }) => MaybePromise<ResolvedDBViteConfig | undefined>
type MaybePromise<T> = Promise<T> | T

interface ViteHubCliContext {
  cwd?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  rootDir: string
  spawn: (command: string, args: string[], options?: { cwd?: string, env?: NodeJS.ProcessEnv, stderr?: "inherit" | "pipe", stdout?: "inherit" | "pipe" }) => Promise<{ exitCode: number | null }>
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface ViteHubCliContributor {
  namespaces: Array<{
    description?: string
    features: Array<{
      description?: string
      name: string
      run: (args: string[], context: ViteHubCliContext) => Promise<number | void> | number | void
      usage?: string
    }>
    name: string
  }>
}

function writeGenerateUsage(context: ViteHubCliContext): void {
  context.stdout.write([
    `Usage: ${generateUsage}`,
    "",
    "Refreshes ViteHub database artifacts and generates Drizzle migrations.",
    "",
    "Options:",
    "  --name <name>      Custom migration name.",
    "  --custom           Generate an empty custom migration. Its snapshot is a copy",
    "                     of the previous one, for SQL that changes only data.",
    "  --schema-snapshot  With --custom, write the snapshot of the current Database",
    "                     Definitions instead, for SQL that changes the tables to them.",
    "  -h, --help         Show this help.",
    "",
  ].join("\n"))
}

function writeMigrateUsage(context: ViteHubCliContext): void {
  context.stdout.write([
    "Usage: vitehub database migrate [--dry-run] [--allow-data-loss]",
    "",
    "Refreshes ViteHub database artifacts and applies pending Drizzle migrations.",
    "It first reads the applied migrations from the database. It refuses pending",
    "migrations that drop tables or columns or delete rows. D1 HTTP databases use",
    "Wrangler's migrations table, like `wrangler d1 migrations apply`. Postgres",
    "migrations hold the advisory lock that a server holds when it migrates on start.",
    "",
    "Options:",
    "  --dry-run          Print the pending migrations and their SQL. Change nothing.",
    "  --allow-data-loss  Apply migrations that lose data. Skips the check.",
    "  -h, --help         Show this help.",
    "",
  ].join("\n"))
}

function writeExportUsage(context: ViteHubCliContext): void {
  context.stdout.write([
    `Usage: ${exportUsage}`,
    "",
    "Writes a SQL dump of each database, or of the one that `--database` names.",
    "Without `--remote`, it reads the local SQLite file that `vitehub database migrate` uses.",
    "SQLite, libSQL, and D1 dumps use the format of `wrangler d1 export`.",
    "",
    "Options:",
    "  --remote           Read the remote database: Cloudflare D1 with CLOUDFLARE_ACCOUNT_ID",
    "                     and CLOUDFLARE_API_TOKEN, D1 HTTP, remote libSQL, or Postgres with pg_dump.",
    "  --stage <name>     Load Vite env files for this mode. Variables from the current",
    "                     process take precedence.",
    "  --database <name>  Export only this database.",
    "  --output <file>    SQL file to write. Defaults to",
    "                     .vitehub/exports/database/<name>-<local|remote>-<time>.sql.",
    "  -h, --help         Show this help.",
    "",
  ].join("\n"))
}

function writeUpUsage(context: ViteHubCliContext): void {
  context.stdout.write([
    `Usage: ${upUsage}`,
    "",
    "Converts migrations folders of Drizzle Kit 0.x, with `meta/_journal.json`, to the",
    "layout of Drizzle Kit 1.0: one `<timestamp>_<name>/migration.sql` folder per",
    "migration. It runs `drizzle-kit up` on the migrations folder of each Database",
    "Definition. Folders that already use the 1.0 layout stay as they are. Applied",
    "migrations stay applied: `vitehub database migrate` and Wrangler keep their ledger rows.",
    "",
    "Options:",
    "  -h, --help         Show this help.",
    "",
  ].join("\n"))
}

const upUsage = "vitehub database up"

const generateUsage = "vitehub database generate [--name <name>] [--custom [--schema-snapshot]]"

const exportUsage = "vitehub database export [--remote] [--stage <name>] [--database <name>] [--output <file>]"

interface ExportArgs {
  database?: string
  output?: string
  remote: boolean
  stage?: string
}

function parseExportArgs(args: string[]): ExportArgs | string {
  const parsed: ExportArgs = { remote: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--remote") {
      parsed.remote = true
      continue
    }
    const option = (["--database", "--output", "--stage"] as const).find(name => arg === name || arg.startsWith(`${name}=`))
    if (!option) return `Unknown option: ${arg}`
    const value = arg === option ? args[++index] : arg.slice(option.length + 1)
    if (!value || value.startsWith("-")) return `${option} requires a value.`
    parsed[option.slice(2) as "database" | "output" | "stage"] = value
  }
  return parsed
}

async function runExport(args: string[], context: ViteHubCliContext, getConfig?: ResolvedDBViteConfigProvider): Promise<number> {
  const parsed = parseExportArgs(args)
  if (typeof parsed === "string") {
    context.stderr.write(`[vitehub] ${parsed}\n`)
    writeExportUsage(context)
    return 1
  }
  const config = await getConfig?.({ strict: false })
  if (!config?.databaseNames.length) {
    context.stderr.write("[vitehub] ViteHub has no resolved Database config. Run the command in a project that uses `hubDb()`.\n")
    return 1
  }
  const names = parsed.database ? [parsed.database] : config.databaseNames
  if (parsed.database && !config.databases[parsed.database]) {
    context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_NOT_FOUND({ database: parsed.database }))}\n`)
    return 1
  }
  if (parsed.output && names.length > 1) {
    context.stderr.write(`[vitehub] --output writes one database. Add --database <name> to pick one of: ${names.join(", ")}.\n`)
    return 1
  }
  const projectRoot = config.rootDir
  const cwd = context.cwd ?? process.cwd()
  let env = context.env ?? process.env
  if (parsed.stage) {
    const { loadEnv } = await import("vite")
    env = { ...loadEnv(parsed.stage, projectRoot, ""), ...env }
  }
  const { describeExportTarget, exportDatabase } = await import("./internal/export.ts")
  const time = new Date().toISOString().replaceAll(":", "").replaceAll(".", "")
  for (const name of names) {
    const output = parsed.output
      ? resolve(cwd, parsed.output)
      : resolve(projectRoot, ".vitehub/exports/database", `${name}-${parsed.remote ? "remote" : "local"}-${time}.sql`)
    try {
      const target = await exportDatabase(config.databases[name]!, { env, fetch: context.fetch, output, projectRoot, remote: parsed.remote, spawn: context.spawn })
      context.stdout.write(`[vitehub] Database "${name}" (${describeExportTarget(target, projectRoot)}): exported to ${relative(cwd, output) || output}.\n`)
    }
    catch (error) {
      const problem = error instanceof Error ? error.message : String(error)
      context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_EXPORT_FAILED({ cause: error, database: name, problem }))}\n`)
      return 1
    }
  }
  return 0
}

const viteHubFlags = new Set(["--allow-data-loss", "--dry-run", "--schema-snapshot"])

function forwardDrizzleArgs(args: string[]) {
  return args.filter(arg => arg !== "-h" && arg !== "--help" && !viteHubFlags.has(arg))
}

function toConfigPath(rootDir: string, file: string): string {
  return isAbsolute(file) ? relative(rootDir, file) || file : file
}

interface DrizzleKitInstall {
  bin: string
  version?: string
}

/** Finds the drizzle-kit bin file in the dependencies of the project, so the command does not depend on PATH. */
function resolveDrizzleKitBin(projectRoots: string[]): string | undefined {
  return resolveDrizzleKit(projectRoots)?.bin
}

function resolveDrizzleKit(projectRoots: string[]): DrizzleKitInstall | undefined {
  for (const projectRoot of projectRoots) {
    const drizzleKit = resolveDrizzleKitFromRoot(projectRoot)
    if (drizzleKit) return drizzleKit
  }
  // pnpm keeps Kit beside the facade's real directory, outside the application's symlink.
  for (const projectRoot of projectRoots) {
    let facadeManifest: string | undefined
    try {
      facadeManifest = resolvePackageManifest("vite-hub", projectRoot)
      if (facadeManifest) facadeManifest = realpathSync(facadeManifest)
    }
    catch {
      continue
    }
    const drizzleKit = facadeManifest && resolveDrizzleKitFromRoot(dirname(facadeManifest))
    if (drizzleKit) return drizzleKit
  }
  return undefined
}

function resolvePackageManifest(name: string, projectRoot: string): string | undefined {
  const base = pathToFileURL(resolve(projectRoot, "package.json"))
  try {
    return createRequire(base).resolve(`${name}/package.json`)
  }
  catch {
    return findPackageJSON(name, base)
  }
}

function resolveDrizzleKitFromRoot(projectRoot: string): DrizzleKitInstall | undefined {
  let packageJsonFile: string | undefined
  try {
    packageJsonFile = resolvePackageManifest("drizzle-kit", projectRoot)
  }
  catch {
    return
  }
  if (!packageJsonFile) return
  const { bin, version } = JSON.parse(readFileSync(packageJsonFile, "utf8")) as { bin?: string | Record<string, string>, version?: string }
  const file = typeof bin === "string" ? bin : bin?.["drizzle-kit"]
  return file ? { bin: resolve(dirname(packageJsonFile), file), ...(version ? { version } : {}) } : undefined
}

async function runDrizzleKit(
  feature: "generate" | "migrate",
  args: string[],
  context: ViteHubCliContext,
  getConfig?: ResolvedDBViteConfigProvider,
): Promise<number> {
  const schemaSnapshot = feature === "generate" && args.includes("--schema-snapshot")
  if (schemaSnapshot && !args.includes("--custom")) {
    context.stderr.write("[vitehub] --schema-snapshot works only with --custom. A migration without --custom already writes the snapshot of the current Database Definitions.\n")
    return 1
  }
  const config = await getConfig?.({ strict: feature === "generate" })
  // Drizzle Kit 1.0 cannot generate or migrate next to a 0.x journal, so stop before it changes anything.
  if (config && !writeOldLayoutDiagnostics(config, context)) return 1
  // Drizzle Kit resolves `out` and the SQLite URL from its working directory, and the Database writes them relative to its
  // project root. In Nuxt the Vite root is `srcDir` (`app/`), so `context.rootDir` is not the project root.
  const projectRoot = config?.rootDir ?? context.rootDir
  const runs = config && config.databaseNames.length > 1
    ? config.databaseNames.map(name => ({ configFile: config.generatedDrizzleConfigFilesByDatabase[name]!, database: config.databases?.[name] }))
    : [{ configFile: config?.generatedDrizzleConfigFile ?? ".vitehub/database/drizzle.config.ts", database: config?.databases?.[config.databaseNames[0]!] }]

  if (feature === "migrate") {
    for (const run of runs) {
      if (!run.database || run.database.dialect !== "sqlite" || run.database.cloudflare?.http) continue
      // Use the same invocation-time env values and local fallback as the generated Kit config.
      const { database } = run
      const defaultUrl = database.name === "default" ? "file:.vitehub/data/database/sqlite.db" : `file:.vitehub/data/database/${database.name}.sqlite.db`
      run.database = { ...database, connection: {
        authToken: resolveConfigValue(database.connection?.authToken, context.env ?? process.env) || undefined,
        url: resolveConfigValue(database.connection?.url, context.env ?? process.env) || defaultUrl,
      } }
    }
  }
  const dryRun = feature === "migrate" && args.includes("--dry-run")
  const allowDataLoss = args.includes("--allow-data-loss")
  if (feature === "migrate" && allowDataLoss && !dryRun) {
    // Bypassing the data-loss check still requires complete migration files, as Kit 0.x did.
    const { readMigrations } = await import("./internal/migration-journal.ts")
    for (const { database } of runs) {
      if (!database) continue
      try {
        readMigrations(resolve(projectRoot, database.migrationsDir))
      }
      catch (error) {
        const problem = error instanceof Error ? error.message : String(error)
        context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: database.name, problem }))}\n`)
        return 1
      }
    }
  }
  // Databases that already have every migration of their journal. Drizzle Kit would start only to apply nothing.
  const upToDate = new Map<ResolvedDrizzleDatabaseConfig, MigrationPlan>()
  if (feature === "migrate" && (dryRun || !allowDataLoss)) {
    // Check every Database before the first one changes, so a refusal leaves all of them as they were.
    let exitCode = 0
    for (const { database } of runs) {
      const check = await checkPendingMigrations(database, projectRoot, context, { allowDataLoss, dryRun })
      exitCode = Math.max(exitCode, check.exitCode)
      if (database && check.plan && !check.plan.pending.length && check.plan.applied) upToDate.set(database, check.plan)
    }
    if (dryRun) context.stdout.write("[vitehub] Dry run. No changes were made.\n")
    if (exitCode !== 0 || dryRun) return exitCode
  }
  // D1 HTTP uses Wrangler's ledger, which Drizzle Kit cannot write, so ViteHub applies those migrations itself.
  const usesD1Http = (database: ResolvedDrizzleDatabaseConfig | undefined): database is ResolvedDrizzleDatabaseConfig =>
    feature === "migrate" && database?.dialect === "sqlite" && !!database.cloudflare?.http && database.cloudflare.databaseId !== undefined
  // Postgres uses ViteHub's migrator, the one that a server runs on start, so both hold the same advisory lock.
  const usesPostgres = (database: ResolvedDrizzleDatabaseConfig | undefined): database is ResolvedDrizzleDatabaseConfig =>
    feature === "migrate" && database?.dialect === "postgresql"
  // A project with only D1 HTTP and Postgres databases can migrate without Drizzle Kit. Prefer the Database root because the
  // generated config and working directory belong to it. Fall back to the invoking Vite root for external Database roots.
  const drizzleKitBin = runs.every(run => usesD1Http(run.database) || usesPostgres(run.database)) ? "" : resolveDrizzleKitBin([projectRoot, context.rootDir])
  if (drizzleKitBin === undefined) {
    context.stderr.write(`[vitehub] Cannot find drizzle-kit in the dependencies of ${projectRoot}. Install it, for example with \`pnpm add -D drizzle-kit\`.\n`)
    return 1
  }
  let postgresMigrated = false
  for (const run of runs) {
    const { configFile, database } = run
    if (usesD1Http(database)) {
      const result = await migrateD1Database(database, projectRoot, context)
      if (result !== 0) return result
      continue
    }
    if (usesPostgres(database)) {
      // The first Postgres run migrates them all, so Definitions on one Postgres database migrate together.
      if (postgresMigrated) continue
      postgresMigrated = true
      const result = await migratePostgresDatabases(runs.map(run => run.database).filter(usesPostgres), projectRoot, context, allowDataLoss)
      if (result !== 0) return result
      continue
    }
    const plan = database && upToDate.get(database)
    if (plan) {
      writeMigrationPlan(plan, context)
      continue
    }
    if (feature === "migrate" && database) await ensureLocalSqliteDirectory(database, projectRoot, context)
    const migrationsDir = run.database?.migrationsDir ? resolve(projectRoot, run.database.migrationsDir) : undefined
    const foldersBefore = schemaSnapshot && migrationsDir ? await listMigrationFolders(migrationsDir) : []
    const result = await runDrizzleKitWithConfig(feature, args, context, { bin: drizzleKitBin, configFile: toConfigPath(projectRoot, configFile), projectRoot })
    if (result !== 0) return result
    if (feature === "generate" && migrationsDir && run.database?.dialect === "sqlite" && run.database.cloudflare) {
      // Keep the Wrangler name of each D1 migration in a committed file, so a later folder cannot renumber it.
      const { recordD1MigrationNames } = await import("./internal/d1-migrations.ts")
      recordD1MigrationNames(migrationsDir)
    }
    if (schemaSnapshot) {
      // `usesD1Http()` is false for every generate, but its type guard narrows `database` to undefined after it.
      if (!migrationsDir) {
        context.stderr.write("[vitehub] --schema-snapshot needs a resolved Database config. Run the command in a project that uses `hubDb()`.\n")
        return 1
      }
      // The folder that this generate wrote. Kit can name two SQLite folders with the same second, so the newest name is not reliable.
      const folder = (await listMigrationFolders(migrationsDir)).find(name => !foldersBefore.includes(name))
      const snapshot = await writeSchemaSnapshot(context, { bin: drizzleKitBin, configFile: resolve(projectRoot, configFile), folder, migrationsDir, projectRoot })
      if (snapshot !== 0) return snapshot
    }
  }
  return 0
}

/** The Databases whose migrations folder has the layout of Drizzle Kit 0.x, one entry per folder. */
function listOldLayoutFolders(config: ResolvedDBViteConfig) {
  const folders = new Map<string, ResolvedDrizzleDatabaseConfig>()
  for (const name of config.databaseNames) {
    const database = config.databases?.[name]
    if (!database) continue
    const dir = resolve(config.rootDir, database.migrationsDir)
    if (!folders.has(dir) && existsSync(join(dir, "meta", "_journal.json"))) folders.set(dir, database)
  }
  return [...folders].map(([dir, database]) => ({ database, dir }))
}

/** Writes `DATABASE_MIGRATIONS_OLD_LAYOUT` for each 0.x migrations folder. Returns false when there is one. */
function writeOldLayoutDiagnostics(config: ResolvedDBViteConfig, context: ViteHubCliContext): boolean {
  const folders = listOldLayoutFolders(config)
  for (const { database, dir } of folders) {
    const diagnostic = databaseErrorDiagnostics.DATABASE_MIGRATIONS_OLD_LAYOUT({ database: database.name, dir: relative(config.rootDir, dir) || dir })
    context.stderr.write(`${formatRuntimeDiagnosticError(diagnostic)}\n`)
  }
  return !folders.length
}

/** Converts the 0.x migrations folder of each Database with `drizzle-kit up`. Returns the exit code. */
async function runUp(args: string[], context: ViteHubCliContext, getConfig?: ResolvedDBViteConfigProvider): Promise<number> {
  if (args.length) {
    context.stderr.write(`[vitehub] Unknown option: ${args[0]}\n`)
    writeUpUsage(context)
    return 1
  }
  const config = await getConfig?.({ strict: false })
  if (!config?.databaseNames.length) {
    context.stderr.write("[vitehub] ViteHub has no resolved Database config. Run the command in a project that uses `hubDb()`.\n")
    return 1
  }
  const projectRoot = config.rootDir
  const folders = listOldLayoutFolders(config)
  if (!folders.length) {
    context.stdout.write("[vitehub] Every migrations folder already uses the layout of Drizzle Kit 1.0.\n")
    return 0
  }
  const drizzleKit = resolveDrizzleKit([projectRoot, context.rootDir])
  if (!drizzleKit) {
    context.stderr.write(`[vitehub] Cannot find drizzle-kit in the dependencies of ${projectRoot}. Install it, for example with \`pnpm add -D drizzle-kit\`.\n`)
    return 1
  }
  // Drizzle Kit 0.x has an `up` command too, but it upgrades 0.x snapshots and keeps the journal.
  const major = Number.parseInt(drizzleKit.version ?? "", 10)
  if (!(major >= 1)) {
    context.stderr.write(`[vitehub] \`vitehub database up\` needs drizzle-kit 1.0, and ${projectRoot} has drizzle-kit ${drizzleKit.version ?? "of an unknown version"}. Install the version that ViteHub uses, for example with \`pnpm add -D drizzle-kit@1.0.0-rc.5\`, and run it again.\n`)
    return 1
  }
  const { bin } = drizzleKit
  for (const { database, dir } of folders) {
    const folder = relative(projectRoot, dir) || dir
    // D1 and libSQL folders are SQLite folders. Kit converts the snapshots by dialect, not by driver.
    const dialect = database.dialect === "postgresql" ? "postgresql" : "sqlite"
    const result = await context.spawn(process.execPath, [bin, "up", "--dialect", dialect, "--out", dir], {
      cwd: projectRoot,
      env: context.env ?? process.env,
      stderr: "inherit",
      stdout: "inherit",
    })
    if (result.exitCode !== 0 || existsSync(join(dir, "meta", "_journal.json"))) {
      context.stderr.write(`[vitehub] drizzle-kit up could not convert ${folder} for the database "${database.name}" (exit code ${result.exitCode ?? 1}). See the drizzle-kit output above.\n`)
      return result.exitCode || 1
    }
    context.stdout.write(`[vitehub] Database "${database.name}": converted ${folder} to the layout of Drizzle Kit 1.0. Commit the new folders.\n`)
  }
  return 0
}

/** The migration folders of a Drizzle Kit 1.0 migrations directory. */
async function listMigrationFolders(migrationsDir: string): Promise<string[]> {
  return (await readdir(migrationsDir, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

/**
 * Drizzle Kit copies the previous snapshot into a custom migration, because it expects SQL that changes only data.
 * For SQL that changes the tables, such as the Comments upgrade, this replaces that copy with the snapshot of the
 * current Database Definitions. Drizzle Kit writes the full snapshot only for a first migration, so it runs once more
 * into an empty directory. The new snapshot keeps its `id` and `prevIds`, so the migration history stays one chain.
 */
async function writeSchemaSnapshot(
  context: ViteHubCliContext,
  { bin, configFile, folder, migrationsDir, projectRoot }: { bin: string, configFile: string, folder: string | undefined, migrationsDir: string, projectRoot: string },
): Promise<number> {
  // Drizzle Kit writes each snapshot beside its migration, in `folder` for the custom migration.
  const target = join(migrationsDir, folder ?? "", "snapshot.json")
  await mkdir(resolve(projectRoot, ".vitehub/database"), { recursive: true })
  const dir = await mkdtemp(resolve(projectRoot, ".vitehub/database/schema-snapshot-"))
  try {
    const config = join(dir, "drizzle.config.ts")
    await writeFile(config, `import config from ${JSON.stringify(configFile)}\n\nexport default { ...config, out: ${JSON.stringify(join(dir, "out"))} }\n`)
    const result = await context.spawn(process.execPath, [bin, "generate", "--config", config], {
      cwd: projectRoot,
      env: withDrizzleKitErrorExit(context.env ?? process.env),
      stderr: "inherit",
      stdout: "pipe",
    })
    const generated = (await listMigrationFolders(join(dir, "out")))[0]
    if (result.exitCode !== 0 || !folder || !generated) {
      context.stderr.write(`[vitehub] drizzle-kit could not write the snapshot of the current Database Definitions for ${relative(projectRoot, target)}. See the drizzle-kit output above.\n`)
      return result.exitCode || 1
    }
    const copied = JSON.parse(await readFile(target, "utf8")) as { id: string, prevIds: string[] }
    const current = JSON.parse(await readFile(join(dir, "out", generated, "snapshot.json"), "utf8")) as Record<string, unknown>
    await writeFile(target, JSON.stringify({ ...current, id: copied.id, prevIds: copied.prevIds }, null, 2))
    return 0
  }
  finally {
    await rm(dir, { force: true, recursive: true })
  }
}

function writeMigrationPlan(plan: MigrationPlan, context: ViteHubCliContext) {
  const count = plan.pending.length
  const lines = [`[vitehub] Database "${plan.database}" (${plan.target}): ${count ? `${count} pending ${count === 1 ? "migration" : "migrations"}.` : "no pending migrations."}`]
  for (const migration of plan.pending) {
    lines.push("", `  ${migration.name}`)
    for (const statement of migration.statements) lines.push(...statement.split("\n").map(line => `    ${line}`))
    for (const loss of migration.dataLoss) lines.push(`    ! Data loss: ${loss.reason}.`)
  }
  context.stdout.write(`${lines.join("\n")}\n`)
}

/** Reads the pending migrations before `migrate` and refuses the ones that lose data. Returns the exit code. */
async function checkPendingMigrations(
  database: ResolvedDrizzleDatabaseConfig | undefined,
  projectRoot: string,
  context: ViteHubCliContext,
  { allowDataLoss, dryRun }: { allowDataLoss: boolean, dryRun: boolean },
): Promise<{ exitCode: number, plan?: MigrationPlan }> {
  // Keep the database driver and migration inspector out of config-time imports.
  // The CLI contributor is loaded while Vite resolves the project config.
  const { readMigrationPlan } = await import("./internal/migration-plan.ts")
  const [error, plan] = database
    ? await readMigrationPlan({ ...database, migrationsDir: resolve(projectRoot, database.migrationsDir) }, { env: context.env ?? process.env, projectRoot })
    : [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: "default", problem: "ViteHub has no resolved Database config. Run the command in a project that uses `hubDb()`." }), undefined]
  if (error) {
    context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
    if (!dryRun) context.stderr.write("[vitehub] To apply the migrations without the check, run `vitehub database migrate --allow-data-loss`.\n")
    return { exitCode: 1 }
  }
  if (dryRun) writeMigrationPlan(plan, context)
  const losses = plan.pending.flatMap(migration => migration.dataLoss.map(loss => `${migration.name}: ${loss.reason}: ${loss.statement}`))
  if (losses.length && !allowDataLoss) {
    context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_MIGRATION_DATA_LOSS({ database: plan.database, statements: losses }))}\n`)
    return { exitCode: 1, plan }
  }
  return { exitCode: 0, plan }
}

async function migrateD1Database(database: ResolvedDrizzleDatabaseConfig, projectRoot: string, context: ViteHubCliContext): Promise<number> {
  const { migrateD1Http } = await import("./internal/migration-plan.ts")
  const problem = await migrateD1Http(
    { ...database, migrationsDir: resolve(projectRoot, database.migrationsDir) },
    { env: context.env ?? process.env, projectRoot },
    name => context.stdout.write(`[vitehub] Database "${database.name}": applied ${name}.\n`),
  )
  if (problem) {
    context.stderr.write(`[vitehub] D1 migration failed for the database "${database.name}". ${problem}\n`)
    return 1
  }
  context.stdout.write(`[vitehub] Database "${database.name}": D1 migrations are up to date.\n`)
  return 0
}

async function migratePostgresDatabases(databases: ResolvedDrizzleDatabaseConfig[], projectRoot: string, context: ViteHubCliContext, allowDataLoss: boolean): Promise<number> {
  const { migratePostgresDatabases: migrate } = await import("./internal/migration-plan.ts")
  const error = await migrate(
    databases.map(database => ({ ...database, migrationsDir: resolve(projectRoot, database.migrationsDir) })),
    { allowDataLoss, env: context.env ?? process.env, projectRoot },
    message => context.stdout.write(`${message}\n`),
  )
  if (error) {
    context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
    return 1
  }
  for (const database of databases) context.stdout.write(`[vitehub] Database "${database.name}": migrations are up to date.\n`)
  return 0
}

/** libSQL does not create parent directories, so the first `database migrate` needs the local data directory to exist. */
async function ensureLocalSqliteDirectory(database: ResolvedDrizzleDatabaseConfig, projectRoot: string, context: ViteHubCliContext) {
  if (database.cloudflare?.http && database.cloudflare.databaseId) return
  const url = resolveConfigValue(database.connection?.url, context.env ?? process.env)
  if (!url || url === ":memory:" || /^(?:libsql:|https?:|wss?:)/i.test(url)) return
  const path = resolveLocalSqlitePath(url)
  if (!path || path === ":memory:") return
  await mkdir(dirname(resolve(projectRoot, path)), { recursive: true })
}

// drizzle-kit generate catches schema load and diff errors, logs them with console.error, and exits 0.
// This preload turns a logged Error into a non-zero exit code so `vitehub database generate` cannot report success.
const drizzleKitFailOnLoggedError = [
  "const logError = console.error",
  "console.error = function (...args) {",
  "  if (args.some(arg => arg instanceof Error)) process.exitCode = 1",
  "  return logError.apply(this, args)",
  "}",
].join("\n")

function withDrizzleKitErrorExit(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const preload = `--import=data:text/javascript,${encodeURIComponent(drizzleKitFailOnLoggedError)}`
  return { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, preload].filter(Boolean).join(" ") }
}

async function runDrizzleKitWithConfig(
  feature: "generate" | "migrate",
  args: string[],
  context: ViteHubCliContext,
  { bin, configFile, projectRoot }: { bin: string, configFile: string, projectRoot: string },
): Promise<number> {
  const drizzleArgs = [
    bin,
    feature,
    "--config",
    configFile,
    ...forwardDrizzleArgs(args),
  ]
  const env = context.env ?? process.env
  const result = await context.spawn(process.execPath, drizzleArgs, {
    cwd: projectRoot,
    env: feature === "generate" ? withDrizzleKitErrorExit(env) : env,
    stderr: "inherit",
    stdout: "inherit",
  })
  const exitCode = result.exitCode ?? 1
  if (exitCode !== 0) {
    context.stderr.write(`[vitehub] drizzle-kit ${feature} failed for ${configFile} (exit code ${exitCode}). See the drizzle-kit output above.\n`)
  }
  return exitCode
}

export function createDbCliContributor(
  options?: false | Exclude<DatabaseOptions, false>["cli"],
  getConfig?: ResolvedDBViteConfigProvider,
): ViteHubCliContributor | undefined {
  if (options === false) return

  const features: ViteHubCliContributor["namespaces"][number]["features"] = []
  if (options?.generate !== false) {
    features.push({
      description: "Generate database migrations from Database Definitions.",
      name: "generate",
      run: async (args, context) => {
        if (args.includes("-h") || args.includes("--help")) {
          writeGenerateUsage(context)
          return 0
        }
        return await runDrizzleKit("generate", args, context, getConfig)
      },
      usage: generateUsage,
    })
  }
  if (options?.migrate !== false) {
    features.push({
      description: "Apply database migrations. Refuses migrations that lose data.",
      name: "migrate",
      run: async (args, context) => {
        if (args.includes("-h") || args.includes("--help")) {
          writeMigrateUsage(context)
          return 0
        }
        return await runDrizzleKit("migrate", args, context, getConfig)
      },
      usage: "vitehub database migrate [--dry-run] [--allow-data-loss]",
    })
  }

  if (options?.up !== false) {
    features.push({
      description: "Convert migrations folders of Drizzle Kit 0.x to the Drizzle Kit 1.0 layout.",
      name: "up",
      run: async (args, context) => {
        if (args.includes("-h") || args.includes("--help")) {
          writeUpUsage(context)
          return 0
        }
        return await runUp(args, context, getConfig)
      },
      usage: upUsage,
    })
  }

  if (options?.export !== false) {
    features.push({
      description: "Export databases to SQL dump files.",
      name: "export",
      run: async (args, context) => {
        if (args.includes("-h") || args.includes("--help")) {
          writeExportUsage(context)
          return 0
        }
        return await runExport(args, context, getConfig)
      },
      usage: exportUsage,
    })
  }

  return {
    namespaces: [{
      description: "Database development workflows.",
      features,
      name: "database",
    }],
  } satisfies SharedViteHubCliContributor
}
