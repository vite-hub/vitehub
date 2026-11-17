import { loadAllEnv, withViteStageEnvironment } from "@vite-hub/internal/vite-stage"

import type { ViteHubCliCommandNamespace, ViteHubCliContext, ViteHubCliSeed, ViteHubCliSeedOptions } from "@vite-hub/internal/cli"

const usage = "vitehub seed [<primitive>...] [--remote [--url <url>]] [--stage <name>] [--database <name>] [--timeout <ms>]"

function writeUsage(seeds: readonly ViteHubCliSeed[], stream: ViteHubCliContext["stdout"]): void {
  stream.write([
    `Usage: ${usage}`,
    "",
    "Writes the seed files of the app: the Database seed files, and the files in server/seed/kv/ and server/seed/blob/.",
    "Without --remote, it writes only local data: the local database, and the KV and Blob stores of the dev server.",
    "Name primitives to seed only them, such as `vitehub seed kv blob`.",
    "",
    "Seed files:",
    ...seeds.length ? seeds.map(seed => `  ${seed.name.padEnd(9)} ${seed.files}`) : ["  None. Turn on Database, KV, or Blob in the ViteHub config."],
    "",
    "Options:",
    "  --remote           Write the deployed data. KV and Blob seeds call the deployed app, with",
    "                     VITEHUB_CONSOLE_PRIVATE_KEY_<NAME> to sign the calls.",
    "  --url <url>        Deployed app URL for --remote. Defaults to `vitehub({ publicUrl })`.",
    "  --stage <name>     Load Vite env files for this mode. Variables from the current process take precedence.",
    "  --database <name>  Seed only this database.",
    "  --timeout <ms>     Request timeout of each call to the app.",
    "  -h, --help         Show this help.",
    "",
  ].join("\n"))
}

interface ParsedSeedArgs {
  database?: string
  help: boolean
  names: string[]
  remote: boolean
  stage?: string
  timeout?: number
  url?: string
}

function parseArgs(args: readonly string[], seeds: readonly ViteHubCliSeed[]): ParsedSeedArgs | string {
  const parsed: ParsedSeedArgs = { help: false, names: [], remote: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
      continue
    }
    if (arg === "--remote") {
      parsed.remote = true
      continue
    }
    const option = (["--database", "--stage", "--timeout", "--url"] as const).find(name => arg === name || arg.startsWith(`${name}=`))
    if (option) {
      const value = arg === option ? args[++index] : arg.slice(option.length + 1)
      if (!value || value.startsWith("-")) return `${option} requires a value.`
      if (option === "--timeout") {
        const timeout = Number(value)
        if (!Number.isSafeInteger(timeout) || timeout <= 0) return "--timeout must be a positive integer of milliseconds."
        parsed.timeout = timeout
      }
      else {
        parsed[option.slice(2) as "database" | "stage" | "url"] = value
      }
      continue
    }
    if (arg.startsWith("-")) return `Unknown option: ${arg}`
    if (!seeds.some(seed => seed.name === arg)) return `Unknown seed: ${arg}. Seeds of this app: ${seeds.map(seed => seed.name).join(", ") || "none"}.`
    if (!parsed.names.includes(arg)) parsed.names.push(arg)
  }
  if (parsed.url && !parsed.remote) return "--url names a deployed app. Add --remote to write its data."
  if (parsed.database && parsed.names.some(name => name !== "database")) return "--database seeds only the Database. Remove the other primitive names."
  return parsed
}

/** Runs the selected seeds in order and stops at the first failure. */
async function runSeeds(seeds: readonly ViteHubCliSeed[], parsed: ParsedSeedArgs, context: ViteHubCliContext): Promise<number> {
  const selected = parsed.names.length || parsed.database
    ? seeds.filter(seed => parsed.names.includes(seed.name) || (parsed.database && seed.name === "database"))
    : seeds
  if (parsed.database && !selected.length) {
    context.stderr.write("[vitehub] --database needs the Database. Turn on Database in the ViteHub config.\n")
    return 1
  }
  let env = { ...context.env }
  return await withViteStageEnvironment(env, async () => {
    if (parsed.stage) {
      const { loadEnv } = await import("vite")
      env = { ...loadAllEnv(loadEnv, parsed.stage, context.rootDir), ...env }
      Object.assign(process.env, env)
    }
    const options: ViteHubCliSeedOptions = {
      env,
      remote: parsed.remote,
      ...(parsed.database ? { database: parsed.database } : {}),
      ...(parsed.timeout ? { timeout: parsed.timeout } : {}),
      ...(parsed.remote && (parsed.url ?? context.publicUrl) ? { url: parsed.url ?? context.publicUrl } : {}),
    }
    const empty: ViteHubCliSeed[] = []
    for (const seed of selected) {
      const code = await seed.run(options, { ...context, env })
      if (code === undefined) empty.push(seed)
      else if (code !== 0) return code
    }
    // A primitive that the command names must have seed files. Without names, only a run that seeds nothing fails.
    const missing = parsed.names.length ? empty : empty.length === selected.length ? empty : []
    if (!missing.length) return 0
    context.stderr.write([
      "[vitehub] Nothing to seed. Add seed files:",
      ...missing.map(seed => `  ${seed.name.padEnd(9)} ${seed.files}`),
      "",
    ].join("\n"))
    return 1
  })
}

/** The `vitehub seed` command, which runs the seeds that the ViteHub plugins contribute. */
export function createSeedNamespace(seeds: readonly ViteHubCliSeed[]): ViteHubCliCommandNamespace {
  return {
    defaultFeature: "seed",
    description: "Write the seed files of Database, KV, and Blob.",
    features: [{
      description: "Write the seed files of Database, KV, and Blob.",
      name: "seed",
      run: async (args, context) => {
        const parsed = parseArgs(args, seeds)
        if (typeof parsed === "string") {
          context.stderr.write(`[vitehub] ${parsed}\n`)
          writeUsage(seeds, context.stderr)
          return 1
        }
        if (parsed.help) {
          writeUsage(seeds, context.stdout)
          return 0
        }
        if (!seeds.length) {
          context.stderr.write("[vitehub] No ViteHub primitive of this app has seed files. Turn on Database, KV, or Blob in the ViteHub config.\n")
          return 1
        }
        return await runSeeds(seeds, parsed, context)
      },
      usage,
    }],
    name: "seed",
  }
}
