import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"

import { abortable } from "@vite-hub/internal/abort"
import { hostFromNitroPreset } from "@vite-hub/internal/deployment"
import { resolveHostCredentials, runHostCli } from "@vite-hub/internal/host-credentials"
import {
  createCloudflareApiClient,
  createCloudflareProvisionClient,
  createNetlifyApiClient,
  createVercelProvisionClient,
  ProvisionRequestError,
} from "@vite-hub/internal/provision"
import { isRecord } from "@vite-hub/internal/object"
import { dirname, join } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "./envelope.ts"
import { setupStatus } from "./status.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { CredentialHost, CredentialSource, HostCredentials, HostCredentialsContext, HostCredentialsDescription } from "@vite-hub/internal/host-credentials"
import type { SetupProject } from "./project.ts"

/** The link file, relative to the project root. It is gitignored and never holds a secret. */
export const SETUP_LINK_FILE = ".vitehub/link.json"

export type SetupLinkHost = CredentialHost

export interface SetupLinkAccount {
  id: string
  name?: string
}

/** One host target of `.vitehub/link.json`. */
export interface SetupLinkTarget {
  /** Absent only for a Deno link without `--account`. */
  account?: SetupLinkAccount
  project: { id?: string, name: string }
  /** True when the host API confirmed that the project exists. */
  verified: boolean
  linkedAt: string
}

/** A host target with its host, as deploy and the other commands use it. */
export interface SetupLink extends SetupLinkTarget {
  host: SetupLinkHost
}

/** The content of `.vitehub/link.json`: one target for each linked host, and the host that deploys without `--host`. */
export interface SetupLinkFile {
  schemaVersion: 2
  default?: SetupLinkHost
  targets: Partial<Record<SetupLinkHost, SetupLinkTarget>>
}

/** The parsed link file. `targets` is empty when the project has no link. */
export interface SetupLinks {
  default?: SetupLinkHost
  targets: SetupLink[]
}

/** The link fields that `vitehub status` reports. */
export type SetupLinkSummary = Pick<SetupLink, "host" | "account" | "project" | "verified">

export interface SetupLinkOptions {
  host?: string
  project?: string
  account?: string
  create: boolean
  /** Make this host the default target. The first linked host is always the default. */
  default?: boolean
}

export interface SetupLinkResult {
  file: string
  link: SetupLink
  /** The host that `vitehub deploy` uses without `--host`. `null` with several hosts and no default. */
  default: SetupLinkHost | null
  /** Every linked host, this one included. */
  hosts: SetupLinkHost[]
  /** True when `--create` created the project on the host. */
  created: boolean
  /** Where the credentials came from. `null` when the host needs none for a link (Deno). */
  credentials: { source: CredentialSource } | null
  /** `added` when the command appended `.vitehub` to `.gitignore`. `no-gitignore` when the project has no `.gitignore`. */
  gitignore: "added" | "present" | "no-gitignore"
}

interface HostProject {
  account?: SetupLinkAccount
  project: { id?: string, name: string }
  created: boolean
  verified: boolean
}

const linkHosts: readonly SetupLinkHost[] = ["cloudflare", "vercel", "netlify", "deno"]

function isLinkHost(value: string): value is SetupLinkHost {
  return linkHosts.some(host => host === value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function invalidResponse(host: string): Error {
  return cliErrorDiagnostics.CLI_R0001({ message: `[vitehub] The ${host} API returned an unexpected response.` })
}

/** The same normalization as the deployment identity of `vitehub({ name })`. */
function normalizeName(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || undefined
}

async function packageName(root: string): Promise<string | undefined> {
  for (let folder = root; ; folder = dirname(folder)) {
    const file = join(folder, "package.json")
    if (existsSync(file)) {
      const value: unknown = JSON.parse(await readFile(file, "utf8"))
      const name = isRecord(value) ? optionalString(value.name)?.trim() : undefined
      if (name) return name
    }
    if (dirname(folder) === folder) return
  }
}

function nameRequired(): SetupFailure {
  return new SetupFailure(cliErrorDiagnostics.SETUP_LINK_NAME_REQUIRED(), setupExitCodes.inputNeeded, { missing: [{ field: "project" }], rerun: "vitehub link --project <name>" })
}

/** `--project`, else the literal `name` of vitehub(), else the package.json name, normalized as the build does. */
async function projectName(project: SetupProject, option: string | undefined): Promise<string> {
  if (option?.trim()) return option.trim()
  const config = project.config
  if (config?.ok) {
    const name = config.site.keys.name
    if (name?.kind === "literal" && typeof name.value === "string") {
      const normalized = normalizeName(name.value)
      if (normalized) return normalized
    }
    if (name || config.site.spread) throw nameRequired()
  }
  else if (config && config.reason !== "no-vitehub") {
    throw nameRequired()
  }
  const name = normalizeName(await packageName(project.root))
  if (name) return name
  throw nameRequired()
}

function linkHost(project: SetupProject, option: string | undefined, env: NodeJS.ProcessEnv): SetupLinkHost {
  const chosen = readLinkHostOption(option)
  if (chosen) return chosen
  const host = setupStatus(project, env).host.name
  if (!isLinkHost(host)) throw new SetupFailure(cliErrorDiagnostics.SETUP_LINK_HOST_UNSUPPORTED({ host }), setupExitCodes.conflict, { missing: [{ field: "host", choices: linkHosts.map(id => ({ id })) }], rerun: "vitehub link --host <host>" })
  return host
}

function rerunCommand(host: SetupLinkHost, name: string, options: SetupLinkOptions, extra: string): string {
  return ["vitehub link", `--host ${host}`, `--project ${name}`, ...(options.account ? [`--account ${options.account}`] : []), extra].join(" ")
}

function notFound(host: SetupLinkHost, name: string, options: SetupLinkOptions, account: string | undefined): SetupFailure {
  const rerun = rerunCommand(host, name, options, "--create")
  return new SetupFailure(cliErrorDiagnostics.SETUP_LINK_PROJECT_NOT_FOUND({ account, host, project: name, rerun }), setupExitCodes.conflict, { rerun })
}

/** Returns undefined when the host API answers 404. */
async function unlessNotFound<T>(request: Promise<T>): Promise<T | undefined> {
  try {
    return await request
  }
  catch (error: unknown) {
    if (error instanceof ProvisionRequestError && error.status === 404) return
    throw error
  }
}

function parseCloudflareAccounts(value: unknown): SetupLinkAccount[] {
  if (!Array.isArray(value)) throw invalidResponse("Cloudflare")
  return value.flatMap((account: unknown) => {
    const id = isRecord(account) ? optionalString(account.id) : undefined
    if (!id || !isRecord(account)) return []
    const name = optionalString(account.name)
    return [{ id, ...(name ? { name } : {}) }]
  })
}

function parseCloudflareWorker(value: unknown): { id?: string, name: string } {
  const name = isRecord(value) ? optionalString(value.name) : undefined
  if (!isRecord(value) || !name) throw invalidResponse("Cloudflare")
  const id = optionalString(value.id)
  return { ...(id ? { id } : {}), name }
}

// Workers API: GET /accounts and GET or POST /accounts/{account_id}/workers/workers[/{name}].
async function linkCloudflare(name: string, options: SetupLinkOptions, token: string, accountId: string | undefined, fetchImpl: typeof fetch): Promise<HostProject> {
  let account: SetupLinkAccount
  if (accountId) account = { id: accountId }
  else {
    const listed = await createCloudflareApiClient(token, fetchImpl)("/accounts", { parse: parseCloudflareAccounts, query: { per_page: "50" } })
    const accounts = listed.result ?? []
    const count = Math.max(accounts.length, listed.result_info?.total_count ?? 0)
    if (count !== 1 || !accounts[0]) {
      throw new SetupFailure(cliErrorDiagnostics.SETUP_LINK_ACCOUNT_REQUIRED({ count }), setupExitCodes.inputNeeded, {
        missing: [{ choices: accounts, field: "account" }],
        rerun: rerunCommand("cloudflare", name, { ...options, account: undefined }, "--account <id>"),
      })
    }
    account = accounts[0]
  }
  const client = createCloudflareProvisionClient({ accountId: account.id, token }, fetchImpl)
  const found = await unlessNotFound(client(`/workers/workers/${encodeURIComponent(name)}`, { parse: parseCloudflareWorker }))
  if (found?.result) return { account, created: false, project: found.result, verified: true }
  if (!options.create) throw notFound("cloudflare", name, options, account.id)
  const created = await client("/workers/workers", { body: { name }, method: "POST", parse: parseCloudflareWorker })
  if (!created.result) throw invalidResponse("Cloudflare")
  return { account, created: true, project: created.result, verified: true }
}

function parseVercelProject(value: unknown): { id: string, name: string, accountId?: string } {
  const id = isRecord(value) ? optionalString(value.id) : undefined
  const name = isRecord(value) ? optionalString(value.name) : undefined
  if (!isRecord(value) || !id || !name) throw invalidResponse("Vercel")
  const accountId = optionalString(value.accountId)
  return { id, name, ...(accountId ? { accountId } : {}) }
}

// Projects API: GET /v9/projects/{idOrName} and POST /v11/projects, with `teamId` for a team.
async function linkVercel(name: string, options: SetupLinkOptions, token: string, teamId: string | undefined, fetchImpl: typeof fetch): Promise<HostProject> {
  const client = createVercelProvisionClient({ teamId, token }, fetchImpl)
  let created = false
  let project = await unlessNotFound(client(`/v9/projects/${encodeURIComponent(name)}`, { parse: parseVercelProject }))
  if (!project) {
    if (!options.create) throw notFound("vercel", name, options, teamId)
    project = await client("/v11/projects", { body: { name }, method: "POST", parse: parseVercelProject })
    created = true
  }
  const accountId = project.accountId ?? teamId
  return { ...(accountId ? { account: { id: accountId } } : {}), created, project: { id: project.id, name: project.name }, verified: true }
}

interface NetlifySite {
  id: string
  name: string
  account?: SetupLinkAccount
}

function parseNetlifySite(value: unknown): NetlifySite {
  const id = isRecord(value) ? optionalString(value.id) : undefined
  const name = isRecord(value) ? optionalString(value.name) : undefined
  if (!isRecord(value) || !id || !name) throw invalidResponse("Netlify")
  const accountId = optionalString(value.account_id)
  const accountName = optionalString(value.account_name) ?? optionalString(value.account_slug)
  return { id, name, ...(accountId ? { account: { id: accountId, ...(accountName ? { name: accountName } : {}) } } : {}) }
}

function parseNetlifySites(value: unknown): NetlifySite[] {
  if (!Array.isArray(value)) throw invalidResponse("Netlify")
  return value.map(parseNetlifySite)
}

// Sites API: GET and POST /sites, or /{account_slug}/sites with `--account`. `name` filters by a part of the name.
async function linkNetlify(name: string, options: SetupLinkOptions, token: string, fetchImpl: typeof fetch): Promise<HostProject> {
  const client = createNetlifyApiClient(token, fetchImpl)
  const path = options.account ? `/${encodeURIComponent(options.account)}/sites` : "/sites"
  let site: NetlifySite | undefined
  for (let page = 1; ; page++) {
    const sites = await client(path, { parse: parseNetlifySites, query: { name, per_page: "100", ...(options.account ? {} : { filter: "all" }), page: String(page) } })
    site = sites.find(item => item.name === name)
    if (site || sites.length < 100) break
  }
  let created = false
  if (!site) {
    if (!options.create) throw notFound("netlify", name, options, options.account)
    site = await client(path, { body: { name }, method: "POST", parse: parseNetlifySite })
    created = true
  }
  return { ...(site.account ? { account: site.account } : {}), created, project: { id: site.id, name: site.name }, verified: true }
}

/** `content` of a `.gitignore` with a `.vitehub` line, or undefined when it already ignores `.vitehub`. */
export function gitignoreWithViteHub(content: string): string | undefined {
  const ignored = content.split(/\r?\n/u).some(line => /^\/?(?:\*\*\/)?\.vitehub\/?$/u.test(line.trim()))
  if (ignored) return
  return `${content}${content === "" || content.endsWith("\n") ? "" : "\n"}.vitehub\n`
}

/** Appends `.vitehub` to the project `.gitignore` when it is missing. */
export async function ensureViteHubGitignore(root: string): Promise<SetupLinkResult["gitignore"]> {
  const file = join(root, ".gitignore")
  if (!existsSync(file)) return "no-gitignore"
  const next = gitignoreWithViteHub(await readFile(file, "utf8"))
  if (next === undefined) return "present"
  await writeFile(file, next)
  return "added"
}

/** Looks up the project on the host, creates it with `create`, and writes `.vitehub/link.json`. */
export async function linkSetupProject(project: SetupProject, options: SetupLinkOptions, context: ViteHubCliContext): Promise<SetupLinkResult> {
  const host = linkHost(project, options.host, context.env)
  const name = await projectName(project, options.project)
  const credentialsContext: HostCredentialsContext = { cwd: project.root, env: context.env, ...(context.runHostCli ? { run: context.runHostCli } : {}) }
  const credentials = await resolveHostCredentials(host, credentialsContext)
  const fetchImpl = context.fetch ?? globalThis.fetch

  let linked: HostProject
  if (host === "deno") {
    // Deno Deploy has no project lookup here yet, so the link keeps the name and stays unverified.
    linked = { ...(options.account ? { account: { id: options.account } } : {}), created: false, project: { name }, verified: false }
  }
  else if (!credentials.ok) {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_LINK_CREDENTIALS_MISSING({ fix: credentials.fix, host }), setupExitCodes.inputNeeded, {
      missing: credentials.missing.map(field => ({ field })),
    })
  }
  else if (host === "cloudflare") linked = await linkCloudflare(name, options, credentials.token, options.account ?? credentials.accountId, fetchImpl)
  else if (host === "vercel") linked = await linkVercel(name, options, credentials.token, options.account ?? credentials.teamId, fetchImpl)
  else linked = await linkNetlify(name, options, credentials.token, fetchImpl)

  const link: SetupLink = {
    host,
    ...(linked.account ? { account: linked.account } : {}),
    project: linked.project,
    verified: linked.verified,
    linkedAt: new Date().toISOString(),
  }
  const { added, links } = await addSetupLink(project.root, link, { default: options.default === true })
  if (added) writeSeparateResourcesNote(context, host, links)
  return {
    created: linked.created,
    credentials: host !== "deno" && credentials.ok ? { source: credentials.source } : null,
    default: links.default ?? null,
    file: SETUP_LINK_FILE,
    gitignore: await ensureViteHubGitignore(project.root),
    hosts: links.targets.map(target => target.host),
    link,
  }
}

/**
 * Says once, when a project gets a second host, that host resources are not shared. A D1 database, a KV namespace, an
 * R2 bucket, or a libSQL database of one host is not the store of the other host.
 */
export function writeSeparateResourcesNote(context: Pick<ViteHubCliContext, "stderr">, host: SetupLinkHost, links: SetupLinks): void {
  const others = links.targets.map(target => target.host).filter(item => item !== host)
  if (!others.length) return
  context.stderr.write(`[vitehub] ${host} is a new host for this app, next to ${others.join(", ")}. Resources such as D1, KV, R2, and libSQL are separate on each host, so ${host} starts with its own empty data.\n`)
}

/** The text of `.vitehub/link.json` for `links`. */
export function formatSetupLinkFile(links: SetupLinks): string {
  const file: SetupLinkFile = {
    schemaVersion: 2,
    ...(links.default ? { default: links.default } : {}),
    targets: Object.fromEntries(links.targets.map(({ host, ...target }) => [host, target])),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/** Writes `.vitehub/link.json`, or removes it when `links` has no target. */
export async function writeSetupLinks(root: string, links: SetupLinks): Promise<void> {
  const file = join(root, SETUP_LINK_FILE)
  if (!links.targets.length) {
    await rm(file, { force: true })
    return
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, formatSetupLinkFile(links))
}

/**
 * Adds the target of `link.host`, or replaces it, and keeps the other targets. The first target becomes the default,
 * and `options.default` makes this one the default. `added` is true when the host had no target before.
 */
export async function addSetupLink(root: string, link: SetupLink, options: { default?: boolean } = {}): Promise<{ added: boolean, links: SetupLinks }> {
  const current = await readSetupLinks(root)
  const added = !current.targets.some(target => target.host === link.host)
  const targets = added ? [...current.targets, link] : current.targets.map(target => target.host === link.host ? link : target)
  const fallback = current.default ?? (targets.length === 1 ? link.host : undefined)
  const preferred = options.default ? link.host : fallback
  const links: SetupLinks = { ...(preferred ? { default: preferred } : {}), targets }
  await writeSetupLinks(root, links)
  return { added, links }
}

/**
 * Removes the target of `host`, or the whole link file without `host`. When the default target goes and one target
 * stays, that one becomes the default. Returns false when there was nothing to remove.
 */
export async function unlinkSetupProject(root: string, host?: SetupLinkHost): Promise<boolean> {
  const file = join(root, SETUP_LINK_FILE)
  if (!existsSync(file)) return false
  if (!host) {
    await rm(file, { force: true })
    return true
  }
  const current = await readSetupLinks(root)
  const targets = current.targets.filter(target => target.host !== host)
  if (targets.length === current.targets.length) return false
  const kept = current.default && current.default !== host ? current.default : targets.length === 1 ? targets[0]!.host : undefined
  await writeSetupLinks(root, { ...(kept ? { default: kept } : {}), targets })
  return true
}

function readTarget(host: SetupLinkHost, value: unknown): SetupLink | undefined {
  if (!isRecord(value)) return
  const project = value.project
  const name = isRecord(project) ? optionalString(project.name) : undefined
  if (!isRecord(project) || !name) return
  const projectId = optionalString(project.id)
  const account = isRecord(value.account) ? optionalString(value.account.id) : undefined
  const accountName = isRecord(value.account) ? optionalString(value.account.name) : undefined
  return {
    host,
    ...(account ? { account: { id: account, ...(accountName ? { name: accountName } : {}) } } : {}),
    project: { ...(projectId ? { id: projectId } : {}), name },
    verified: value.verified === true,
    linkedAt: optionalString(value.linkedAt) ?? "",
  }
}

/**
 * Reads the targets of `.vitehub/link.json`. A missing or unreadable file has no target. A file of schema version 1
 * holds one host link, so it reads as one target that is also the default. The next write saves it as version 2.
 */
export async function readSetupLinks(root: string): Promise<SetupLinks> {
  const file = join(root, SETUP_LINK_FILE)
  if (!existsSync(file)) return { targets: [] }
  let value: unknown
  try {
    value = JSON.parse(await readFile(file, "utf8"))
  }
  catch {
    return { targets: [] }
  }
  if (!isRecord(value)) return { targets: [] }
  if (value.schemaVersion === 1) {
    const host = typeof value.host === "string" && isLinkHost(value.host) ? value.host : undefined
    const target = host ? readTarget(host, value) : undefined
    return target ? { default: target.host, targets: [target] } : { targets: [] }
  }
  if (value.schemaVersion !== 2 || !isRecord(value.targets)) return { targets: [] }
  const entries = value.targets
  const targets = linkHosts.flatMap(host => readTarget(host, entries[host]) ?? [])
  const preferred = targets.find(target => target.host === value.default)?.host
  return { ...(preferred ? { default: preferred } : {}), targets }
}

/** The result of picking a target: the target, none, or several without a default. */
export type SetupLinkSelection =
  | { link: SetupLink | undefined }
  | { ambiguous: SetupLinkHost[] }

/** Picks the target of `host`. Without `host`: the default target, else the only target. */
export function selectSetupLink(links: SetupLinks, host?: SetupLinkHost): SetupLinkSelection {
  if (host) return { link: links.targets.find(target => target.host === host) }
  const preferred = links.default ?? (links.targets.length === 1 ? links.targets[0]!.host : undefined)
  if (preferred) return { link: links.targets.find(target => target.host === preferred) }
  return links.targets.length ? { ambiguous: links.targets.map(target => target.host) } : { link: undefined }
}

/** The failure for several targets and no default. `command` is the command to run again with `--host`. */
export function hostRequired(hosts: readonly SetupLinkHost[], command: string): SetupFailure {
  return new SetupFailure(cliErrorDiagnostics.SETUP_LINK_HOST_REQUIRED({ command, hosts: hosts.join(", ") }), setupExitCodes.inputNeeded, {
    missing: [{ choices: hosts.map(id => ({ id })), field: "host" }],
    rerun: `${command} --host ${hosts[0]}`,
  })
}

/** Reads `--host` of a command that uses a link target. */
export function readLinkHostOption(value: string | undefined): SetupLinkHost | undefined {
  if (value === undefined) return
  const host = hostFromNitroPreset(value)
  if (!host) throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] Unknown host ${JSON.stringify(value)}. Use cloudflare, vercel, netlify, or deno.` })
  if (!isLinkHost(host)) throw new SetupFailure(cliErrorDiagnostics.SETUP_LINK_HOST_UNSUPPORTED({ host }), setupExitCodes.conflict)
  return host
}

/** What `vitehub status` adds to the feature status. */
export interface SetupLinkStatus {
  /** The target that `vitehub deploy` uses without `--host`. With several targets and no default, the target of the config host, else `null`. */
  link: SetupLinkSummary | null
  /** Every linked host target. */
  targets: SetupLinkSummary[]
  /** The host that `vitehub deploy` uses without `--host`. */
  default: SetupLinkHost | null
  /** For the `link` host, else the config host. Never includes the token. `null` on a host without credentials (Node). */
  credentials: HostCredentialsDescription | null
}

/** The link file and the credentials that `vitehub status` reads. `credentials` holds the token and never goes in output. */
export interface SetupLinkState {
  status: SetupLinkStatus
  link: SetupLink | undefined
  credentials: HostCredentials | undefined
}

function summary(link: SetupLink): SetupLinkSummary {
  return { host: link.host, ...(link.account ? { account: link.account } : {}), project: link.project, verified: link.verified }
}

/** Reads the link and credentials, skipping CLI discovery offline and sharing the online host deadline. */
export async function readSetupLinkState(project: SetupProject, host: string, context: ViteHubCliContext, options: { offline?: boolean, signal?: AbortSignal } = {}): Promise<SetupLinkState> {
  const links = await readSetupLinks(project.root)
  const selected = selectSetupLink(links)
  const link = "link" in selected ? selected.link : links.targets.find(target => target.host === host)
  const credentialHost = link?.host ?? (isLinkHost(host) ? host : undefined)
  const credentials = credentialHost ? await readStatusCredentials(credentialHost, project.root, context, options) : undefined
  return {
    credentials,
    link,
    status: {
      credentials: credentials ? describeCredentials(credentials) : null,
      default: links.default ?? null,
      link: link ? summary(link) : null,
      targets: links.targets.map(summary),
    },
  }
}

async function readStatusCredentials(host: CredentialHost, cwd: string, context: ViteHubCliContext, options: { offline?: boolean, signal?: AbortSignal }): Promise<HostCredentials> {
  const envOnly = () => resolveHostCredentials(host, { cwd, env: context.env, run: async () => ({ exitCode: 1, stdout: "" }) })
  if (options.offline) return await envOnly()
  const signal = options.signal
  try {
    return await abortable(signal, "Host credential discovery timed out", () => resolveHostCredentials(host, {
      cwd,
      env: context.env,
      run: (command, args, runOptions) => {
        signal?.throwIfAborted()
        return (context.runHostCli ?? runHostCli)(command, args, { ...runOptions, ...(signal ? { signal } : {}) })
      },
    }))
  }
  catch (error: unknown) {
    if (!signal?.aborted) throw error
    // Preserve the credential output contract using only local environment data after a timeout.
    return await envOnly()
  }
}

function describeCredentials(credentials: HostCredentials): HostCredentialsDescription {
  if (!credentials.ok) return credentials
  const { token: _token, ...description } = credentials
  return description
}

/** The link and the credential status for `vitehub status`. The credentials never include the token. */
export async function readSetupLinkStatus(project: SetupProject, host: string, context: ViteHubCliContext): Promise<SetupLinkStatus> {
  return (await readSetupLinkState(project, host, context)).status
}
