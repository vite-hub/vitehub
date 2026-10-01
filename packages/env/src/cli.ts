import * as v from "valibot"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { viteHubEnvServerModulePath } from "@vite-hub/internal/build/vite"
import { withViteStageServer } from "@vite-hub/internal/vite-stage"

import type { ViteStageServerConfig } from "@vite-hub/internal/vite-stage"
import type { ViteHubCliContext, ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ServerEnvInspection, ServerEnvInspectionEntry } from "./types.ts"
import { envErrorDiagnostics } from "./error-diagnostics.ts"
import { isBlockingServerEnvEntry } from "./server.ts"

type EnvCliCommand = "check" | "inspect"

export interface EnvCliInspectInput {
  applicationRoot?: string
  env: NodeJS.ProcessEnv
  rootDir: string
  stage: string
}

export interface EnvCliOptions {
  /** Replaces stage loading in tests. */
  inspect?: (input: EnvCliInspectInput) => Promise<ServerEnvInspection>
  resolveProjectRoot: (viteRoot: string) => string
}

interface ParsedEnvCliArgs {
  help: boolean
  json: boolean
  stage?: string
}

export interface EnvCliReport {
  entries: readonly ServerEnvInspectionEntry[]
  ok: boolean
  stage: string
}

/** CLI discovery resolves Vite config in development mode, so the default stage matches it. */
const defaultEnvCliStage = "development"

function usage(command: EnvCliCommand): string {
  return `vitehub env ${command} [--stage <name>] [--json]`
}

function writeUsage(command: EnvCliCommand, stream: ViteHubCliContext["stdout"]): void {
  stream.write([
    `Usage: ${usage(command)}`,
    "",
    command === "check"
      ? "Checks declared Server Env values. Exits with 1 when loadServerEnv() would fail."
      : "Lists declared Server Env variables and their status. Values are never printed.",
    "",
    "Options:",
    `  --stage <name>  Load Vite env files for this mode. Defaults to ${defaultEnvCliStage}.`,
    "                  Variables from the current process take precedence.",
    "  --json          Print machine-readable output.",
    "  -h, --help      Show this help.",
    "",
  ].join("\n"))
}

function parseArgs(args: string[]): ParsedEnvCliArgs {
  const parsed: ParsedEnvCliArgs = { help: false, json: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--json") parsed.json = true
    else if (arg === "--stage" || arg.startsWith("--stage=")) {
      const value = arg === "--stage" ? args[++index] : arg.slice("--stage=".length)
      if (!value || value.startsWith("-")) throw envErrorDiagnostics.ENV_R0025({ message: "--stage requires a name." })
      parsed.stage = value
    }
    else throw envErrorDiagnostics.ENV_R0026({ message: `Unknown option: ${arg}` })
  }
  return parsed
}

function isInspection(value: unknown): value is ServerEnvInspection {
  return v.is(v.object({ entries: v.array(v.object({
    masked: v.boolean(), path: v.optional(v.string()), provider: v.optional(v.string()), required: v.boolean(),
    source: v.picklist(["env", "literal", "provider"]), status: v.picklist(["available", "defaulted", "error", "invalid", "missing"]),
  })) }), value)
}

async function inspectStage(input: EnvCliInspectInput): Promise<ServerEnvInspection> {
  const explicitEnv = { ...input.env }
  const vite = await import("vite")
  const projectRoot = input.applicationRoot ?? input.rootDir
  const hasNuxtConfig = ["js", "mjs", "cjs", "ts", "mts", "cts"].some(extension => existsSync(join(projectRoot, `nuxt.config.${extension}`)))
  const stageVite = {
    loadEnv: vite.loadEnv,
    async createServer(config: ViteStageServerConfig) {
      if (!hasNuxtConfig) return await vite.createServer(config)
      const require = createRequire(join(projectRoot, "package.json"))
      // SAFETY: nuxt/kit owns loadNuxt. Resolve the application-installed version.
      const kit = await import(pathToFileURL(require.resolve("nuxt/kit")).href) as {
        loadNuxt: (options: { cwd: string, dev: true, envName: string, overrides: { devtools: { enabled: false }, vite: { mode: string }, vitehubCliDiscovery: true }, ready: true }) => Promise<{ close: () => Promise<void>, options: { vite?: import("vite").InlineConfig } }>
      }
      Object.assign(process.env, vite.loadEnv(input.stage, projectRoot, ""))
      for (const [key, value] of Object.entries(explicitEnv)) if (value !== undefined) process.env[key] = value
      const nuxt = await kit.loadNuxt({ cwd: projectRoot, dev: true, envName: input.stage, overrides: { devtools: { enabled: false }, vite: { mode: input.stage }, vitehubCliDiscovery: true }, ready: true })
      try {
        const server = await vite.createServer({ ...nuxt.options.vite, ...config, configFile: false })
        const close = server.close.bind(server)
        server.close = async () => {
          try { await close() }
          finally { await nuxt.close() }
        }
        return server
      }
      catch (error) {
        await nuxt.close()
        throw error
      }
    },
  }
  return await withViteStageServer(stageVite, { ...input, env: explicitEnv }, async (server) => {
    // The Env plugin writes this module while the stage server resolves its config.
    // Nuxt reloads its stage-specific declarations before this server resolves config.
    const selectedPlugin = server.config.plugins.find(plugin => plugin.name === "@vite-hub/env/vite")
    const selectedAPI = v.safeParse(v.object({ resolveProjectRoot: v.function() }), selectedPlugin?.api)
    if (!selectedAPI.success) throw envErrorDiagnostics.ENV_R0027({ message: "[vitehub] The selected stage does not configure the Env plugin." })
    const selectedRoot: unknown = selectedAPI.output.resolveProjectRoot(server.config.root)
    if (!v.is(v.string(), selectedRoot)) throw envErrorDiagnostics.ENV_R0027({ message: "[vitehub] The selected Env plugin returned an invalid project root." })
    const modulePath = viteHubEnvServerModulePath(selectedRoot)
    const generated = await server.ssrLoadModule(pathToFileURL(modulePath).href)
    const inspect: unknown = generated.inspectServerEnv
    if (!v.is(v.function(), inspect)) throw envErrorDiagnostics.ENV_R0027({ message: `[vitehub] The generated Server Env module does not export inspectServerEnv(): ${modulePath}` })
    const inspection: unknown = await inspect()
    if (!isInspection(inspection)) throw envErrorDiagnostics.ENV_R0028({ message: "[vitehub] inspectServerEnv() returned an invalid result." })
    return inspection
  })
}

function displayPath(entry: ServerEnvInspectionEntry): string {
  return entry.path?.replace(/^env\.server\./, "") ?? "(undisclosed name)"
}

function displaySource(entry: ServerEnvInspectionEntry): string {
  if (entry.source === "provider") return `provider:${entry.provider ?? "unknown"}`
  return entry.source === "env" ? "host env" : "literal"
}

function formatTable(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  "))
}

function writeReport(command: EnvCliCommand, report: EnvCliReport, context: ViteHubCliContext): void {
  const lines = [`Server Env (stage: ${report.stage})`, ""]
  if (!report.entries.length) {
    lines.push("No Server Env variables declared.")
  }
  else {
    lines.push(...formatTable([
      ["VARIABLE", "STATUS", "SOURCE", "REQUIRED", "SECRET"],
      ...report.entries.map(entry => [
        displayPath(entry),
        isBlockingServerEnvEntry(entry) ? `${entry.status} !` : entry.status,
        displaySource(entry),
        entry.required ? "yes" : "no",
        entry.masked ? "yes" : "no",
      ]),
    ]))
  }
  const blocking = report.entries.filter(isBlockingServerEnvEntry).length
  lines.push("", blocking
    ? `${blocking} of ${report.entries.length} variables would make loadServerEnv() fail.`
    : `${report.entries.length} variables checked. Values are not shown.`)
  if (command === "check") lines.push(report.ok ? "Server Env check passed." : "Server Env check failed.")
  context.stdout.write(`${lines.join("\n")}\n`)
}

async function runEnvCli(command: EnvCliCommand, args: string[], context: ViteHubCliContext, options: EnvCliOptions): Promise<number> {
  let parsed: ParsedEnvCliArgs
  try {
    parsed = parseArgs(args)
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writeUsage(command, context.stderr)
    return 1
  }
  if (parsed.help) {
    writeUsage(command, context.stdout)
    return 0
  }

  const input: EnvCliInspectInput = { env: context.env, rootDir: context.rootDir, stage: parsed.stage ?? defaultEnvCliStage }
  const inspection = options.inspect
    ? await options.inspect(input)
    : await inspectStage({ ...input, applicationRoot: context.cwd })
  const report: EnvCliReport = {
    entries: inspection.entries,
    ok: !inspection.entries.some(isBlockingServerEnvEntry),
    stage: input.stage,
  }
  if (parsed.json) context.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else writeReport(command, report, context)
  return command === "check" && !report.ok ? 1 : 0
}

export function createEnvCliContributor(options: EnvCliOptions): ViteHubCliContributor {
  return {
    namespaces: [{
      description: "Server Env inspection workflows.",
      features: [
        {
          description: "List declared Server Env variables and their status without values.",
          name: "inspect",
          run: async (args, context) => await runEnvCli("inspect", args, context, options),
          usage: usage("inspect"),
        },
        {
          description: "Exit with 1 when a required Server Env value is missing or any value is invalid.",
          name: "check",
          run: async (args, context) => await runEnvCli("check", args, context, options),
          usage: usage("check"),
        },
      ],
      name: "env",
    }],
  }
}
