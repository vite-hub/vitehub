import { existsSync } from "node:fs"
import { readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import process from "node:process"

import { editViteHubConfig, locateViteHubConfig } from "@vite-hub/internal/config-edit"
import { listMatchingFiles } from "@vite-hub/internal/definition-catalog"
import { featureIds, features, featureSupport, impliedFeatures } from "@vite-hub/internal/features"
import { dirname, join, relative } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { confirmSetupChange, featurePackages, readFeatureId, setupDiff } from "./add.ts"
import { SetupFailure, setupExitCodes, writeSetupError, writeSetupJson } from "./envelope.ts"
import { readSetupProject } from "./project.ts"
import { setupStatus, uninstallArgs } from "./status.ts"

import type { ViteHubCliCommand, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { ConfigEdit, JsonValue } from "@vite-hub/internal/config-edit"
import type { DeploymentPreset } from "@vite-hub/internal/deployment"
import type { FeatureId, FeatureStarter } from "@vite-hub/internal/features"
import type { SetupChange } from "./add.ts"
import type { SetupProject } from "./project.ts"
import type { SetupStatus } from "./status.ts"

export interface SetupRemoveArgs {
  features: FeatureId[]
  json: boolean
  dryRun: boolean
  yes: boolean
  /** `--keep-files`: keep the starter Definitions. */
  keepFiles: boolean
  /** `--force`: turn the features off while the app still uses them, and write `false` for an implied feature. */
  force: boolean
  /** False with `--no-uninstall`. */
  uninstall: boolean
  help: boolean
}

/** A place where the app still uses a feature that `vitehub remove` turns off. */
export interface SetupReference {
  feature: FeatureId
  /** Relative to the project root. */
  file: string
  line?: number
  /** The import, such as `vite-hub/queue`. Undefined for a Definition file or a discovered file. */
  module?: string
}

export interface SetupRemovePlan {
  /** `planned` for a dry run or a plan that waits for `--yes`, `applied` when done, `unchanged` when there is nothing to do. */
  status: "planned" | "applied" | "unchanged"
  root: string
  host: SetupStatus["host"]
  features: readonly FeatureId[]
  /** Every feature that goes off, with the ones that only the removed features turned on, such as Workflow for Agent. */
  turnedOff: readonly FeatureId[]
  /** The config patch first, then the starter Definitions to delete. */
  changes: readonly SetupChange[]
  /** Files that stay: edited Definitions with `--force`, and starter Definitions with `--keep-files`. */
  kept: readonly { path: string, reason: "edited" | "keep-files" }[]
  /** Uses of the features that `--force` ignored. */
  references: readonly SetupReference[]
  uninstall: { packages: readonly string[], devPackages: readonly string[], command?: string }
  nextSteps: readonly string[]
}

const usage = "vitehub remove <feature...> [--dry-run] [--yes] [--keep-files] [--force] [--no-uninstall] [--json]"

function invalid(message: string): Error {
  return cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${message} Usage: ${usage}` })
}

/** Reads the arguments. Throws `CLI_R0003` for an unknown flag or feature. */
export function readRemoveArgs(args: readonly string[]): SetupRemoveArgs {
  const parsed: SetupRemoveArgs = { dryRun: false, features: [], force: false, help: false, json: false, keepFiles: false, uninstall: true, yes: false }
  for (const arg of args) {
    if (arg === "--json") parsed.json = true
    else if (arg === "--dry-run") parsed.dryRun = true
    else if (arg === "--yes" || arg === "-y") parsed.yes = true
    else if (arg === "--keep-files") parsed.keepFiles = true
    else if (arg === "--force") parsed.force = true
    else if (arg === "--no-uninstall") parsed.uninstall = false
    else if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg.startsWith("-")) throw invalid(`Unknown argument ${JSON.stringify(arg)}.`)
    else {
      const id = readFeatureId(arg, usage)
      if (!parsed.features.includes(id)) parsed.features.push(id)
    }
  }
  return parsed
}

function rerunCommand(args: SetupRemoveArgs): string {
  return [
    "vitehub remove",
    ...args.features,
    ...(args.keepFiles ? ["--keep-files"] : []),
    ...(args.force ? ["--force"] : []),
    ...(args.uninstall ? [] : ["--no-uninstall"]),
    "--yes",
    ...(args.json ? ["--json"] : []),
  ].join(" ")
}

/** The `vite-hub` subpath of a feature, such as `vite-hub/rate-limit`. */
function runtimeModule(id: FeatureId): string {
  return `vite-hub/${id === "sandboxTask" ? "sandbox/task" : id.replace(/[A-Z]/gu, char => `-${char.toLowerCase()}`)}`
}

/** The package of an import, such as `@vite-hub/schedule` for `@vite-hub/schedule/vite`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
}

function importsModule(specifier: string, module: string): boolean {
  return specifier === module || specifier.startsWith(`${module}/`)
}

/** Static imports, re-exports, dynamic imports, and `require` calls. Comments can match, which only makes `remove` stricter. */
const specifierPattern = /\b(?:from|import|require)\s*\(?\s*(["'])([^"'\r\n]+)\1/gu
const sourceFile = /\.(?:[cm]?[jt]sx?|vue)$/iu
const declarationFile = /\.d\.[cm]?[jt]sx?$/iu

function lineAt(content: string, index: number): number {
  let line = 1
  for (let cursor = content.indexOf("\n"); cursor !== -1 && cursor < index; cursor = content.indexOf("\n", cursor + 1)) line++
  return line
}

/** True when `content` equals the current or an earlier starter template for the Definition at `path`. */
function isStarter(starter: FeatureStarter, path: string, content: string): boolean {
  const parts = path.replace(/\.[^./]+$/u, "").split("/")
  const name = [parts.at(-1), parts.at(-2), "default"].find(candidate => candidate && starter.file(candidate) === path)
  return name !== undefined && [starter.template, ...starter.previousTemplates ?? []].some(template => template(name) === content)
}

interface PlannedRemove {
  plan: SetupRemovePlan
  configFile?: { path: string, before: string, after: string }
  /** Starter Definitions to delete. */
  deletes: { path: string, content: string }[]
  uninstall: string[]
}

/** Plans `vitehub remove` without writing anything. Throws `SetupFailure` when the change is not safe or not possible. */
export async function planSetupRemove(project: SetupProject, args: SetupRemoveArgs, env: NodeJS.ProcessEnv): Promise<PlannedRemove> {
  const status = setupStatus(project, env)
  const configFile = project.configFile ?? (project.framework === "nuxt" ? "nuxt.config.ts" : "vite.config.ts")
  const manual = (reason: string) => {
    const snippet = args.features.map(id => `${id}: false,`).join("\n")
    return new SetupFailure(cliErrorDiagnostics.SETUP_CONFIG_MANUAL({ file: configFile, reason, snippet }), setupExitCodes.conflict, { data: { snippet } })
  }
  const host = status.host.name
  if (host === "unknown") throw manual(project.config && !project.config.ok ? project.config.reason : "dynamic-options")

  const keys = project.config?.ok ? project.config.site.keys : {}
  const before = project.configFile ? await readFile(join(project.root, project.configFile), "utf8") : ""
  const simulate = (edits: readonly ConfigEdit[]): { code?: string, status: SetupStatus } => {
    if (!edits.length) return { status }
    if (!project.config?.ok || !project.configFile) throw manual(project.config && !project.config.ok ? project.config.reason : "no-vitehub")
    const result = editViteHubConfig(project.configFile, before, edits)
    if (!result.ok) throw manual(result.reason)
    return { code: result.code, status: setupStatus({ ...project, config: locateViteHubConfig(project.configFile, result.code) }, env) }
  }
  const enabled = (state: SetupStatus, id: FeatureId) => state.features.find(item => item.id === id)!

  // First delete the keys, then write `false` for the features that stay on without a key.
  const edits = new Map<FeatureId, ConfigEdit>()
  for (const id of args.features) {
    const current = keys[id]
    if (current?.kind === "expression") throw manual("dynamic-options")
    if (current && current.value !== false) edits.set(id, { key: id, op: "delete" })
  }
  const deleted = simulate([...edits.values()]).status
  const blocking: SetupReference[] = []
  const directories = project.serverDirs ?? []
  for (const id of args.features) {
    const state = enabled(deleted, id)
    if (state.enabled === "off") continue
    if (state.reason === "implied" && !args.force) {
      const disabled = deleted.features.filter(item => item.enabled === "off" && item.reason === "config").map(item => item.id)
      const by = deleted.features.filter(item => item.enabled === "on" && item.reason !== "implied" && impliedFeatures([item.id], host, disabled).includes(id)).map(item => item.id)
      throw new SetupFailure(cliErrorDiagnostics.SETUP_FEATURE_IMPLIED({ by: by.join(", "), feature: id }), setupExitCodes.conflict, { data: { impliedBy: by } })
    }
    if (state.reason === "default" && !features[id].enabledByDefault && state.enabled === "on") {
      // A discovered file, such as `server/comments.ts`, turns the feature on without a key.
      for (const directory of directories) {
        for (const name of features[id].enabledByDiscovery ?? []) {
          if (existsSync(join(directory, name))) blocking.push({ feature: id, file: relative(project.root, join(directory, name)) })
        }
      }
    }
    edits.set(id, { key: id, op: "set", value: false })
  }
  const after = simulate([...edits.values()])

  const turnedOff = featureIds.filter(id => enabled(status, id).enabled === "on" && enabled(after.status, id).enabled !== "on")
  const remaining = featureIds.filter(id => enabled(after.status, id).enabled !== "off")
  const afterKeys = after.code && project.configFile ? locateViteHubConfig(project.configFile, after.code) : project.config
  const valueOf = (source: typeof project.config, id: FeatureId): JsonValue | undefined => {
    const key = source?.ok ? source.site.keys[id] : undefined
    return key?.kind === "literal" ? key.value : undefined
  }
  const packagesOf = (id: FeatureId, value: JsonValue | undefined, preset: DeploymentPreset) => {
    const packages = featurePackages(id, value, preset)
    return [...packages.prod, ...packages.dev]
  }
  const stillNeeded = new Set(remaining.flatMap(id => packagesOf(id, valueOf(afterKeys, id), host)))

  // Starter Definitions go; other files in a Definition folder are uses of the feature.
  const starters = new Map<string, string>()
  const edited: string[] = []
  for (const id of turnedOff) {
    const starter = features[id].definition
    if (!starter || !existsSync(join(project.root, starter.dir))) continue
    for (const file of listMatchingFiles(join(project.root, starter.dir), () => true)) {
      const path = relative(project.root, file)
      const content = await readFile(file, "utf8")
      if (isStarter(starter, path, content)) {
        starters.set(path, content)
      }
      else {
        blocking.push({ feature: id, file: path })
        edited.push(path)
      }
    }
  }

  const modules = new Map<string, FeatureId>()
  for (const id of turnedOff) {
    modules.set(runtimeModule(id), id)
    for (const name of packagesOf(id, valueOf(project.config, id), host)) if (!stillNeeded.has(name) && !modules.has(name)) modules.set(name, id)
  }
  const imported = new Set<string>()
  for (const file of listMatchingFiles(project.root, name => sourceFile.test(name) && !declarationFile.test(name))) {
    const path = relative(project.root, file)
    // A deleted starter is no use; a kept starter keeps its imports installed.
    if ((starters.has(path) && !args.keepFiles) || edited.includes(path)) continue
    const content = await readFile(file, "utf8")
    for (const match of content.matchAll(specifierPattern)) {
      const specifier = match[2]!
      imported.add(packageName(specifier))
      if (starters.has(path)) continue
      for (const [module, id] of modules) {
        if (importsModule(specifier, module)) blocking.push({ feature: id, file: path, line: lineAt(content, match.index), module: specifier })
      }
    }
  }
  if (blocking.length && !args.force) {
    const list = blocking.map(item => `  ${item.file}${item.line ? `:${item.line}` : ""}${item.module ? ` imports ${item.module}` : ""}`).join("\n")
    const used = [...new Set(blocking.map(item => item.feature))].join(", ")
    throw new SetupFailure(cliErrorDiagnostics.SETUP_FEATURE_IN_USE({ features: used, references: list }), setupExitCodes.conflict, { data: { references: blocking } })
  }

  const prod: string[] = []
  const dev: string[] = []
  for (const id of turnedOff) {
    const packages = featurePackages(id, valueOf(project.config, id), host)
    const removable = (name: string) => !stillNeeded.has(name) && !imported.has(name) && !prod.includes(name) && !dev.includes(name)
    for (const name of packages.prod) if (removable(name) && project.declared(name, false)) prod.push(name)
    for (const name of packages.dev) if (removable(name) && project.declared(name, true)) dev.push(name)
  }
  const uninstall = [...prod, ...dev]
  const command = uninstall.length ? [project.packageManager, ...uninstallArgs(project.packageManager, uninstall)].join(" ") : undefined

  const changes: SetupChange[] = []
  if (after.code !== undefined && after.code !== before) {
    changes.push({ after: after.code, before, diff: setupDiff(project.configFile!, before, after.code), kind: "patch", path: project.configFile! })
  }
  const deletes: PlannedRemove["deletes"] = []
  const kept: SetupRemovePlan["kept"][number][] = []
  for (const [path, content] of starters) {
    if (args.keepFiles) {
      kept.push({ path, reason: "keep-files" })
      continue
    }
    deletes.push({ content, path })
    changes.push({ after: "", before: content, diff: setupDiff(path, content, ""), kind: "delete", path })
  }
  for (const path of edited) kept.push({ path, reason: "edited" })

  const nextSteps: string[] = []
  if (command && !args.uninstall) nextSteps.push(`Uninstall the packages: ${command}`)
  if (edited.length) nextSteps.push(`${edited.join(", ")} stayed because ${edited.length === 1 ? "it differs" : "they differ"} from the starter. Delete or move ${edited.length === 1 ? "it" : "them"} by hand.`)
  const hosted = host === "node" ? [] : turnedOff.flatMap((id) => {
    const support = featureSupport(id, host)
    return support.level === "native" && support.guarantee === "native" ? [`${features[id].title} (${support.display})`] : []
  })
  if (hosted.length) nextSteps.push(`ViteHub does not delete host resources. Delete the resources of ${hosted.join(", ")} on ${host} by hand when you no longer need them.`)
  if (existsSync(join(project.root, ".vitehub/data"))) nextSteps.push("Local data in .vitehub/data stays. Delete it by hand when you no longer need it.")
  if (existsSync(join(project.root, ".vitehub/link.json"))) nextSteps.push("The host credentials and .vitehub/link.json stay unchanged.")
  nextSteps.push("Run `vitehub status` to check the result.")

  const plan: SetupRemovePlan = {
    changes,
    features: args.features,
    host: status.host,
    kept,
    nextSteps,
    references: blocking,
    root: project.root,
    status: changes.length || (command && args.uninstall) ? "planned" : "unchanged",
    turnedOff,
    uninstall: { devPackages: dev, packages: prod, ...(command ? { command } : {}) },
  }
  return { deletes, plan, uninstall, ...(after.code !== undefined && after.code !== before ? { configFile: { after: after.code, before, path: project.configFile! } } : {}) }
}

/** Deletes `path` and then each folder that is empty after it, such as the `server/queues` that `add` created. */
async function deleteStarter(root: string, path: string): Promise<void> {
  await rm(join(root, path))
  for (let folder = dirname(join(root, path)); folder !== root && folder.startsWith(`${root}/`); folder = dirname(folder)) {
    if ((await readdir(folder)).length) return
    await rmdir(folder)
  }
}

async function applyRemove(project: SetupProject, planned: PlannedRemove, args: SetupRemoveArgs, context: ViteHubCliContext): Promise<void> {
  // Check every file before the first write, so a stale plan writes nothing.
  if (planned.configFile && await readFile(join(project.root, planned.configFile.path), "utf8") !== planned.configFile.before) {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_STALE_PLAN({ file: planned.configFile.path }), setupExitCodes.stalePlan)
  }
  for (const file of planned.deletes) {
    if (await readFile(join(project.root, file.path), "utf8").catch(() => undefined) !== file.content) {
      throw new SetupFailure(cliErrorDiagnostics.SETUP_STALE_PLAN({ file: file.path }), setupExitCodes.stalePlan)
    }
  }
  // The config goes first, so the app stops using the feature before its files and packages go.
  if (planned.configFile) await writeFile(join(project.root, planned.configFile.path), planned.configFile.after)
  for (const file of planned.deletes) await deleteStarter(project.root, file.path)
  if (args.uninstall && planned.uninstall.length) {
    const commandArgs = uninstallArgs(project.packageManager, planned.uninstall)
    // The package manager logs to stderr, so `--json` keeps one document on stdout.
    const result = await context.spawn(project.packageManager, commandArgs, { cwd: project.root, env: context.env, stdout: "stderr" })
    if (result.exitCode !== 0) {
      throw new SetupFailure(cliErrorDiagnostics.SETUP_UNINSTALL_FAILED({ command: [project.packageManager, ...commandArgs].join(" "), exitCode: result.exitCode ?? result.signal }), setupExitCodes.error)
    }
  }
}

function writePlan(plan: SetupRemovePlan, context: ViteHubCliContext): void {
  for (const change of plan.changes) context.stdout.write(change.diff.endsWith("\n") ? change.diff : `${change.diff}\n`)
  const extra = plan.turnedOff.filter(id => !plan.features.includes(id))
  const lines = [
    ...(plan.uninstall.command ? [`Uninstall: ${plan.uninstall.command}`] : []),
    ...(extra.length ? [`Also turns off: ${extra.join(", ")}`] : []),
    ...plan.kept.map(file => `Keeps: ${file.path} (${file.reason === "edited" ? "differs from the starter" : "--keep-files"})`),
  ]
  if (lines.length) context.stdout.write(`${lines.join("\n")}\n`)
}

function writeResult(plan: SetupRemovePlan, context: ViteHubCliContext): void {
  if (plan.status === "unchanged") context.stdout.write(`${plan.features.join(", ")} already off. Nothing to change.\n`)
  else context.stdout.write(`Removed ${plan.features.join(", ")}.${plan.changes.length ? ` Changed ${plan.changes.map(change => change.path).join(", ")}.` : ""}\n`)
  context.stdout.write(`\nNext steps:\n${plan.nextSteps.map(step => `- ${step}`).join("\n")}\n`)
}

async function runRemove(args: string[], context: ViteHubCliContext): Promise<number> {
  let parsed: SetupRemoveArgs | undefined
  try {
    parsed = readRemoveArgs(args)
    if (parsed.help) {
      context.stdout.write(`Usage: ${usage}\n\n${removeCommand.description}\n`)
      return setupExitCodes.done
    }
    if (!parsed.features.length) {
      throw new SetupFailure(cliErrorDiagnostics.SETUP_INPUT_NEEDED({ message: "[vitehub] Name at least one feature, such as `vitehub remove kv`." }), setupExitCodes.inputNeeded, {
        missing: [{ choices: featureIds, field: "feature" }],
      })
    }
    const project = await readSetupProject(context.rootDir, context.env)
    const planned = await planSetupRemove(project, parsed, context.env)
    const { plan } = planned
    if (plan.status === "unchanged" || parsed.dryRun) {
      if (parsed.json) writeSetupJson(context, plan)
      else if (plan.status === "unchanged") writeResult(plan, context)
      else writePlan(plan, context)
      return setupExitCodes.done
    }
    if (!parsed.yes) {
      const interactive = !parsed.json && !!process.stdin.isTTY && !!process.stderr.isTTY
      if (!interactive) {
        if (!parsed.json) writePlan(plan, context)
        throw new SetupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] `vitehub remove` changes files and was not confirmed. Without a terminal, pass --yes." }), setupExitCodes.inputNeeded, {
          data: plan,
          rerun: rerunCommand(parsed),
        })
      }
      writePlan(plan, context)
      if (!await confirmSetupChange()) throw new SetupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] The change was not confirmed. Nothing was written." }), setupExitCodes.error)
    }
    await applyRemove(project, planned, parsed, context)
    const applied: SetupRemovePlan = { ...plan, status: "applied" }
    if (parsed.json) writeSetupJson(context, applied)
    else writeResult(applied, context)
    return setupExitCodes.done
  }
  catch (error: unknown) {
    return writeSetupError(context, parsed?.json ?? args.includes("--json"), error)
  }
}

export const removeCommand: ViteHubCliCommand = {
  description: "Turn off features: edit vitehub() options, delete unchanged starter Definitions, and uninstall unused packages. Reads the config without running it.",
  name: "remove",
  run: runRemove,
  usage,
}
