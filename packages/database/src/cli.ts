import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire, findPackageJSON } from "node:module"
import { pathToFileURL } from "node:url"

import type { DatabaseOptions } from "./types.ts"
import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "./types.ts"
import type { ViteHubCliContributor as SharedViteHubCliContributor, ViteHubCliSeed, ViteHubCliSeedOptions } from "@vite-hub/internal/cli"
import type { AdoptedMigration, MigrationPlan } from "./internal/migration-plan.ts"
import type { SqliteSnapshot } from "./internal/snapshot-uniques.ts"

import { dirname, isAbsolute, join, relative, resolve } from "pathe"

import { formatInstallArgument, installSpecifier } from "@vite-hub/internal/features"
import { formatRuntimeDiagnosticError, isRuntimeDiagnostic } from "@vite-hub/runtime"
import { loadAllEnv } from "@vite-hub/internal/vite-stage"
import { isRecord } from "@vite-hub/internal/object"

import { resolveConfigValue } from "./config-value.ts"
import { databaseErrorDiagnostics } from "./error-diagnostics.ts"
import { resolveLocalSqlitePath } from "./runtime/local-path.ts"
import { runsOnPglite } from "./runtime/postgres-env.ts"
import { readOldMigrationsLayout } from "./internal/migrations-layout.ts"
import { addStatementBreakpoints, isNoTransactionMigration, splitSqlStatements } from "./internal/migration-sql.ts"

import type { OldMigrationsLayout } from "./internal/migrations-layout.ts"

/** Refreshes generated artifacts. `strict` fails when a Database Definition cannot load to list its tables. */
type ResolvedDBViteConfigProvider = (options: { strict: boolean }) => MaybePromise<ResolvedDBViteConfig | undefined>
type MaybePromise<T> = Promise<T> | T

interface ViteHubCliContext {
  cwd?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  rootDir: string
  spawn: (command: string, args: string[], options?: { cwd?: string, env?: NodeJS.ProcessEnv, stderr?: "inherit" | "pipe", stdin?: "ignore" | "inherit", stdout?: "inherit" | "pipe" }) => Promise<{ exitCode: number | null, stdout?: string }>
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
  seeds?: ViteHubCliSeed[]
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
    "  --hints <json>     Answer the rename or create questions of Drizzle Kit ahead of",
    "                     time, as a JSON array. --hints-file <file> reads it from a file.",
    "",
    "Without a terminal, or with CI set, it never asks. A question that has no hint fails",
    "with DATABASE_GENERATE_AMBIGUOUS_CHANGE and exit code 2.",
    "",
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
    "Converts migrations folders of Drizzle Kit 0.x, with `meta/_journal.json`, and",
    "folders of hand-written SQLite or D1 `.sql` files to the layout of Drizzle Kit 1.0: one",
    "`<timestamp>_<name>/migration.sql` folder per migration. A complete 0.x folder goes",
    "through `drizzle-kit up`. Folders that already use the 1.0 layout stay as they are. Applied",
    "migrations stay applied: `vitehub database migrate` and Wrangler keep their ledger rows.",
    "On SQLite, the snapshots record the unique indexes of 0.x `.unique()` columns as",
    "the UNIQUE constraints of the Definitions, so the next generate keeps the tables.",
    "",
    "Options:",
    "  -h, --help         Show this help.",
    "",
  ].join("\n"))
}

const upUsage = "vitehub database up"

const generateUsage = "vitehub database generate [--name <name>] [--custom [--schema-snapshot]] [--hints <json> | --hints-file <file>]"

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
    context.stderr.write("[vitehub] ViteHub has no resolved Database config. Run the command in a project that uses `hubDatabase()`.\n")
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
    env = { ...loadAllEnv(loadEnv, parsed.stage, projectRoot), ...env }
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
      const failure = databaseErrorDiagnostics.DATABASE_EXPORT_FAILED.is(error) ? error : databaseErrorDiagnostics.DATABASE_EXPORT_FAILED({ cause: error, database: name, problem })
      context.stderr.write(`${formatRuntimeDiagnosticError(failure)}\n`)
      return 1
    }
  }
  return 0
}

/**
 * Runs the seed file of each database for `vitehub seed`, which loaded the env files of `--stage` into `options.env` and
 * `process.env`. Returns `undefined` when no database has a seed file and `--database` names none.
 */
async function runSeed(options: ViteHubCliSeedOptions, context: ViteHubCliContext, getConfig?: ResolvedDBViteConfigProvider, getAlias?: () => Record<string, string> | undefined): Promise<number | undefined> {
  const config = await getConfig?.({ strict: false })
  if (!config?.databaseNames.length) {
    context.stderr.write("[vitehub] ViteHub has no resolved Database config. Run the command in a project that uses `hubDatabase()`.\n")
    return 1
  }
  if (options.database && !config.databases[options.database]) {
    context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_NOT_FOUND({ database: options.database }))}\n`)
    return 1
  }
  const projectRoot = config.rootDir
  const cwd = context.cwd ?? process.cwd()
  const { findSeedFile, seedDatabase } = await import("./internal/seed.ts")
  const seeds = (options.database ? [options.database] : config.databaseNames).map(name => ({ database: config.databases[name]!, ...findSeedFile(config.databases[name]!, projectRoot) }))
  // Without `--database`, a database without a seed file has nothing to seed, and `vitehub seed` reports a run that seeds nothing.
  if (!options.database && seeds.every(seed => !seed.exists)) return undefined
  const missing = options.database ? seeds.find(seed => !seed.exists) : undefined
  if (missing) {
    const file = relative(cwd, missing.file) || missing.file
    context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_SEED_NOT_FOUND({ database: missing.database.name, file }))}\n`)
    return 1
  }
  for (const seed of seeds.filter(seed => seed.exists)) {
    try {
      const target = await seedDatabase(seed.database, seed.file, { alias: getAlias?.(), env: options.env, fetch: context.fetch, projectRoot, remote: options.remote })
      context.stdout.write(`[vitehub] Database "${seed.database.name}" (${target}): ran ${relative(cwd, seed.file) || seed.file}.\n`)
    }
    catch (error) {
      context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
      return 1
    }
  }
  return 0
}

const sqlUsage = "vitehub database sql [<query>] [--remote] [--stage <name>] [--database <name>] [--json]"

function writeSqlUsage(context: ViteHubCliContext): void {
  context.stdout.write([
    `Usage: ${sqlUsage}`,
    "",
    "Runs SQL on a database and prints the rows of each statement as a table. Without",
    "<query>, it reads the SQL from stdin. Without `--remote`, it uses the local SQLite file",
    "or PGlite folder that `vitehub database migrate` uses.",
    "",
    "Options:",
    "  --remote           Use the remote database, with the credentials of `vitehub database export --remote`.",
    "  --stage <name>     Load Vite env files for this mode. Variables from the current",
    "                     process take precedence.",
    "  --database <name>  The database to use. Needed when the app has several.",
    "  --json             Print one JSON array with `{ columns, rows, rowsAffected }` for each statement.",
    "  -h, --help         Show this help.",
    "",
  ].join("\n"))
}

const dropUsage = "vitehub database drop [--remote] [--stage <name>] [--database <name>] [--yes]"

function writeDropUsage(context: ViteHubCliContext): void {
  context.stdout.write([
    `Usage: ${dropUsage}`,
    "",
    "Drops every table and view of a database, and the migrations table with them, in one",
    "transaction. Run `vitehub database migrate` to create the tables again. It asks before it",
    "drops. Without a terminal to ask, it needs `--yes`. Without `--remote`, it uses the local",
    "SQLite file or PGlite folder that `vitehub database migrate` uses.",
    "",
    "Options:",
    "  --remote           Use the remote database, with the credentials of `vitehub database export --remote`.",
    "  --stage <name>     Load Vite env files for this mode. Variables from the current",
    "                     process take precedence.",
    "  --database <name>  The database to drop. Needed when the app has several.",
    "  --yes              Drop without asking.",
    "  -h, --help         Show this help.",
    "",
  ].join("\n"))
}

const resetUsage = "vitehub database reset [--remote] [--stage <name>] [--database <name>] [--yes]"

function writeResetUsage(context: ViteHubCliContext): void {
  context.stdout.write([
    `Usage: ${resetUsage}`,
    "",
    "Drops every table and view of a database, like `vitehub database drop`, then applies all",
    "of its migrations again, like `vitehub database migrate`. It asks before it drops. Without",
    "a terminal to ask, it needs `--yes`. Without `--remote`, it uses the local SQLite file or",
    "PGlite folder that `vitehub database migrate` uses.",
    "",
    "Options:",
    "  --remote           Use the remote database, with the credentials of `vitehub database export --remote`.",
    "  --stage <name>     Load Vite env files for this mode. Variables from the current",
    "                     process take precedence.",
    "  --database <name>  The database to reset. Needed when the app has several.",
    "  --yes              Reset without asking.",
    "  -h, --help         Show this help.",
    "",
  ].join("\n"))
}

/** Terminal input of `sql`, `drop`, and `reset`. Tests replace it. */
export interface DbCliIo {
  /** Asks whether `drop` or `reset` may drop the tables. Defaults to a prompt when stdin and stderr are terminals. */
  confirm?: (question: string) => Promise<boolean>
  /** Reads the SQL of `sql` when no argument has it. Defaults to stdin when stdin is not a terminal. */
  readStdin?: () => Promise<string | undefined>
}

interface TargetArgs {
  database?: string
  remote: boolean
  stage?: string
}

/** Parses the target flags of `sql`, `drop`, and `reset`, plus their boolean flags and positionals. */
function parseTargetArgs(args: string[], flags: readonly string[]): (TargetArgs & { flags: Set<string>, positionals: string[] }) | string {
  const parsed: TargetArgs & { flags: Set<string>, positionals: string[] } = { flags: new Set(), positionals: [], remote: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    // SQL can start with `-`, such as a `-- comment`. Only `-x` or `--name` is an option.
    if (!/^--?[a-z]/i.test(arg)) {
      parsed.positionals.push(arg)
      continue
    }
    if (arg === "--remote") {
      parsed.remote = true
      continue
    }
    if (flags.includes(arg)) {
      parsed.flags.add(arg)
      continue
    }
    if (arg === "--force" && flags.includes("--yes")) return "--force is now --yes. Run the command again with --yes."
    const option = (["--database", "--stage"] as const).find(name => arg === name || arg.startsWith(`${name}=`))
    if (!option) return `Unknown option: ${arg}`
    const value = arg === option ? args[++index] : arg.slice(option.length + 1)
    if (!value || value.startsWith("-")) return `${option} requires a value.`
    parsed[option.slice(2) as "database" | "stage"] = value
  }
  return parsed
}

/** Picks the one database of `sql`, `drop`, and `reset` and loads the stage env. Writes the problem and returns undefined on failure. */
async function resolveCommandTarget(parsed: TargetArgs, context: ViteHubCliContext, getConfig?: ResolvedDBViteConfigProvider) {
  const config = await getConfig?.({ strict: false })
  if (!config?.databaseNames.length) {
    context.stderr.write("[vitehub] ViteHub has no resolved Database config. Run the command in a project that uses `hubDatabase()`.\n")
    return
  }
  if (parsed.database && !config.databases[parsed.database]) {
    context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_NOT_FOUND({ database: parsed.database }))}\n`)
    return
  }
  if (!parsed.database && config.databaseNames.length > 1) {
    context.stderr.write(`[vitehub] The app has several databases. Add --database <name> to pick one of: ${config.databaseNames.join(", ")}.\n`)
    return
  }
  const database = config.databases[parsed.database ?? config.databaseNames[0]!]!
  let env = context.env ?? process.env
  if (parsed.stage) {
    const { loadEnv } = await import("vite")
    env = { ...loadEnv(parsed.stage, config.rootDir, ""), ...env }
  }
  return { database, env, projectRoot: config.rootDir }
}

/** Asks on the terminal through stderr. Only `y` or `yes`, in any case, is a yes. */
async function askOnTerminal(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises")
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(?:es)?$/i.test((await terminal.question(question)).trim())
  }
  finally {
    terminal.close()
  }
}

async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString("utf8")
}

async function runSql(args: string[], context: ViteHubCliContext, getConfig: ResolvedDBViteConfigProvider | undefined, io: DbCliIo): Promise<number> {
  const parsed = parseTargetArgs(args, ["--json"])
  if (typeof parsed === "string" || parsed.positionals.length > 1) {
    context.stderr.write(`[vitehub] ${typeof parsed === "string" ? parsed : "Pass the SQL as one argument. Quote it, or pipe it on stdin."}\n`)
    writeSqlUsage(context)
    return 1
  }
  const query = parsed.positionals[0] ?? await (io.readStdin ?? readStdin)()
  if (!query?.trim()) {
    context.stderr.write("[vitehub] No SQL to run. Pass it as an argument, such as `vitehub database sql \"select 1\"`, or pipe it on stdin.\n")
    return 1
  }
  const resolved = await resolveCommandTarget(parsed, context, getConfig)
  if (!resolved) return 1
  const { database } = resolved
  const fail = (problem: string, cause?: unknown) => {
    context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_SQL_FAILED({ cause, database: database.name, problem }))}\n`)
    return 1
  }
  const { formatSqlResult, openSqlConnection } = await import("./internal/sql.ts")
  let connection: import("./internal/sql.ts").SqlConnection | undefined
  try {
    const opened = await openSqlConnection(database, { env: resolved.env, fetch: context.fetch, projectRoot: resolved.projectRoot, remote: parsed.remote })
    if ("problem" in opened) return fail(opened.problem)
    if ("missing" in opened) return fail(`It uses ${opened.missing}, which does not exist. Run \`vitehub database migrate\` to create it.`)
    connection = opened.connection
    const results = await connection.run(query)
    if (parsed.flags.has("--json")) {
      context.stdout.write(`${JSON.stringify(results, jsonValue, 2)}\n`)
      return 0
    }
    context.stderr.write(`[vitehub] Database "${database.name}" (${connection.target}).\n`)
    context.stdout.write(results.map(formatSqlResult).join("\n"))
    return 0
  }
  catch (error) {
    return fail(error instanceof Error ? error.message : String(error), error)
  }
  finally {
    await connection?.close()
  }
}

/** JSON has no bigint or bytes. Bigints become strings, and bytes become hex strings. */
function jsonValue(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString()
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("hex")
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")
  return value
}

async function runDrop(args: string[], context: ViteHubCliContext, getConfig: ResolvedDBViteConfigProvider | undefined, io: DbCliIo): Promise<number> {
  const parsed = parseTargetArgs(args, ["--yes"])
  if (typeof parsed === "string" || parsed.positionals.length) {
    context.stderr.write(`[vitehub] ${typeof parsed === "string" ? parsed : `Unknown argument: ${parsed.positionals[0]}`}\n`)
    writeDropUsage(context)
    return 1
  }
  const resolved = await resolveCommandTarget(parsed, context, getConfig)
  if (!resolved) return 1
  return await dropTables("drop", parsed, resolved, context, io)
}

async function runReset(args: string[], context: ViteHubCliContext, getConfig: ResolvedDBViteConfigProvider | undefined, io: DbCliIo): Promise<number> {
  const parsed = parseTargetArgs(args, ["--yes"])
  if (typeof parsed === "string" || parsed.positionals.length) {
    context.stderr.write(`[vitehub] ${typeof parsed === "string" ? parsed : `Unknown argument: ${parsed.positionals[0]}`}\n`)
    writeResetUsage(context)
    return 1
  }
  const resolved = await resolveCommandTarget(parsed, context, getConfig)
  if (!resolved) return 1
  const { database, env, projectRoot } = resolved
  const fail = (problem: string, cause?: unknown) => {
    context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_DROP_FAILED({ cause, command: "reset", database: database.name, problem }))}\n`)
    return 1
  }
  // `migrate` applies the migrations of a D1 binding to its local SQLite file, so it cannot rebuild the deployed database.
  const { resolveExportTarget } = await import("./internal/export.ts")
  if (parsed.remote && !database.cloudflare?.http && resolveExportTarget(database, { env, projectRoot, remote: true }).kind === "d1") {
    return fail(`\`vitehub database migrate\` does not apply migrations to the deployed D1 database of a binding. Run \`vitehub database drop --remote\`, then \`wrangler d1 migrations apply ${database.cloudflare?.databaseName ?? "<database>"} --remote\`.`)
  }
  // Read the migrations before the drop, so a broken migrations folder does not leave an empty database.
  const { readMigrations } = await import("./internal/migration-journal.ts")
  try {
    readMigrations(resolve(projectRoot, database.migrationsDir), database.name, { flat: isD1Http(database) })
  }
  catch (error) {
    if (isRuntimeDiagnostic(error)) {
      context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
      return 1
    }
    return fail(`Its migrations cannot be read, so nothing was dropped. ${error instanceof Error ? error.message : String(error)}`, error)
  }
  const dropped = await dropTables("reset", parsed, resolved, context, io)
  if (dropped !== 0) return dropped
  // The tables are gone, so a migration that drops a column or deletes rows loses nothing.
  return await runDrizzleKit("migrate", ["--allow-data-loss"], { ...context, env }, getConfig, database.name)
}

/** Drops every table of the target after the person confirms, or with `--yes`. Returns the exit code. */
async function dropTables(
  command: "drop" | "reset",
  parsed: TargetArgs & { flags: Set<string> },
  resolved: NonNullable<Awaited<ReturnType<typeof resolveCommandTarget>>>,
  context: ViteHubCliContext,
  io: DbCliIo,
): Promise<number> {
  const { database } = resolved
  const fail = (problem: string, cause?: unknown) => {
    context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_DROP_FAILED({ cause, command, database: database.name, problem }))}\n`)
    return 1
  }
  const { openSqlConnection, planDrop } = await import("./internal/sql.ts")
  let connection: import("./internal/sql.ts").SqlConnection | undefined
  try {
    const opened = await openSqlConnection(database, { env: resolved.env, fetch: context.fetch, projectRoot: resolved.projectRoot, remote: parsed.remote })
    if ("problem" in opened) return fail(opened.problem)
    if ("missing" in opened) {
      context.stdout.write(`[vitehub] Database "${database.name}" (${opened.missing}): it does not exist, so there is nothing to drop.\n`)
      return 0
    }
    connection = opened.connection
    const plan = await planDrop(connection)
    if (!plan.statements.length) {
      context.stdout.write(`[vitehub] Database "${database.name}" (${connection.target}): it has no tables to drop.\n`)
      return 0
    }
    if (!parsed.flags.has("--yes")) {
      const objects = `${plan.objects.length} ${plan.objects.length === 1 ? "table or view" : "tables and views"}`
      const question = command === "drop"
        ? `Drop ${objects} of the database "${database.name}" (${connection.target})? All their data is lost. [y/N] `
        : `Drop ${objects} of the database "${database.name}" (${connection.target}) and apply its migrations again? All their data is lost. [y/N] `
      const confirm = io.confirm ?? (process.stdin.isTTY && process.stderr.isTTY ? askOnTerminal : undefined)
      if (!confirm || !await confirm(question)) {
        context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_DROP_NOT_CONFIRMED({ command, database: database.name }))}\n`)
        return 1
      }
    }
    await connection.runInTransaction(plan.statements)
    context.stdout.write(`[vitehub] Database "${database.name}" (${connection.target}): dropped ${plan.objects.join(", ")}.\n`)
    return 0
  }
  catch (error) {
    return fail(error instanceof Error ? error.message : String(error), error)
  }
  finally {
    await connection?.close()
  }
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
  /** Runs only this database, such as the one that `reset` dropped. */
  only?: string,
): Promise<number> {
  if (feature === "generate" && args.includes("--non-interactive")) {
    context.stderr.write("[vitehub] --non-interactive was removed. Without a terminal, or with CI set, `vitehub database generate` never asks. Run it with CI=1 to never ask in a terminal.\n")
    return 1
  }
  const schemaSnapshot = feature === "generate" && args.includes("--schema-snapshot")
  if (schemaSnapshot && !args.includes("--custom")) {
    context.stderr.write("[vitehub] --schema-snapshot works only with --custom. A migration without --custom already writes the snapshot of the current Database Definitions.\n")
    return 1
  }
  const config = await getConfig?.({ strict: feature === "generate" })
  // Drizzle Kit 1.0 cannot generate or migrate next to a 0.x journal, so stop before it changes anything.
  if (config && !writeOldLayoutDiagnostics(config, context, only, feature)) return 1
  // Drizzle Kit resolves `out` and the SQLite URL from its working directory, and the Database writes them relative to its
  // project root. In Nuxt the Vite root is `srcDir` (`app/`), so `context.rootDir` is not the project root.
  const projectRoot = config?.rootDir ?? context.rootDir
  const runs = (config && config.databaseNames.length > 1
    ? config.databaseNames.map(name => ({ configFile: config.generatedDrizzleConfigFilesByDatabase[name]!, database: config.databases?.[name] }))
    : [{ configFile: config?.generatedDrizzleConfigFile ?? ".vitehub/database/drizzle.config.ts", database: config?.databases?.[config.databaseNames[0]!] }])
    .filter(run => !only || run.database?.name === only)

  if (feature === "migrate") {
    const env = context.env ?? process.env
    const pgliteDatabases = runs.flatMap(({ database }) =>
      database?.dialect === "postgresql" && runsOnPglite(database.driver, resolveConfigValue(database.connection?.url, env), env) ? [database] : [],
    )
    if (pgliteDatabases.length && args.some(arg => arg === "--config" || arg.startsWith("--config="))) {
      context.stderr.write("[vitehub] `vitehub database migrate` does not support --config for PGlite. Set the migration options in the Database Definition, or run `drizzle-kit migrate --config <file>` directly.\n")
      return 1
    }
    for (const database of pgliteDatabases) {
      if (!await checkPgliteMigrationHistory(database, projectRoot, context)) return 1
    }
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
        readMigrations(resolve(projectRoot, database.migrationsDir), database.name, { flat: isD1Http(database) })
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
    feature === "migrate" && database !== undefined && isD1Http(database)
  // Postgres and PGlite use ViteHub's migrator, the one that a server runs on start, so both hold the same advisory lock.
  const usesPostgres = (database: ResolvedDrizzleDatabaseConfig | undefined): database is ResolvedDrizzleDatabaseConfig =>
    feature === "migrate" && database?.dialect === "postgresql"
  // A project with only D1 HTTP and Postgres databases can migrate without Drizzle Kit. Prefer the Database root because the
  // generated config and working directory belong to it. Fall back to the invoking Vite root for external Database roots.
  const drizzleKitBin = runs.every(run => usesD1Http(run.database) || usesPostgres(run.database)) ? "" : resolveDrizzleKitBin([projectRoot, context.rootDir])
  if (drizzleKitBin === undefined) {
    context.stderr.write(`[vitehub] Cannot find drizzle-kit in the dependencies of ${projectRoot}. Install it, for example with \`pnpm add -D ${formatInstallArgument(installSpecifier("drizzle-kit"))}\`.\n`)
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
    // The type guards above narrow `database` to undefined, so read the run's Database.
    if (feature === "migrate" && run.database?.dialect === "sqlite") {
      // Record the migrations that another ledger lists first, so Drizzle Kit does not run them again.
      const result = await adoptSqliteMigrations(run.database, projectRoot, context)
      if (result !== 0) return result
    }
    const plan = database && upToDate.get(database)
    if (plan) {
      writeMigrationPlan(plan, context)
      continue
    }
    if (feature === "migrate" && database) await ensureLocalDatabaseDirectory(database, projectRoot, context)
    if (feature === "migrate" && run.database?.dialect === "sqlite") {
      const result = await migrateSplitSqliteDatabase(run.database, args, context, { bin: drizzleKitBin, configFile: toConfigPath(projectRoot, configFile), projectRoot })
      if (result === 0) continue
      if (result !== undefined) return result
    }
    const migrationsDir = run.database?.migrationsDir ? resolve(projectRoot, run.database.migrationsDir) : undefined
    if (feature === "generate" && migrationsDir && run.database?.dialect === "sqlite" && await hasUnrecordedUniques(migrationsDir)) {
      // A folder that `drizzle-kit up` or an older ViteHub converted still lists each `.unique()` column as an index.
      await recordConvertedUniques(context, { bin: drizzleKitBin, configFile: resolve(projectRoot, configFile), database: run.database.name, migrationsDir, projectRoot })
    }
    const foldersBefore = feature === "generate" && migrationsDir ? await listMigrationFolders(migrationsDir) : []
    const result = await runDrizzleKitWithConfig(feature, args, context, { bin: drizzleKitBin, configFile: toConfigPath(projectRoot, configFile), database: run.database?.name ?? "default", projectRoot })
    if (result !== 0) return result
    if (feature === "generate" && migrationsDir) {
      const { orderGeneratedMigrations } = await import("./internal/contributed-migrations.ts")
      orderGeneratedMigrations(migrationsDir, foldersBefore)
    }
    if (schemaSnapshot) {
      // `usesD1Http()` is false for every generate, but its type guard narrows `database` to undefined after it.
      if (!migrationsDir) {
        context.stderr.write("[vitehub] --schema-snapshot needs a resolved Database config. Run the command in a project that uses `hubDatabase()`.\n")
        return 1
      }
      // The folder that this generate wrote. Kit can name two SQLite folders with the same second, so the newest name is not reliable.
      const folder = (await listMigrationFolders(migrationsDir)).find(name => !foldersBefore.includes(name))
      const snapshot = await writeSchemaSnapshot(context, { bin: drizzleKitBin, configFile: resolve(projectRoot, configFile), folder, migrationsDir, projectRoot })
      if (snapshot !== 0) return snapshot
    }
    if (feature === "generate" && migrationsDir && run.database) {
      // Contributed SQL goes after the migrations that Drizzle Kit just wrote, so their order never changes.
      const contributed = config?.migrationContributionsByDatabase?.[run.database.name] ?? []
      if (contributed.length) {
        const { describeContributedMigration, planContributedMigrations, writeContributedMigrations } = await import("./internal/contributed-migrations.ts")
        const { pending } = planContributedMigrations(migrationsDir, contributed, run.database.dialect)
        writeContributedMigrations(migrationsDir, pending).forEach((folder, index) => {
          context.stdout.write(`[vitehub] Database "${run.database!.name}": added the migration ${relative(projectRoot, join(migrationsDir, folder))} from ${describeContributedMigration(pending[index]!)}.\n`)
        })
      }
      if (run.database.dialect === "sqlite" && run.database.cloudflare) {
        // Keep the Wrangler name of each D1 migration in a committed file, so a later folder cannot renumber it.
        const { recordD1MigrationNames } = await import("./internal/d1-migrations.ts")
        recordD1MigrationNames(migrationsDir)
      }
    }
  }
  return 0
}

/** The Databases whose migrations folder has a layout that Drizzle Kit 1.0 cannot read, one entry per folder. */
function listOldLayoutFolders(config: ResolvedDBViteConfig) {
  const folders = new Map<string, { database: ResolvedDrizzleDatabaseConfig, layout: OldMigrationsLayout }>()
  for (const name of config.databaseNames) {
    const database = config.databases?.[name]
    if (!database) continue
    const dir = resolve(config.rootDir, database.migrationsDir)
    const layout = folders.has(dir) ? undefined : readOldMigrationsLayout(dir, { existsSync, readdirSync })
    if (layout) folders.set(dir, { database, layout })
  }
  return [...folders].map(([dir, folder]) => ({ ...folder, dir }))
}

/** D1 HTTP applies flat SQL itself, as Wrangler does. Drizzle Kit skips it everywhere else. */
function isD1Http(database: ResolvedDrizzleDatabaseConfig): boolean {
  return database.dialect === "sqlite" && !!database.cloudflare?.http && database.cloudflare.databaseId !== undefined
}

/** Writes `DATABASE_MIGRATIONS_OLD_LAYOUT` for each old migrations folder, or for the one of `only`. Returns false when there is one. */
function writeOldLayoutDiagnostics(config: ResolvedDBViteConfig, context: ViteHubCliContext, only?: string, feature?: "generate" | "migrate"): boolean {
  const folders = listOldLayoutFolders(config)
    .filter(({ database, layout }) => (!only || database.name === only) && !(feature === "migrate" && layout === "flat" && isD1Http(database)))
  for (const { database, dir, layout } of folders) {
    const diagnostic = databaseErrorDiagnostics.DATABASE_MIGRATIONS_OLD_LAYOUT({ database: database.name, dir: relative(config.rootDir, dir) || dir, layout })
    context.stderr.write(`${formatRuntimeDiagnosticError(diagnostic)}\n`)
  }
  return !folders.length
}

/**
 * Converts the old migrations folder of each Database to one folder per migration. A clean Drizzle Kit 0.x folder goes
 * through `drizzle-kit up`. Flat `.sql` files that no complete journal covers, such as hand-written Wrangler files, move
 * to folders by ViteHub. Returns the exit code.
 */
async function runUp(args: string[], context: ViteHubCliContext, getConfig?: ResolvedDBViteConfigProvider): Promise<number> {
  if (args.length) {
    context.stderr.write(`[vitehub] Unknown option: ${args[0]}\n`)
    writeUpUsage(context)
    return 1
  }
  const config = await getConfig?.({ strict: false })
  if (!config?.databaseNames.length) {
    context.stderr.write("[vitehub] ViteHub has no resolved Database config. Run the command in a project that uses `hubDatabase()`.\n")
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
    context.stderr.write(`[vitehub] Cannot find drizzle-kit in the dependencies of ${projectRoot}. Install it, for example with \`pnpm add -D ${formatInstallArgument(installSpecifier("drizzle-kit"))}\`.\n`)
    return 1
  }
  // Drizzle Kit 0.x has an `up` command too, but it upgrades 0.x snapshots and keeps the journal.
  const major = Number.parseInt(drizzleKit.version ?? "", 10)
  if (!(major >= 1)) {
    context.stderr.write(`[vitehub] \`vitehub database up\` needs drizzle-kit 1.0, and ${projectRoot} has drizzle-kit ${drizzleKit.version ?? "of an unknown version"}. Install the version that ViteHub uses, for example with \`pnpm add -D drizzle-kit@1.0.0-rc.6\`, and run it again.\n`)
    return 1
  }
  const { bin } = drizzleKit
  const { canDrizzleKitConvert } = await import("./internal/d1-migrations.ts")
  for (const { database, dir, layout } of folders) {
    const folder = relative(projectRoot, dir) || dir
    const configFile = config.databaseNames.length > 1 ? config.generatedDrizzleConfigFilesByDatabase[database.name]! : config.generatedDrizzleConfigFile
    let complete: boolean
    try {
      complete = layout === "journal" && canDrizzleKitConvert(dir)
    }
    catch (error) {
      writeFlatConversionError(context, database.name, folder, error)
      return 1
    }
    if (!complete) {
      const result = await convertFlatMigrations(context, { bin, configFile: resolve(projectRoot, configFile), database, dir, projectRoot })
      if (result !== 0) return result
      continue
    }
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
    if (dialect === "sqlite") {
      await recordConvertedUniques(context, { bin, configFile: resolve(projectRoot, configFile), database: database.name, migrationsDir: dir, projectRoot })
    }
  }
  return 0
}

/**
 * Moves each flat `.sql` file to its own migration folder, with a breakpoint between its statements, and removes a
 * Drizzle Kit 0.x `meta/` folder. The newest folder gets the snapshot of the replayed SQL, not of the Definitions.
 */
async function convertFlatMigrations(
  context: ViteHubCliContext,
  { bin, configFile, database, dir, projectRoot }: { bin: string, configFile: string, database: ResolvedDrizzleDatabaseConfig, dir: string, projectRoot: string },
): Promise<number> {
  const { d1MigrationNamesFile, planFlatMigrationFolders, readD1MigrationNames } = await import("./internal/d1-migrations.ts")
  const directory = relative(projectRoot, dir) || dir
  let moves: Array<{ file: string, folder: string, sql: string }>
  let snapshot: string
  let names: Record<string, string> | undefined
  try {
    if ((await listMigrationFolders(dir)).some(folder => /^\d{14}_/.test(folder) || existsSync(join(dir, folder, "migration.sql")))) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATION_CONVERSION_FAILED({ problem: "The folder already contains migration folders. Move them out of the old migrations folder before converting it." })
    }
    moves = await Promise.all(planFlatMigrationFolders(dir).map(async move => ({ ...move, sql: addStatementBreakpoints(await readFile(join(dir, move.file), "utf8"), database.dialect) })))
    if (!moves.length) throw databaseErrorDiagnostics.DATABASE_MIGRATION_CONVERSION_FAILED({ problem: "There are no flat SQL files to convert." })
    if (database.cloudflare) {
      const recorded = readD1MigrationNames(dir)
      names = Object.fromEntries([...Object.entries(recorded), ...moves.map(move => [move.folder, move.file] as const)].sort(([a], [b]) => a.localeCompare(b)))
    }
    if (await readSchemaSnapshot(context, { bin, configFile, projectRoot }) === undefined) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATION_CONVERSION_FAILED({ problem: "Drizzle Kit could not read the current Database Definitions. See the Drizzle Kit output above." })
    }
    snapshot = database.dialect === "postgresql"
      ? await readReplayedPostgresSnapshot(context, { bin, moves, projectRoot })
      : await readReplayedSqliteSnapshot(context, { bin, moves, projectRoot })
  }
  catch (error) {
    writeFlatConversionError(context, database.name, directory, error)
    return 1
  }
  for (const { file, folder, sql } of moves) {
    await mkdir(join(dir, folder))
    await writeFile(join(dir, folder, "migration.sql"), sql)
    await rm(join(dir, file))
  }
  await writeFile(join(dir, moves.at(-1)!.folder, "snapshot.json"), snapshot)
  await rm(join(dir, "meta"), { force: true, recursive: true })
  if (names) await writeFile(join(dir, d1MigrationNamesFile), `${JSON.stringify(names, null, 2)}\n`)
  context.stdout.write(`[vitehub] Database "${database.name}": converted ${moves.length} SQL ${moves.length === 1 ? "file" : "files"} in ${directory} to migration folders. Commit the new folders.\n`)
  return 0
}

function writeFlatConversionError(context: ViteHubCliContext, database: string, directory: string, error: unknown): void {
  const diagnostic = isRuntimeDiagnostic(error) ? error : databaseErrorDiagnostics.DATABASE_MIGRATION_CONVERSION_FAILED({
    cause: error,
    problem: error instanceof Error ? error.message : String(error),
  })
  context.stderr.write(`[vitehub] Database "${database}": ${directory} stays as it was.\n${formatRuntimeDiagnosticError(diagnostic)}\n`)
}

async function readReplayedSqliteSnapshot(
  context: ViteHubCliContext,
  { bin, moves, projectRoot }: { bin: string, moves: readonly { file: string, sql: string }[], projectRoot: string },
): Promise<string> {
  const { DatabaseSync, constants } = await import("node:sqlite")
  const dir = await mkdtemp(resolve(projectRoot, ".vitehub/database/migration-replay-"))
  try {
    const dbFile = join(dir, "replay.sqlite")
    const database = new DatabaseSync(dbFile)
    try {
      database.setAuthorizer(action => action === constants.SQLITE_ATTACH ? constants.SQLITE_DENY : constants.SQLITE_OK)
      for (const { file, sql } of moves) {
        try {
          for (const statement of sql.split("--> statement-breakpoint")) database.exec(statement)
        }
        catch (error) {
          throw databaseErrorDiagnostics.DATABASE_MIGRATION_CONVERSION_FAILED({ cause: error, problem: `Could not replay ${file}: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
    }
    finally {
      database.close()
    }
    const out = join(dir, "out")
    const result = await context.spawn(process.execPath, [bin, "pull", "--dialect", "sqlite", "--url", dbFile, "--out", out, "--init"], {
      cwd: projectRoot,
      env: withDrizzleKitErrorExit(context.env ?? process.env),
      stderr: "inherit",
      stdout: "pipe",
    })
    const generated = (await listMigrationFolders(out))[0]
    if (result.exitCode !== 0 || !generated) throw databaseErrorDiagnostics.DATABASE_MIGRATION_CONVERSION_FAILED({ problem: "Drizzle Kit could not write a snapshot of the replayed SQL." })
    return await readFile(join(out, generated, "snapshot.json"), "utf8")
  }
  finally {
    await rm(dir, { force: true, recursive: true })
  }
}

/**
 * Replays Postgres SQL files on a temporary PGlite folder, and returns the snapshot that `drizzle-kit pull` writes for it.
 * A file that starts with `-- vitehub:no-transaction` runs statement by statement, the others in one transaction each.
 */
async function readReplayedPostgresSnapshot(
  context: ViteHubCliContext,
  { bin, moves, projectRoot }: { bin: string, moves: readonly { file: string, sql: string }[], projectRoot: string },
): Promise<string> {
  let PGlite: typeof import("@electric-sql/pglite").PGlite
  try {
    PGlite = (createRequire(join(projectRoot, "package.json"))("@electric-sql/pglite") as typeof import("@electric-sql/pglite")).PGlite
  }
  catch (error) {
    throw databaseErrorDiagnostics.DATABASE_MIGRATION_CONVERSION_FAILED({ cause: error, problem: "ViteHub replays Postgres SQL on PGlite to write the snapshot, but the project cannot load `@electric-sql/pglite`. Install it, for example with `pnpm add -D @electric-sql/pglite`." })
  }
  await mkdir(resolve(projectRoot, ".vitehub/database"), { recursive: true })
  const dir = await mkdtemp(resolve(projectRoot, ".vitehub/database/migration-replay-"))
  try {
    const dataDir = join(dir, "pglite")
    const database = new PGlite(dataDir)
    try {
      for (const { file, sql } of moves) {
        try {
          if (isNoTransactionMigration(sql)) {
            for (const statement of splitSqlStatements(sql, "postgresql")) await database.query(statement)
          }
          else {
            await database.transaction(async (tx) => {
              await tx.exec(sql)
            })
          }
        }
        catch (error) {
          throw databaseErrorDiagnostics.DATABASE_MIGRATION_CONVERSION_FAILED({ cause: error, problem: `Could not replay ${file}: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
    }
    finally {
      await database.close()
    }
    const out = join(dir, "out")
    const result = await context.spawn(process.execPath, [bin, "pull", "--dialect", "postgresql", "--driver", "pglite", "--url", dataDir, "--out", out], {
      cwd: projectRoot,
      env: withDrizzleKitErrorExit(context.env ?? process.env),
      stderr: "inherit",
      stdout: "pipe",
    })
    const generated = (await listMigrationFolders(out))[0]
    if (result.exitCode !== 0 || !generated) throw databaseErrorDiagnostics.DATABASE_MIGRATION_CONVERSION_FAILED({ problem: "Drizzle Kit could not write a snapshot of the replayed SQL." })
    const { markGeneratedPostgresNames } = await import("./internal/snapshot-uniques.ts")
    const snapshot: unknown = JSON.parse(await readFile(join(out, generated, "snapshot.json"), "utf8"))
    markGeneratedPostgresNames(snapshot)
    return JSON.stringify(snapshot, null, 2)
  }
  finally {
    await rm(dir, { force: true, recursive: true })
  }
}

/** The migration folders of a Drizzle Kit 1.0 migrations directory. */
async function listMigrationFolders(migrationsDir: string): Promise<string[]> {
  return (await readdir(migrationsDir, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

async function hasLinearSnapshotHistory(dir: string): Promise<boolean> {
  const ids = new Set<string>()
  let parent = "00000000-0000-0000-0000-000000000000"
  ids.add(parent)
  for (const folder of (await listMigrationFolders(dir)).sort((a, b) => a.localeCompare(b))) {
    const file = join(dir, folder, "snapshot.json")
    if (!existsSync(file)) continue
    const snapshot: unknown = JSON.parse(await readFile(file, "utf8"))
    if (!isRecord(snapshot) || typeof snapshot.id !== "string" || ids.has(snapshot.id)
      || !Array.isArray(snapshot.prevIds) || snapshot.prevIds.length !== 1 || snapshot.prevIds[0] !== parent) return false
    ids.add(snapshot.id)
    parent = snapshot.id
  }
  return true
}

async function checkPgliteMigrationHistory(database: ResolvedDrizzleDatabaseConfig, projectRoot: string, context: ViteHubCliContext): Promise<boolean> {
  try {
    const dir = resolve(projectRoot, database.migrationsDir)
    if (await hasLinearSnapshotHistory(dir)) return true
    const bin = resolveDrizzleKitBin([projectRoot, context.rootDir])
    if (!bin) throw new Error("The migration snapshots do not form a single chain. Install a supported drizzle-kit to check the history before migrating.")
    const result = await context.spawn(process.execPath, [bin, "check", "--dialect", "postgresql", "--out", toConfigPath(projectRoot, dir)], {
      cwd: projectRoot,
      env: withDrizzleKitErrorExit(context.env ?? process.env),
      stderr: "inherit",
      stdout: "inherit",
    })
    if (result.exitCode === 0) return true
    throw new Error(`drizzle-kit check failed (exit code ${result.exitCode ?? 1}). See the drizzle-kit output above.`)
  }
  catch (error) {
    const problem = error instanceof Error ? error.message : String(error)
    context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: database.name, problem }))}\n`)
    return false
  }
}

/**
 * The snapshot of the current Database Definitions. Drizzle Kit writes the full snapshot only for a first migration, so
 * it runs once more into an empty directory. Undefined when Drizzle Kit fails, null for an empty schema.
 */
async function readSchemaSnapshot(
  context: ViteHubCliContext,
  { bin, configFile, projectRoot }: { bin: string, configFile: string, projectRoot: string },
): Promise<Record<string, unknown> | null | undefined> {
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
    if (result.exitCode !== 0) return undefined
    if (!generated) return null
    return JSON.parse(await readFile(join(dir, "out", generated, "snapshot.json"), "utf8")) as Record<string, unknown>
  }
  finally {
    await rm(dir, { force: true, recursive: true })
  }
}

/**
 * Drizzle Kit copies the previous snapshot into a custom migration, because it expects SQL that changes only data.
 * For SQL that changes the tables, such as the Comments upgrade, this replaces that copy with the snapshot of the
 * current Database Definitions. The new snapshot keeps its `id` and `prevIds`, so the migration history stays one chain.
 */
async function writeSchemaSnapshot(
  context: ViteHubCliContext,
  { bin, configFile, folder, migrationsDir, projectRoot }: { bin: string, configFile: string, folder: string | undefined, migrationsDir: string, projectRoot: string },
): Promise<number> {
  // Drizzle Kit writes each snapshot beside its migration, in `folder` for the custom migration.
  const target = join(migrationsDir, folder ?? "", "snapshot.json")
  const current = folder ? await readSchemaSnapshot(context, { bin, configFile, projectRoot }) : undefined
  if (!current) {
    context.stderr.write(`[vitehub] drizzle-kit could not write the snapshot of the current Database Definitions for ${relative(projectRoot, target)}. See the drizzle-kit output above.\n`)
    return 1
  }
  const copied = JSON.parse(await readFile(target, "utf8")) as { id: string, prevIds: string[] }
  await writeFile(target, JSON.stringify({ ...current, id: copied.id, prevIds: copied.prevIds }, null, 2))
  return 0
}

/** Reports whether the newest snapshot of a SQLite folder lists a `.unique()` column of Drizzle Kit 0.x as an index. */
async function hasUnrecordedUniques(migrationsDir: string): Promise<boolean> {
  // Contributed SQL folders can have no snapshot, so read the newest folder that has one.
  const file = (await listMigrationFolders(migrationsDir)).sort().reverse().map(folder => join(migrationsDir, folder, "snapshot.json")).find(existsSync)
  if (!file) return false
  const snapshot = JSON.parse(await readFile(file, "utf8")) as Partial<SqliteSnapshot>
  if (!Array.isArray(snapshot.ddl)) return false
  const { hasKit0UniqueIndexes } = await import("./internal/snapshot-uniques.ts")
  return hasKit0UniqueIndexes({ ddl: snapshot.ddl })
}

/**
 * After `drizzle-kit up` on a SQLite folder, records the unique indexes that Drizzle Kit 0.x wrote for `.unique()`
 * columns as the UNIQUE constraints of the current Definitions, so the next `generate` does not rebuild these tables.
 */
async function recordConvertedUniques(
  context: ViteHubCliContext,
  { bin, configFile, database, migrationsDir, projectRoot }: { bin: string, configFile: string, database: string, migrationsDir: string, projectRoot: string },
): Promise<void> {
  const schema = await readSchemaSnapshot(context, { bin, configFile, projectRoot })
  if (!Array.isArray(schema?.ddl)) {
    context.stderr.write(`[vitehub] Database "${database}": drizzle-kit could not read the current Database Definitions, so the converted snapshots keep each \`.unique()\` column of Drizzle Kit 0.x as a unique index. If the next \`vitehub database generate\` rebuilds tables only to add UNIQUE constraints, declare these columns with \`uniqueIndex()\` and the index names of the old migrations.\n`)
    return
  }
  const { recordUniqueIndexesAsConstraints } = await import("./internal/snapshot-uniques.ts")
  let replaced = 0
  for (const folder of await listMigrationFolders(migrationsDir)) {
    const file = join(migrationsDir, folder, "snapshot.json")
    if (!existsSync(file)) continue
    const snapshot = JSON.parse(await readFile(file, "utf8")) as { ddl: Parameters<typeof recordUniqueIndexesAsConstraints>[0]["ddl"] }
    const count = recordUniqueIndexesAsConstraints(snapshot, schema as typeof snapshot)
    if (!count) continue
    replaced = Math.max(replaced, count)
    await writeFile(file, JSON.stringify(snapshot, null, 2))
  }
  if (replaced) context.stdout.write(`[vitehub] Database "${database}": the snapshots record ${replaced} unique ${replaced === 1 ? "index" : "indexes"} of \`.unique()\` columns as UNIQUE constraints, as Drizzle Kit 1.0 declares them. The database keeps its indexes.\n`)
}

function writeMigrationPlan(plan: MigrationPlan, context: ViteHubCliContext) {
  const count = plan.pending.length
  const lines = [`[vitehub] Database "${plan.database}" (${plan.target}): ${count ? `${count} pending ${count === 1 ? "migration" : "migrations"}.` : "no pending migrations."}`]
  for (const from of new Set(plan.adopted.map(migration => migration.from))) {
    const names = plan.adopted.filter(migration => migration.from === from).map(migration => migration.name)
    lines.push(`  Applied before, as ${from} lists: ${names.join(", ")}`)
  }
  for (const migration of plan.pending) {
    lines.push("", `  ${migration.name}`)
    for (const statement of migration.statements) lines.push(...statement.split("\n").map(line => `    ${line}`))
    for (const loss of migration.dataLoss) lines.push(`    ! Data loss: ${loss.reason}.`)
  }
  context.stdout.write(`${lines.join("\n")}\n`)
}

async function migrateSplitSqliteDatabase(
  database: ResolvedDrizzleDatabaseConfig,
  args: string[],
  context: ViteHubCliContext,
  { bin, configFile, projectRoot }: { bin: string, configFile: string, projectRoot: string },
): Promise<number | undefined> {
  const { migrateSplitSqlite } = await import("./internal/migration-plan.ts")
  const env = context.env ?? process.env
  try {
    return await migrateSplitSqlite(
      { ...database, migrationsDir: resolve(projectRoot, database.migrationsDir) },
      { env, projectRoot },
      async () => {
        const result = await context.spawn(process.execPath, [bin, "check", "--config", configFile, ...forwardDrizzleArgs(args)], {
          cwd: projectRoot,
          env: withDrizzleKitErrorExit(env),
          stderr: "inherit",
          stdout: "inherit",
        })
        if (result.exitCode === 0) return true
        context.stderr.write(`[vitehub] drizzle-kit check failed for ${configFile} (exit code ${result.exitCode ?? 1}). See the drizzle-kit output above.\n`)
        return false
      },
      name => context.stdout.write(`[vitehub] Database "${database.name}": applied ${name}.\n`),
    )
  }
  catch (error) {
    context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
    return 1
  }
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
    : [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: "default", problem: "ViteHub has no resolved Database config. Run the command in a project that uses `hubDatabase()`." }), undefined]
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
    migration => writeAdopted(database.name, migration, context),
  )
  if (problem) {
    context.stderr.write(isRuntimeDiagnostic(problem)
      ? `${formatRuntimeDiagnosticError(problem)}\n`
      : `[vitehub] D1 migration failed for the database "${database.name}". ${problem instanceof Error ? problem.message : String(problem)}\n`)
    return 1
  }
  context.stdout.write(`[vitehub] Database "${database.name}": D1 migrations are up to date.\n`)
  return 0
}

function writeAdopted(database: string, migration: AdoptedMigration, context: ViteHubCliContext) {
  context.stdout.write(`[vitehub] Database "${database}": recorded ${migration.name} as applied, as ${migration.from} lists it.\n`)
}

/** Records the migrations that another ledger lists in Drizzle's ledger of a SQLite or libSQL database. Returns the exit code. */
async function adoptSqliteMigrations(database: ResolvedDrizzleDatabaseConfig, projectRoot: string, context: ViteHubCliContext): Promise<number> {
  const { adoptSqliteMigrations: adopt } = await import("./internal/migration-plan.ts")
  const error = await adopt(
    { ...database, migrationsDir: resolve(projectRoot, database.migrationsDir) },
    { env: context.env ?? process.env, projectRoot },
    migration => writeAdopted(database.name, migration, context),
  )
  if (error) {
    context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
    return 1
  }
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
async function ensureLocalDatabaseDirectory(database: ResolvedDrizzleDatabaseConfig, projectRoot: string, context: ViteHubCliContext) {
  const env = context.env ?? process.env
  if (database.dialect === "postgresql") return
  if (database.cloudflare?.http && database.cloudflare.databaseId) return
  const url = resolveConfigValue(database.connection?.url, env)
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

// Drizzle Kit asks rename-or-create questions only when its stdin is a terminal.
function generateCanAsk(env: NodeJS.ProcessEnv): boolean {
  if (env.CI && env.CI !== "0" && env.CI !== "false") return false
  return !!process.stdin.isTTY
}

function generateRetry(args: string[]): { command: string, hints: unknown[], hintsFile?: string } {
  const command = ["vitehub database generate"]
  let hints: unknown[] = []
  let hintsFile: string | undefined
  for (let index = 0; index < args.length; index++) {
    const [, option, inline] = /^(--hints(?:-file)?)(?:=(.*))?$/s.exec(args[index]!) ?? []
    if (!option) {
      const arg = args[index]!
      command.push(/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)
      continue
    }
    const value = inline ?? args[++index] ?? ""
    if (option === "--hints-file") hintsFile = value
    else hints = JSON.parse(value) as unknown[]
  }
  return { command: command.join(" "), hints, ...(hintsFile ? { hintsFile } : {}) }
}

const drizzleKitMissingHintsExitCode = 2

// `--explain --output json` writes no migration and prints the unanswered questions as JSON.
async function readAmbiguousChanges(
  args: string[],
  context: ViteHubCliContext,
  { bin, configFile, projectRoot }: { bin: string, configFile: string, projectRoot: string },
): Promise<Array<{ entity: string[], kind: string }>> {
  const result = await context.spawn(process.execPath, [bin, "generate", "--config", configFile, ...forwardDrizzleArgs(args), "--explain", "--output", "json"], {
    cwd: projectRoot,
    env: context.env ?? process.env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  })
  const line = result.stdout?.split("\n").findLast(line => line.startsWith("{"))
  if (!line) return []
  const output = JSON.parse(line) as { status?: string, unresolved?: Array<{ entity?: string[], kind?: string, type?: string }> }
  return (output.unresolved ?? []).flatMap(item => item.type === "rename_or_create" && item.kind && item.entity ? [{ entity: item.entity, kind: item.kind }] : [])
}

async function runDrizzleKitWithConfig(
  feature: "generate" | "migrate",
  args: string[],
  context: ViteHubCliContext,
  { bin, configFile, database, projectRoot }: { bin: string, configFile: string, database: string, projectRoot: string },
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
    ...(feature === "generate" && !generateCanAsk(env) ? { stdin: "ignore" as const } : {}),
    stdout: "inherit",
  })
  const exitCode = result.exitCode ?? 1
  if (feature === "generate" && exitCode === drizzleKitMissingHintsExitCode) {
    const changes = await readAmbiguousChanges(args, context, { bin, configFile, projectRoot })
    context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_GENERATE_AMBIGUOUS_CHANGE({ changes, database, ...generateRetry(args) }))}\n`)
    return exitCode
  }
  if (exitCode !== 0) {
    context.stderr.write(`[vitehub] drizzle-kit ${feature} failed for ${configFile} (exit code ${exitCode}). See the drizzle-kit output above.\n`)
  }
  return exitCode
}

export function createDbCliContributor(
  options?: false | Exclude<DatabaseOptions, false>["cli"],
  getConfig?: ResolvedDBViteConfigProvider,
  /** Import aliases of the host, such as Vite `resolve.alias`, for the seed file. */
  getAlias?: () => Record<string, string> | undefined,
  io: DbCliIo = {},
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

  if (options?.sql !== false) {
    features.push({
      description: "Run SQL on a database and print the rows.",
      name: "sql",
      run: async (args, context) => {
        if (args.includes("-h") || args.includes("--help")) {
          writeSqlUsage(context)
          return 0
        }
        return await runSql(args, context, getConfig, io)
      },
      usage: sqlUsage,
    })
  }

  if (options?.drop !== false) {
    features.push({
      description: "Drop every table of a database, and its migrations table.",
      name: "drop",
      run: async (args, context) => {
        if (args.includes("-h") || args.includes("--help")) {
          writeDropUsage(context)
          return 0
        }
        return await runDrop(args, context, getConfig, io)
      },
      usage: dropUsage,
    })
  }

  if (options?.reset !== false) {
    features.push({
      description: "Drop every table of a database, then apply its migrations again.",
      name: "reset",
      run: async (args, context) => {
        if (args.includes("-h") || args.includes("--help")) {
          writeResetUsage(context)
          return 0
        }
        return await runReset(args, context, getConfig, io)
      },
      usage: resetUsage,
    })
  }

  return {
    namespaces: [{
      description: "Database development workflows.",
      features,
      name: "database",
    }],
    ...(options?.seed === false
      ? {}
      : { seeds: [{ files: "server/databases/<name>/seed.ts", name: "database", run: async (seedOptions, context) => await runSeed(seedOptions, context, getConfig, getAlias) }] }),
  } satisfies SharedViteHubCliContributor
}
