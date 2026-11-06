import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import process from "node:process"
import { createInterface } from "node:readline/promises"

import { editViteHubConfig } from "@vite-hub/internal/config-edit"
import { featureIds, features, featureSupport, impliedFeatures } from "@vite-hub/internal/features"
import { createTwoFilesPatch } from "diff"
import { basename, dirname, join } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { setupExitCodes, writeSetupError, writeSetupJson } from "./envelope.ts"
import { readSetupProject } from "./project.ts"
import { installArgs, installCommand, setsOption, setupStatus } from "./status.ts"

import type { ViteHubCliCommand, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { ConfigEdit, JsonValue } from "@vite-hub/internal/config-edit"
import type { FeatureId } from "@vite-hub/internal/features"
import type { SetupFailure, SetupMissing } from "./envelope.ts"
import type { SetupProject } from "./project.ts"
import type { SetupStatus } from "./status.ts"

export interface SetupAddArgs {
  features: FeatureId[]
  json: boolean
  dryRun: boolean
  yes: boolean
  install: boolean
  name?: string
  /** `--option` values, by feature. */
  options: Partial<Record<FeatureId, Record<string, JsonValue>>>
  help: boolean
}

export interface SetupChange {
  /** Relative to the project root. */
  path: string
  kind: "create" | "patch"
  before?: string
  after: string
  /** A unified diff from `before` to `after`. */
  diff: string
}

export interface SetupAddPlan {
  /** `planned` for a dry run or a plan that waits for `--yes`, `applied` when done, `unchanged` when there is nothing to do. */
  status: "planned" | "applied" | "unchanged"
  root: string
  host: SetupStatus["host"]
  features: readonly FeatureId[]
  changes: readonly SetupChange[]
  install: { packages: readonly string[], devPackages: readonly string[], command?: string }
  /** Features that the added features turn on. Only supplied provider options need an explicit config key. */
  implied: readonly FeatureId[]
  nextSteps: readonly string[]
}

/** A failure with its exit code, `missing`, and `rerun`. */
class SetupAddError extends Error {
  constructor(readonly error: Error, readonly failure: SetupFailure) {
    super(error.message)
  }
}

const usage = "vitehub add <feature...> [--name <definition>] [--option <key=value>]... [--dry-run] [--yes] [--no-install] [--json]"

/**
 * Values that `--option` can choose for an `explicit` host, first the one that `rerun` uses, and the feature that the
 * value needs. Options without an entry, such as `database.connection`, need a value that only the developer knows.
 */
const optionChoices: Partial<Record<string, { values: readonly [string, ...string[]], requires?: FeatureId }>> = {
  "cache.driver": { requires: "kv", values: ["kv"] },
  "email.driver": { values: ["resend"] },
  "kv.driver": { values: ["upstash"] },
  "realtime.authority": { values: ["memory"] },
  "workflow.provider": { values: ["openworkflow"] },
}

/** Features whose key accepts only a boolean. */
const booleanFeatures: readonly FeatureId[] = ["queue", "sandboxTask"]
/** The value that turns a feature on, when `true` is not valid for its key. */
const enabledValues: Partial<Record<FeatureId, JsonValue>> = { env: {} }
/** Options without a default that the feature key needs. */
const requiredOptions: Partial<Record<FeatureId, readonly string[]>> = { observability: ["service"] }

function invalid(message: string): Error {
  return cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${message} Usage: ${usage}` })
}

function featureId(value: string): FeatureId {
  const key = value.replaceAll("-", "").toLowerCase()
  const id = featureIds.find(item => item.toLowerCase() === key)
  if (!id) throw invalid(`Unknown feature ${JSON.stringify(value)}. Run \`vitehub catalog\` to list the features.`)
  return id
}

function optionValue(value: string): JsonValue {
  if (value === "true" || value === "false" || value === "null" || /^-?\d+(?:\.\d+)?$/u.test(value)) return JSON.parse(value) as JsonValue
  return value
}

function setPath(target: Record<string, JsonValue>, path: readonly string[], value: JsonValue): void {
  const [key, ...rest] = path as [string, ...string[]]
  if (!rest.length) {
    target[key] = value
    return
  }
  const child = target[key]
  const next: Record<string, JsonValue> = isRecord(child) ? { ...child } : {}
  setPath(next, rest, value)
  target[key] = next
}

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Reads the arguments. Throws `CLI_R0003` for an unknown flag, feature, or option. */
export function readAddArgs(args: readonly string[]): SetupAddArgs {
  const parsed: SetupAddArgs = { dryRun: false, features: [], help: false, install: true, json: false, options: {}, yes: false }
  const rawOptions: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined]
    const value = (): string => {
      const next = inline ?? args[++index]
      if (next === undefined || (inline === undefined && next.startsWith("--"))) throw invalid(`${flag} needs a value.`)
      return next
    }
    if (flag === "--json") parsed.json = true
    else if (flag === "--dry-run") parsed.dryRun = true
    else if (flag === "--yes" || flag === "-y") parsed.yes = true
    else if (flag === "--no-install") parsed.install = false
    else if (flag === "-h" || flag === "--help") parsed.help = true
    else if (flag === "--name") parsed.name = value()
    else if (flag === "--option") rawOptions.push(value())
    else if (arg.startsWith("-")) throw invalid(`Unknown argument ${JSON.stringify(arg)}.`)
    else if (!parsed.features.includes(featureId(arg))) parsed.features.push(featureId(arg))
  }
  if (parsed.name !== undefined && !/^[a-z0-9][a-z0-9-]*$/u.test(parsed.name)) {
    throw invalid(`--name ${JSON.stringify(parsed.name)} must use lowercase letters, digits, and dashes, such as \`welcome-email\`.`)
  }
  for (const option of rawOptions) {
    const separator = option.indexOf("=")
    if (separator <= 0) throw invalid(`--option ${JSON.stringify(option)} must be key=value, such as \`email.driver=resend\`.`)
    const path = option.slice(0, separator).split(".")
    const head = featureIds.find(id => id === path[0])
    const id = head ?? (parsed.features.length === 1 ? parsed.features[0] : undefined)
    const keys = head ? path.slice(1) : path
    if (!id || !keys.length || keys.some(key => !key)) throw invalid(`--option ${JSON.stringify(option)} must start with one of the features, such as \`${parsed.features[0] ?? "email"}.driver=resend\`.`)
    if (booleanFeatures.includes(id)) throw invalid(`${id} has no options. Its key accepts only true or false.`)
    setPath(parsed.options[id] ??= {}, keys, optionValue(option.slice(separator + 1)))
  }
  return parsed
}

function quote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

function flatten(prefix: string, value: JsonValue, out: string[]): string[] {
  if (isRecord(value)) for (const [key, child] of Object.entries(value)) flatten(`${prefix}.${key}`, child, out)
  else out.push(`${prefix}=${value === null || typeof value !== "object" ? String(value) : JSON.stringify(value)}`)
  return out
}

/** The `vitehub add` command for `args`, with `extra` options and `--yes` unless it is a dry run. */
function rerunCommand(args: SetupAddArgs, extra: Partial<Record<FeatureId, Record<string, JsonValue>>> = {}, extraFeatures: readonly FeatureId[] = []): string {
  const ids = [...args.features, ...extraFeatures.filter(id => !args.features.includes(id))]
  const optionIds = [...new Set([...ids, ...Object.keys(args.options), ...Object.keys(extra)])] as FeatureId[]
  const options = optionIds.flatMap((id) => {
    const merged = mergeValue(args.options[id], extra[id])
    return isRecord(merged) ? flatten(id, merged, []) : []
  })
  return [
    "vitehub add",
    ...ids,
    ...(args.name ? ["--name", args.name] : []),
    ...options.flatMap(option => ["--option", quote(option)]),
    ...(args.install ? [] : ["--no-install"]),
    ...(args.dryRun ? ["--dry-run"] : ["--yes"]),
    ...(args.json ? ["--json"] : []),
  ].join(" ")
}

function mergeValue(base: JsonValue | undefined, patch: JsonValue | undefined): JsonValue | undefined {
  if (patch === undefined) return base
  if (!isRecord(base) || !isRecord(patch)) return patch
  const merged: Record<string, JsonValue> = { ...base }
  for (const [key, value] of Object.entries(patch)) merged[key] = mergeValue(base[key], value)!
  return merged
}

function sameValue(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (isRecord(left) && isRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    return [...keys].every(key => sameValue(left[key], right[key]))
  }
  return JSON.stringify(left) === JSON.stringify(right)
}

function toSource(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(toSource).join(", ")}]`
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, child]) => `${/^[A-Z_$][\w$]*$/iu.test(key) ? key : JSON.stringify(key)}: ${toSource(child)}`)
    return entries.length ? `{ ${entries.join(", ")} }` : "{}"
  }
  return JSON.stringify(value)
}

function diffOf(path: string, before: string, after: string): string {
  return createTwoFilesPatch(before ? `a/${path}` : "/dev/null", `b/${path}`, before, after, undefined, undefined, { context: 3 })
    .replace(/^=+\n/u, "")
}

/**
 * The config value that `add` writes for `id`, `undefined` when the config already turns it on, or `expression` when
 * the key is an expression that only a person can edit.
 */
function nextValue(id: FeatureId, status: SetupStatus, project: SetupProject, options: Record<string, JsonValue> | undefined): { value: JsonValue } | "expression" | undefined {
  const current = project.config?.ok ? project.config.site.keys[id] : undefined
  if (current?.kind === "expression") return "expression"
  const literal = current?.value
  if (!options) {
    const on = status.features.find(item => item.id === id)!.enabled === "on"
    return on ? undefined : { value: enabledValues[id] ?? true }
  }
  const merged = mergeValue(isRecord(literal) ? literal : {}, options)!
  return sameValue(literal, merged) ? undefined : { value: merged }
}

interface Planned {
  plan: SetupAddPlan
  configFile?: { path: string, before: string, after: string }
  files: { path: string, content: string }[]
  install: { prod: string[], dev: string[] }
}

/** Plans `vitehub add` without writing anything. Throws `SetupAddError` when the change needs input or is not possible. */
export async function planSetupAdd(project: SetupProject, args: SetupAddArgs, env: NodeJS.ProcessEnv): Promise<Planned> {
  const status = setupStatus(project, env)
  const host = status.host.name
  if (host === "unknown") {
    const file = project.configFile ?? "vite.config.ts"
    const reason = project.config && !project.config.ok ? project.config.reason : "dynamic-options"
    const snippet = args.features.map(id => `${id}: ${toSource(mergeValue(true, args.options[id])!)},`).join("\n")
    throw new SetupAddError(cliErrorDiagnostics.SETUP_CONFIG_MANUAL({ file, reason, snippet }), { data: { snippet }, exitCode: setupExitCodes.conflict })
  }

  for (const id of args.features) {
    const support = featureSupport(id, host)
    const current = project.config?.ok ? project.config.site.keys[id] : undefined
    const driver = args.options[id]?.driver ?? (current?.kind === "literal" && isRecord(current.value) ? current.value.driver : undefined)
    if (id === "email" && driver === "cloudflare-email" && host !== "cloudflare") {
      throw new SetupAddError(cliErrorDiagnostics.SETUP_FEATURE_UNSUPPORTED({ detail: "The cloudflare-email driver requires Cloudflare. Choose email.driver=resend on this host.", feature: id, host }), { exitCode: setupExitCodes.conflict })
    }
    if (support.level === "unsupported") {
      throw new SetupAddError(cliErrorDiagnostics.SETUP_FEATURE_UNSUPPORTED({ detail: support.detail, feature: id, host }), { exitCode: setupExitCodes.conflict })
    }
  }

  const missing: SetupMissing[] = []
  const defaults: Partial<Record<FeatureId, Record<string, JsonValue>>> = {}
  const requires: FeatureId[] = []
  let rerunnable = true
  const keep = status.features.filter(item => item.enabled === "off" && item.reason === "config" && !args.features.includes(item.id)).map(item => item.id)
  // Implications and provider prerequisites need their inputs before any file can be written.
  const inputFeatures = [...args.features, ...impliedFeatures(args.features, host, keep)]
  for (const id of inputFeatures) {
    const support = featureSupport(id, host)
    const options = args.options[id]
    const current = project.config?.ok ? project.config.site.keys[id] : undefined
    const value = mergeValue(current?.kind === "literal" ? current.value : undefined, options)
    if (support.level === "explicit") {
      const key = support.option.slice(id.length + 1)
      if (!(options && key in options) && !setsOption(project, support.option)) {
        const choices = optionChoices[support.option]
        missing.push({ field: support.option, ...(choices ? { choices: choices.values } : {}) })
        if (choices) setPath(defaults[id] ??= {}, [key], choices.values[0])
        else rerunnable = false
      }
    }
    for (const [field, choice] of Object.entries(optionChoices)) {
      if (!choice?.requires || !field.startsWith(`${id}.`)) continue
      const key = field.slice(id.length + 1)
      const selected = (isRecord(value) ? value[key] : undefined) ?? defaults[id]?.[key]
      if (typeof selected !== "string" || !choice.values.includes(selected)) continue
      if (!inputFeatures.includes(choice.requires)) inputFeatures.push(choice.requires)
      if (!args.features.includes(choice.requires) && !requires.includes(choice.requires) && status.features.find(item => item.id === choice.requires)?.enabled !== "on") requires.push(choice.requires)
    }
    if (id === "schedule" && host === "node" && current?.kind !== "expression" && !(isRecord(value) && value.providerOutput === false)) {
      if (isRecord(value) && (value.providerOutput === "nitro" || value.providerOutput === "standalone")) {
        missing.push({ choices: ["auto"], field: "schedule.providerOutput" })
        setPath(defaults.schedule ??= {}, ["providerOutput"], "auto")
      }
      if (!isRecord(value) || value.runtime === undefined) {
        missing.push({ choices: ["process"], field: "schedule.runtime.driver" })
        setPath(defaults.schedule ??= {}, ["runtime", "driver"], "process")
      }
    }
    for (const key of requiredOptions[id] ?? []) {
      if (options && key in options) continue
      if (setsOption(project, `${id}.${key}`)) continue
      missing.push({ field: `${id}.${key}` })
      setPath(defaults[id] ??= {}, [key], basename(project.root).toLowerCase().replace(/[^a-z0-9]+/gu, "-") || "app")
    }
  }
  for (const id of Object.keys(args.options) as FeatureId[]) {
    if (!inputFeatures.includes(id)) throw invalid(`${id} is not requested or required by ${args.features.join(", ")}.`)
  }
  if (missing.length) {
    const fields = missing.map(item => `\`${item.field}\``).join(", ")
    throw new SetupAddError(cliErrorDiagnostics.SETUP_INPUT_NEEDED({ message: `[vitehub] Set ${fields} to add ${args.features.join(", ")} on the ${host} preset.` }), {
      exitCode: setupExitCodes.inputNeeded,
      missing,
      ...(rerunnable ? { rerun: rerunCommand(args, defaults, requires) } : {}),
    })
  }

  const edits: ConfigEdit[] = []
  let expression = false
  const addedFeatures = [...args.features, ...requires]
  for (const id of new Set([...addedFeatures, ...inputFeatures.filter(id => args.options[id])])) {
    const next = nextValue(id, status, project, args.options[id])
    expression ||= next === "expression"
    if (next !== undefined) edits.push({ key: id, op: "set", value: next === "expression" ? mergeValue(true, args.options[id])! : next.value })
  }

  const changes: SetupChange[] = []
  const files: Planned["files"] = []
  let configFile: Planned["configFile"]

  // Starter Definition files.
  if (args.name !== undefined) {
    const withStarter = args.features.filter(id => features[id].definition)
    if (!withStarter.length) throw invalid(`${args.features.join(", ")} has no Definition files, so --name has no effect. Features with Definitions: ${featureIds.filter(id => features[id].definition).join(", ")}.`)
    for (const id of withStarter) {
      const starter = features[id].definition!
      const path = starter.file(args.name)
      const content = starter.template(args.name)
      const file = join(project.root, path)
      if (existsSync(file)) {
        if (await readFile(file, "utf8") === content) continue
        throw new SetupAddError(cliErrorDiagnostics.SETUP_FILE_EXISTS({ file: path }), { exitCode: setupExitCodes.conflict })
      }
      files.push({ content, path })
      changes.push({ after: content, diff: diffOf(path, "", content), kind: "create", path })
    }
  }

  if (edits.length) {
    const manualReason = !project.config ? "no-vitehub" : !project.config.ok ? project.config.reason : expression ? "dynamic-options" : undefined
    const file = project.configFile ?? (project.framework === "nuxt" ? "nuxt.config.ts" : "vite.config.ts")
    const snippet = edits.map(edit => edit.op === "set" ? `${edit.key}: ${toSource(edit.value)},` : "").join("\n")
    const manual = (reason: string) => new SetupAddError(cliErrorDiagnostics.SETUP_CONFIG_MANUAL({ file, reason, snippet }), { data: { snippet }, exitCode: setupExitCodes.conflict })
    if (manualReason || !project.configFile) throw manual(manualReason ?? "no-vitehub")
    const before = await readFile(join(project.root, project.configFile), "utf8")
    const result = editViteHubConfig(project.configFile, before, edits)
    if (!result.ok) throw manual(result.reason)
    configFile = { after: result.code, before, path: project.configFile }
    changes.push({ after: result.code, before, diff: diffOf(project.configFile, before, result.code), kind: "patch", path: project.configFile })
  }

  // The features that this command turns on, through the config or through an implication.
  const alreadyOn = new Set(status.features.filter(item => item.enabled === "on").map(item => item.id))
  const implied = impliedFeatures([...new Set([...alreadyOn, ...addedFeatures])], host, keep.filter(id => !requires.includes(id))).filter(id => !addedFeatures.includes(id))
  const install: Planned["install"] = { dev: [], prod: [] }
  for (const id of [...addedFeatures, ...implied]) {
    for (const name of features[id].packages) if (!project.declared(name, false) && !install.prod.includes(name)) install.prod.push(name)
    for (const name of features[id].devPackages) if (!project.declared(name, true) && !install.dev.includes(name)) install.dev.push(name)
  }
  const command = installCommand(project.packageManager, install.prod, install.dev)

  const nextSteps: string[] = []
  if (command && !args.install) nextSteps.push(`Install the packages: ${command}`)
  for (const id of implied) {
    const support = featureSupport(id, host)
    if (support.level === "unsupported") nextSteps.push(`${id} is turned on by ${args.features.join(", ")} but is not supported on ${host}: ${support.detail} Set \`${id}: false\` to turn it off.`)
    else if (support.level === "explicit" && !setsOption(project, support.option) && !(args.options[id] && support.option.slice(id.length + 1) in args.options[id])) nextSteps.push(`${id} is turned on by ${args.features.join(", ")}. Set \`${support.option}\` on ${host}, or set \`${id}: false\`. ${support.detail}`)
  }
  if (args.name !== undefined && args.features.includes("realtime")) nextSteps.push(`server/realtime/${args.name}.ts stores documents in the Workspace "${args.name}". Add a Workspace Definition in server/workspaces/${args.name}.ts.`)
  for (const id of args.features) nextSteps.push(`${features[id].title}: https://vitehub.dev${features[id].docs}`)
  nextSteps.push("Run `vitehub status` to check the result.")

  const plan: SetupAddPlan = {
    changes,
    features: addedFeatures,
    host: status.host,
    implied,
    install: { devPackages: install.dev, packages: install.prod, ...(command ? { command } : {}) },
    nextSteps,
    root: project.root,
    status: changes.length || (command && args.install) ? "planned" : "unchanged",
  }
  return { files, install, plan, ...(configFile ? { configFile } : {}) }
}

async function applyPlan(project: SetupProject, planned: Planned, args: SetupAddArgs, context: ViteHubCliContext): Promise<void> {
  const { dev, prod } = planned.install
  if (args.install) {
    for (const [packages, isDev] of [[prod, false], [dev, true]] as const) {
      if (!packages.length) continue
      const commandArgs = installArgs(project.packageManager, packages, isDev)
      // The package manager logs to stderr, so `--json` keeps one document on stdout.
      const result = await context.spawn(project.packageManager, commandArgs, { cwd: project.root, env: context.env, stdout: "stderr" })
      if (result.exitCode !== 0) {
        throw new SetupAddError(cliErrorDiagnostics.SETUP_INSTALL_FAILED({ command: [project.packageManager, ...commandArgs].join(" "), exitCode: result.exitCode ?? result.signal }), { exitCode: setupExitCodes.error })
      }
    }
  }
  for (const file of planned.files) {
    await mkdir(dirname(join(project.root, file.path)), { recursive: true })
    // `wx` fails when the file appeared after the plan, so a file is never overwritten.
    try {
      await writeFile(join(project.root, file.path), file.content, { flag: "wx" })
    }
    catch {
      throw new SetupAddError(cliErrorDiagnostics.SETUP_FILE_EXISTS({ file: file.path }), { exitCode: setupExitCodes.conflict })
    }
  }
  if (planned.configFile) {
    const path = join(project.root, planned.configFile.path)
    if (await readFile(path, "utf8") !== planned.configFile.before) {
      throw new SetupAddError(cliErrorDiagnostics.SETUP_STALE_PLAN({ file: planned.configFile.path }), { exitCode: setupExitCodes.stalePlan })
    }
    await writeFile(path, planned.configFile.after)
  }
}

function writePlan(plan: SetupAddPlan, context: ViteHubCliContext): void {
  for (const change of plan.changes) context.stdout.write(change.diff.endsWith("\n") ? change.diff : `${change.diff}\n`)
  const lines = [
    ...(plan.install.command ? [`Install: ${plan.install.command}`] : []),
    ...(plan.implied.length ? [`Also turns on: ${plan.implied.join(", ")}`] : []),
  ]
  if (lines.length) context.stdout.write(`${lines.join("\n")}\n`)
}

function writeResult(plan: SetupAddPlan, context: ViteHubCliContext): void {
  if (plan.status === "unchanged") context.stdout.write(`${plan.features.join(", ")} already on. Nothing to change.\n`)
  else context.stdout.write(`Added ${plan.features.join(", ")}.${plan.changes.length ? ` Changed ${plan.changes.map(change => change.path).join(", ")}.` : ""}\n`)
  context.stdout.write(`\nNext steps:\n${plan.nextSteps.map(step => `- ${step}`).join("\n")}\n`)
}

async function confirm(): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(?:es)?$/iu.test((await terminal.question("Apply these changes? [y/N] ")).trim())
  }
  finally {
    terminal.close()
  }
}

async function runAdd(args: string[], context: ViteHubCliContext): Promise<number> {
  let parsed: SetupAddArgs | undefined
  try {
    parsed = readAddArgs(args)
    if (parsed.help) {
      context.stdout.write(`Usage: ${usage}\n\n${addCommand.description}\n`)
      return setupExitCodes.done
    }
    if (!parsed.features.length) {
      throw new SetupAddError(cliErrorDiagnostics.SETUP_INPUT_NEEDED({ message: "[vitehub] Name at least one feature, such as `vitehub add kv`." }), {
        exitCode: setupExitCodes.inputNeeded,
        missing: [{ choices: featureIds, field: "feature" }],
      })
    }
    const project = await readSetupProject(context.rootDir, context.env)
    const planned = await planSetupAdd(project, parsed, context.env)
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
        throw new SetupAddError(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] `vitehub add` changes files and was not confirmed. Without a terminal, pass --yes." }), {
          data: plan,
          exitCode: setupExitCodes.inputNeeded,
          rerun: rerunCommand(parsed),
        })
      }
      writePlan(plan, context)
      if (!await confirm()) throw new SetupAddError(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] The change was not confirmed. Nothing was written." }), { exitCode: setupExitCodes.error })
    }
    await applyPlan(project, planned, parsed, context)
    const applied: SetupAddPlan = { ...plan, status: "applied" }
    if (parsed.json) writeSetupJson(context, applied)
    else writeResult(applied, context)
    return setupExitCodes.done
  }
  catch (error: unknown) {
    const json = parsed?.json ?? args.includes("--json")
    if (error instanceof SetupAddError) return writeSetupError(context, json, error.error, error.failure)
    return writeSetupError(context, json, error)
  }
}

export const addCommand: ViteHubCliCommand = {
  description: "Turn on features: edit vitehub() options, install packages, and create starter Definitions. Reads the config without running it.",
  name: "add",
  run: runAdd,
  usage,
}
