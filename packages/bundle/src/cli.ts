import { resolve } from "node:path"

import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"

import { formatBytes } from "./bytes.ts"
import { compareBundleReports, readSavedBundleReport } from "./compare.ts"
import { readBundleReportRoot, readEnvironmentReports } from "./files.ts"
import { createBundleReport, explainBundle, explainBundleRoute } from "./report.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliFeature } from "@vite-hub/internal/cli"
import type { BundleComparison, BundleFinding, BundleSide, BundleSideComparison } from "./types.ts"

const reportUsage = "vitehub bundle [--against <report>] [--json]"
const whyUsage = "vitehub bundle why <package|file|/route> [--json]"
const missingReport = "No bundle report in .vitehub/bundle/. Set `bundle: true` in vitehub() (vite.config.ts) or in `vitehub` (nuxt.config.ts), then run a production build.\n"

export { formatBytes }

/** A loaded project supplies its Vite root; runtime dispatch uses the last build's location. */
function projectRoot(context: ViteHubCliContext): string {
  const root = resolveViteHubProjectRoot(context.rootDir)
  if (resolve(context.cwd) !== resolve(context.rootDir)) return root
  return readBundleReportRoot(context.cwd) ?? readBundleReportRoot(root) ?? root
}

interface ParsedArgs {
  help: boolean
  json: boolean
  positional: string[]
  against?: string
  /** An option that needs a value and has none. */
  missing?: string
  unknown?: string
}

function parse(args: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false, json: false, positional: [] }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--json") result.json = true
    else if (arg === "--against" && args[index + 1] && !args[index + 1]!.startsWith("-")) result.against = args[++index]
    else if (arg.startsWith("--against=") && arg.length > "--against=".length) result.against = arg.slice("--against=".length)
    else if (arg === "--against" || arg === "--against=") result.missing ??= "--against <report>"
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
  if (side.routesUnavailable) lines.push(`  Routes unavailable: ${side.routesUnavailable}`)
  if (side.routes?.length) {
    const routes = side.routes.slice(0, 5)
    const routeWidth = Math.max(...routes.map(route => formatBytes(route.bytes).length))
    lines.push("  Largest routes (first visit, page files only):")
    for (const route of routes) lines.push(`    ${formatBytes(route.bytes).padStart(routeWidth)}  ${formatBytes(route.pageBytes).padStart(routeWidth)}  ${route.path}`)
    if (side.routes.length > 5) lines.push(`    ${side.routes.length - 5} more routes in --json`)
  }
  return lines
}

function fileCount(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`
}

function routeLines(explanation: NonNullable<ReturnType<typeof explainBundleRoute>>): string[] {
  const { route } = explanation
  const js = route.files.filter(file => !file.file.endsWith(".css"))
  const startup = js.filter(file => file.startup)
  const lines = [
    `Route ${route.path}: ${formatBytes(route.bytes)} of JavaScript on a first visit (gzip ${formatBytes(route.gzip)}), ${formatBytes(route.cssBytes)} of CSS.`,
    `  Startup files: ${formatBytes(route.bytes - route.pageBytes)} in ${fileCount(startup.length)}. Page files: ${formatBytes(route.pageBytes)} in ${fileCount(js.length - startup.length)}.`,
    `  Components: ${route.components.join(", ") || "none"}`,
    "  Files (bytes, gzip):",
  ]
  const width = Math.max(...route.files.map(file => formatBytes(file.bytes).length))
  for (const file of route.files) lines.push(`    ${formatBytes(file.bytes).padStart(width)}  ${formatBytes(file.gzip).padStart(width)}  ${file.file}${file.startup ? "  [startup]" : ""}`)
  if (explanation.modules.length) {
    lines.push("  Largest modules in the page files:")
    const modules = explanation.modules.slice(0, 10)
    const moduleWidth = Math.max(...modules.map(module => formatBytes(module.bytes).length))
    for (const module of modules) lines.push(`    ${formatBytes(module.bytes).padStart(moduleWidth)}  ${module.id}`)
  }
  lines.push("", "Run `vitehub bundle why <module>` on a module to see the import chain that loads it.", "")
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

/** `+1.2 kB`, `-300 B`, or `0 B`. */
function formatDelta(bytes: number): string {
  return bytes > 0 ? `+${formatBytes(bytes)}` : bytes < 0 ? `-${formatBytes(-bytes)}` : "0 B"
}

function change(before: number, after: number): string {
  return `${formatBytes(before)} → ${formatBytes(after)} (${formatDelta(after - before)})`
}

function comparisonLines(label: string, side: BundleSideComparison): string[] {
  if (!side.groups.length && !side.delta.bytes && !side.delta.gzip && !side.delta.startupBytes && !side.delta.startupGzip) {
    return [`${label}: no change, ${formatBytes(side.after.bytes)}. Startup: ${formatBytes(side.after.startupBytes)}.`]
  }
  const lines = [
    `${label}: ${change(side.before.bytes, side.after.bytes)}, gzip ${change(side.before.gzip, side.after.gzip)}.`,
    `  Startup: ${change(side.before.startupBytes, side.after.startupBytes)}, gzip ${change(side.before.startupGzip, side.after.startupGzip)}.`,
  ]
  if (!side.groups.length) return lines
  lines.push("  Groups that changed (total, startup):")
  const shown = side.groups.slice(0, 10)
  const width = Math.max(...shown.flatMap(group => [formatDelta(group.delta.bytes).length, formatDelta(group.delta.startupBytes).length]))
  for (const group of shown) {
    lines.push(`    ${formatDelta(group.delta.bytes).padStart(width)}  ${formatDelta(group.delta.startupBytes).padStart(width)}  ${group.name} (${group.kind}), ${group.change}`)
  }
  if (side.groups.length > 10) lines.push(`    ${side.groups.length - 10} more groups in --json`)
  return lines
}

function comparisonText(comparison: BundleComparison): string {
  const lines = [`Bundle of the build from ${comparison.builds.after}, compared with the build from ${comparison.builds.before}`, ""]
  if (comparison.builds.before === comparison.builds.after) {
    lines.push("Both reports are from the same build. Run the production build again after the change, then compare.", "")
  }
  if (comparison.server) lines.push(...comparisonLines("Server", comparison.server), "")
  if (comparison.client) lines.push(...comparisonLines("Client", comparison.client), "")
  return lines.join("\n")
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
      "With --against, it compares the last build with a saved report: the bytes of each side and of its startup",
      "code, and the groups that grew, shrank, were added, or were removed. Save the report before the change:",
      "",
      "  vitehub bundle --json > .vitehub/bundle-before.json",
      "  # change the code, then run the production build again",
      "  vitehub bundle --against .vitehub/bundle-before.json",
      "",
      "Options:",
      "  --against <report>  Compare with a saved report: the output of --json, a copy of .vitehub/bundle/,",
      "                      or a project root that has .vitehub/bundle/.",
      "  --json              Print the full report, or the comparison with --against.",
      "  -h, --help          Show this help.",
      "",
    ].join("\n"))
    return 0
  }
  if (parsed.missing) {
    context.stderr.write(`${parsed.missing} needs a value.\nUsage: ${reportUsage}\n`)
    return 1
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
  if (parsed.against) {
    const before = readSavedBundleReport(resolve(context.cwd, parsed.against))
    if (!before) {
      context.stderr.write(`No bundle report in ${parsed.against}. Save one before the change with \`vitehub bundle --json > .vitehub/bundle-before.json\`.\n`)
      return 1
    }
    const comparison = compareBundleReports(before, report)
    context.stdout.write(parsed.json
      ? `${JSON.stringify({ ...comparison, findings: report.findings }, null, 2)}\n`
      : `${comparisonText(comparison)}${findingLines(report.findings).join("\n")}`)
    return exitCode(report.findings)
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
      "For a page route, such as /docs/kv, it shows what the browser loads on a first visit: the startup files, the",
      "files of the route's layout and pages, and the largest modules that the route adds. Nuxt apps only.",
      "",
      "Examples:",
      "  vitehub bundle why @libsql/client",
      "  vitehub bundle why server/api/hello.get.ts",
      "  vitehub bundle why /docs/kv",
      "",
      "Options:",
      "  --json      Print machine-readable JSON.",
      "  -h, --help  Show this help.",
      "",
    ].join("\n"))
    return 0
  }
  const target = parsed.positional[0]
  if (parsed.against || parsed.missing) parsed.unknown ??= "--against"
  if (parsed.unknown || !target || parsed.positional.length > 1) {
    context.stderr.write(`${parsed.unknown ? `Unknown argument ${parsed.unknown}.\n` : "Name one package, file, or group.\n"}Usage: ${whyUsage}\n`)
    return 1
  }
  const reports = readEnvironmentReports(projectRoot(context))
  if (!reports.length) {
    context.stderr.write(missingReport)
    return 1
  }
  const route = target.startsWith("/") ? explainBundleRoute(reports, target) : undefined
  if (route) {
    context.stdout.write(parsed.json ? `${JSON.stringify(route, null, 2)}\n` : routeLines(route).join("\n"))
    return 0
  }
  const explanations = explainBundle(reports, target)
  const unavailable = !explanations.length && target.startsWith("/") ? createBundleReport(reports)?.client?.routesUnavailable : undefined
  if (unavailable) {
    context.stdout.write(parsed.json ? `${JSON.stringify({ target, unavailable }, null, 2)}\n` : `Routes unavailable: ${unavailable}\n`)
    return 1
  }
  if (parsed.json) {
    context.stdout.write(`${JSON.stringify({ target, explanations }, null, 2)}\n`)
    return 0
  }
  if (!explanations.length) {
    context.stdout.write(target.startsWith("/") ? `No page route of the last build renders ${target}. Routes need a Nuxt app with pages.\n` : `${target} is not in the last build.\n`)
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
  { description: "Show why a package or file is in the output, or what a page route loads.", name: "why", run: runWhy, usage: whyUsage },
]

/** The `vitehub bundle` commands. They read `.vitehub/bundle/` and need no dev server. */
export const bundleCliContributor: ViteHubCliContributor = {
  namespaces: [{ defaultFeature: "report", description: "Inspect the size of the last production build.", features, name: "bundle" }],
}
