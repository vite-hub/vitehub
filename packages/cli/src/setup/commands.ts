import { setupCatalog } from "./catalog.ts"
import { readSetupArgs, setupExitCodes, writeSetupError, writeSetupJson } from "./envelope.ts"
import { readSetupProject } from "./project.ts"
import { setupStatus } from "./status.ts"

import type { ViteHubCliCommand, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { SetupFeatureStatus, SetupStatus } from "./status.ts"

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n")
}

function supportLabel(support: SetupFeatureStatus["support"]): string {
  if (support.level === "unknown") return "unknown"
  if (support.level === "unsupported") return "-"
  return support.level === "explicit" ? `${support.display} (set ${support.option})` : support.display
}

function writeHelp(command: ViteHubCliCommand, context: ViteHubCliContext): number {
  context.stdout.write(`Usage: ${command.usage}\n\n${command.description}\n`)
  return setupExitCodes.done
}

/** Runs `body` and reports any error in the setup envelope. */
async function runSetupCommand(command: ViteHubCliCommand, args: string[], context: ViteHubCliContext, body: (json: boolean) => Promise<number>): Promise<number> {
  const json = args.includes("--json")
  try {
    const parsed = readSetupArgs(args, command.usage)
    if (parsed.help) return writeHelp(command, context)
    return await body(parsed.json)
  }
  catch (error: unknown) {
    return writeSetupError(context, json, error)
  }
}

const catalogCommand: ViteHubCliCommand = {
  description: "List every ViteHub feature and how each host supports it. Needs no project.",
  name: "catalog",
  run: (args, context) => runSetupCommand(catalogCommand, args, context, async (json) => {
    const catalog = setupCatalog()
    if (json) {
      writeSetupJson(context, catalog)
      return setupExitCodes.done
    }
    context.stdout.write(`${table([
      ["feature", ...catalog.hosts],
      ...catalog.features.map(feature => [feature.id, ...catalog.hosts.map(host => supportLabel(feature.hosts[host]))]),
    ])}\n\n"-" is unsupported. Run \`vitehub catalog --json\` for packages, docs, and details.\n`)
    return setupExitCodes.done
  }),
  usage: "vitehub catalog [--json]",
}

function configLabel(config: SetupStatus["config"]): string {
  if ("form" in config) return `${config.file} (${config.form})`
  const at = config.file ? `${config.file}${config.line === undefined ? "" : `:${config.line}`}: ` : ""
  return `${at}manual (${config.manual})`
}

function writeStatus(status: SetupStatus, context: ViteHubCliContext): void {
  const shown = status.features.filter(feature => feature.enabled !== "off")
  const off = status.features.length - shown.length
  context.stdout.write(`${table([
    ["root", status.root],
    ["framework", status.framework],
    ["config", configLabel(status.config)],
    ["host", `${status.host.name} (${status.host.source})`],
    ["packages", status.packageManager],
  ])}\n\n`)
  if (shown.length) {
    context.stdout.write(`${table([
      ["feature", "state", "support", "fix"],
      ...shown.map(feature => [feature.id, feature.reason === "config" ? feature.enabled : `${feature.enabled} (${feature.reason})`, supportLabel(feature.support), feature.fix ?? ""]),
    ])}\n\n`)
  }
  context.stdout.write(`${off} features are off. Run \`vitehub catalog\` to list them.\n`)
}

const statusCommand: ViteHubCliCommand = {
  description: "Show the host, the enabled features, and what each one still needs. Reads the config without running it.",
  name: "status",
  run: (args, context) => runSetupCommand(statusCommand, args, context, async (json) => {
    const status = setupStatus(await readSetupProject(context.rootDir, context.env), context.env)
    if (json) writeSetupJson(context, status)
    else writeStatus(status, context)
    return setupExitCodes.done
  }),
  usage: "vitehub status [--json]",
}

/** The setup commands. They run before the CLI loads the project config. */
export const setupCommands: readonly ViteHubCliCommand[] = [catalogCommand, statusCommand]
