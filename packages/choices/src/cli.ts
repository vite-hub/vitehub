import { readdir, readFile, stat } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { parseArgs } from "node:util"

import { withStdoutOnStderr } from "@vite-hub/internal/cli"
import { loadAllEnv } from "@vite-hub/internal/vite-stage"

import { choicesDiagnostics } from "./diagnostics.ts"
import type { ViteHubCliCommandNamespace, ViteHubCliContext, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { ChoicesError, ChoicesPlan, ChoicesResult } from "./types.ts"

const listUsage = "vitehub choices list [--json]"
const runUsage = "vitehub choices run <file> <text> [--export <name>] [--context <json>] [--inspect]"

type CliContext = Pick<ViteHubCliContext, "env" | "rootDir"> & ViteHubCliStreams

interface LoadedChoices {
  inspect: (text: string, request?: { context?: unknown }) => Promise<ChoicesResult<ChoicesPlan>>
  name: string | undefined
  resolve: (text: string, request?: { context?: unknown }) => Promise<ChoicesResult<unknown>>
}

interface FoundChoices {
  export: string
  name: string | undefined
}

interface ListedFile {
  choices: FoundChoices[]
  error?: string
  file: string
}

const sourceExtensions = /\.(?:[cm]?[jt]s)$/
const testFiles = /\.(?:test|spec)\.[cm]?[jt]s$/
const skippedDirectories = new Set(["__tests__", "build", "coverage", "dist", "node_modules", "test", "tests"])
const definesChoices = /\bdefineChoices\s*\(/

function isChoices(value: unknown): value is LoadedChoices {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "resolve") === "function"
    && typeof Reflect.get(value, "inspect") === "function"
}

function choicesOf(module: Record<string, unknown>): Array<FoundChoices & { choices: LoadedChoices }> {
  return Object.entries(module).flatMap(([key, value]) => isChoices(value) ? [{ choices: value, export: key, name: value.name }] : [])
}

async function loadModule(file: string, rootDir: string): Promise<Record<string, unknown>> {
  const { runnerImport } = await import("vite")
  const { module } = await runnerImport<Record<string, unknown>>(file, { configFile: false, logLevel: "silent", root: rootDir })
  return module
}

async function loadProjectEnv(context: CliContext): Promise<void> {
  const { loadEnv } = await import("vite")
  const mode = context.env.NODE_ENV === "production" ? "production" : "development"
  for (const [key, value] of Object.entries(loadAllEnv(loadEnv, mode, context.rootDir))) {
    if (process.env[key] === undefined) process.env[key] = value
  }
}

async function findSourceFiles(directory: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await findSourceFiles(path, found)
    else if (entry.isFile() && sourceExtensions.test(entry.name) && !testFiles.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(path)
  }
  return found
}

/** Finds the files that name `defineChoices()`, then loads each one to read its exports. There is no registry. */
export async function listChoices(rootDir: string): Promise<ListedFile[]> {
  const listed: ListedFile[] = []
  for (const path of (await findSourceFiles(rootDir)).sort()) {
    if (!definesChoices.test(await readFile(path, "utf8"))) continue
    const file = relative(rootDir, path)
    try {
      const choices = choicesOf(await loadModule(path, rootDir)).map(({ export: name, name: label }) => ({ export: name, name: label }))
      if (choices.length) listed.push({ choices, file })
    }
    catch (error) {
      listed.push({ choices: [], error: error instanceof Error ? error.message : String(error), file })
    }
  }
  return listed
}

function printTable(rows: string[][], stdout: ViteHubCliStreams["stdout"]): void {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  for (const row of rows) stdout.write(`${row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()}\n`)
}

async function runList(args: string[], context: CliContext): Promise<number> {
  const { values } = parseArgs({ args, allowPositionals: false, options: { json: { type: "boolean" } }, strict: true })
  const files = await withStdoutOnStderr(() => listChoices(context.rootDir), context.stderr)
  if (values.json) {
    context.stdout.write(`${JSON.stringify({ files }, null, 2)}\n`)
    return files.some(file => file.error) ? 1 : 0
  }
  if (!files.length) {
    context.stdout.write("No file exports the result of defineChoices().\n")
    return 0
  }
  const rows = [["FILE", "EXPORT", "NAME"]]
  for (const file of files) {
    if (file.error) rows.push([file.file, "!", `failed to load: ${file.error.split("\n", 1)[0]}`])
    else for (const choices of file.choices) rows.push([file.file, choices.export, choices.name ?? "-"])
  }
  printTable(rows, context.stdout)
  context.stdout.write(`\nRun one with: vitehub choices run ${files.find(file => file.choices.length)?.file ?? "<file>"} "<text>"\n`)
  return files.some(file => file.error) ? 1 : 0
}

function parseContext(value: string | undefined): { context?: unknown } {
  if (value === undefined) return {}
  try {
    return { context: JSON.parse(value) }
  }
  catch {
    throw choicesDiagnostics.DECISIONS_CLI_ARGUMENTS_INVALID({ problem: `--context must be JSON, such as '{"tenantId":"t1"}'.` })
  }
}

function errorJson(error: ChoicesError): string {
  return `${JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2)}\n`
}

async function runOne(args: string[], context: CliContext): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { context: { type: "string" }, export: { type: "string" }, inspect: { type: "boolean" } },
    strict: true,
  })
  const [file, ...words] = positionals
  const text = words.join(" ")
  if (!file || !text) throw choicesDiagnostics.DECISIONS_CLI_ARGUMENTS_INVALID({ problem: `Give a file and a text. Usage: ${runUsage}` })
  const request = parseContext(values.context)
  const path = resolve(context.rootDir, file)
  if (!(await stat(path).catch(() => undefined))?.isFile()) throw choicesDiagnostics.DECISIONS_CLI_CHOICES_NOT_FOUND({ problem: `${file} is not a file. Run vitehub choices list to find the files that call defineChoices().` })

  const found = await withStdoutOnStderr(async () => {
    await loadProjectEnv(context)
    return choicesOf(await loadModule(path, context.rootDir))
  }, context.stderr)
  const names = found.map(item => item.export).join(", ")
  const chosen = values.export === undefined ? found : found.filter(item => item.export === values.export)
  if (!found.length) throw choicesDiagnostics.DECISIONS_CLI_CHOICES_NOT_FOUND({ problem: `${file} has no export from defineChoices().` })
  if (!chosen.length) throw choicesDiagnostics.DECISIONS_CLI_CHOICES_NOT_FOUND({ problem: `${file} has no export "${values.export}". Its exports from defineChoices() are: ${names}.` })
  if (chosen.length > 1) throw choicesDiagnostics.DECISIONS_CLI_ARGUMENTS_INVALID({ problem: `${file} has several exports from defineChoices(): ${names}. Pick one with --export.` })

  const choices = chosen[0]!.choices
  const [error, data] = await withStdoutOnStderr(() => values.inspect ? choices.inspect(text, request) : choices.resolve(text, request), context.stderr)
  if (error) {
    context.stdout.write(errorJson(error))
    return 1
  }
  context.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
  return 0
}

function cliFix(error: unknown): string | undefined {
  return choicesDiagnostics.is(error) && error.code.startsWith("DECISIONS_CLI_") ? error.fix : undefined
}

function guard(usage: string, run: (args: string[], context: CliContext) => Promise<number>) {
  return async (args: string[], context: CliContext): Promise<number> => {
    if (args.includes("-h") || args.includes("--help")) {
      context.stdout.write(`Usage: ${usage}\n`)
      return 0
    }
    try {
      return await run(args, context)
    }
    catch (error) {
      const fix = cliFix(error)
      if (fix === undefined && !(error instanceof TypeError && "code" in error)) throw error
      context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${fix ? `Fix: ${fix}\n` : `Usage: ${usage}\n`}`)
      return 1
    }
  }
}

/**
 * The `vitehub choices` commands. They load a Choices file by path and do not load the project config.
 * `run` calls the gateway of the definition, so it reads the same keys as the app, from the shell or the `.env` files.
 */
export function createChoicesCliNamespace(): ViteHubCliCommandNamespace {
  return {
    description: "List the Choices of the app and run one with a text. Does not load the project config.",
    features: [
      {
        description: "List the exports of defineChoices() results, by file.",
        name: "list",
        run: guard(listUsage, runList),
        usage: listUsage,
      },
      {
        description: "Run one Choices definition with a text and print the selection as JSON. --inspect prints the questions without a model call.",
        name: "run",
        run: guard(runUsage, runOne),
        usage: runUsage,
      },
    ],
    name: "choices",
  }
}
