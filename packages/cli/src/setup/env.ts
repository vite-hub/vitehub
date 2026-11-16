import { randomBytes } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { readFile, realpath, stat } from "node:fs/promises"
import process from "node:process"
import { createInterface } from "node:readline/promises"
import { parseArgs, parseEnv } from "node:util"

import { withViteStageEnvironment } from "@vite-hub/internal/vite-stage"
import { basename, dirname, join, relative } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { build, readBuildOutput } from "./build-output.ts"
import { cloudflareEnv } from "./deploy/cloudflare.ts"
import { denoEnv } from "./deploy/deno.ts"
import { createDeployRun } from "./deploy/host.ts"
import { netlifyEnv } from "./deploy/netlify.ts"
import { vercelEnv } from "./deploy/vercel.ts"
import { SetupFailure, setupExitCodes, writeSetupError, writeSetupJson } from "./envelope.ts"
import { hostRequired, readLinkHostOption, readSetupLinks, selectSetupLink } from "./link.ts"
import { readSetupProject } from "./project.ts"

import type { DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"
import type { ViteHubCliContext, ViteHubCliFeature } from "@vite-hub/internal/cli"
import type { BuildOutput } from "./build-output.ts"
import type { DeployHost, DeployRun, HostEnv, HostEnvContext, HostEnvTarget } from "./deploy/host.ts"
import type { SetupLink } from "./link.ts"
import type { SetupProject } from "./project.ts"

/** The stage that a deploy without `--preview` reads. */
const defaultStage = "production"

/** The host CLI tokens. They are never values to push, and no output may show them. */
const tokenNames = ["CLOUDFLARE_API_TOKEN", "VERCEL_TOKEN", "NETLIFY_AUTH_TOKEN", "DENO_DEPLOY_TOKEN"]

const hostEnvs: Record<DeployHost, (context: HostEnvContext) => HostEnv> = {
  cloudflare: cloudflareEnv,
  deno: denoEnv,
  netlify: netlifyEnv,
  vercel: vercelEnv,
}

/** Hosts without a preview environment: a Worker has one set of secrets, and ViteHub deploys Deno to production only. */
const noPreview: ReadonlySet<DeployHost> = new Set(["cloudflare", "deno"])

interface EnvArgs {
  host?: DeployHost
  stage: string
  only: string[]
  yes: boolean
  json: boolean
  help: boolean
}

/** One set of names that the app reads, without its values. */
export interface EnvDiffEntry {
  names: readonly string[]
  prefix?: string
  path?: string
  owners?: readonly string[]
  secret: boolean
}

/** What `vitehub env diff --json` prints, after `schemaVersion: 1`. */
export interface EnvDiffOutput {
  host: DeployHost
  project: string
  stage: string
  target: HostEnvTarget
  /** True when no required name is missing. */
  ok: boolean
  missing: { required: EnvDiffEntry[], optional: EnvDiffEntry[] }
  /** Names on the host that no entry of the build reads. */
  extra: string[]
}

/**
 * Where a pushed value came from: the shell, one of the stage env files relative to the project root, such as
 * `.env.production` or `config/.env.production` with `envDir: "config"`, or `vitehub deploy`, which generated it.
 */
export type EnvValueSource = "process" | "generated" | `${string}.env${string}`

/** What `vitehub env push --json` prints, after `schemaVersion: 1`. Never a value. */
export interface EnvPushOutput {
  host: DeployHost
  project: string
  stage: string
  target: HostEnvTarget
  pushed: { name: string, source: EnvValueSource, secret: boolean, replaced: boolean }[]
  /** Entries without a local value. The host keeps what it has. */
  skipped: (EnvDiffEntry & { required: boolean })[]
}

function readEnvArgs(args: readonly string[], push: boolean, usage: string | undefined): EnvArgs {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        help: { short: "h", type: "boolean", default: false },
        host: { type: "string" },
        json: { type: "boolean", default: false },
        stage: { type: "string" },
        ...(push ? { only: { multiple: true, type: "string" }, yes: { short: "y", type: "boolean", default: false } } : {}),
      },
      strict: true,
    })
    const host = readLinkHostOption(typeof values.host === "string" ? values.host : undefined)
    const stage = typeof values.stage === "string" ? values.stage : defaultStage
    const only = Array.isArray(values.only) ? values.only.filter(item => typeof item === "string") : []
    return { help: values.help === true, ...(host ? { host } : {}), json: values.json === true, only, stage, yes: values.yes === true }
  }
  catch (error: unknown) {
    if (error instanceof SetupFailure || (error instanceof Error && "why" in error)) throw error
    throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${error instanceof Error ? error.message : String(error)} Usage: ${usage}` })
  }
}

function stageTarget(host: DeployHost, stage: string): HostEnvTarget {
  if (stage === "production") return "production"
  if (stage !== "preview" || noPreview.has(host)) throw new SetupFailure(cliErrorDiagnostics.SETUP_ENV_STAGE_UNSUPPORTED({ host, stage }), setupExitCodes.conflict)
  return "preview"
}

function linkedTarget(links: Awaited<ReturnType<typeof readSetupLinks>>, host: DeployHost | undefined, command: string): SetupLink {
  const selected = selectSetupLink(links, host)
  if ("ambiguous" in selected) throw hostRequired(selected.ambiguous, command)
  if (!selected.link) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOYMENTS_NOT_LINKED({ host }), setupExitCodes.inputNeeded, { missing: [{ field: "link" }], rerun: host ? `vitehub link --host ${host}` : "vitehub link" })
  return selected.link
}

/** The names and the env folder of the last build for `host`. Builds first when there is no build output for `host`. */
async function readNames(project: SetupProject, host: DeployHost, context: ViteHubCliContext): Promise<BuildOutput> {
  try {
    return await readBuildOutput(project.root, host)
  }
  catch (error: unknown) {
    const code = error instanceof SetupFailure ? Reflect.get(error.cause, "code") : undefined
    if (code !== "SETUP_DEPLOY_OUTPUT_MISSING" && code !== "SETUP_DEPLOY_HOST_MISMATCH") throw error
  }
  context.stderr.write(`No build output for ${host}. Building it to read the names.\n`)
  await build(project, host, context)
  return await readBuildOutput(project.root, host)
}

interface EnvTarget {
  host: DeployHost
  link: SetupLink
  stage: string
  target: HostEnvTarget
  project: SetupProject
  entries: DeploymentEnvEntry[]
  /** Vite's resolved `envDir` of the build, or `false` when the app loads no env file. */
  envDir: string | false
  hostEnv: HostEnv
  run: DeployRun
  /** Values that no output may show. Push adds the values that it reads. */
  secrets: string[]
}

async function openTarget(args: EnvArgs, command: string, context: ViteHubCliContext): Promise<EnvTarget> {
  const project = await readSetupProject(context.rootDir, context.env)
  const link = linkedTarget(await readSetupLinks(project.root), args.host, command)
  const host = link.host
  const target = stageTarget(host, args.stage)
  const { env: entries, envDir } = await readNames(project, host, context)
  const secrets = tokenNames.flatMap((name) => {
    const token = context.env[name]?.trim()
    return token ? [token] : []
  })
  // The runner reads `secrets` at each run, so values that push adds later are redacted too.
  const run = createDeployRun(context.stderr, secrets)
  const hostEnv = hostEnvs[host]({ env: context.env, fetch: context.fetch ?? globalThis.fetch, link, root: project.root, run, secrets, target })
  return { entries, envDir, host, hostEnv, link, project, run, secrets, stage: args.stage, target }
}

function diffEntry(entry: DeploymentEnvEntry): EnvDiffEntry {
  return {
    names: entry.names,
    ...(entry.prefix ? { prefix: entry.prefix } : {}),
    ...(entry.path ? { path: entry.path } : {}),
    ...(entry.owners?.length ? { owners: entry.owners } : {}),
    secret: entry.secret,
  }
}

function isRequired(entry: DeploymentEnvEntry): boolean {
  return entry.required && !entry.hasDefault
}

function matchesPrefix(entry: DeploymentEnvEntry, name: string): boolean {
  return !!entry.prefix && name.startsWith(entry.prefix) && name.length > entry.prefix.length
}

/** True when one of `names` sets the entry: one of its names, or a name with its prefix. */
function isSet(entry: DeploymentEnvEntry, names: ReadonlySet<string>): boolean {
  return entry.names.some(name => names.has(name)) || [...names].some(name => matchesPrefix(entry, name))
}

/** Compares the names that the build lists with the names on the host. Hosts return no values, so it never says "changed". */
export function diffEnvNames(entries: readonly DeploymentEnvEntry[], hostNames: readonly string[]): Pick<EnvDiffOutput, "extra" | "missing" | "ok"> {
  const onHost = new Set(hostNames)
  const missing: EnvDiffOutput["missing"] = { optional: [], required: [] }
  for (const entry of entries) {
    if (isSet(entry, onHost)) continue
    missing[isRequired(entry) ? "required" : "optional"].push(diffEntry(entry))
  }
  const known = (name: string) => entries.some(entry => entry.names.includes(name) || matchesPrefix(entry, name))
  const extra = [...onHost].filter(name => !known(name)).sort()
  return { extra, missing, ok: !missing.required.length }
}

function entryLabel(entry: EnvDiffEntry): string {
  const names = [...entry.names, ...(entry.prefix ? [`${entry.prefix}*`] : [])].join(" or ")
  const from = entry.path ?? entry.owners?.join(", ")
  return from ? `${names} (${from})` : names
}

function targetLabel(output: { host: DeployHost, project: string, stage: string, target: HostEnvTarget }): string {
  return `${output.project} on ${output.host}, stage ${output.stage}${output.target === output.stage ? "" : ` (${output.target})`}`
}

function writeDiff(output: EnvDiffOutput, context: ViteHubCliContext): void {
  const lines = [`Env names of ${targetLabel(output)}:`]
  const section = (title: string, items: readonly string[]) => {
    if (items.length) lines.push(`${title}:`, ...items.map(item => `  ${item}`))
  }
  section("Missing required", output.missing.required.map(entryLabel))
  section("Missing optional", output.missing.optional.map(entryLabel))
  section("Extra on the host, read by no declaration", output.extra)
  if (!output.missing.required.length && !output.missing.optional.length && !output.extra.length) lines.push("Every name is on the host.")
  lines.push("Hosts do not return values, so this compares names only.")
  if (output.missing.required.length || output.missing.optional.length) {
    lines.push(`Run \`vitehub env push --host ${output.host}${output.stage === defaultStage ? "" : ` --stage ${output.stage}`}\` to set them from the shell and .env.${output.stage}.`)
  }
  context.stdout.write(`${lines.join("\n")}\n`)
}

async function runDiff(args: EnvArgs, context: ViteHubCliContext): Promise<number> {
  const target = await openTarget(args, "vitehub env diff", context)
  const hostNames = await target.hostEnv.listSecretNames()
  const output: EnvDiffOutput = { host: target.host, project: target.link.project.name, stage: target.stage, target: target.target, ...diffEnvNames(target.entries, hostNames) }
  if (args.json) writeSetupJson(context, output)
  else writeDiff(output, context)
  return output.ok ? setupExitCodes.done : setupExitCodes.error
}

interface LocalValue {
  value: string
  source: EnvValueSource
  /** Every env file that the value reads: its own file, and the files of the names that it expands with `$NAME`. */
  files: string[]
}

/** An env file as output names it: relative to the project root, such as `config/.env.production`. */
function fileSource(root: string, path: string): EnvValueSource {
  const folder = relative(root, dirname(path))
  return `${folder ? `${folder}/` : ""}.env${basename(path).slice(".env".length)}`
}

/** The names that a raw value expands, as Vite does: `$NAME`, `${NAME}`, and names in defaults, such as BASE in `${UNSET:-$BASE}`. */
function expandedNames(value: string): string[] {
  return [...value.matchAll(/(?<!\\)\$\{?([A-Za-z_]\w*)/gu)].map(match => match[1]!)
}

/**
 * The values of `stage` as Vite loads them: `.env`, `.env.local`, `.env.<stage>`, `.env.<stage>.local` in `envDir`, with
 * later files winning and the shell winning over every file (`packages/internal/src/vite-stage.ts`). With `envDir: false`
 * only the shell counts. Each value keeps its source, and every file that it reads through `$NAME` expansion.
 */
export async function readLocalEnvValues(root: string, envDir: string | false, stage: string, env: NodeJS.ProcessEnv): Promise<Map<string, LocalValue>> {
  const raw = new Map<string, { path: string, value: string }>()
  const paths = envDir === false ? [] : [".env", ".env.local", `.env.${stage}`, `.env.${stage}.local`].map(file => join(envDir, file))
  for (const path of paths) {
    // Vite reads regular files and follows symlinks.
    if (!(await stat(path).catch(() => undefined))?.isFile()) continue
    for (const [name, value] of Object.entries(parseEnv(await readFile(path, "utf8")))) {
      if (value !== undefined) raw.set(name, { path, value })
    }
  }
  // Vite expands a name from the shell first, else from the files. A shell value can expand file names in turn.
  const filesOf = (name: string, seen: Set<string>): string[] => {
    if (seen.has(name)) return []
    seen.add(name)
    const shell = env[name]
    const file = shell === undefined ? raw.get(name) : undefined
    const value = shell ?? file?.value ?? ""
    return [...file ? [file.path] : [], ...expandedNames(value).flatMap(reference => filesOf(reference, seen))]
  }
  const vite = await import("vite")
  // Vite expands `$NAME` references. With the prefix "", loadEnv also returns every variable of the shell.
  const loaded = await withViteStageEnvironment(env, async () => vite.loadEnv(stage, envDir, ""))
  const values = new Map<string, LocalValue>()
  for (const [name, value] of Object.entries(loaded)) {
    if (value === "") continue
    // A shell value of a name wins without expansion.
    if (env[name] !== undefined) values.set(name, { files: [], source: "process", value })
    else {
      const own = raw.get(name)
      if (own) values.set(name, { files: [...new Set(filesOf(name, new Set()))], source: fileSource(root, own.path), value })
    }
  }
  return values
}

interface PlannedValue {
  name: string
  value: string
  source: EnvValueSource
  /** The env files that the value reads. See `LocalValue`. */
  files: readonly string[]
  secret: boolean
}

/** The value of each entry: the first name in read order that has a local value, and every local name of a prefix. */
function planPush(entries: readonly DeploymentEnvEntry[], values: ReadonlyMap<string, LocalValue>, only: readonly string[]): { planned: PlannedValue[], skipped: EnvPushOutput["skipped"] } {
  const wanted = only.length ? new Set(only) : undefined
  const unknown = only.filter(name => !entries.some(entry => entry.names.includes(name) || matchesPrefix(entry, name)))
  if (unknown.length) throw new SetupFailure(cliErrorDiagnostics.SETUP_ENV_NAME_UNKNOWN({ names: unknown.join(", ") }), setupExitCodes.inputNeeded)
  const planned = new Map<string, PlannedValue>()
  const skipped: EnvPushOutput["skipped"] = []
  for (const entry of entries) {
    const names = wanted ? entry.names.filter(name => wanted.has(name)) : entry.names
    const prefixed = [...values.keys()].filter(name => matchesPrefix(entry, name) && (!wanted || wanted.has(name)))
    if (!names.length && !prefixed.length && wanted) continue
    const first = names.find(name => values.has(name))
    const chosen = [...(first ? [first] : []), ...prefixed]
    if (!chosen.length) {
      skipped.push({ ...diffEntry(entry), required: isRequired(entry) })
      continue
    }
    for (const name of chosen) {
      const local = values.get(name)!
      const current = planned.get(name)
      planned.set(name, { files: local.files, name, secret: entry.secret || (current?.secret ?? false), source: local.source, value: local.value })
    }
  }
  return { planned: [...planned.values()], skipped }
}

/**
 * True when `directory` or a parent folder looks like a git repository, or `GIT_DIR` names one: a `.git` file, as in a
 * worktree, or a `.git` folder with `HEAD`. It does not ask git, because git reports a broken repository the same way
 * as no repository, and a broken one must refuse.
 */
function inGitRepository(directory: string, env: NodeJS.ProcessEnv): boolean {
  if (env.GIT_DIR) return true
  for (let current = directory; ; current = dirname(current)) {
    const marker = join(current, ".git")
    if (existsSync(marker) && (!statSync(marker).isDirectory() || existsSync(join(marker, "HEAD")))) return true
    if (dirname(current) === current) return false
  }
}

/** What git says about one env file, by its real path. Throws when git cannot answer. */
async function gitFileState(file: string, label: string, run: DeployRun, env: NodeJS.ProcessEnv): Promise<"tracked" | "ignored" | "unignored"> {
  const failed = (reason: string) => new SetupFailure(cliErrorDiagnostics.SETUP_ENV_GIT_FAILED({ file: label, reason }), setupExitCodes.error)
  const git = async (args: string[]) => {
    try {
      return await run("git", args, { cwd: dirname(file), env })
    }
    catch (error: unknown) {
      throw failed(error instanceof Error ? error.message : String(error))
    }
  }
  // `--error-unmatch` exits with 1 for an untracked file, and `check-ignore` with 1 for a file that is not ignored.
  const tracked = await git(["ls-files", "--error-unmatch", "--", basename(file)])
  if (tracked.exitCode === 0) return "tracked"
  if (tracked.exitCode !== 1) throw failed(tracked.stderr.trim() || `git ls-files exited with ${tracked.exitCode}`)
  const ignored = await git(["check-ignore", "-q", "--", basename(file)])
  if (ignored.exitCode === 0) return "ignored"
  if (ignored.exitCode === 1) return "unignored"
  throw failed(ignored.stderr.trim() || `git check-ignore exited with ${ignored.exitCode}`)
}

/**
 * Refuses a secret whose value reads an env file that git tracks, or that git does not ignore: pushing it would hide
 * that the secret is in git, or that the next commit can add it. It checks every file that the value reads, through
 * `$NAME` expansion too, by its real path, so a symlink to a tracked file does not pass. When git cannot answer inside a
 * repository, it refuses. A file outside any git repository passes with a warning, since git cannot commit it.
 */
async function assertUntracked(planned: readonly PlannedValue[], root: string, run: DeployRun, env: NodeJS.ProcessEnv, stderr: ViteHubCliContext["stderr"]): Promise<void> {
  const byFile = new Map<string, string[]>()
  for (const item of planned) {
    if (!item.secret) continue
    for (const file of item.files) {
      const real = await realpath(file)
      byFile.set(real, [...new Set([...byFile.get(real) ?? [], item.name])])
    }
  }
  // Real paths on both sides, so a symlinked project folder gives a short label.
  const realRoot = await realpath(root).catch(() => root)
  for (const [file, names] of byFile) {
    const label = relative(realRoot, file)
    if (!inGitRepository(dirname(file), env)) {
      stderr.write(`Warning: ${label} is not in a git repository, so ViteHub cannot check that git ignores it.\n`)
      continue
    }
    const state = await gitFileState(file, label, run, env)
    if (state === "tracked") throw new SetupFailure(cliErrorDiagnostics.SETUP_ENV_FILE_TRACKED({ file: label, names: names.join(", ") }), setupExitCodes.conflict)
    if (state === "unignored") throw new SetupFailure(cliErrorDiagnostics.SETUP_ENV_FILE_NOT_IGNORED({ file: label, names: names.join(", ") }), setupExitCodes.conflict)
  }
}

async function confirmPush(planned: readonly PlannedValue[], label: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(?:es)?$/iu.test((await terminal.question(`Push ${planned.map(item => item.name).join(", ")} to ${label}? [y/N] `)).trim())
  }
  finally {
    terminal.close()
  }
}

function pushRerun(args: EnvArgs): string {
  return ["vitehub env push", ...(args.host ? [`--host ${args.host}`] : []), ...(args.stage === defaultStage ? [] : [`--stage ${args.stage}`]), ...args.only.map(name => `--only ${name}`), "--yes", ...(args.json ? ["--json"] : [])].join(" ")
}

/** Short plain values, such as "1", would hide host output that has nothing to do with them. */
function addRedactions(planned: readonly PlannedValue[], secrets: string[]): void {
  for (const item of planned) if (item.secret || item.value.length >= 4) secrets.push(item.value)
}

function sourceLabel(source: EnvValueSource): string {
  return source === "process" ? "the shell" : source === "generated" ? "a generated value" : source
}

function writePush(output: EnvPushOutput, context: ViteHubCliContext): void {
  const lines = output.pushed.length
    ? [`Pushed to ${targetLabel(output)}:`, ...output.pushed.map(item => `  ${item.name} from ${sourceLabel(item.source)}${item.replaced ? ", replaced" : ""}`)]
    : [`Nothing to push to ${targetLabel(output)}.`]
  if (output.skipped.length) lines.push("No local value, so the host keeps what it has:", ...output.skipped.map(item => `  ${entryLabel(item)}${item.required ? " (required)" : ""}`))
  context.stdout.write(`${lines.join("\n")}\n`)
}

async function runPush(args: EnvArgs, context: ViteHubCliContext): Promise<number> {
  const target = await openTarget(args, "vitehub env push", context)
  const values = await readLocalEnvValues(target.project.root, target.envDir, target.stage, context.env)
  const { planned, skipped } = planPush(target.entries, values, args.only)
  addRedactions(planned, target.secrets)
  const output: EnvPushOutput = { host: target.host, project: target.link.project.name, pushed: [], skipped, stage: target.stage, target: target.target }
  if (!planned.length) {
    if (args.json) writeSetupJson(context, output)
    else writePush(output, context)
    return setupExitCodes.done
  }
  await assertUntracked(planned, target.project.root, target.run, context.env, context.stderr)
  if (!args.yes) {
    const interactive = !args.json && !!process.stdin.isTTY && !!process.stderr.isTTY
    if (!interactive) throw new SetupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] `vitehub env push` changes host variables and was not confirmed. Without a terminal, pass --yes." }), setupExitCodes.inputNeeded, { rerun: pushRerun(args) })
    if (!await confirmPush(planned, targetLabel(output))) throw new SetupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] The push was not confirmed. Nothing was pushed." }), setupExitCodes.error)
  }
  const onHost = new Set(await target.hostEnv.listSecretNames())
  for (const item of planned) {
    await target.hostEnv.setSecret(item.name, item.value, { secret: item.secret })
    output.pushed.push({ name: item.name, replaced: onHost.has(item.name), secret: item.secret, source: item.source })
  }
  if (args.json) writeSetupJson(context, output)
  else writePush(output, context)
  return setupExitCodes.done
}

/** The name that ViteHub derives its own keys from. A deploy can generate it, because no one else has to know it. */
const appSecretName = "VITEHUB_SECRET"

/** What `vitehub deploy --json` prints in `env`. Names only, never a value. */
export interface DeployEnvOutput {
  /** `production`, or `preview` with `--preview`. It picks the `.env.<stage>` files. */
  stage: string
  /** Every name and prefix that the build lists. */
  checked: string[]
  /** Optional entries that neither the host nor a local value sets. Required ones stop the deploy. */
  missing: EnvDiffEntry[]
  /** Names that the deploy set on the host, or uploaded with the Cloudflare version. */
  pushed: string[]
  /** Names that the deploy generated, such as `VITEHUB_SECRET`. They are in `pushed` too. */
  generated?: string[]
}

export interface DeployEnvOptions {
  host: DeployHost
  /** The link target of the host. Without it, the project does not exist on the host yet, so the host has no names. */
  link: SetupLink | undefined
  preview: boolean
  /** `--push-env`: also replace names that the host has. */
  pushEnv: boolean
  /** `--yes`: generate `VITEHUB_SECRET` without the question. */
  yes: boolean
  interactive: boolean
  root: string
  entries: readonly DeploymentEnvEntry[]
  /** Vite's resolved `envDir` of the build, from `deployment.json`. */
  envDir: string | false
  context: ViteHubCliContext
  run: DeployRun
  /** The redaction list of the deploy runner. The gate adds the values that it reads. */
  secrets: string[]
}

export interface DeployEnvPlan {
  output: DeployEnvOutput
  /** The values to upload with the Cloudflare version, by name. Empty on other hosts. */
  upload: Record<string, string>
  /** Sets the values on the host. Deploy calls it just before the host deploy. Does nothing on Cloudflare. */
  apply: () => Promise<void>
}

async function confirmGenerate(label: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(?:es)?$/iu.test((await terminal.question(`${appSecretName} is not set on ${label} and has no local value. Generate one and set it? [y/N] `)).trim())
  }
  finally {
    terminal.close()
  }
}

function entryNames(entries: readonly DeploymentEnvEntry[]): string[] {
  return [...new Set(entries.flatMap(entry => [...entry.names, ...(entry.prefix ? [`${entry.prefix}*`] : [])]))]
}

/**
 * The Env gate of `vitehub deploy`. It runs after provisioning and the build, before migrations, env writes, or publishing code. Each required entry must be on
 * the host or have a local value (the shell, then the stage env files, as `env push` reads them). Deploy sets every
 * entry that the host lacks and that has a local value; `--push-env` also replaces the names that the host has.
 * Cloudflare always re-supplies local stage values and requires a local value for every existing secret, so an
 * omitted secret cannot inherit from another stage. Other hosts use their env CLI before the deploy.
 */
export async function checkDeployEnv(options: DeployEnvOptions): Promise<DeployEnvPlan> {
  const { context, entries, host, link } = options
  const stage = options.preview ? "preview" : defaultStage
  const output: DeployEnvOutput = { checked: entryNames(entries), missing: [], pushed: [], stage }
  if (!entries.length) return { apply: async () => {}, output, upload: {} }

  // Wrangler inherits omitted secrets from the latest upload, which may be a preview.
  // Re-supply every remote secret from this stage rather than trusting that inheritance.
  const target: HostEnvTarget = options.preview && host !== "cloudflare" ? "preview" : "production"
  const hostEnv = link ? hostEnvs[host]({ env: context.env, fetch: context.fetch ?? globalThis.fetch, link, root: options.root, run: options.run, secrets: options.secrets, target }) : undefined
  const onHost = new Set(hostEnv ? await hostEnv.listSecretNames() : [])
  const values = await readLocalEnvValues(options.root, options.envDir, stage, context.env)
  const candidates = options.pushEnv || host === "cloudflare" ? entries : entries.filter(entry => !isSet(entry, onHost))
  const planned = planPush(candidates, values, []).planned
  if (host === "cloudflare") {
    for (const name of onHost) {
      const local = values.get(name)
      if (local && !planned.some(item => item.name === name)) planned.push({ name, secret: true, ...local })
    }
    // Even an undeclared or optional remote secret would otherwise inherit the other stage's value.
    const unavailable = [...onHost].filter(name => !values.has(name))
    if (unavailable.length) {
      throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_ENV_STAGE_UNSAFE({ names: unavailable.join(", "), stage }), setupExitCodes.inputNeeded)
    }
    for (const item of planned) if (onHost.has(item.name)) item.secret = true
  }
  const label = `${link?.project.name ?? "the new project"} on ${host}`

  const unset = () => entries.filter(entry => !isSet(entry, new Set([...onHost, ...planned.map(item => item.name)])))
  const appSecret = unset().find(entry => isRequired(entry) && entry.names.includes(appSecretName))
  if (appSecret && (options.yes || (options.interactive && await confirmGenerate(label)))) {
    planned.push({ files: [], name: appSecretName, secret: true, source: "generated", value: randomBytes(32).toString("base64") })
    output.generated = [appSecretName]
  }
  addRedactions(planned, options.secrets)

  const missing = unset()
  const required = missing.filter(isRequired)
  if (required.length) {
    const names = required.map(entry => entryLabel(diffEntry(entry))).join(", ")
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_ENV_MISSING({ firstDeploy: !link, host, names, stage }), setupExitCodes.inputNeeded, {
      data: { env: { ...output, missing: missing.map(diffEntry) } },
      missing: required.map(entry => ({ field: entry.names[0] ?? `${entry.prefix}*` })),
    })
  }
  if (planned.length && !hostEnv && host !== "cloudflare") {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_ENV_NOT_LINKED({ host, names: planned.map(item => item.name).join(", ") }), setupExitCodes.inputNeeded, { rerun: `vitehub link --host ${host} --create` })
  }
  await assertUntracked(planned, options.root, options.run, context.env, context.stderr)

  output.missing = missing.map(diffEntry)
  output.pushed = planned.map(item => item.name)
  if (output.missing.length) context.stderr.write(`Warning: optional env not set on ${host}: ${output.missing.map(entryLabel).join(", ")}.\n`)
  for (const item of planned) {
    context.stderr.write(item.source === "generated"
      ? `Generated ${item.name} and set it on ${host}.\n`
      : `Setting ${item.name} on ${host}${host === "cloudflare" ? " with the new version" : ""} from ${sourceLabel(item.source)}${onHost.has(item.name) ? ", replaced" : ""}.\n`)
  }
  if (host === "cloudflare" || !hostEnv) return { apply: async () => {}, output, upload: host === "cloudflare" ? Object.fromEntries(planned.map(item => [item.name, item.value])) : {} }
  return {
    apply: async () => {
      for (const item of planned) await hostEnv.setSecret(item.name, item.value, { secret: item.secret })
    },
    output,
    upload: {},
  }
}

/** Runs `vitehub env diff` or `vitehub env push`. `feature` gives the usage and description for `--help`. */
export async function runEnvCommand(feature: Pick<ViteHubCliFeature, "description" | "usage"> & { name: "diff" | "push" }, args: string[], context: ViteHubCliContext): Promise<number> {
  const json = args.includes("--json")
  const push = feature.name === "push"
  try {
    const parsed = readEnvArgs(args, push, feature.usage)
    if (parsed.help) {
      context.stdout.write(`Usage: ${feature.usage}\n\n${feature.description}\n`)
      return setupExitCodes.done
    }
    return push ? await runPush(parsed, context) : await runDiff(parsed, context)
  }
  catch (error: unknown) {
    return writeSetupError(context, json, error)
  }
}
