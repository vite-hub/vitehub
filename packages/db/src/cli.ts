import type { DBModulePublicOptions } from "./types.ts"
import type { ResolvedDBViteConfig } from "./types.ts"

import { isAbsolute, relative } from "pathe"

interface ViteHubCliContext {
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

type ResolvedDBViteConfigProvider = () => MaybePromise<ResolvedDBViteConfig | undefined>
type MaybePromise<T> = Promise<T> | T

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

async function runDrizzleKit(
  feature: "generate" | "migrate",
  args: string[],
  context: ViteHubCliContext,
  getConfig?: ResolvedDBViteConfigProvider,
): Promise<number> {
  const config = await getConfig?.()
  const configFiles = config && config.databaseNames.length > 1
    ? config.databaseNames.map(name => config.generatedDrizzleConfigFilesByDatabase[name]!)
    : [config?.generatedDrizzleConfigFile ?? ".vitehub/db/drizzle.config.ts"]

  for (const configFile of configFiles) {
    const result = await runDrizzleKitWithConfig(feature, args, context, toConfigPath(context.rootDir, configFile))
    if (result !== 0) return result
  }
  return 0
}

async function runDrizzleKitWithConfig(feature: "generate" | "migrate", args: string[], context: ViteHubCliContext, configFile: string): Promise<number> {
  const drizzleArgs = [
    feature,
    "--config",
    configFile,
    ...forwardDrizzleArgs(args),
  ]
  const result = await context.spawn("pnpm", ["exec", "drizzle-kit", ...drizzleArgs], {
    cwd: context.rootDir,
    stderr: "inherit",
    stdout: "inherit",
  })
  return result.exitCode ?? 1
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
  }
}
