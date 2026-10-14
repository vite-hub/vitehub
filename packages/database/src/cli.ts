import { mkdir } from "node:fs/promises"
import { delimiter, join } from "node:path"

import type { DBModulePublicOptions } from "./types.ts"
import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "./types.ts"
import type { ViteHubCliContributor as SharedViteHubCliContributor } from "@vite-hub/internal/cli"

import { dirname, isAbsolute, relative, resolve } from "pathe"

import { resolveConfigValue } from "./config-value.ts"
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
    "Usage: vitehub db migrate",
    "",
    "Refreshes ViteHub database artifacts and applies Drizzle migrations.",
    "",
  ].join("\n"))
}

function forwardDrizzleArgs(args: string[]) {
  return args.filter(arg => arg !== "-h" && arg !== "--help")
}

function toConfigPath(rootDir: string, file: string): string {
  return isAbsolute(file) ? relative(rootDir, file) || file : file
}

function withProjectBinPath(rootDir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") || "PATH"
  const processPathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") || "PATH"
  return {
    ...env,
    [pathKey]: [join(rootDir, "node_modules", ".bin"), env[pathKey] ?? process.env[processPathKey]].filter(Boolean).join(delimiter),
  }
}

async function runDrizzleKit(
  feature: "generate" | "migrate",
  args: string[],
  context: ViteHubCliContext,
  getConfig?: ResolvedDBViteConfigProvider,
): Promise<number> {
  const config = await getConfig?.({ strict: feature === "generate" })
  const runs = config && config.databaseNames.length > 1
    ? config.databaseNames.map(name => ({ configFile: config.generatedDrizzleConfigFilesByDatabase[name]!, database: config.databases?.[name] }))
    : [{ configFile: config?.generatedDrizzleConfigFile ?? ".vitehub/database/drizzle.config.ts", database: config?.databases?.[config.databaseNames[0]!] }]

  for (const { configFile, database } of runs) {
    if (feature === "migrate" && database) await ensureLocalSqliteDirectory(database, context)
    const result = await runDrizzleKitWithConfig(feature, args, context, toConfigPath(context.rootDir, configFile))
    if (result !== 0) return result
  }
  return 0
}

/** libSQL does not create parent directories, so the first `db migrate` needs the local data directory to exist. */
async function ensureLocalSqliteDirectory(database: ResolvedDrizzleDatabaseConfig, context: ViteHubCliContext) {
  if (database.cloudflare?.http && database.cloudflare.databaseId) return
  const url = resolveConfigValue(database.connection?.url, context.env ?? process.env)
  if (!url || url === ":memory:" || /^(?:libsql:|https?:|wss?:)/i.test(url)) return
  const path = resolveLocalSqlitePath(url)
  if (!path || path === ":memory:") return
  await mkdir(dirname(resolve(context.rootDir, path)), { recursive: true })
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

async function runDrizzleKitWithConfig(feature: "generate" | "migrate", args: string[], context: ViteHubCliContext, configFile: string): Promise<number> {
  const drizzleArgs = [
    feature,
    "--config",
    configFile,
    ...forwardDrizzleArgs(args),
  ]
  const env = withProjectBinPath(context.rootDir, context.env)
  const result = await context.spawn("drizzle-kit", drizzleArgs, {
    cwd: context.rootDir,
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
      description: "Apply database migrations.",
      name: "migrate",
      run: async (args, context) => {
        if (args.includes("-h") || args.includes("--help")) {
          writeMigrateUsage(context)
          return 0
        }
        return await runDrizzleKit("migrate", args, context, getConfig)
      },
      usage: "vitehub db migrate",
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
