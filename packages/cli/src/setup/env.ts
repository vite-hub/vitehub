import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import process from "node:process"
import { createInterface } from "node:readline/promises"
import { parseArgs, parseEnv } from "node:util"

import { withViteStageEnvironment } from "@vite-hub/internal/vite-stage"
import { join } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { build, readBuildOutput } from "./deploy.ts"
import { cloudflareEnv } from "./deploy/cloudflare.ts"
import { denoEnv } from "./deploy/deno.ts"
import { githubEnv, isGitHubSecretName, resolveGitHubRepository, resolveGitHubToken } from "./deploy/github.ts"
import { createDeployRun } from "./deploy/host.ts"
import { netlifyEnv } from "./deploy/netlify.ts"
import { vercelEnv } from "./deploy/vercel.ts"
import { SetupFailure, setupExitCodes, writeSetupError, writeSetupJson } from "./envelope.ts"
import { hostRequired, readLinkHostOption, readSetupLinks, selectSetupLink } from "./link.ts"
import { readSetupProject } from "./project.ts"

import type { DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"
import type { ViteHubCliContext, ViteHubCliFeature } from "@vite-hub/internal/cli"
import type { GitHubEnvDestination } from "./deploy/github.ts"
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
  /** `--to github`: write the Actions secrets of a GitHub repository instead of the host variables. */
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

/** Where a pushed value came from: the shell, or one of the stage env files. */
export type EnvValueSource = "process" | `.env${string}`

/** What `vitehub env push --json` prints, after `schemaVersion: 1`. Never a value. */
export interface EnvPushOutput {
  host: DeployHost
  project: string
  stage: string
  target?: HostEnvTarget
  github?: GitHubEnvDestination
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

/** The names of the last build for `host`. Builds first when there is no build output for `host`. */
async function readNames(project: SetupProject, host: DeployHost, context: ViteHubCliContext): Promise<DeploymentEnvEntry[]> {
  try {
    return (await readBuildOutput(project.root, host)).env
  }
  catch (error: unknown) {
    const code = error instanceof SetupFailure ? Reflect.get(error.cause, "code") : undefined
    if (code !== "SETUP_DEPLOY_OUTPUT_MISSING" && code !== "SETUP_DEPLOY_HOST_MISMATCH") throw error
  }
  context.stderr.write(`No build output for ${host}. Building it to read the names.\n`)
  await build(project, host, context)
  return (await readBuildOutput(project.root, host)).env
}

interface EnvTarget {
  host: DeployHost
  /** The host project name, or the build name for `--to github` without a link. */
  name: string
  stage: string
  target?: HostEnvTarget
  github?: GitHubEnvDestination
  project: SetupProject
  entries: DeploymentEnvEntry[]
  hostEnv: HostEnv
  run: DeployRun
  /** Values that no output may show. Push adds the values that it reads. */
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
  const entries = await readNames(project, host, context)
  const secrets = hostTokens(context.env)
  // The runner reads `secrets` at each run, so values that push adds later are redacted too.
  const run = createDeployRun(context.stderr, secrets)
  const hostEnv = hostEnvs[host]({ env: context.env, fetch: context.fetch ?? globalThis.fetch, link, root: project.root, run, secrets, target })
  return { entries, host, hostEnv, name: link.project.name, project, run, secrets, stage: args.stage, target }
}

/**
 * GitHub is a destination, not a host: the names come from the build of the linked host (or `--host`), and the stage
 * only picks the local `.env.<stage>` file. Names that GitHub reserves (`GITHUB_*`) drop out of each entry.
 */
async function openGitHubTarget(args: EnvArgs, options: NonNullable<EnvArgs["github"]>, project: SetupProject, command: string, context: ViteHubCliContext): Promise<EnvTarget> {
  const selected = selectSetupLink(await readSetupLinks(project.root), args.host)
  if ("ambiguous" in selected) throw hostRequired(selected.ambiguous, `${command} --to github`)
  const host = args.host ?? selected.link?.host
  if (!host) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOYMENTS_NOT_LINKED({}), setupExitCodes.inputNeeded, { missing: [{ field: "host" }], rerun: `${command} --to github --host cloudflare` })
  const entries = (await readNames(project, host, context)).flatMap((entry) => {
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
  return { entries, github, host, hostEnv: githubEnv({ ...github, fetch, secrets, token }), name, project, run, secrets, stage: args.stage }
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

/** Compares the names that the build lists with the names on the host. Hosts return no values, so it never says "changed". */
export function diffEnvNames(entries: readonly DeploymentEnvEntry[], hostNames: readonly string[]): Pick<EnvDiffOutput, "extra" | "missing" | "ok"> {
  const onHost = new Set(hostNames)
  const missing: EnvDiffOutput["missing"] = { optional: [], required: [] }
  for (const entry of entries) {
    if (entry.names.some(name => onHost.has(name)) || hostNames.some(name => matchesPrefix(entry, name))) continue
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

function targetLabel(output: { host: DeployHost, project: string, stage: string, target?: HostEnvTarget, github?: GitHubEnvDestination }): string {
  if (output.github) return `the GitHub Actions secrets of ${output.github.repository}${output.github.environment ? `, environment ${output.github.environment}` : ""}, stage ${output.stage}`
  return `${output.project} on ${output.host}, stage ${output.stage}${output.target === output.stage ? "" : ` (${output.target})`}`
}

/** The flags that name the destination again, for a hint or a rerun. */
function destinationFlags(output: { host: DeployHost, stage: string, github?: GitHubEnvDestination }): string[] {
  return [
    ...(output.github ? ["--to github", `--repo ${output.github.repository}`, ...(output.github.environment ? [`--environment ${output.github.environment}`] : [])] : [`--host ${output.host}`]),
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
  const output: EnvDiffOutput = { ...destination(target), ...diffEnvNames(target.entries, hostNames) }
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
}

/**
 * The values of `stage` as Vite loads them: `.env`, `.env.local`, `.env.<stage>`, `.env.<stage>.local`, with later files
 * winning and the shell winning over every file (`packages/internal/src/vite-stage.ts`). Each value keeps its source.
 */
export async function readLocalEnvValues(root: string, stage: string, env: NodeJS.ProcessEnv): Promise<Map<string, LocalValue>> {
  const files = [".env", ".env.local", `.env.${stage}`, `.env.${stage}.local`] as const
  const sources = new Map<string, EnvValueSource>()
  for (const file of files) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    for (const name of Object.keys(parseEnv(await readFile(path, "utf8")))) sources.set(name, file)
  }
  const vite = await import("vite")
  // Vite expands `$NAME` references. With the prefix "", loadEnv also returns every variable of the shell.
  const loaded = await withViteStageEnvironment(env, async () => vite.loadEnv(stage, root, ""))
  const values = new Map<string, LocalValue>()
  for (const [name, value] of Object.entries(loaded)) {
    const source = env[name] !== undefined ? "process" : sources.get(name)
    if (source && value !== "") values.set(name, { source, value })
  }
  return values
}

interface PlannedValue {
  name: string
  value: string
  source: EnvValueSource
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
      planned.set(name, { name, secret: entry.secret || (current?.secret ?? false), source: local.source, value: local.value })
    }
  }
  return { planned: [...planned.values()], skipped }
}

/** Refuses a secret whose value comes from a file that git tracks: pushing it would hide that the secret is in git. */
async function assertUntracked(planned: readonly PlannedValue[], target: EnvTarget, env: NodeJS.ProcessEnv): Promise<void> {
  const byFile = new Map<string, string[]>()
  for (const item of planned) {
    if (item.secret && item.source !== "process") byFile.set(item.source, [...byFile.get(item.source) ?? [], item.name])
  }
  for (const [file, names] of byFile) {
    const result = await target.run("git", ["ls-files", "--error-unmatch", "--", file], { cwd: target.project.root, env }).catch(() => undefined)
    if (result?.exitCode === 0) throw new SetupFailure(cliErrorDiagnostics.SETUP_ENV_FILE_TRACKED({ file, names: names.join(", ") }), setupExitCodes.conflict)
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
  const github = args.github ? ["--to github", ...(args.github.repo ? [`--repo ${args.github.repo}`] : []), ...(args.github.environment ? [`--environment ${args.github.environment}`] : [])] : []
  return ["vitehub env push", ...(args.host ? [`--host ${args.host}`] : []), ...github, ...(args.stage === defaultStage ? [] : [`--stage ${args.stage}`]), ...args.only.map(name => `--only ${name}`), "--yes", ...(args.json ? ["--json"] : [])].join(" ")
}

function writePush(output: EnvPushOutput, context: ViteHubCliContext): void {
  const lines = output.pushed.length
    ? [`Pushed to ${targetLabel(output)}:`, ...output.pushed.map(item => `  ${item.name} from ${item.source === "process" ? "the shell" : item.source}${item.replaced ? ", replaced" : ""}`)]
    : [`Nothing to push to ${targetLabel(output)}.`]
  if (output.skipped.length) lines.push(`No local value, so ${output.github ? "GitHub" : "the host"} keeps what it has:`, ...output.skipped.map(item => `  ${entryLabel(item)}${item.required ? " (required)" : ""}`))
  context.stdout.write(`${lines.join("\n")}\n`)
}

async function runPush(args: EnvArgs, context: ViteHubCliContext): Promise<number> {
  const target = await openTarget(args, "vitehub env push", context)
  const values = await readLocalEnvValues(target.project.root, target.stage, context.env)
  const { planned, skipped } = planPush(target.entries, values, args.only)
  // Short plain values, such as "1", would hide host output that has nothing to do with them.
  for (const item of planned) if (item.secret || item.value.length >= 4) target.secrets.push(item.value)
  const output: EnvPushOutput = { ...destination(target), pushed: [], skipped }
  if (!planned.length) {
    if (args.json) writeSetupJson(context, output)
    else writePush(output, context)
    return setupExitCodes.done
  }
  await assertUntracked(planned, target, context.env)
  if (!args.yes) {
    const interactive = !args.json && !!process.stdin.isTTY && !!process.stderr.isTTY
    if (!interactive) throw new SetupFailure(cliErrorDiagnostics.CLI_R0004({ message: `[vitehub] \`vitehub env push\` changes ${target.github ? "GitHub Actions secrets" : "host variables"} and was not confirmed. Without a terminal, pass --yes.` }), setupExitCodes.inputNeeded, { rerun: pushRerun(args) })
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
