import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { formatDiagnostic } from "nostics"

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
  warn: (message: string) => void
}

// Each feature package bundles its own copy of this module, so every copy shares one map through the global.
const runsKey = Symbol.for("vitehub.hints.runs")
const shared = globalThis as typeof globalThis & { [runsKey]?: WeakMap<object, HintsRun> }
const runs = shared[runsKey] ??= new WeakMap<object, HintsRun>()

function hintRun(config: Pick<ResolvedConfig, "root" | "command" | "logger">): HintsRun {
  let run = runs.get(config)
  if (!run) {
    run = {
      file: resolve(config.root, viteHubHintsFile),
      report: { version: 1, command: config.command, startedAt: new Date().toISOString(), hints: [] },
      keys: new Set(),
      warn: message => config.logger.warn(message),
    }
    runs.set(config, run)
  }
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
export function reportViteHubHint(config: Pick<ResolvedConfig, "root" | "command" | "logger">, diagnostic: Diagnostic): void {
  const run = hintRun(config)
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
  run.warn(formatDiagnostic(diagnostic))
}

/**
 * Starts the hints of a build or dev server: writes an empty {@link viteHubHintsFile}, so a run without hints does not
 * leave the hints of an earlier run in place.
 */
export function viteHubHintsPlugin(): Plugin {
  return {
    name: "vite-hub/hints",
    configResolved(config) {
      write(hintRun(config))
    },
  }
}
