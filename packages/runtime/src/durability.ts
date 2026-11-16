import { defineDiagnostics } from "nostics"

/**
 * Where the state of a primitive lives.
 *
 * - `shared`: every server instance reads and writes the same store, such as Postgres, Redis, or S3.
 * - `host`: the state is in files on this host. It survives a restart, but another host or container does not see it.
 * - `process`: the state is in the memory of this process. A restart loses it and other processes do not see it.
 */
export type DurabilityScope = "host" | "process" | "shared"

/** What one primitive reports about the store that it uses in this server. */
export interface Durability {
  /** The primitive, such as `kv`, `queue`, or `database`. */
  primitive: string
  /** The named store or Database, when the primitive has more than one. Omitted for the default. */
  name?: string
  /** The driver or engine that holds the state, such as `fs-lite`, `memory`, or `postgres`. */
  store: string
  scope: DurabilityScope
  /** One sentence that tells where the state is. */
  reason: string
  /** How to make the state shared. Set it when `scope` is not `shared`. */
  fix?: string
}

/** What a reporter reads at boot besides the configuration of its own primitive. */
export interface DurabilityContext {
  /** The server environment. A driver that an environment variable selects at boot reads it here. */
  env: Record<string, string | undefined>
  /**
   * The report of another primitive in this server, such as the Database that a KV store keeps its rows in. `name`
   * defaults to the default store. `undefined` when that primitive is off.
   */
  find: (primitive: string, name?: string) => Durability | undefined
}

/**
 * A primitive's durability reporter. The build passes the resolved configuration of the primitive as `input`. The
 * server passes a context with its environment and the other reports, so a driver that the environment or the Default
 * Database selects at boot reports correctly.
 */
export type DurabilityReporter<Input> = (input: Input, context: DurabilityContext) => readonly Durability[]

/** One primitive's reporter, with its configuration already applied. */
export interface DurabilityEntry {
  primitive: string
  report: (context: DurabilityContext) => readonly Durability[]
}

/**
 * Runs every reporter once, in order. A reporter that calls `context.find()` runs the reporter of that primitive first,
 * so the order of the entries does not matter.
 */
export function collectDurability(entries: readonly DurabilityEntry[], env: Record<string, string | undefined>): Durability[] {
  const results = new Map<DurabilityEntry, readonly Durability[]>()
  const running = new Set<DurabilityEntry>()
  const run = (entry: DurabilityEntry): readonly Durability[] => {
    const done = results.get(entry)
    if (done) return done
    // A cycle reports nothing for the primitive that is still running.
    if (running.has(entry)) return []
    running.add(entry)
    const reports = entry.report(context)
    running.delete(entry)
    results.set(entry, reports)
    return reports
  }
  const context: DurabilityContext = {
    env,
    find: (primitive, name = "default") => entries
      .filter(entry => entry.primitive === primitive)
      .flatMap(run)
      .find(report => (report.name ?? "default") === name),
  }
  return entries.flatMap(entry => [...run(entry)])
}

/**
 * Where a SQLite or libSQL URL keeps its data: `:memory:` in this process, `libsql:`, `http(s):`, or `ws(s):` on a
 * remote server, and anything else, such as `file:`, on this host.
 */
export function classifySqliteUrl(url: string): Pick<Durability, "reason" | "scope" | "store"> {
  if (url === ":memory:" || url === "file::memory:") return { store: "sqlite", scope: "process", reason: "SQLite in the memory of this process." }
  if (url === "remote" || /^(?:libsql|https?|wss?):/i.test(url)) return { store: "libsql", scope: "shared", reason: "A remote libSQL server." }
  return { store: "sqlite", scope: "host", reason: `The SQLite file ${url.replace(/^file:(?:\/\/)?/i, "")} on this host.` }
}

/**
 * Hides a remote URL before the build writes it into the server: a `file:` or `:memory:` URL stays, and any other URL
 * becomes `remote`, which `classifySqliteUrl()` reads as a remote server.
 */
export function sqliteUrlInput(url: string): string {
  return /^file:/i.test(url) || url === ":memory:" ? url : "remote"
}

/** A configuration value that can name runtime environment variables, as the Database and Workflow options do. */
export type DurabilityConfigValue = string | {
  default?: unknown
  source?: { name?: string, names?: readonly string[] }
}

/** Reads a configuration value the same way the runtime does: the first set environment variable, then the default. */
export function resolveDurabilityValue(value: DurabilityConfigValue | undefined, env: Record<string, string | undefined>): string | undefined {
  if (typeof value !== "object") return value?.trim() || undefined
  for (const name of value.source?.names ?? (value.source?.name ? [value.source.name] : [])) {
    const resolved = env[name]?.trim()
    if (resolved) return resolved
  }
  return typeof value.default === "string" ? value.default.trim() || undefined : undefined
}

/** The durability of the running server, as `vitehub durability list` shows it. */
export interface DurabilityReport {
  instances: number
  /** Where the instance count comes from. */
  instancesSource: "default" | "env" | "option"
  primitives: readonly Durability[]
  /** The primitives that split their state when `instances` is greater than 1. */
  problems: readonly Durability[]
}

export interface DurabilityCheckOptions {
  /** `node.instances` from the ViteHub config. `VITEHUB_INSTANCES` in `env` overrides it. */
  instances?: number
  env?: Record<string, string | undefined>
  /** Fail when several instances would split state. The dev server only records the report. */
  enforce?: boolean
  /** Write the boot table. Defaults to `console.info`. Pass `false` to skip it. */
  log?: ((message: string) => void) | false
}

export const instancesEnvName = "VITEHUB_INSTANCES"

interface DurabilityDiagnosticData extends Record<string, unknown> {
  instances: number
  /** One line per primitive that would split its state, with its fix. */
  lines: string[]
  primitives: string[]
}

interface InstanceCountDiagnosticData extends Record<string, unknown> {
  source: string
  value: string
}

const durabilityDiagnostics = defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    RUNTIME_R0017: {
      why: ({ instances, lines }: DurabilityDiagnosticData) => [
        `[vitehub] ${instancesEnvName} is ${instances}, but these primitives keep their state in one process or on one host. Each instance would see different data:`,
        ...lines,
      ].join("\n"),
      fix: `Move each listed primitive to a shared store, or set ${instancesEnvName}=1 and run one instance.`,
      data: (params: DurabilityDiagnosticData) => params,
    },
    RUNTIME_R0018: {
      why: ({ source, value }: InstanceCountDiagnosticData) => `${source} must be a positive integer. It is ${JSON.stringify(value)}.`,
      fix: `Set ${instancesEnvName} or \`node.instances\` to the number of server instances that share this deployment, such as 1 or 3.`,
      data: (params: InstanceCountDiagnosticData) => params,
    },
  },
})

/**
 * The number of server instances that run this build. `VITEHUB_INSTANCES` wins over `node.instances`, because a
 * deployment often decides the count after the build. The default is 1.
 */
export function readInstanceCount(env: Record<string, string | undefined> = process.env, configured?: number): Pick<DurabilityReport, "instances" | "instancesSource"> {
  const value = env[instancesEnvName]?.trim()
  if (value) {
    if (!/^\d+$/.test(value) || Number(value) < 1) {
      throw durabilityDiagnostics.RUNTIME_R0018({ source: instancesEnvName, value })
    }
    return { instances: Number(value), instancesSource: "env" }
  }
  if (configured === undefined) return { instances: 1, instancesSource: "default" }
  if (!Number.isInteger(configured) || configured < 1) {
    throw durabilityDiagnostics.RUNTIME_R0018({ source: "node.instances", value: String(configured) })
  }
  return { instances: configured, instancesSource: "option" }
}

function label(durability: Durability): string {
  return durability.name ? `${durability.primitive} (${durability.name})` : durability.primitive
}

/** One line per primitive: name, store, scope, and reason, in aligned columns. */
export function formatDurabilityTable(primitives: readonly Durability[]): string {
  const rows = primitives.map(durability => [label(durability), durability.store, durability.scope, durability.reason])
  const widths = [0, 1, 2].map(column => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => `  ${row.map((cell, column) => column < 3 ? cell.padEnd(widths[column]!) : cell).join("  ")}`).join("\n")
}

function instancesLabel(report: Pick<DurabilityReport, "instances" | "instancesSource">): string {
  const count = `${report.instances} instance${report.instances === 1 ? "" : "s"}`
  if (report.instancesSource === "env") return `${count}, from ${instancesEnvName}`
  if (report.instancesSource === "option") return `${count}, from node.instances`
  return `${count}. Set ${instancesEnvName} when you run more`
}

/** The primitives that would split their state across `instances` server instances. */
export function durabilityProblems(primitives: readonly Durability[], instances: number): Durability[] {
  return instances > 1 ? primitives.filter(durability => durability.scope !== "shared") : []
}

/** Builds the error that a server with several instances and a `host` or `process` store fails with. */
export function durabilityError(report: Pick<DurabilityReport, "instances" | "problems">): Error {
  return durabilityDiagnostics.RUNTIME_R0017({
    instances: report.instances,
    lines: report.problems.map(durability => `  - ${label(durability)}: ${durability.store} (${durability.scope}). ${durability.reason}${durability.fix ? ` Fix: ${durability.fix}` : ""}`),
    primitives: report.problems.map(label),
  })
}

const reportKey: unique symbol = Symbol.for("vitehub.durability.report")
const scope = globalThis as typeof globalThis & { [reportKey]?: DurabilityReport }

/** The report that the server recorded at boot, or `undefined` before the boot check runs or outside a Node server. */
export function getDurabilityReport(): DurabilityReport | undefined {
  return scope[reportKey]
}

/**
 * Records the durability of each primitive, prints one line per primitive, and fails when several instances would
 * split state. A Node server runs it once at boot, from a Nitro plugin that ViteHub generates.
 */
export function checkDurability(primitives: readonly Durability[], options: DurabilityCheckOptions = {}): DurabilityReport {
  const count = readInstanceCount(options.env ?? process.env, options.instances)
  const report: DurabilityReport = { ...count, primitives: [...primitives], problems: durabilityProblems(primitives, count.instances) }
  scope[reportKey] = report
  const log = options.log === undefined ? (message: string) => console.info(message) : options.log
  if (log && primitives.length) {
    log(`[vitehub] Durability (${instancesLabel(report)}):\n${formatDurabilityTable(primitives)}`)
  }
  if (options.enforce !== false && report.problems.length) throw durabilityError(report)
  return report
}
