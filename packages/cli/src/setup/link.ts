import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"

import { deploymentPresetFromNitro } from "@vite-hub/internal/deployment"
import { resolveHostCredentials } from "@vite-hub/internal/host-credentials"
import {
  createCloudflareApiClient,
  createCloudflareProvisionClient,
  createNetlifyApiClient,
  createVercelProvisionClient,
  ProvisionRequestError,
} from "@vite-hub/internal/provision"
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

/** The content of `.vitehub/link.json`. */
export interface SetupLink {
  schemaVersion: 1
  host: SetupLinkHost
  /** Absent only for a Deno link without `--account`. */
  account?: SetupLinkAccount
  project: { id?: string, name: string }
  /** True when the host API confirmed that the project exists. */
  verified: boolean
  linkedAt: string
}

/**
 * The pending Console link from `vitehub init --console`. `tokenSha256` is the SHA-256 of a secret that only the
 * browser holds, so the file never holds the secret itself.
 */
export interface SetupConsoleLink {
  pendingId: string
  tokenSha256: string
}

/** The content of `.vitehub/link.json`: a host link, a pending Console link, or both. */
export type SetupLinkFile = { schemaVersion: 1, console?: SetupConsoleLink } & Partial<Omit<SetupLink, "schemaVersion">>

/** The link fields that `vitehub status` reports. */
export type SetupLinkSummary = Pick<SetupLink, "host" | "account" | "project" | "verified">

export interface SetupLinkOptions {
  host?: string
  project?: string
  account?: string
  create: boolean
}

export interface SetupLinkResult {
  file: string
  link: SetupLink
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
  if (option !== undefined) {
    const preset = deploymentPresetFromNitro(option)
    if (!preset) throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] Unknown host ${JSON.stringify(option)}. Use cloudflare, vercel, netlify, or deno.` })
    if (!isLinkHost(preset)) throw new SetupFailure(cliErrorDiagnostics.SETUP_LINK_HOST_UNSUPPORTED({ host: preset }), setupExitCodes.conflict)
    return preset
  }
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
    schemaVersion: 1,
    host,
    ...(linked.account ? { account: linked.account } : {}),
    project: linked.project,
    verified: linked.verified,
    linkedAt: new Date().toISOString(),
  }
  const pending = await readSetupConsoleLink(project.root)
  await writeSetupLinkFile(project.root, { ...link, ...(pending ? { console: pending } : {}) })
  return {
    created: linked.created,
    credentials: credentials.ok ? { source: credentials.source } : null,
    file: SETUP_LINK_FILE,
    gitignore: await ensureViteHubGitignore(project.root),
    link,
  }
}

/** The text of `.vitehub/link.json` for `link`. */
export function formatSetupLinkFile(link: SetupLinkFile): string {
  return `${JSON.stringify(link, null, 2)}\n`
}

/** Writes `.vitehub/link.json`. */
export async function writeSetupLinkFile(root: string, link: SetupLinkFile): Promise<void> {
  const file = join(root, SETUP_LINK_FILE)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, formatSetupLinkFile(link))
}

/**
 * Removes the host link from `.vitehub/link.json`. A pending Console link stays; without one, the file goes.
 * Returns false when the project has no host link.
 */
export async function unlinkSetupProject(root: string): Promise<boolean> {
  const file = join(root, SETUP_LINK_FILE)
  if (!existsSync(file)) return false
  const [link, pending] = await Promise.all([readSetupLink(root), readSetupConsoleLink(root)])
  if (pending) {
    if (!link) return false
    await writeSetupLinkFile(root, { console: pending, schemaVersion: 1 })
    return true
  }
  await rm(file, { force: true })
  return true
}

async function readLinkJson(root: string): Promise<Record<string, unknown> | undefined> {
  const file = join(root, SETUP_LINK_FILE)
  if (!existsSync(file)) return
  let value: unknown
  try {
    value = JSON.parse(await readFile(file, "utf8"))
  }
  catch {
    return
  }
  return isRecord(value) && value.schemaVersion === 1 ? value : undefined
}

/** A valid `--console` pending id: URL-safe characters only. */
export const consolePendingIdPattern: RegExp = /^[\w-]{1,128}$/u

/** Reads the pending Console link from `.vitehub/link.json`. Returns undefined when there is none. */
export async function readSetupConsoleLink(root: string): Promise<SetupConsoleLink | undefined> {
  const pending = (await readLinkJson(root))?.console
  if (!isRecord(pending)) return
  const pendingId = optionalString(pending.pendingId)
  const tokenSha256 = optionalString(pending.tokenSha256)
  if (!pendingId || !consolePendingIdPattern.test(pendingId) || !tokenSha256 || !/^[0-9a-f]{64}$/u.test(tokenSha256)) return
  return { pendingId, tokenSha256 }
}

/** Reads the host link from `.vitehub/link.json`. Returns undefined when the file is missing or has no host link. */
export async function readSetupLink(root: string): Promise<SetupLink | undefined> {
  const value = await readLinkJson(root)
  if (!value || typeof value.host !== "string" || !isLinkHost(value.host)) return
  const project = value.project
  const name = isRecord(project) ? optionalString(project.name) : undefined
  if (!isRecord(project) || !name) return
  const projectId = optionalString(project.id)
  const account = isRecord(value.account) ? optionalString(value.account.id) : undefined
  const accountName = isRecord(value.account) ? optionalString(value.account.name) : undefined
  return {
    schemaVersion: 1,
    host: value.host,
    ...(account ? { account: { id: account, ...(accountName ? { name: accountName } : {}) } } : {}),
    project: { ...(projectId ? { id: projectId } : {}), name },
    verified: value.verified === true,
    linkedAt: optionalString(value.linkedAt) ?? "",
  }
}

/** What `vitehub status` adds to the feature status. */
export interface SetupLinkStatus {
  link: SetupLinkSummary | null
  /** The pending Console link from `vitehub init --console`, without the hash. */
  console: { pendingId: string } | null
  /** For the linked host, else the config host. Never includes the token. `null` on a host without credentials (Node). */
  credentials: HostCredentialsDescription | null
}

/** The link file and the credentials that `vitehub status` reads. `credentials` holds the token and never goes in output. */
export interface SetupLinkState {
  status: SetupLinkStatus
  link: SetupLink | undefined
  credentials: HostCredentials | undefined
}

/** Reads the link and resolves the credentials once, for the status fields and for a host request. */
export async function readSetupLinkState(project: SetupProject, host: string, context: ViteHubCliContext): Promise<SetupLinkState> {
  const [link, pending] = await Promise.all([readSetupLink(project.root), readSetupConsoleLink(project.root)])
  const credentialHost = link?.host ?? (isLinkHost(host) ? host : undefined)
  const credentials = credentialHost
    ? await resolveHostCredentials(credentialHost, { cwd: project.root, env: context.env, ...(context.runHostCli ? { run: context.runHostCli } : {}) })
    : undefined
  return {
    credentials,
    link,
    status: {
      console: pending ? { pendingId: pending.pendingId } : null,
      credentials: credentials ? describeCredentials(credentials) : null,
      link: link ? { host: link.host, ...(link.account ? { account: link.account } : {}), project: link.project, verified: link.verified } : null,
    },
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
