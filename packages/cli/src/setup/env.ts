import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import process from "node:process"
import { createInterface } from "node:readline/promises"
import { parseArgs, parseEnv } from "node:util"

import { withViteStageEnvironment } from "@vite-hub/internal/vite-stage"
import { join } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { build, readBuildOutput } from "./deploy.ts"
import { decryptEnvValues, envKeysFile, isEncryptedEnvValue } from "./env-encrypted.ts"
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

/** Where a pushed value came from: the shell, or one of the stage env files. */
export type EnvValueSource = "process" | `.env${string}`

/** What `vitehub env push --json` prints, after `schemaVersion: 1`. Never a value. */
export interface EnvPushOutput {
  host: DeployHost
  project: string
  stage: string
  target: HostEnvTarget
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
  link: SetupLink
  stage: string
  target: HostEnvTarget
  project: SetupProject
  entries: DeploymentEnvEntry[]
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
  const entries = await readNames(project, host, context)
  const secrets = tokenNames.flatMap((name) => {
    const token = context.env[name]?.trim()
    return token ? [token] : []
  })
  // The runner reads `secrets` at each run, so values that push adds later are redacted too.
  const run = createDeployRun(context.stderr, secrets)
  const hostEnv = hostEnvs[host]({ env: context.env, fetch: context.fetch ?? globalThis.fetch, link, root: project.root, run, secrets, target })
  return { entries, host, hostEnv, link, project, run, secrets, stage: args.stage, target }
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
  /** A dotenvx `encrypted:` value from an env file. `value` is the ciphertext until the push decrypts it. */
  encrypted: boolean
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
    if (source && value !== "") values.set(name, { encrypted: source !== "process" && isEncryptedEnvValue(value), source, value })
  }
  return values
}

interface PlannedValue {
  name: string
  value: string
  source: EnvValueSource
  secret: boolean
  encrypted: boolean
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
      planned.set(name, { encrypted: local.encrypted, name, secret: entry.secret || (current?.secret ?? false), source: local.source, value: local.value })
    }
  }
  return { planned: [...planned.values()], skipped }
}

/**
 * Refuses a plaintext secret from a file that git tracks: pushing it would hide that the secret is in git.
 * An encrypted value may be in git, but the private keys in `.env.keys` may not.
 */
async function assertUntracked(planned: readonly PlannedValue[], target: EnvTarget, env: NodeJS.ProcessEnv): Promise<void> {
  const tracked = async (file: string) => (await target.run("git", ["ls-files", "--error-unmatch", "--", file], { cwd: target.project.root, env }).catch(() => undefined))?.exitCode === 0
  const byFile = new Map<string, string[]>()
  for (const item of planned) {
    if (item.secret && item.source !== "process" && !item.encrypted) byFile.set(item.source, [...byFile.get(item.source) ?? [], item.name])
  }
  for (const [file, names] of byFile) {
    if (await tracked(file)) throw new SetupFailure(cliErrorDiagnostics.SETUP_ENV_FILE_TRACKED({ file, names: names.join(", ") }), setupExitCodes.conflict)
  }
  if (planned.some(item => item.encrypted) && await tracked(envKeysFile)) {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_ENV_KEYS_TRACKED({ file: envKeysFile }), setupExitCodes.conflict)
  }
}

/** Replaces each encrypted value with its plaintext. The private keys and the plaintext join the values that output redacts. */
async function decryptPlanned(planned: readonly PlannedValue[], root: string, env: NodeJS.ProcessEnv, secrets: string[]): Promise<PlannedValue[]> {
  const encrypted = planned.filter(item => item.encrypted)
  const { keys, values } = await decryptEnvValues(root, encrypted.map(item => ({ file: item.source, name: item.name, value: item.value })), env)
  secrets.push(...keys)
  return planned.map((item) => {
    const value = values.get(item.name)
    if (value === undefined) return item
    // A decrypted value is a secret to redact, even when its declaration is plain.
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
  return ["vitehub env push", ...(args.host ? [`--host ${args.host}`] : []), ...(args.stage === defaultStage ? [] : [`--stage ${args.stage}`]), ...args.only.map(name => `--only ${name}`), "--yes", ...(args.json ? ["--json"] : [])].join(" ")
}

function writePush(output: EnvPushOutput, context: ViteHubCliContext): void {
  const lines = output.pushed.length
    ? [`Pushed to ${targetLabel(output)}:`, ...output.pushed.map(item => `  ${item.name} from ${item.source === "process" ? "the shell" : item.source}${item.encrypted ? ", decrypted" : ""}${item.replaced ? ", replaced" : ""}`)]
    : [`Nothing to push to ${targetLabel(output)}.`]
  if (output.skipped.length) lines.push("No local value, so the host keeps what it has:", ...output.skipped.map(item => `  ${entryLabel(item)}${item.required ? " (required)" : ""}`))
  context.stdout.write(`${lines.join("\n")}\n`)
}

async function runPush(args: EnvArgs, context: ViteHubCliContext): Promise<number> {
  const target = await openTarget(args, "vitehub env push", context)
  const values = await readLocalEnvValues(target.project.root, target.stage, context.env)
  const { planned: stored, skipped } = planPush(target.entries, values, args.only)
  // Short plain values, such as "1", would hide host output that has nothing to do with them.
  for (const item of stored) if (item.secret || item.value.length >= 4) target.secrets.push(item.value)
  const output: EnvPushOutput = { host: target.host, project: target.link.project.name, pushed: [], skipped, stage: target.stage, target: target.target }
  if (!stored.length) {
    if (args.json) writeSetupJson(context, output)
    else writePush(output, context)
    return setupExitCodes.done
  }
  await assertUntracked(stored, target, context.env)
  const planned = await decryptPlanned(stored, target.project.root, context.env, target.secrets)
  if (!args.yes) {
    const interactive = !args.json && !!process.stdin.isTTY && !!process.stderr.isTTY
    if (!interactive) throw new SetupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] `vitehub env push` changes host variables and was not confirmed. Without a terminal, pass --yes." }), setupExitCodes.inputNeeded, { rerun: pushRerun(args) })
    if (!await confirmPush(planned, targetLabel(output))) throw new SetupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] The push was not confirmed. Nothing was pushed." }), setupExitCodes.error)
  }
  const onHost = new Set(await target.hostEnv.listSecretNames())
  for (const item of planned) {
    await target.hostEnv.setSecret(item.name, item.value, { secret: item.secret })
    output.pushed.push({ name: item.name, replaced: onHost.has(item.name), secret: item.secret, source: item.source, ...(item.encrypted ? { encrypted: true as const } : {}) })
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
