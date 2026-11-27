import { randomBytes } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { readFile, realpath, stat } from "node:fs/promises"
import process from "node:process"
import { createInterface } from "node:readline/promises"
import { parseArgs, parseEnv } from "node:util"

import { loadAllEnv, withViteStageEnvironment } from "@vite-hub/internal/vite-stage"
import { basename, dirname, join, relative } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { build, readBuildOutput } from "./build-output.ts"
import { decryptEnvValues, envKeysFile, isEncryptedEnvValue } from "./env-encrypted.ts"
import { cloudflareEnv, wranglerVarNames } from "./deploy/cloudflare.ts"
import { consoleKeyPrefix } from "./deploy/console.ts"
import { denoEnv } from "./deploy/deno.ts"
import { githubEnv, isGitHubSecretName, resolveGitHubRepository, resolveGitHubToken } from "./deploy/github.ts"
import { createDeployRun } from "./deploy/host.ts"
import { netlifyEnv } from "./deploy/netlify.ts"
import { vercelEnv } from "./deploy/vercel.ts"
import { isSetupFailure, setupFailure, setupExitCodes, writeSetupError, writeSetupJson } from "./envelope.ts"
import { hostRequired, readLinkHostOption, readSetupLinks, selectSetupLink } from "./link.ts"
import { readSetupProject } from "./project.ts"

import type { DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"
import type { ViteHubCliContext, ViteHubCliFeature } from "@vite-hub/internal/cli"
import type { BuildOutput } from "./build-output.ts"
import type { GitHubEnvDestination } from "./deploy/github.ts"
import type { DeployHost, DeployRun, HostEnv, HostEnvContext, HostEnvTarget } from "./deploy/host.ts"
import type { SetupLink } from "./link.ts"
import type { SetupProject } from "./project.ts"

const defaultStage = "production"

const tokenNames = ["CLOUDFLARE_API_TOKEN", "VERCEL_TOKEN", "NETLIFY_AUTH_TOKEN", "DENO_DEPLOY_TOKEN"]

export const hostEnvs: Record<DeployHost, (context: HostEnvContext) => HostEnv> = {
  cloudflare: cloudflareEnv,
  deno: denoEnv,
  netlify: netlifyEnv,
  vercel: vercelEnv,
}

const noPreview: ReadonlySet<DeployHost> = new Set(["cloudflare", "deno"])

interface EnvArgs {
  host?: DeployHost
  github?: { repo?: string, environment?: string }
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
  /** The host of the build that lists the names. With `--to github`, the names still come from this build. */
  host: DeployHost
  project: string
  stage: string
  /** The host environment. Absent with `--to github`. */
  target?: HostEnvTarget
  /** The GitHub Actions secrets of `--to github`. */
  github?: GitHubEnvDestination
  /** True when no required name is missing. */
  ok: boolean
  missing: { required: EnvDiffEntry[], optional: EnvDiffEntry[] }
  /** Names on the host that no entry of the build reads. */
  extra: string[]
}

/**
 * Where a pushed value came from: the shell, one of the stage env files relative to the project root, such as
 * `.env.production` or `config/.env.production` with `envDir: "config"`, `vitehub deploy`, which generated it, or the
 * Console of the saved login, which has the public key of each app that it links.
 */
export type EnvValueSource = "process" | "generated" | "console" | `${string}.env${string}`

/** What `vitehub env push --json` prints, after `schemaVersion: 1`. Never a value. */
export interface EnvPushOutput {
  host: DeployHost
  project: string
  stage: string
  target?: HostEnvTarget
  github?: GitHubEnvDestination
  /** `encrypted` is true for a dotenvx value that the CLI decrypted before the push. */
  pushed: { name: string, source: EnvValueSource, secret: boolean, replaced: boolean, encrypted?: true }[]
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
        to: { type: "string" },
        repo: { type: "string" },
        environment: { type: "string" },
        ...(push ? { only: { multiple: true, type: "string" }, yes: { short: "y", type: "boolean", default: false } } : {}),
      },
      strict: true,
    })
    const host = readLinkHostOption(typeof values.host === "string" ? values.host : undefined)
    const stage = typeof values.stage === "string" ? values.stage : defaultStage
    const only = Array.isArray(values.only) ? values.only.filter(item => typeof item === "string") : []
    const repo = typeof values.repo === "string" ? values.repo : undefined
    const environment = typeof values.environment === "string" ? values.environment : undefined
    if (values.to !== undefined && values.to !== "github") throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] Unknown --to ${JSON.stringify(values.to)}. The only destination is github. For a host, use --host.` })
    if (values.to === undefined && (repo !== undefined || environment !== undefined)) throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] --repo and --environment need --to github. Usage: ${usage}` })
    const github = values.to === "github" ? { ...(repo === undefined ? {} : { repo }), ...(environment === undefined ? {} : { environment }) } : undefined
    return { help: values.help === true, ...(host ? { host } : {}), ...(github ? { github } : {}), json: values.json === true, only, stage, yes: values.yes === true }
  }
  catch (error: unknown) {
    if (isSetupFailure(error) || (error instanceof Error && "why" in error)) throw error
    throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${error instanceof Error ? error.message : String(error)} Usage: ${usage}` })
  }
}

function stageTarget(host: DeployHost, stage: string): HostEnvTarget {
  if (stage === "production") return "production"
  if (stage !== "preview" || noPreview.has(host)) throw setupFailure(cliErrorDiagnostics.SETUP_ENV_STAGE_UNSUPPORTED({ host, stage }), setupExitCodes.conflict)
  return "preview"
}

function linkedTarget(links: Awaited<ReturnType<typeof readSetupLinks>>, host: DeployHost | undefined, command: string): SetupLink {
  const selected = selectSetupLink(links, host)
  if ("ambiguous" in selected) throw hostRequired(selected.ambiguous, command)
  if (!selected.link) throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOYMENTS_NOT_LINKED({ host }), setupExitCodes.inputNeeded, { missing: [{ field: "link" }], rerun: host ? `vitehub link --host ${host}` : "vitehub link" })
  return selected.link
}

async function readNames(project: SetupProject, host: DeployHost, context: ViteHubCliContext): Promise<BuildOutput> {
  try {
    return await readBuildOutput(project.root, host)
  }
  catch (error: unknown) {
    const code = isSetupFailure(error) ? Reflect.get(error, "code") : undefined
    if (code !== "SETUP_DEPLOY_OUTPUT_MISSING" && code !== "SETUP_DEPLOY_HOST_MISMATCH") throw error
  }
  context.stderr.write(`No build output for ${host}. Building it to read the names.\n`)
  await build(project, host, context)
  return await readBuildOutput(project.root, host)
}

async function configVarNames(host: DeployHost, outputDir: string): Promise<Set<string>> {
  return new Set(host === "cloudflare" ? await wranglerVarNames(outputDir) : [])
}

interface EnvTarget {
  host: DeployHost
  name: string
  stage: string
  target?: HostEnvTarget
  github?: GitHubEnvDestination
  project: SetupProject
  entries: DeploymentEnvEntry[]
  configVars: Set<string>
  envDir: string | false
  hostEnv: HostEnv
  run: DeployRun
  secrets: string[]
}

function hostTokens(env: NodeJS.ProcessEnv): string[] {
  return tokenNames.flatMap((name) => {
    const token = env[name]?.trim()
    return token ? [token] : []
  })
}

async function openTarget(args: EnvArgs, command: string, context: ViteHubCliContext): Promise<EnvTarget> {
  const project = await readSetupProject(context.rootDir, context.env)
  if (args.github) return await openGitHubTarget(args, args.github, project, command, context)
  const link = linkedTarget(await readSetupLinks(project.root), args.host, command)
  const host = link.host
  const target = stageTarget(host, args.stage)
  const { env: entries, envDir, outputDir } = await readNames(project, host, context)
  const configVars = await configVarNames(host, outputDir)
  const secrets = hostTokens(context.env)
  const run = createDeployRun(context.stderr, secrets)
  const hostEnv = hostEnvs[host]({ env: context.env, fetch: context.fetch ?? globalThis.fetch, link, root: project.root, run, secrets, target })
  return { configVars, entries, envDir, host, hostEnv, name: link.project.name, project, run, secrets, stage: args.stage, target }
}

async function openGitHubTarget(args: EnvArgs, options: NonNullable<EnvArgs["github"]>, project: SetupProject, command: string, context: ViteHubCliContext): Promise<EnvTarget> {
  const selected = selectSetupLink(await readSetupLinks(project.root), args.host)
  if ("ambiguous" in selected) throw hostRequired(selected.ambiguous, `${command} --to github`)
  const host = args.host ?? selected.link?.host
  if (!host) throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOYMENTS_NOT_LINKED({}), setupExitCodes.inputNeeded, { missing: [{ field: "host" }], rerun: `${command} --to github --host cloudflare` })
  const { env: buildEntries, envDir } = await readNames(project, host, context)
  const entries = buildEntries.flatMap((entry) => {
    const names = entry.names.filter(isGitHubSecretName)
    return names.length || entry.prefix ? [{ ...entry, names }] : []
  })
  const secrets = hostTokens(context.env)
  const run = createDeployRun(context.stderr, secrets)
  const fetch = context.fetch ?? globalThis.fetch
  const repository = await resolveGitHubRepository(options.repo, { env: context.env, root: project.root, run })
  const token = await resolveGitHubToken(repository, { env: context.env, fetch, root: project.root, run })
  secrets.push(token)
  const github: GitHubEnvDestination = { repository, ...(options.environment ? { environment: options.environment } : {}) }
  const name = selected.link?.project.name ?? (await readBuildOutput(project.root, host)).identityName ?? repository
  return { configVars: new Set(), entries, envDir, github, host, hostEnv: githubEnv({ ...github, fetch, secrets, token }), name, project, run, secrets, stage: args.stage }
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

function isSet(entry: DeploymentEnvEntry, names: ReadonlySet<string>): boolean {
  return entry.names.some(name => names.has(name)) || [...names].some(name => matchesPrefix(entry, name))
}

/** Compares the names that the build lists with the names on the host. Hosts return no values, so it never says "changed". */
export function diffEnvNames(entries: readonly DeploymentEnvEntry[], hostNames: readonly string[], ignoreCase = false, configVars: ReadonlySet<string> = new Set()): Pick<EnvDiffOutput, "extra" | "missing" | "ok"> {
  const normalize = (name: string) => ignoreCase ? name.toUpperCase() : name
  const comparable = (entry: DeploymentEnvEntry): DeploymentEnvEntry => ignoreCase
    ? { ...entry, names: entry.names.map(normalize), ...(entry.prefix ? { prefix: normalize(entry.prefix) } : {}) }
    : entry
  const onHost = new Set([...hostNames, ...configVars].map(normalize))
  const missing: EnvDiffOutput["missing"] = { optional: [], required: [] }
  for (const entry of entries) {
    if (isSet(comparable(entry), onHost)) continue
    missing[isRequired(entry) ? "required" : "optional"].push(diffEntry(entry))
  }
  const known = (name: string) => entries.some((entry) => {
    const compared = comparable(entry)
    return compared.names.includes(normalize(name)) || matchesPrefix(compared, normalize(name))
  })
  const extra = hostNames.filter(name => !known(name) && !configVars.has(name)).sort()
  return { extra, missing, ok: !missing.required.length }
}

function entryLabel(entry: EnvDiffEntry): string {
  const names = [...entry.names, ...(entry.prefix ? [`${entry.prefix}*`] : [])].join(" or ")
  const from = entry.path ?? entry.owners?.join(", ")
  return from ? `${names} (${from})` : names
}

function targetLabel(output: { host: DeployHost, project: string, stage: string, target?: HostEnvTarget, github?: GitHubEnvDestination }): string {
  if (output.github) return `the GitHub Actions secrets of ${output.github.repository}${output.github.environment ? `, environment ${output.github.environment}` : ""}, stage ${output.stage}`
  return `${output.project} on ${output.host}, stage ${output.stage}${output.target === output.stage ? "" : ` (${output.target})`}`
}

function destinationFlags(output: { host: DeployHost, stage: string, github?: GitHubEnvDestination }): string[] {
  return [
    ...(output.github ? ["--to github", `--repo ${output.github.repository}`, `--host ${output.host}`, ...(output.github.environment ? [`--environment ${output.github.environment}`] : [])] : [`--host ${output.host}`]),
    ...(output.stage === defaultStage ? [] : [`--stage ${output.stage}`]),
  ]
}

function writeDiff(output: EnvDiffOutput, context: ViteHubCliContext): void {
  const lines = [`Env names of ${targetLabel(output)}:`]
  const section = (title: string, items: readonly string[]) => {
    if (items.length) lines.push(`${title}:`, ...items.map(item => `  ${item}`))
  }
  section("Missing required", output.missing.required.map(entryLabel))
  section("Missing optional", output.missing.optional.map(entryLabel))
  const where = output.github ? "on GitHub" : "on the host"
  section(`Extra ${where}, read by no declaration`, output.extra)
  if (!output.missing.required.length && !output.missing.optional.length && !output.extra.length) lines.push(`Every name is ${where}.`)
  lines.push(`${output.github ? "GitHub does" : "Hosts do"} not return values, so this compares names only.`)
  if (output.missing.required.length || output.missing.optional.length) {
    lines.push(`Run \`${["vitehub env push", ...destinationFlags(output)].join(" ")}\` to set them from the shell and .env.${output.stage}.`)
  }
  context.stdout.write(`${lines.join("\n")}\n`)
}

async function runDiff(args: EnvArgs, context: ViteHubCliContext): Promise<number> {
  const target = await openTarget(args, "vitehub env diff", context)
  const hostNames = await target.hostEnv.listSecretNames()
  const output: EnvDiffOutput = { ...destination(target), ...diffEnvNames(target.entries, hostNames, !!target.github, target.configVars) }
  if (args.json) writeSetupJson(context, output)
  else writeDiff(output, context)
  return output.ok ? setupExitCodes.done : setupExitCodes.error
}

function destination(target: EnvTarget): Pick<EnvDiffOutput, "github" | "host" | "project" | "stage" | "target"> {
  return { host: target.host, project: target.name, stage: target.stage, ...(target.target ? { target: target.target } : {}), ...(target.github ? { github: target.github } : {}) }
}

interface LocalValue {
  value: string
  source: EnvValueSource
  encrypted: boolean
  files: string[]
}

function fileSource(root: string, path: string): EnvValueSource {
  const folder = relative(root, dirname(path))
  return `${folder ? `${folder}/` : ""}.env${basename(path).slice(".env".length)}`
}

function expandedFiles(raw: Map<string, { path: string, value: string }>, env: NodeJS.ProcessEnv): Map<string, Set<string>> {
  const parsed = Object.fromEntries([...raw].map(([name, file]) => [name, file.value]))
  const files = new Map([...raw].map(([name, file]) => [name, new Set([file.path])]))
  for (const name of Object.keys(parsed)) {
    let result = parsed[name]!
    const sources = new Set(files.get(name))
    if (env[name] && env[name] !== result) {
      parsed[name] = env[name]!
      files.set(name, new Set())
      continue
    }
    const values = { ...parsed, ...env }
    const regex = /(?<!\\)\${([^{}]+)}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/g
    const seen = new Set<string>()
    let match: RegExpExecArray | null
    while ((match = regex.exec(result)) !== null) {
      seen.add(result)
      const template = match[0]
      const expression = (match[1] || match[2])!
      const operator = expression.match(/(:\+|\+|:-|-)/)?.[0]
      const parts = operator ? expression.split(operator) : [expression]
      const key = parts.shift()!
      if (env[key] === undefined) {
        for (const path of files.get(key) ?? []) sources.add(path)
      }
      const alternate = operator === ":+" || operator === "+"
      const fallback = alternate && !values[key] ? "" : parts.join(operator)
      const replacement = alternate ? undefined : values[key]
      result = result.replace(template, replacement && !seen.has(replacement) ? replacement : fallback)
      if (result === parsed[key]) break
      regex.lastIndex = 0
    }
    parsed[name] = result.replace(/\\\$/g, "$")
    files.set(name, sources)
  }
  return files
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
    if (!(await stat(path).catch(() => undefined))?.isFile()) continue
    for (const [name, value] of Object.entries(parseEnv(await readFile(path, "utf8")))) {
      if (value !== undefined) raw.set(name, { path, value })
    }
  }
  const ciphertextSources = new Map<string, string>()
  for (const file of raw.values()) {
    if (isEncryptedEnvValue(file.value)) ciphertextSources.set(file.value, file.path)
  }
  const files = expandedFiles(raw, env)
  const vite = await import("vite")
  const loaded = await withViteStageEnvironment(env, async () => loadAllEnv(vite.loadEnv, stage, envDir))
  const values = new Map<string, LocalValue>()
  for (const [name, value] of Object.entries(loaded)) {
    if (value === "") continue
    if (env[name] !== undefined) values.set(name, { encrypted: false, files: [], source: "process", value })
    else {
      const own = raw.get(name)
      if (own) {
        const origin = own.value === value ? own.path : ciphertextSources.get(value) ?? own.path
        values.set(name, { encrypted: isEncryptedEnvValue(value), files: [...files.get(name) ?? []], source: fileSource(root, origin), value })
      }
    }
  }
  return values
}

interface PlannedValue {
  name: string
  value: string
  source: EnvValueSource
  files: readonly string[]
  secret: boolean
  encrypted: boolean
}

function planPush(entries: readonly DeploymentEnvEntry[], values: ReadonlyMap<string, LocalValue>, only: readonly string[], onHost: ReadonlySet<string> = new Set()): { planned: PlannedValue[], skipped: EnvPushOutput["skipped"] } {
  const wanted = only.length ? new Set(only) : undefined
  const unknown = only.filter(name => !entries.some(entry => entry.names.includes(name) || matchesPrefix(entry, name)))
  if (unknown.length) throw setupFailure(cliErrorDiagnostics.SETUP_ENV_NAME_UNKNOWN({ names: unknown.join(", ") }), setupExitCodes.inputNeeded)
  const planned = new Map<string, PlannedValue>()
  const skipped: EnvPushOutput["skipped"] = []
  for (const entry of entries) {
    const names = entry.names.some(name => onHost.has(name)) ? [] : wanted ? entry.names.filter(name => wanted.has(name)) : entry.names
    const prefixed = [...values.keys()].filter(name => matchesPrefix(entry, name) && !onHost.has(name) && (!wanted || wanted.has(name)))
    if (!names.length && !prefixed.length && wanted) continue
    const first = names.find(name => values.has(name))
    const chosen = [...(first ? [first] : []), ...prefixed]
    if (!chosen.length) {
      if (isSet(entry, onHost)) continue
      skipped.push({ ...diffEntry(entry), required: isRequired(entry) })
      continue
    }
    for (const name of chosen) {
      const local = values.get(name)!
      const current = planned.get(name)
      planned.set(name, { encrypted: local.encrypted, files: local.files, name, secret: entry.secret || (current?.secret ?? false), source: local.source, value: local.value })
    }
  }
  return { planned: [...planned.values()], skipped }
}

function inGitRepository(directory: string, env: NodeJS.ProcessEnv): boolean {
  if (env.GIT_DIR) return true
  for (let current = directory; ; current = dirname(current)) {
    const marker = join(current, ".git")
    if (existsSync(marker) && (!statSync(marker).isDirectory() || existsSync(join(marker, "HEAD")))) return true
    if (dirname(current) === current) return false
  }
}

async function gitFileState(file: string, label: string, run: DeployRun, env: NodeJS.ProcessEnv): Promise<"tracked" | "ignored" | "unignored"> {
  const failed = (reason: string) => setupFailure(cliErrorDiagnostics.SETUP_ENV_GIT_FAILED({ file: label, reason }), setupExitCodes.error)
  const git = async (args: string[]) => {
    try {
      return await run("git", args, { cwd: dirname(file), env })
    }
    catch (error: unknown) {
      throw failed(error instanceof Error ? error.message : String(error))
    }
  }
  const tracked = await git(["ls-files", "--error-unmatch", "--", basename(file)])
  if (tracked.exitCode === 0) return "tracked"
  if (tracked.exitCode !== 1) throw failed(tracked.stderr.trim() || `git ls-files exited with ${tracked.exitCode}`)
  const ignored = await git(["check-ignore", "-q", "--", basename(file)])
  if (ignored.exitCode === 0) return "ignored"
  if (ignored.exitCode === 1) return "unignored"
  throw failed(ignored.stderr.trim() || `git check-ignore exited with ${ignored.exitCode}`)
}

async function assertUntracked(planned: readonly PlannedValue[], root: string, run: DeployRun, env: NodeJS.ProcessEnv, stderr: ViteHubCliContext["stderr"]): Promise<void> {
  const byFile = new Map<string, string[]>()
  for (const item of planned) {
    if (!item.secret || item.encrypted) continue
    for (const file of item.files) {
      const real = await realpath(file)
      byFile.set(real, [...new Set([...byFile.get(real) ?? [], item.name])])
    }
  }
  const realRoot = await realpath(root).catch(() => root)
  for (const [file, names] of byFile) {
    const label = relative(realRoot, file)
    if (!inGitRepository(dirname(file), env)) {
      stderr.write(`Warning: ${label} is not in a git repository, so ViteHub cannot check that git ignores it.\n`)
      continue
    }
    const state = await gitFileState(file, label, run, env)
    if (state === "tracked") throw setupFailure(cliErrorDiagnostics.SETUP_ENV_FILE_TRACKED({ file: label, names: names.join(", ") }), setupExitCodes.conflict)
    if (state === "unignored") throw setupFailure(cliErrorDiagnostics.SETUP_ENV_FILE_NOT_IGNORED({ file: label, names: names.join(", ") }), setupExitCodes.conflict)
  }
  const keysPath = join(root, envKeysFile)
  const realKeys = await realpath(keysPath).catch(() => undefined)
  if (planned.some(item => item.encrypted) && realKeys && inGitRepository(dirname(realKeys), env) && await gitFileState(realKeys, envKeysFile, run, env) === "tracked") {
    throw setupFailure(cliErrorDiagnostics.SETUP_ENV_KEYS_TRACKED({ file: envKeysFile }), setupExitCodes.conflict)
  }
}

async function decryptPlanned(planned: readonly PlannedValue[], root: string, env: NodeJS.ProcessEnv, secrets: string[]): Promise<PlannedValue[]> {
  const encrypted = planned.filter(item => item.encrypted)
  const { keys, values } = await decryptEnvValues(root, encrypted.map(item => ({ file: item.source, name: item.name, value: item.value })), env)
  secrets.push(...keys)
  return planned.map((item) => {
    const value = values.get(item.name)
    if (value === undefined) return item
    secrets.push(value)
    return { ...item, value }
  })
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
  const github = args.github ? ["--to github", ...(args.github.repo ? [`--repo ${args.github.repo}`] : []), ...(args.github.environment ? [`--environment ${args.github.environment}`] : [])] : []
  return ["vitehub env push", ...(args.host ? [`--host ${args.host}`] : []), ...github, ...(args.stage === defaultStage ? [] : [`--stage ${args.stage}`]), ...args.only.map(name => `--only ${name}`), "--yes", ...(args.json ? ["--json"] : [])].join(" ")
}

function addRedactions(planned: readonly PlannedValue[], secrets: string[]): void {
  for (const item of planned) if (item.secret || item.value.length >= 4) secrets.push(item.value)
}

function sourceLabel(source: EnvValueSource): string {
  return source === "process" ? "the shell" : source === "generated" ? "a generated value" : source === "console" ? "the Console" : source
}

function writePush(output: EnvPushOutput, context: ViteHubCliContext): void {
  const lines = output.pushed.length
    ? [`Pushed to ${targetLabel(output)}:`, ...output.pushed.map(item => `  ${item.name} from ${sourceLabel(item.source)}${item.encrypted ? ", decrypted" : ""}${item.replaced ? ", replaced" : ""}`)]
    : [`Nothing to push to ${targetLabel(output)}.`]
  if (output.skipped.length) lines.push(`No local value, so ${output.github ? "GitHub" : "the host"} keeps what it has:`, ...output.skipped.map(item => `  ${entryLabel(item)}${item.required ? " (required)" : ""}`))
  context.stdout.write(`${lines.join("\n")}\n`)
}

async function runPush(args: EnvArgs, context: ViteHubCliContext): Promise<number> {
  const target = await openTarget(args, "vitehub env push", context)
  const values = await readLocalEnvValues(target.project.root, target.envDir, target.stage, context.env)
  const { planned: stored, skipped } = planPush(target.entries, values, args.only, target.configVars)
  addRedactions(stored, target.secrets)
  const output: EnvPushOutput = { ...destination(target), pushed: [], skipped }
  if (!stored.length) {
    if (args.json) writeSetupJson(context, output)
    else writePush(output, context)
    return setupExitCodes.done
  }
  await assertUntracked(stored, target.project.root, target.run, context.env, context.stderr)
  const planned = await decryptPlanned(stored, target.project.root, context.env, target.secrets)
  if (!args.yes) {
    const interactive = !args.json && !!process.stdin.isTTY && !!process.stderr.isTTY
    if (!interactive) throw setupFailure(cliErrorDiagnostics.CLI_R0004({ message: `[vitehub] \`vitehub env push\` changes ${target.github ? "GitHub Actions secrets" : "host variables"} and was not confirmed. Without a terminal, pass --yes.` }), setupExitCodes.inputNeeded, { rerun: pushRerun(args) })
    if (!await confirmPush(planned, targetLabel(output))) throw setupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] The push was not confirmed. Nothing was pushed." }), setupExitCodes.error)
  }
  const remoteName = (name: string) => target.github ? name.toUpperCase() : name
  const onHost = new Set((await target.hostEnv.listSecretNames()).map(remoteName))
  for (const item of planned) {
    await target.hostEnv.setSecret(item.name, item.value, { secret: item.secret })
    output.pushed.push({ name: item.name, replaced: onHost.has(remoteName(item.name)), secret: item.secret, source: item.source, ...(item.encrypted ? { encrypted: true as const } : {}) })
  }
  if (args.json) writeSetupJson(context, output)
  else writePush(output, context)
  return setupExitCodes.done
}

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
  /** The build output. On Cloudflare, the plain vars of its Wrangler config count as set. */
  outputDir: string
  /**
   * The `VITEHUB_CONSOLE_KEY_<NAME>` public keys of the Console of the saved login, by name. A key counts as a local
   * value only when the host already has its name, so a deploy never sets the key of another app.
   */
  consoleKeys?: Readonly<Record<string, string>>
  deferConsoleKey?: boolean
}

export interface DeployEnvPlan {
  output: DeployEnvOutput
  /** The values to upload with the Cloudflare version, by name. Empty on other hosts. */
  upload: Record<string, string>
  /** Sets the values on the host. Deploy calls it just before the host deploy. Does nothing on Cloudflare. */
  apply: () => Promise<void>
  /** The names that the host has after the deploy. */
  onHost: ReadonlySet<string>
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
  if (!entries.length) return { apply: async () => {}, onHost: new Set(), output, upload: {} }

  const target: HostEnvTarget = options.preview && host !== "cloudflare" ? "preview" : "production"
  const hostEnv = link ? hostEnvs[host]({ env: context.env, fetch: context.fetch ?? globalThis.fetch, link, root: options.root, run: options.run, secrets: options.secrets, target }) : undefined
  const onHost = new Set(hostEnv ? await hostEnv.listSecretNames() : [])
  const values = await readLocalEnvValues(options.root, options.envDir, stage, context.env)
  for (const [name, value] of Object.entries(host === "cloudflare" ? options.consoleKeys ?? {} : {})) {
    if (onHost.has(name) && !values.has(name)) values.set(name, { encrypted: false, files: [], source: "console", value })
  }
  const configVars = await configVarNames(host, options.outputDir)
  const stored = planPush(entries, values, [], options.pushEnv || host === "cloudflare" ? configVars : onHost).planned
  if (host === "cloudflare") {
    for (const name of onHost) {
      const local = values.get(name)
      if (local && !stored.some(item => item.name === name)) stored.push({ name, secret: true, ...local })
    }
    const unavailable = [...onHost].filter(name => !values.has(name))
    if (unavailable.length) {
      throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_ENV_STAGE_UNSAFE({ console: unavailable.some(name => name.startsWith(consoleKeyPrefix)), names: unavailable.join(", "), stage }), setupExitCodes.inputNeeded)
    }
    for (const item of stored) if (onHost.has(item.name)) item.secret = true
  }
  const label = `${link?.project.name ?? "the new project"} on ${host}`

  const unset = () => entries.filter(entry => !isSet(entry, new Set([...onHost, ...configVars, ...stored.map(item => item.name)])))
  const appSecret = unset().find(entry => isRequired(entry) && entry.names.includes(appSecretName))
  if (appSecret && (options.yes || (options.interactive && await confirmGenerate(label)))) {
    stored.push({ encrypted: false, files: [], name: appSecretName, secret: true, source: "generated", value: randomBytes(32).toString("base64") })
    output.generated = [appSecretName]
  }
  addRedactions(stored, options.secrets)

  const missing = unset().filter(entry => !options.deferConsoleKey || entry.prefix !== consoleKeyPrefix)
  const required = missing.filter(isRequired)
  if (required.length) {
    const names = required.map(entry => entryLabel(diffEntry(entry))).join(", ")
    throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_ENV_MISSING({ console: required.some(entry => entry.prefix === consoleKeyPrefix), firstDeploy: !link, host, names, stage }), setupExitCodes.inputNeeded, {
      data: { env: { ...output, missing: missing.map(diffEntry) } },
      missing: required.map(entry => ({ field: entry.names[0] ?? `${entry.prefix}*` })),
    })
  }
  if (stored.length && !hostEnv && host !== "cloudflare") {
    throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_ENV_NOT_LINKED({ host, names: stored.map(item => item.name).join(", ") }), setupExitCodes.inputNeeded, { rerun: host === "deno" ? "vitehub link --host deno" : `vitehub link --host ${host} --create` })
  }
  await assertUntracked(stored, options.root, options.run, context.env, context.stderr)
  const planned = await decryptPlanned(stored, options.root, context.env, options.secrets)

  output.missing = missing.map(diffEntry)
  output.pushed = planned.map(item => item.name)
  if (output.missing.length) context.stderr.write(`Warning: optional env not set on ${host}: ${output.missing.map(entryLabel).join(", ")}.\n`)
  for (const item of planned) {
    context.stderr.write(item.source === "generated"
      ? `Generated ${item.name} and set it on ${host}.\n`
      : `Setting ${item.name} on ${host}${host === "cloudflare" ? " with the new version" : ""} from ${sourceLabel(item.source)}${item.encrypted ? ", decrypted" : ""}${onHost.has(item.name) ? ", replaced" : ""}.\n`)
  }
  const deployedNames = new Set([...onHost, ...configVars, ...output.pushed])
  if (host === "cloudflare" || !hostEnv) return { apply: async () => {}, onHost: deployedNames, output, upload: host === "cloudflare" ? Object.fromEntries(planned.map(item => [item.name, item.value])) : {} }
  return {
    apply: async () => {
      for (const item of planned) await hostEnv.setSecret(item.name, item.value, { secret: item.secret })
    },
    onHost: deployedNames,
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
