import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { findPackageJSON } from "node:module"
import { pathToFileURL } from "node:url"

import type { DBModulePublicOptions } from "./types.ts"
import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "./types.ts"
import type { ViteHubCliContributor as SharedViteHubCliContributor } from "@vite-hub/internal/cli"
import type { MigrationPlan } from "./internal/migration-plan.ts"

import { dirname, isAbsolute, relative, resolve } from "pathe"

import { formatRuntimeDiagnosticError } from "@vite-hub/runtime"

import { resolveConfigValue } from "./config-value.ts"
import { databaseErrorDiagnostics } from "./error-diagnostics.ts"
import { resolveLocalSqlitePath } from "./runtime/local-path.ts"

/** Refreshes generated artifacts. `strict` fails when a Database Definition cannot load to list its tables. */
type ResolvedDBViteConfigProvider = (options: { strict: boolean }) => MaybePromise<ResolvedDBViteConfig | undefined>
type MaybePromise<T> = Promise<T> | T

interface ViteHubCliContext {
  env?: NodeJS.ProcessEnv
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
    "Usage: vitehub db generate [--name <name>] [--custom]",
    "",
    "Refreshes ViteHub database artifacts and generates Drizzle migrations.",
    "",
    "Options:",
    "  --name <name>  Custom migration name.",
    "  --custom       Generate an empty custom migration.",
    "  -h, --help     Show this help.",
    "",
  ].join("\n"))
}

function writeMigrateUsage(context: ViteHubCliContext): void {
  context.stdout.write([
    "Usage: vitehub db migrate [--dry-run] [--allow-data-loss]",
    "",
    "Refreshes ViteHub database artifacts and applies pending Drizzle migrations.",
    "It first reads the applied migrations from the database. It refuses pending",
    "migrations that drop tables or columns or delete rows.",
    "",
    "Options:",
    "  --dry-run          Print the pending migrations and their SQL. Change nothing.",
    "  --allow-data-loss  Apply migrations that lose data. Skips the check.",
    "  -h, --help         Show this help.",
    "",
  ].join("\n"))
}

const migrateFlags = new Set(["--allow-data-loss", "--dry-run"])

function forwardDrizzleArgs(args: string[]) {
  return args.filter(arg => arg !== "-h" && arg !== "--help" && !migrateFlags.has(arg))
}

function toConfigPath(rootDir: string, file: string): string {
  return isAbsolute(file) ? relative(rootDir, file) || file : file
}

/** Finds the drizzle-kit bin file in the dependencies of the project, so the command does not depend on PATH. */
function resolveDrizzleKitBin(projectRoots: string[]): string | undefined {
  for (const projectRoot of projectRoots) {
    const drizzleKitBin = resolveDrizzleKitBinFromRoot(projectRoot)
    if (drizzleKitBin) return drizzleKitBin
  }
  return undefined
}

function resolveDrizzleKitBinFromRoot(projectRoot: string): string | undefined {
  let packageJsonFile: string | undefined
  try {
    packageJsonFile = findPackageJSON("drizzle-kit", pathToFileURL(resolve(projectRoot, "package.json")))
  }
  catch {
    return
  }
  if (!packageJsonFile) return
  const { bin } = JSON.parse(readFileSync(packageJsonFile, "utf8")) as { bin?: string | Record<string, string> }
  const file = typeof bin === "string" ? bin : bin?.["drizzle-kit"]
  return file ? resolve(dirname(packageJsonFile), file) : undefined
}

async function runDrizzleKit(
  feature: "generate" | "migrate",
  args: string[],
  context: ViteHubCliContext,
  getConfig?: ResolvedDBViteConfigProvider,
): Promise<number> {
  const config = await getConfig?.({ strict: feature === "generate" })
  // Drizzle Kit resolves `out` and the SQLite URL from its working directory, and the Database writes them relative to its
  // project root. In Nuxt the Vite root is `srcDir` (`app/`), so `context.rootDir` is not the project root.
  const projectRoot = config?.rootDir ?? context.rootDir
  // Prefer the Database root because the generated config and working directory
  // belong to it. Fall back to the invoking Vite root for external Database roots.
  const drizzleKitBin = resolveDrizzleKitBin([projectRoot, context.rootDir])
  if (!drizzleKitBin) {
    context.stderr.write(`[vitehub] Cannot find drizzle-kit in the dependencies of ${projectRoot}. Install it, for example with \`pnpm add -D drizzle-kit\`.\n`)
    return 1
  }
  const runs = config && config.databaseNames.length > 1
    ? config.databaseNames.map(name => ({ configFile: config.generatedDrizzleConfigFilesByDatabase[name]!, database: config.databases?.[name] }))
    : [{ configFile: config?.generatedDrizzleConfigFile ?? ".vitehub/database/drizzle.config.ts", database: config?.databases?.[config.databaseNames[0]!] }]

  const dryRun = feature === "migrate" && args.includes("--dry-run")
  const allowDataLoss = args.includes("--allow-data-loss")
  if (feature === "migrate" && (dryRun || !allowDataLoss)) {
    // Check every Database before the first one changes, so a refusal leaves all of them as they were.
    let exitCode = 0
    for (const { database } of runs) {
      exitCode = Math.max(exitCode, await checkPendingMigrations(database, projectRoot, context, { allowDataLoss, dryRun }))
    }
    if (dryRun) context.stdout.write("[vitehub] Dry run. No changes were made.\n")
    if (exitCode !== 0 || dryRun) return exitCode
  }
  for (const { configFile, database } of runs) {
    if (feature === "migrate" && database) await ensureLocalSqliteDirectory(database, projectRoot, context)
    const result = await runDrizzleKitWithConfig(feature, args, context, { bin: drizzleKitBin, configFile: toConfigPath(projectRoot, configFile), projectRoot })
    if (result !== 0) return result
  }
  return 0
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
): Promise<number> {
  // Keep the database driver and migration inspector out of config-time imports.
  // The CLI contributor is loaded while Vite resolves the project config.
  const { readMigrationPlan } = await import("./internal/migration-plan.ts")
  const [error, plan] = database
    ? await readMigrationPlan(database, { env: context.env ?? process.env, projectRoot })
    : [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: "default", problem: "ViteHub has no resolved Database config. Run the command in a project that uses `hubDb()`." }), undefined]
  if (error) {
    context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
    if (!dryRun) context.stderr.write("[vitehub] To apply the migrations without the check, run `vitehub db migrate --allow-data-loss`.\n")
    return 1
  }
  if (dryRun) writeMigrationPlan(plan, context)
  const losses = plan.pending.flatMap(migration => migration.dataLoss.map(loss => `${migration.name}: ${loss.reason}: ${loss.statement}`))
  if (losses.length && !allowDataLoss) {
    context.stderr.write(`${formatRuntimeDiagnosticError(databaseErrorDiagnostics.DATABASE_MIGRATION_DATA_LOSS({ database: plan.database, statements: losses }))}\n`)
    return 1
  }
  return 0
}

/** libSQL does not create parent directories, so the first `db migrate` needs the local data directory to exist. */
async function ensureLocalSqliteDirectory(database: ResolvedDrizzleDatabaseConfig, projectRoot: string, context: ViteHubCliContext) {
  if (database.cloudflare?.http && database.cloudflare.databaseId) return
  const url = resolveConfigValue(database.connection?.url, context.env ?? process.env)
  if (!url || url === ":memory:" || /^(?:libsql:|https?:|wss?:)/i.test(url)) return
  const path = resolveLocalSqlitePath(url)
  if (!path || path === ":memory:") return
  await mkdir(dirname(resolve(projectRoot, path)), { recursive: true })
}

// drizzle-kit generate catches schema load and diff errors, logs them with console.error, and exits 0.
// This preload turns a logged Error into a non-zero exit code so `vitehub db generate` cannot report success.
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
  options?: false | Exclude<DBModulePublicOptions, false>["cli"],
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
      usage: "vitehub db generate [--name <name>] [--custom]",
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
      usage: "vitehub db migrate [--dry-run] [--allow-data-loss]",
    })
  }

  return {
    namespaces: [{
      description: "Database development workflows.",
      features,
      name: "db",
    }],
  } satisfies SharedViteHubCliContributor
}
