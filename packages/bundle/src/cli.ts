import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"

import { formatBytes } from "./bytes.ts"
import { readEnvironmentReports } from "./files.ts"
import { createBundleReport, explainBundle } from "./report.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliFeature } from "@vite-hub/internal/cli"
import type { BundleFinding, BundleSide } from "./types.ts"

const reportUsage = "vitehub bundle [--json]"
const whyUsage = "vitehub bundle why <package|file> [--json]"
const missingReport = "No bundle report in .vitehub/bundle/. Set `bundle: true` in vitehub() (vite.config.ts) or in `vitehub` (nuxt.config.ts), then run a production build.\n"

export { formatBytes }

/** The CLI passes the Vite root, which is `app/` in Nuxt. Reports live in the project root. */
function projectRoot(context: ViteHubCliContext): string {
  return resolveViteHubProjectRoot(context.rootDir)
}

function parse(args: string[]): { help: boolean, json: boolean, positional: string[], unknown?: string } {
  const result: { help: boolean, json: boolean, positional: string[], unknown?: string } = { help: false, json: false, positional: [] }
  for (const arg of args) {
    if (arg === "--json") result.json = true
    else if (arg === "-h" || arg === "--help") result.help = true
    else if (arg.startsWith("-")) result.unknown ??= arg
    else result.positional.push(arg)
  }
  return result
}

function sideLines(label: string, side: BundleSide, startupMeaning: string): string[] {
  const lines = [
    `${label}: ${formatBytes(side.bytes)} of JavaScript in ${side.chunks} files (gzip ${formatBytes(side.gzip)}). Environments: ${side.environments.join(", ")}.`,
    `  Startup: ${formatBytes(side.startup.bytes)} in ${side.startup.chunks} files (gzip ${formatBytes(side.startup.gzip)}). ${startupMeaning}`,
    "  Largest groups (total, startup):",
  ]
  const width = Math.max(...side.groups.slice(0, 10).map(group => formatBytes(group.bytes).length))
  for (const group of side.groups.slice(0, 10)) {
    lines.push(`    ${formatBytes(group.bytes).padStart(width)}  ${formatBytes(group.startupBytes).padStart(width)}  ${group.name} (${group.kind})`)
  }
  if (side.groups.length > 10) lines.push(`    ${side.groups.length - 10} more groups in --json`)
  return lines
}

function findingLines(findings: readonly BundleFinding[]): string[] {
  if (!findings.length) return ["Checks: no findings.", ""]
  const lines = [`Checks: ${findings.length} ${findings.length === 1 ? "finding" : "findings"}.`]
  for (const finding of findings) {
    lines.push(`  ${finding.severity} ${finding.code} (${finding.side}): ${finding.why}`)
    if (finding.chain.length) lines.push(`    Chain: ${finding.chain.map(step => step.id).join(" → ")}`)
    lines.push(`    Fix: ${finding.fix}`, `    Docs: ${finding.docs}`)
  }
  lines.push("")
  return lines
}

/** Like `vite-doctor`: an error finding fails the command, a warning does not. */
function exitCode(findings: readonly BundleFinding[]): number {
  return findings.some(finding => finding.severity === "error") ? 1 : 0
}

function runReport(args: string[], context: ViteHubCliContext): number {
  const parsed = parse(args)
  if (parsed.help) {
    context.stdout.write([
      `Usage: ${reportUsage}`,
      "",
      "Shows the size of the last production build: client and server, the code that loads at startup, and the largest",
      "packages and folders. Needs a build with `bundle: true` in vitehub(). No dev server needed.",
      "",
      "Then it runs the bundle checks. It exits with 1 when a finding is an error, such as a server over the host size",
      "limit. Warnings, such as a package that this build never runs at startup but loads there, keep exit code 0.",
      "",
      "Options:",
      "  --json      Print the full report.",
      "  -h, --help  Show this help.",
      "",
    ].join("\n"))
    return 0
  }
  if (parsed.unknown || parsed.positional.length) {
    context.stderr.write(`Unknown argument ${parsed.unknown ?? parsed.positional[0]}.\nUsage: ${reportUsage}\n`)
    return 1
  }
  const report = createBundleReport(readEnvironmentReports(projectRoot(context)))
  if (!report) {
    context.stderr.write(missingReport)
    return 1
  }
  if (parsed.json) {
    context.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return exitCode(report.findings)
  }
  const lines = [`Bundle of the build from ${report.build}${report.host ? ` for ${report.host}` : ""}`, ""]
  if (report.server) lines.push(...sideLines("Server", report.server, "This code loads before the server answers its first request."), "")
  if (report.client) lines.push(...sideLines("Client", report.client, "Combined startup across all page entries; shared files count once."), "")
  lines.push(...findingLines(report.findings))
  lines.push("Run `vitehub bundle why <package|file>` to see why something is in the output.", "")
  context.stdout.write(lines.join("\n"))
  return exitCode(report.findings)
}

function runWhy(args: string[], context: ViteHubCliContext): number {
  const parsed = parse(args)
  if (parsed.help) {
    context.stdout.write([
      `Usage: ${whyUsage}`,
      "",
      "Shows why a package, a file, or a group is in the last production build: its size on the client and the server,",
      "whether it loads at startup, and the shortest import chain from the entry to it.",
      "",
      "Examples:",
      "  vitehub bundle why @libsql/client",
      "  vitehub bundle why server/api/hello.get.ts",
      "",
      "Options:",
      "  --json      Print machine-readable JSON.",
      "  -h, --help  Show this help.",
      "",
    ].join("\n"))
    return 0
  }
  const target = parsed.positional[0]
  if (parsed.unknown || !target || parsed.positional.length > 1) {
    context.stderr.write(`${parsed.unknown ? `Unknown argument ${parsed.unknown}.\n` : "Name one package, file, or group.\n"}Usage: ${whyUsage}\n`)
    return 1
  }
  const reports = readEnvironmentReports(projectRoot(context))
  if (!reports.length) {
    context.stderr.write(missingReport)
    return 1
  }
  const explanations = explainBundle(reports, target)
  if (parsed.json) {
    context.stdout.write(`${JSON.stringify({ target, explanations }, null, 2)}\n`)
    return 0
  }
  if (!explanations.length) {
    context.stdout.write(`${target} is not in the last build.\n`)
    return 0
  }
  const lines: string[] = []
  for (const explanation of explanations) {
    lines.push(`${explanation.side === "server" ? "Server" : "Client"}: ${formatBytes(explanation.bytes)} in ${explanation.group}${explanation.startup ? ", loads at startup" : ", loads on demand"}.`)
    if (explanation.chain.length) {
      for (const [index, step] of explanation.chain.entries()) lines.push(`  ${index === 0 ? "" : "→ "}${step.id}${index === 0 || step.environment !== explanation.chain[index - 1]!.environment ? `  [${step.environment}]` : ""}`)
    }
    else lines.push("  No import chain from an entry. A plugin or the bundler added it.")
    lines.push("")
  }
  context.stdout.write(lines.join("\n"))
  return 0
}

const features: ViteHubCliFeature[] = [
  { description: "Show client and server size, startup size, and the largest groups.", name: "report", run: runReport, usage: reportUsage },
  { description: "Show why a package or file is in the output.", name: "why", run: runWhy, usage: whyUsage },
]

/** The `vitehub bundle` commands. They read `.vitehub/bundle/` and need no dev server. */
export const bundleCliContributor: ViteHubCliContributor = {
  namespaces: [{ defaultFeature: "report", description: "Inspect the size of the last production build.", features, name: "bundle" }],
}
