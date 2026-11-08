import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"

import { join } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { applySetupAdd, planSetupAdd, readAddArgs, shellQuote } from "./add.ts"
import { setupCatalog } from "./catalog.ts"
import { SetupFailure, setupExitCodes, writeSetupError } from "./envelope.ts"
import { readSetupProject } from "./project.ts"
import { applySetupRemove, planSetupRemove, readRemoveArgs } from "./remove.ts"
import { setupStatus } from "./status.ts"

import type { ViteHubCliSpawn } from "@vite-hub/internal/cli"
import type { SetupAddArgs, SetupAddPlan, SetupAddPlanned } from "./add.ts"
import type { SetupCatalog } from "./catalog.ts"
import type { PlannedRemove, SetupRemoveArgs, SetupRemovePlan } from "./remove.ts"

/**
 * Runs the package manager with an argument array and no shell. `onOutput` gets its stdout and stderr as they arrive.
 * Tests pass a fake runner.
 */
export type SetupCommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string, env: NodeJS.ProcessEnv, onOutput: (text: string, stream: "stdout" | "stderr") => void },
) => Promise<{ exitCode: number | null, signal?: NodeJS.Signals | null }>

/**
 * A change that the dev Setup page asks for. It names features and options only: never a path or a command. The
 * session turns it into the same arguments as `vitehub add` or `vitehub remove`.
 */
export interface SetupPlanRequest {
  action: "add" | "remove"
  features: readonly string[]
  /** `add`: `--option` values, such as `kv.driver=upstash`. */
  options?: readonly string[]
  /** `add`: `--name` of the starter Definitions. */
  name?: string
  /** `add`: false for `--no-install`. */
  install?: boolean
  /** `remove`: `--force`. */
  force?: boolean
  /** `remove`: `--keep-files`. */
  keepFiles?: boolean
  /** `remove`: false for `--no-uninstall`. */
  uninstall?: boolean
}

/** A JSON document of a setup command, the same as its `--json` output, and the exit code of the command. */
export interface SetupSessionResult {
  exitCode: number
  body: { schemaVersion: 1, [key: string]: unknown }
}

/** Fields that the session adds to a plan document. */
export interface SetupSessionPlanFields {
  /** Applies this plan once with `apply()`. Absent when there is nothing to change. */
  planId?: string
  /** The CLI command that makes the same change. */
  command: string
  /** True when applying writes the config file, so the dev server restarts. */
  restart: boolean
}

export interface SetupSession {
  catalog: () => SetupSessionResult
  status: () => Promise<SetupSessionResult>
  /** Plans a change without writing anything. The document equals `vitehub add|remove ... --dry-run --json`, with {@link SetupSessionPlanFields}. */
  plan: (request: unknown) => Promise<SetupSessionResult>
  /**
   * Applies exactly the stored plan, once. It fails with exit code 4 when a file that the plan read changed, or when
   * planning again would give another plan. Applies run one at a time.
   */
  apply: (planId: unknown, onOutput?: (text: string, stream: "stdout" | "stderr") => void) => Promise<SetupSessionResult>
}

export interface SetupSessionOptions {
  /** The project root. The session never takes a path from a request. */
  root: string
  env: NodeJS.ProcessEnv
  run: SetupCommandRunner
  /** The most plans that the session keeps. The oldest goes first. Defaults to 20. */
  maxPlans?: number
}

type StoredPlan =
  | { action: "add", args: SetupAddArgs, planned: SetupAddPlanned, files: Map<string, string>, fields: SetupSessionPlanFields }
  | { action: "remove", args: SetupRemoveArgs, planned: PlannedRemove, files: Map<string, string>, fields: SetupSessionPlanFields }

const featurePattern = /^[a-z][a-z-]*$/iu

function invalid(message: string): Error {
  return cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${message}` })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function readStrings(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw invalid(`\`${field}\` must be a list of strings.`)
  return value
}

function readFlag(value: unknown, field: string): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value
  throw invalid(`\`${field}\` must be true or false.`)
}

/** The CLI arguments of a request. Every value goes inline after `=`, so no value can become another flag. */
export function setupRequestArgs(request: unknown): { action: "add" | "remove", argv: string[] } {
  if (!isObject(request)) throw invalid("The request must be a JSON object.")
  const action = request.action
  if (action !== "add" && action !== "remove") throw invalid("`action` must be \"add\" or \"remove\".")
  const allowed = action === "add" ? ["action", "features", "options", "name", "install"] : ["action", "features", "force", "keepFiles", "uninstall"]
  const unknown = Object.keys(request).find(key => !allowed.includes(key))
  if (unknown) throw invalid(`Unknown field \`${unknown}\` for ${action}.`)
  const features = readStrings(request.features, "features")
  if (!features.length) throw invalid("Name at least one feature.")
  const bad = features.find(feature => !featurePattern.test(feature))
  if (bad !== undefined) throw invalid(`Unknown feature ${JSON.stringify(bad)}.`)
  const argv = [...features]
  if (action === "add") {
    if (request.name !== undefined && typeof request.name !== "string") throw invalid("`name` must be a string.")
    if (request.name !== undefined) argv.push(`--name=${request.name}`)
    for (const option of readStrings(request.options, "options")) argv.push(`--option=${option}`)
    if (readFlag(request.install, "install") === false) argv.push("--no-install")
  }
  else {
    if (readFlag(request.force, "force")) argv.push("--force")
    if (readFlag(request.keepFiles, "keepFiles")) argv.push("--keep-files")
    if (readFlag(request.uninstall, "uninstall") === false) argv.push("--no-uninstall")
  }
  return { action, argv }
}

/** The SHA-256 of each file, or `absent`. */
async function fingerprint(root: string, paths: Iterable<string>): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const path of new Set(paths)) {
    const content = await readFile(join(root, path)).catch(() => undefined)
    files.set(path, content === undefined ? "absent" : createHash("sha256").update(content).digest("hex"))
  }
  return files
}

function sameChange(left: SetupAddPlan | SetupRemovePlan, right: SetupAddPlan | SetupRemovePlan): boolean {
  const install = (plan: SetupAddPlan | SetupRemovePlan) => "install" in plan ? plan.install : plan.uninstall
  return JSON.stringify([left.changes, install(left)]) === JSON.stringify([right.changes, install(right)])
}

function failureResult(error: unknown): SetupSessionResult {
  let output = ""
  const sink = { write: (chunk: string | Uint8Array) => { output += String(chunk) } }
  const exitCode = writeSetupError({ stderr: sink, stdout: sink }, true, error)
  // SAFETY: `writeSetupError` with `json` writes one `{ schemaVersion: 1, ... }` document.
  return { body: JSON.parse(output) as SetupSessionResult["body"], exitCode }
}

/**
 * The setup engine for a long-running process, such as the dev Setup page. It does what `vitehub status`, `catalog`,
 * `add`, and `remove` do, with the same documents, and keeps each plan until one `apply()` uses it.
 */
export function createSetupSession(options: SetupSessionOptions): SetupSession {
  const plans = new Map<string, StoredPlan>()
  const maxPlans = options.maxPlans ?? 20
  let queue: Promise<unknown> = Promise.resolve()

  async function plan(request: unknown): Promise<SetupSessionResult> {
    try {
      const { action, argv } = setupRequestArgs(request)
      const command = `vitehub ${action} ${[...argv, "--yes"].map(shellQuote).join(" ")}`
      const project = await readSetupProject(options.root, options.env)
      let stored: StoredPlan
      if (action === "add") {
        const args = readAddArgs([...argv, "--dry-run", "--json"])
        const planned = await planSetupAdd(project, args, options.env)
        stored = { action, args, fields: { command, restart: !!planned.configFile }, files: new Map(), planned }
      }
      else {
        const args = readRemoveArgs([...argv, "--dry-run", "--json"])
        const planned = await planSetupRemove(project, args, options.env)
        stored = { action, args, fields: { command, restart: !!planned.configFile }, files: new Map(), planned }
      }
      const { plan: document } = stored.planned
      if (document.status === "planned") {
        stored.files = await fingerprint(project.root, ["package.json", ...(project.configFile ? [project.configFile] : []), ...document.changes.map(change => change.path)])
        const planId = randomUUID()
        stored.fields.planId = planId
        plans.set(planId, stored)
        for (const id of plans.keys()) {
          if (plans.size <= maxPlans) break
          plans.delete(id)
        }
      }
      return { body: { schemaVersion: 1, ...document, ...stored.fields }, exitCode: setupExitCodes.done }
    }
    catch (error: unknown) {
      return failureResult(error)
    }
  }

  async function applyStored(planId: unknown, onOutput: (text: string, stream: "stdout" | "stderr") => void): Promise<SetupSessionResult> {
    try {
      const stored = typeof planId === "string" ? plans.get(planId) : undefined
      if (!stored || typeof planId !== "string") throw new SetupFailure(cliErrorDiagnostics.SETUP_PLAN_UNKNOWN(), setupExitCodes.error)
      // A plan applies once, also when the apply fails.
      plans.delete(planId)
      const current = await fingerprint(options.root, stored.files.keys())
      for (const [path, hash] of stored.files) {
        if (current.get(path) !== hash) throw new SetupFailure(cliErrorDiagnostics.SETUP_STALE_PLAN({ file: path }), setupExitCodes.stalePlan)
      }
      // Files that the plan did not record, such as an import that `remove` scans for, can still change the plan.
      const project = await readSetupProject(options.root, options.env)
      const again = stored.action === "add" ? await planSetupAdd(project, stored.args, options.env) : await planSetupRemove(project, stored.args, options.env)
      if (!sameChange(stored.planned.plan, again.plan)) {
        throw new SetupFailure(cliErrorDiagnostics.SETUP_STALE_PLAN({ file: project.configFile ?? "the project" }), setupExitCodes.stalePlan)
      }
      const spawn: ViteHubCliSpawn = async (command, args, spawnOptions) => await options.run(command, args, { cwd: spawnOptions?.cwd ?? project.root, env: spawnOptions?.env ?? options.env, onOutput })
      const context = { env: options.env, spawn }
      if (stored.action === "add") await applySetupAdd(project, stored.planned, stored.args, context)
      else await applySetupRemove(project, stored.planned, stored.args, context, { configLast: true })
      const { planId: _planId, ...fields } = stored.fields
      return { body: { schemaVersion: 1, ...stored.planned.plan, status: "applied", ...fields }, exitCode: setupExitCodes.done }
    }
    catch (error: unknown) {
      return failureResult(error)
    }
  }

  return {
    apply: async (planId, onOutput = () => {}) => {
      const result = queue.then(async () => await applyStored(planId, onOutput))
      queue = result
      return await result
    },
    catalog: () => {
      const catalog: SetupCatalog = setupCatalog()
      // Starter templates are functions, so the document keeps only the data.
      return { body: JSON.parse(JSON.stringify(catalog)) as SetupSessionResult["body"], exitCode: setupExitCodes.done }
    },
    plan,
    status: async () => {
      try {
        return { body: { ...setupStatus(await readSetupProject(options.root, options.env), options.env) }, exitCode: setupExitCodes.done }
      }
      catch (error: unknown) {
        return failureResult(error)
      }
    },
  }
}
