import { existsSync, readFileSync, statSync } from "node:fs"

import { collectViteHubDefinitionInspectors, collectViteHubProviderOutputEntries, redactInspectionValue } from "@vite-hub/internal/inspect"
import { PROVISION_STATE_FILE, readProvisionStateSync, redactProvisionState } from "@vite-hub/internal/provision-state"
import { relative, resolve } from "pathe"

import type { ViteHubCliCommandNamespace, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { ViteHubDefinitionSummary, ViteHubProviderOutputEntry } from "@vite-hub/internal/inspect"

type InspectContext = Pick<ViteHubCliContext, "rootDir" | "stderr" | "stdout">

interface ParsedInspectArgs {
  error?: string
  help: boolean
  json: boolean
  kind?: string
}

const definitionsUsage = "vitehub inspect definitions [--kind <kind>] [--json]"
const providerOutputUsage = "vitehub inspect provider-output [--json]"

function parseArgs(args: string[], options: { kind: boolean }): ParsedInspectArgs {
  const parsed: ParsedInspectArgs = { help: false, json: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--json") parsed.json = true
    else if (options.kind && arg === "--kind") {
      const kind = args[index + 1]
      if (!kind || kind.startsWith("-")) parsed.error ??= "Option --kind requires a value."
      else {
        parsed.kind = kind
        index++
      }
    }
    else if (options.kind && arg?.startsWith("--kind=")) {
      const kind = arg.slice("--kind=".length)
      if (!kind) parsed.error ??= "Option --kind requires a value."
      else parsed.kind = kind
    }
    else if (arg) parsed.error ??= `Unknown inspect argument: ${arg}`
  }
  return parsed
}

function writeJson(context: InspectContext, value: unknown): void {
  context.stdout.write(`${JSON.stringify(redactInspectionValue(value), null, 2)}\n`)
}

function redactSummary(summary: ViteHubDefinitionSummary): ViteHubDefinitionSummary {
  return {
    ...summary,
    fields: summary.fields.map(field => ({ label: field.label, value: String(redactInspectionValue(field.value, field.label)) })),
  }
}

async function runDefinitions(args: string[], context: InspectContext, plugins: readonly unknown[]): Promise<number> {
  const parsed = parseArgs(args, { kind: true })
  if (parsed.help) {
    context.stdout.write([
      `Usage: ${definitionsUsage}`,
      "",
      "Lists the Definitions that each active package discovered.",
      "",
      "Options:",
      "  --kind <kind>  Show one kind only, for example queue or rate-limit.",
      "  --json         Print machine-readable JSON.",
      "  -h, --help     Show this help.",
      "",
    ].join("\n"))
    return 0
  }
  if (parsed.error) {
    context.stderr.write(`${parsed.error}\nUsage: ${definitionsUsage}\n`)
    return 1
  }

  const inspectors = await collectViteHubDefinitionInspectors(plugins)
  const selected = parsed.kind ? inspectors.filter(inspector => inspector.kind === parsed.kind) : inspectors
  if (parsed.kind && !selected.length) {
    const kinds = inspectors.map(inspector => inspector.kind).sort()
    context.stderr.write(`Unknown Definition kind: ${parsed.kind}\nAvailable kinds: ${kinds.length ? kinds.join(", ") : "none"}\n`)
    return 1
  }

  const groups = await Promise.all(selected.map(async inspector => ({
    definitions: (await inspector.list()).map(redactSummary),
    kind: inspector.kind,
    label: inspector.label,
  })))

  if (parsed.json) {
    writeJson(context, { definitions: groups })
    return 0
  }

  if (!groups.length) {
    context.stdout.write("No package contributes Definition inspection.\n")
    return 0
  }
  const lines: string[] = []
  for (const group of groups) {
    lines.push(`${group.label} (${group.kind}): ${group.definitions.length}`)
    if (!group.definitions.length) lines.push("  No Definitions discovered.")
    for (const definition of group.definitions) {
      lines.push(`  ${definition.name}  ${definition.file}  [${definition.source}]`)
      for (const field of definition.fields) lines.push(`    ${field.label}: ${field.value}`)
    }
    lines.push("")
  }
  context.stdout.write(lines.join("\n"))
  return 0
}

interface ProviderOutputReport {
  content?: unknown
  description: string
  exists: boolean
  owner: string
  path: string
  type?: "directory" | "file"
}

function readProviderOutputEntry(rootDir: string, entry: ViteHubProviderOutputEntry): ProviderOutputReport {
  const path = relative(rootDir, entry.path) || "."
  if (!existsSync(entry.path)) return { description: entry.description, exists: false, owner: entry.owner, path }
  const directory = statSync(entry.path).isDirectory()
  const report: ProviderOutputReport = {
    description: entry.description,
    exists: true,
    owner: entry.owner,
    path,
    type: directory ? "directory" : "file",
  }
  if (!directory && entry.path.endsWith(".json")) {
    try {
      report.content = JSON.parse(readFileSync(entry.path, "utf8"))
    }
    catch {
      report.content = "[unreadable JSON]"
    }
  }
  return report
}

async function runProviderOutput(args: string[], context: InspectContext, plugins: readonly unknown[]): Promise<number> {
  const parsed = parseArgs(args, { kind: false })
  if (parsed.help) {
    context.stdout.write([
      `Usage: ${providerOutputUsage}`,
      "",
      "Lists generated Provider Output files and shows which exist.",
      "Run a production build first to generate deployment output.",
      "JSON output includes file contents with credentials and Worker vars redacted.",
      "",
      "Options:",
      "  --json      Print machine-readable JSON.",
      "  -h, --help  Show this help.",
      "",
    ].join("\n"))
    return 0
  }
  if (parsed.error) {
    context.stderr.write(`${parsed.error}\nUsage: ${providerOutputUsage}\n`)
    return 1
  }

  const entries = [
    ...await collectViteHubProviderOutputEntries(plugins),
    { description: "Provision State with non-secret provider resource ids", owner: "cli", path: resolve(context.rootDir, PROVISION_STATE_FILE) },
  ]
  const reports = entries
    .map(entry => readProviderOutputEntry(context.rootDir, entry))
    .sort((left, right) => left.path.localeCompare(right.path))

  if (parsed.json) {
    const providerOutput = reports.map(report => {
      // SAFETY: Redaction preserves the report structure and replaces only sensitive values with strings.
      const redacted = redactInspectionValue(report) as ProviderOutputReport
      if (report.path === PROVISION_STATE_FILE && report.type === "file" && report.content !== "[unreadable JSON]") {
        redacted.content = redactProvisionState(readProvisionStateSync(context.rootDir))
      }
      return redacted
    })
    context.stdout.write(`${JSON.stringify({ providerOutput }, null, 2)}\n`)
    return 0
  }

  const present = reports.filter(report => report.exists)
  const missing = reports.filter(report => !report.exists)
  const lines = [`Provider Output: ${present.length} of ${reports.length} present`]
  for (const report of present) lines.push(`  ${report.path}  (${report.owner}) ${report.description}`)
  if (missing.length) {
    lines.push("", "Not generated:")
    for (const report of missing) lines.push(`  ${report.path}  (${report.owner}) ${report.description}`)
  }
  lines.push("")
  context.stdout.write(lines.join("\n"))
  return 0
}

/** Built-in namespace that renders package-owned inspection data. */
export function createInspectNamespace(plugins: readonly unknown[]): ViteHubCliCommandNamespace {
  return {
    description: "Inspect discovered Definitions and generated Provider Output.",
    features: [
      {
        description: "List Definitions discovered by each active package.",
        name: "definitions",
        run: (args, context) => runDefinitions(args, context, plugins),
        usage: definitionsUsage,
      },
      {
        description: "List generated Provider Output files with secrets redacted.",
        name: "provider-output",
        run: (args, context) => runProviderOutput(args, context, plugins),
        usage: providerOutputUsage,
      },
    ],
    name: "inspect",
  }
}
