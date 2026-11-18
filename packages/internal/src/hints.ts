import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { formatDiagnostic } from "nostics"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT } from "./build/vite.ts"

import type { Diagnostic } from "nostics"
import type { Plugin, ResolvedConfig } from "vite"

/**
 * The file that lists the hints of the last build or dev server, relative to the project root. A hint is a warning
 * about something that works now and fails later, such as counts that stay in one server's memory. Agents and CI read
 * the file instead of the terminal.
 */
export const viteHubHintsFile = ".vitehub/hints.json"

/** One hint: a nostics code, why it matters, how to fix it, and its docs page. */
export interface ViteHubHint {
  code: string
  why: string
  fix?: string
  docs?: string
  /** Files in the app, as `file:line:column`, when the hint is about one place. */
  sources?: string[]
}

/** The content of {@link viteHubHintsFile}. */
export interface ViteHubHintsReport {
  version: 1
  command: "build" | "serve"
  /** When the build or dev server started. A report from another run is stale. */
  startedAt: string
  hints: ViteHubHint[]
}

interface HintsRun {
  file: string
  report: ViteHubHintsReport
  keys: Set<string>
}

type HintsConfig = Pick<ResolvedConfig, "root" | "command" | "logger">

// Each feature package bundles its own copy of this module, so every copy shares one map through the global. Runs
// are keyed by the report file: a Vite environment has its own config object, but the same project root.
const runsKey = Symbol.for("vitehub.hints.runs")
const shared = globalThis as typeof globalThis & { [runsKey]?: Map<string, HintsRun> }
const runs = shared[runsKey] ??= new Map<string, HintsRun>()
const startedKey = Symbol.for("vitehub.hints.started")
const startedShared = globalThis as typeof globalThis & { [startedKey]?: WeakSet<object> }
const started = startedShared[startedKey] ??= new WeakSet<object>()

/**
 * The report of the ViteHub project root, where the other generated files go. A Nuxt app with `srcDir: "app"` has its
 * Vite root in `app/`, one folder below.
 */
function hintsFile(config: HintsConfig): string {
  const projectRoot: unknown = Reflect.get(config, VITEHUB_PROJECT_ROOT)
  return resolve(typeof projectRoot === "string" ? projectRoot : resolveViteHubProjectRoot(config.root), viteHubHintsFile)
}

function startRun(config: HintsConfig): HintsRun {
  const file = hintsFile(config)
  const run = { file, report: { version: 1 as const, command: config.command, startedAt: new Date().toISOString(), hints: [] }, keys: new Set<string>() }
  runs.set(file, run)
  return run
}

function write(run: HintsRun): void {
  mkdirSync(dirname(run.file), { recursive: true })
  writeFileSync(run.file, `${JSON.stringify(run.report, null, 2)}\n`)
}

/**
 * Reports a hint from a Vite plugin hook: prints it once with its fix and docs link, and adds it to
 * {@link viteHubHintsFile}. Build the diagnostic from the package's nostics catalog, so its code has a docs page.
 */
export function reportViteHubHint(config: HintsConfig, diagnostic: Diagnostic): void {
  const run = runs.get(hintsFile(config)) ?? startRun(config)
  const hint: ViteHubHint = {
    code: diagnostic.code,
    why: diagnostic.why,
    ...diagnostic.fix ? { fix: diagnostic.fix } : {},
    ...diagnostic.docs ? { docs: diagnostic.docs } : {},
    ...diagnostic.sources?.length ? { sources: diagnostic.sources } : {},
  }
  const key = JSON.stringify([hint.code, hint.sources ?? []])
  if (run.keys.has(key)) return
  run.keys.add(key)
  run.report.hints.push(hint)
  write(run)
  config.logger.warn(formatDiagnostic(diagnostic))
}

/**
 * Starts the hints of a build or dev server: writes an empty {@link viteHubHintsFile}, so a run without hints does not
 * leave the hints of an earlier run in place. Every plugin that reports hints calls it from `configResolved`, so a
 * package used without `vitehub()` starts its own run. The first call for a resolved config starts the run, and the
 * calls of other plugins of the same build keep it.
 */
export function startViteHubHints(config: HintsConfig): void {
  if (started.has(config)) return
  started.add(config)
  write(startRun(config))
}

/** The plugin that `vitehub()` adds, so a build without any hint still writes an empty report. */
export function viteHubHintsPlugin(): Plugin {
  return {
    name: "vite-hub/hints",
    configResolved: { order: "pre", handler: startViteHubHints },
  }
}
