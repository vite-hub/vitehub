import { resolveAgentEvalOptions, withAgentEvalSetupFile, writeAgentEvaliteConfig, type ResolvedAgentEvalOptions } from "./internal/evalite-config.ts"

import type { AgentEvalOptions } from "./types.ts"

interface AgentEvaliteRunnerOptions extends ResolvedAgentEvalOptions {
  cacheEnabled?: boolean
  cwd: string
  mode: "run-once-and-exit" | "watch-for-file-changes"
  outputPath?: string
  path?: string
  scoreThreshold?: number
}

type EvaliteRunner = (options: AgentEvaliteRunnerOptions) => Promise<{ exitCode?: number } | void>
type AgentEvaliteConfigWriter = (rootDir: string, options: ResolvedAgentEvalOptions) => Promise<string>

interface AgentCliContext {
  cwd: string
  env: NodeJS.ProcessEnv
  rootDir: string
  spawn?: unknown
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface AgentCliContributor {
  namespaces: Array<{
    description?: string
    features: Array<{
      description?: string
      name: string
      run: (args: string[], context: AgentCliContext) => Promise<number | void> | number | void
      usage?: string
    }>
    name: string
  }>
}

interface ParsedEvalArgs {
  help: boolean
  hideTable?: boolean
  noCache?: boolean
  outputPath?: string
  path?: string
  threshold?: number
  watch: boolean
}

function writeUsage(context: AgentCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent eval [path] [--watch] [--threshold <score>] [--output <path>] [--hide-table] [--no-cache]",
    "",
    "Runs discovered ViteHub Agent Evals with ViteHub defaults.",
    "",
    "Arguments:",
    "  path         Optional eval file path filter.",
    "",
    "Options:",
    "  --watch              Run Evalite in watch mode.",
    "  --threshold <score>  Fail when the score is below the threshold.",
    "  --output <path>      Write Evalite JSON results to a file.",
    "  --hide-table         Hide Evalite's detailed table output.",
    "  --no-cache           Disable Evalite model output caching.",
    "  -h, --help           Show this help.",
    "",
  ].join("\n"))
}

function readOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`)
  }
  return value
}

function parseEvalArgs(args: string[]): ParsedEvalArgs {
  const parsed: ParsedEvalArgs = {
    help: false,
    watch: false,
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
      continue
    }
    if (arg === "--watch" || arg === "watch") {
      parsed.watch = true
      continue
    }
    if (arg === "--hide-table") {
      parsed.hideTable = true
      continue
    }
    if (arg === "--no-cache") {
      parsed.noCache = true
      continue
    }
    if (arg === "--threshold") {
      const value = readOptionValue(args, index, arg)
      const threshold = Number.parseFloat(value)
      if (!Number.isFinite(threshold)) {
        throw new Error("--threshold must be a number.")
      }
      parsed.threshold = threshold
      index++
      continue
    }
    if (arg.startsWith("--threshold=")) {
      const threshold = Number.parseFloat(arg.slice("--threshold=".length))
      if (!Number.isFinite(threshold)) {
        throw new Error("--threshold must be a number.")
      }
      parsed.threshold = threshold
      continue
    }
    if (arg === "--output" || arg === "--outputPath") {
      parsed.outputPath = readOptionValue(args, index, arg)
      index++
      continue
    }
    if (arg.startsWith("--output=")) {
      parsed.outputPath = arg.slice("--output=".length)
      continue
    }
    if (arg.startsWith("--outputPath=")) {
      parsed.outputPath = arg.slice("--outputPath=".length)
      continue
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}.`)
    }
    if (!parsed.path) {
      parsed.path = arg
      continue
    }
    throw new Error(`Unexpected argument: ${arg}.`)
  }

  return parsed
}

async function loadEvaliteRunner(): Promise<EvaliteRunner> {
  const { runAgentEvalite } = await import("./evalite-runner.js")
  return runAgentEvalite
}

export async function runAgentEvalCli(
  args: string[],
  context: AgentCliContext,
  options: false | AgentEvalOptions | undefined,
  runner?: EvaliteRunner,
  writeConfig: AgentEvaliteConfigWriter = writeAgentEvaliteConfig,
): Promise<number> {
  const resolvedOptions = resolveAgentEvalOptions(options)
  if (resolvedOptions === false) {
    context.stderr.write("Agent eval CLI is disabled by the Agent integration.\n")
    return 1
  }

  let parsed: ParsedEvalArgs
  try {
    parsed = parseEvalArgs(args)
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writeUsage(context)
    return 1
  }

  if (parsed.help) {
    writeUsage(context)
    return 0
  }

  const run = runner || await loadEvaliteRunner()
  const runOptions = withAgentEvalSetupFile(context.rootDir, resolvedOptions)
  await writeConfig(context.rootDir, runOptions)
  const result = await run({
    cache: runOptions.cache,
    cacheEnabled: parsed.noCache ? false : undefined,
    cwd: context.rootDir,
    forceRerunTriggers: runOptions.forceRerunTriggers,
    hideTable: parsed.hideTable ?? runOptions.hideTable,
    maxConcurrency: runOptions.maxConcurrency,
    mode: parsed.watch ? "watch-for-file-changes" : "run-once-and-exit",
    outputPath: parsed.outputPath,
    path: parsed.path,
    scoreThreshold: parsed.threshold ?? runOptions.scoreThreshold,
    server: runOptions.server,
    setupFiles: runOptions.setupFiles,
    testTimeout: runOptions.testTimeout,
    trialCount: runOptions.trialCount,
  })

  return result?.exitCode ?? 0
}

export function createAgentCliContributor(options?: false | AgentEvalOptions): AgentCliContributor | undefined {
  if (options === false) return
  return {
    namespaces: [{
      description: "Agent development workflows.",
      features: [{
        description: "Run ViteHub Agent Evals.",
        name: "eval",
        run: async (args, context) => await runAgentEvalCli(args, context, options),
        usage: "vitehub agent eval [path] [--watch]",
      }],
      name: "agent",
    }],
  }
}
