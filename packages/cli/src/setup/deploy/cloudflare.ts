import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { createCloudflareProvisionClient } from "@vite-hub/internal/provision"
import { dirname, join } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { shellQuote } from "../add.ts"
import { setupFailure, setupExitCodes } from "../envelope.ts"
import { commandRejected, commitMessage, findUrl, hostCli, hostCliFailed, hostListFailed, isoTime, isRecord, optionalString, parseCommitMessage, splitManifestCommand, untilInterrupted } from "./host.ts"

import type { DeployAdapter, DeployCommit, DeployContext, DeployResult, DeployRunResult, HostDeployment, HostDeploymentSource, HostEnv, HostEnvContext, ListDeployments } from "./host.ts"

const valueFlags = new Set(["--config"])
const plainFlags = new Set(["--containers-rollout=gradual"])

interface WranglerCommand {
  args: string[]
  config: string
  migrations: string[]
}

async function readWranglerCommand(outputDir: string): Promise<WranglerCommand> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(outputDir, "nitro.json"), "utf8"))
  }
  catch {
    throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file: join(outputDir, "nitro.json") }), setupExitCodes.error)
  }
  const command = isRecord(manifest) && isRecord(manifest.commands) ? optionalString(manifest.commands.deploy) : undefined
  if (!command) throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file: `commands.deploy in ${join(outputDir, "nitro.json")}` }), setupExitCodes.error)
  const steps = command.split(" && ").map(step => splitManifestCommand(step))
  const words = steps.pop()!
  if (words[0] !== "npx" || words[1] !== "wrangler" || words[2] !== "deploy") throw commandRejected(command)
  const args: string[] = []
  let config: string | undefined
  for (let index = 3; index < words.length; index++) {
    const word = words[index]!
    if (plainFlags.has(word)) args.push(word)
    else if (valueFlags.has(word) && words[index + 1] !== undefined && !words[index + 1]!.startsWith("-")) {
      const value = words[++index]!
      if (word === "--config") config = value
      args.push(word, value)
    }
    else throw commandRejected(command)
  }
  if (!config) throw commandRejected(command)
  const migrations = steps.map((step) => {
    const [binding, ...flags] = step.slice(5)
    const valid = step.slice(0, 5).join(" ") === "npx wrangler d1 migrations apply" && binding !== undefined && /^[A-Z_a-z]\w*$/u.test(binding)
      && flags.length === 3 && flags[0] === "--remote" && flags[1] === "--config" && flags[2] === config
    if (!valid) throw commandRejected(command)
    return binding
  })
  return { args, config, migrations }
}

/**
 * The plain vars of the Wrangler config that the build writes (`vars` in the `--config` file of `commands.deploy`). The
 * deploy sets them with the version, so the Worker has them at runtime even though `wrangler secret list` omits them.
 */
export async function wranglerVarNames(outputDir: string): Promise<string[]> {
  const { config } = await readWranglerCommand(outputDir)
  const wrangler = await readWranglerConfig(outputDir, config)
  return isRecord(wrangler.vars) ? Object.keys(wrangler.vars) : []
}

/** The Wrangler config that the `--config` flag of `commands.deploy` names. */
async function readWranglerConfig(outputDir: string, config: string): Promise<Record<string, unknown>> {
  const file = join(outputDir, config)
  let value: unknown
  try {
    value = JSON.parse(await readFile(file, "utf8"))
  }
  catch {
    throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file }), setupExitCodes.error)
  }
  return isRecord(value) ? value : {}
}

interface D1Migrations {
  binding: string
  /** The migration file names, as Wrangler records them in the migrations table. */
  files: string[]
  table: string
}

/**
 * The D1 bindings of the Wrangler config whose `migrations_dir` holds `.sql` files, except the bindings that the deploy
 * command migrates. Wrangler reads `migrations_dir` relative to the config file, and its default pattern is `*.sql`
 * without dot files. A binding with `migrations_pattern` selects other files, and ViteHub's build never writes one.
 */
async function unmigratedD1Bindings(outputDir: string, config: string, wrangler: Record<string, unknown>, migrated: readonly string[]): Promise<D1Migrations[]> {
  const found: D1Migrations[] = []
  for (const entry of Array.isArray(wrangler.d1_databases) ? wrangler.d1_databases : []) {
    if (!isRecord(entry)) continue
    const binding = optionalString(entry.binding)
    const dir = optionalString(entry.migrations_dir)
    if (!binding || !dir || entry.migrations_pattern !== undefined || migrated.includes(binding)) continue
    const items = await readdir(join(outputDir, dirname(config), dir), { withFileTypes: true }).catch(() => [])
    const files = items.filter(item => item.isFile() && item.name.endsWith(".sql") && !item.name.startsWith(".")).map(item => item.name).toSorted()
    if (files.length) found.push({ binding, files, table: optionalString(entry.migrations_table) ?? "d1_migrations" })
  }
  return found
}

function d1BindingsWithoutId(wrangler: Record<string, unknown>): string[] {
  return (Array.isArray(wrangler.d1_databases) ? wrangler.d1_databases : []).flatMap((entry) => {
    if (!isRecord(entry) || optionalString(entry.database_id)) return []
    const binding = optionalString(entry.binding)
    return binding ? [binding] : []
  })
}

/** The `results` rows of `wrangler d1 execute --json`, which prints one `{ results, success, meta }` per statement. */
function d1ResultNames(result: DeployRunResult): string[] | undefined {
  let value: unknown
  try {
    value = JSON.parse(result.stdout.slice(Math.max(result.stdout.indexOf("["), 0)))
  }
  catch {
    return undefined
  }
  if (!Array.isArray(value)) return undefined
  return value.flatMap(item => isRecord(item) && Array.isArray(item.results) ? item.results : [])
    .flatMap(row => isRecord(row) && typeof row.name === "string" ? [row.name] : [])
}

interface WranglerOutputEntry {
  type?: unknown
  version_id?: unknown
  targets?: unknown
  preview_url?: unknown
  worker_name?: unknown
}

async function readWranglerOutput(file: string): Promise<WranglerOutputEntry[]> {
  const text = await readFile(file, "utf8").catch(() => "")
  return text.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line)
      return isRecord(value) ? [value] : []
    }
    catch {
      return []
    }
  })
}

/**
 * Wrangler 4.157 writes the `workers.dev` target as an `https://` URL, a custom domain as a bare host, such as
 * `example.com (custom domain)`, and a route as its pattern. A route with one host and the path `/*` serves every path
 * of that host. A wildcard host, a narrower path, triggers, and a custom domain with `production: disabled` have no
 * URL to request.
 */
export function wranglerTargetUrl(targets: unknown): string | undefined {
  const texts = Array.isArray(targets) ? targets.filter(target => typeof target === "string") : []
  return [...texts.map(directTargetUrl), ...texts.map(routeTargetUrl)].find(url => url !== undefined && URL.canParse(url))
}

const workersDevTarget = /^https:\/\/[^\s*/]+\.workers\.dev\/?$/u
const customDomainTarget = /^([^\s*/:]+) \(custom domain[ )]/u
const catchAllRouteTarget = /^(?:https:\/\/)?([^\s*/:]+)\/\*(?: \(zone (?:id|name): [^)]+\))?$/u

function directTargetUrl(target: string): string | undefined {
  if (workersDevTarget.test(target)) return target
  const domain = customDomainTarget.exec(target)?.[1]
  return domain && !target.includes("production: disabled") ? `https://${domain}` : undefined
}

function routeTargetUrl(target: string): string | undefined {
  const host = catchAllRouteTarget.exec(target)?.[1]
  return host ? `https://${host}` : undefined
}

const durationUnits: Record<string, number> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }

function claimExpiry(text: string): string | undefined {
  const match = /Claim within:\s*(\d+)\s*(second|minute|hour|day)s?/u.exec(text)
  return match ? new Date(Date.now() + Number(match[1]) * durationUnits[match[2]!]!).toISOString() : undefined
}

export async function cloudflareAdapter(context: DeployContext): Promise<DeployAdapter> {
  const command = await readWranglerCommand(context.outputDir)
  const wrangler = hostCli("wrangler", "wrangler", context.root, context.env)
  const linked = !context.temporary && context.link?.host === "cloudflare" ? context.link : undefined
  const accountId = linked?.account?.id ?? (context.credentials.ok ? context.credentials.accountId : undefined)
  const target = linked ? ["--name", linked.project.name] : []
  const env: NodeJS.ProcessEnv = {
    ...context.env,
    ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
  }
  const run = (args: readonly string[], options: { stdin?: string, show?: boolean, env?: NodeJS.ProcessEnv, signal?: AbortSignal } = {}) =>
    context.run(wrangler[0], [...wrangler.slice(1), ...args], { cwd: context.outputDir, env: options.env ?? env, ...options })

  /** The migrations of `target` that its migrations table does not list. A database without the table has none applied. */
  const pendingD1Migrations = async (target: D1Migrations): Promise<string[]> => {
    const query = async (sql: string) => {
      const step = `wrangler d1 execute ${target.binding}`
      const result = await run(["d1", "execute", target.binding, "--remote", "--config", command.config, "--json", "--command", sql], { env: { ...env, WRANGLER_LOG: "log" } })
      if (result.exitCode !== 0) throw hostCliFailed(step, result, context.secrets)
      const names = d1ResultNames(result)
      if (!names) throw hostCliFailed(`${step} printed no JSON`, result, context.secrets)
      return names
    }
    const tables = await query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${target.table.replaceAll("'", "''")}'`)
    const applied = new Set(tables.length ? await query(`SELECT name FROM "${target.table.replaceAll('"', '""')}"`) : [])
    return target.files.filter(file => !applied.has(file))
  }

  return {
    async deploy(): Promise<DeployResult> {
      if (!context.temporary) {
        const wranglerConfig = await readWranglerConfig(context.outputDir, command.config)
        const environment = env.CLOUDFLARE_ENV
        const named = environment && isRecord(wranglerConfig.env) && Object.hasOwn(wranglerConfig.env, environment) ? wranglerConfig.env[environment] : undefined
        const config = isRecord(named) ? named : wranglerConfig
        const unprovisioned = d1BindingsWithoutId(config)
        if (unprovisioned.length) {
          throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_D1_DATABASE_ID_MISSING({ bindings: unprovisioned.join(", ") }), setupExitCodes.error)
        }
        // Without `database.migrateOnDeploy`, nothing applies the migrations of the build. New code on old tables
        // answers every query that needs a new table or column with an error, so the deploy stops before it ships.
        for (const target of context.preview ? [] : await unmigratedD1Bindings(context.outputDir, command.config, config, command.migrations)) {
          const pending = await pendingD1Migrations(target)
          if (!pending.length) continue
          throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_D1_MIGRATIONS_PENDING({
            apply: `npx wrangler d1 migrations apply ${shellQuote(target.binding)} --remote --config ${shellQuote(command.config)}${environment ? ` --env ${shellQuote(environment)}` : ""}`,
            binding: target.binding,
            migrations: pending.join(", "),
          }), setupExitCodes.error)
        }
        for (const binding of context.preview ? [] : command.migrations) {
          const result = await run(["d1", "migrations", "apply", binding, "--remote", "--config", command.config], { show: true })
          if (result.exitCode !== 0) throw hostCliFailed(`wrangler d1 migrations apply ${binding}`, result, context.secrets)
        }
      }
      return await untilInterrupted(async (signal) => {
        const folder = await mkdtemp(join(tmpdir(), "vitehub-deploy-"))
        const outputFile = join(folder, "wrangler-output.jsonl")
        try {
          const args = context.preview
            ? ["versions", "upload", ...command.args.filter(arg => !plainFlags.has(arg))]
            : ["deploy", ...command.args]
          args.push(...target, "--keep-vars")
          if (context.temporary) args.push("--temporary")
          if (context.commit) args.push("--tag", context.commit.sha.slice(0, 12), "--message", commitMessage(context.commit))
          if (context.upload && Object.keys(context.upload).length) {
            const secretsFile = join(folder, "secrets.json")
            await writeFile(secretsFile, JSON.stringify(context.upload), { flag: "wx", mode: 0o600 })
            args.push("--secrets-file", secretsFile)
          }
          const result = await run(args, { env: { ...env, WRANGLER_OUTPUT_FILE_PATH: outputFile }, show: true, signal })
          const step = context.preview ? "wrangler versions upload" : "wrangler deploy"
          if (result.exitCode !== 0) throw hostCliFailed(step, result, context.secrets)
          const entry = (await readWranglerOutput(outputFile)).findLast(item => item.type === (context.preview ? "version-upload" : "deploy"))
          const text = `${result.stdout}\n${result.stderr}`
          const fromTargets = entry && !context.preview
          const url = fromTargets ? wranglerTargetUrl(entry.targets) : optionalString(entry?.preview_url) ?? findUrl(text, /\.workers\.dev$/u)
          if (!url && !fromTargets) throw hostCliFailed(`${step} printed no URL`, result, context.secrets)
          const version = optionalString(entry?.version_id)
          const claimUrl = /Claim URL:\s*(https:\/\/\S+)/u.exec(text)?.[1]
          const expiresAt = claimExpiry(text)
          const name = optionalString(entry?.worker_name)
          return {
            ...(url ? { url } : {}),
            ...(version ? { version } : {}),
            ...(claimUrl ? { claim: { url: claimUrl, ...(expiresAt ? { expiresAt } : {}) } } : {}),
            ...(name ? { project: { name, ...(accountId ? { accountId } : {}) } } : {}),
          }
        }
        finally {
          await rm(folder, { force: true, recursive: true })
        }
      })
    },
  }
}

interface CloudflareVersion {
  id: string
  createdAt: string
  hasPreview: boolean
  commit?: DeployCommit
  source: HostDeploymentSource
}

/**
 * The secrets of the linked Worker. Wrangler 4.158 (`wrangler secret put --help`, `wrangler secret list --help`, in
 * test/fixtures/host-cli-help/). `secret put` reads the value from stdin when stdin is not a terminal, and creates a
 * draft Worker when the Worker does not exist. A Worker has one set of secrets for every version, so there is no
 * preview target. Every value becomes a secret: a plain var lives in the Wrangler config that the build writes.
 */
export function cloudflareEnv(context: HostEnvContext): HostEnv {
  const wrangler = hostCli("wrangler", "wrangler", context.root, context.env)
  const env: NodeJS.ProcessEnv = { ...context.env, ...(context.link.account ? { CLOUDFLARE_ACCOUNT_ID: context.link.account.id } : {}) }
  const worker = ["--name", context.link.project.name]
  const run = (args: readonly string[], stdin?: string) =>
    context.run(wrangler[0], [...wrangler.slice(1), ...args], { cwd: context.root, env, ...(stdin === undefined ? {} : { stdin }) })

  return {
    async listSecretNames() {
      const result = await run(["secret", "list", "--format", "json", ...worker])
      if (result.exitCode !== 0) throw hostListFailed("wrangler secret list", result, context.secrets)
      const start = result.stdout.indexOf("[")
      let value: unknown
      try {
        value = JSON.parse(result.stdout.slice(start))
      }
      catch {
        throw hostListFailed("wrangler secret list printed no JSON", result, context.secrets)
      }
      return Array.isArray(value) ? value.flatMap(item => isRecord(item) && typeof item.name === "string" ? [item.name] : []) : []
    },
    async setSecret(name, value) {
      const result = await run(["secret", "put", name, ...worker], value)
      if (result.exitCode !== 0) throw hostCliFailed(`wrangler secret put ${name}`, result, context.secrets)
    },
  }
}

function cloudflareSource(value: unknown): HostDeploymentSource {
  if (value === "wrangler" || value === "cf_cli") return "cli"
  if (value === "workersci") return "git"
  if (value === "dash" || value === "dash_template" || value === "quick_editor" || value === "playground") return "dashboard"
  if (value === "api" || value === "terraform" || value === "integration") return "api"
  return "unknown"
}

function parseVersion(value: unknown): CloudflareVersion | undefined {
  if (!isRecord(value)) return
  const id = optionalString(value.id)
  if (!id) return
  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const commit = isRecord(value.annotations) ? parseCommitMessage(value.annotations["workers/message"]) : undefined
  return { createdAt: isoTime(metadata.created_on), hasPreview: metadata.hasPreview === true, id, source: cloudflareSource(metadata.source), ...(commit ? { commit } : {}) }
}

function parseVersions(value: unknown): CloudflareVersion[] {
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : []
  return items.flatMap(item => parseVersion(item) ?? [])
}

interface CloudflareDeployment {
  id: string
  createdAt: string
  source: HostDeploymentSource
  versionId?: string
  versionIds: string[]
}

function parseDeployments(value: unknown): CloudflareDeployment[] {
  const items = isRecord(value) && Array.isArray(value.deployments) ? value.deployments : []
  return items.flatMap((item: unknown) => {
    const id = isRecord(item) ? optionalString(item.id) : undefined
    if (!id || !isRecord(item)) return []
    const versions = (Array.isArray(item.versions) ? item.versions : []).flatMap((version: unknown) => {
      const versionId = isRecord(version) ? optionalString(version.version_id) : undefined
      return versionId && isRecord(version) ? [{ id: versionId, percentage: typeof version.percentage === "number" ? version.percentage : 0 }] : []
    })
    const main = versions.toSorted((a, b) => b.percentage - a.percentage)[0]
    return [{ createdAt: isoTime(item.created_on), id, source: cloudflareSource(item.source), versionIds: versions.map(version => version.id), ...(main ? { versionId: main.id } : {}) }]
  })
}

async function optional<T>(request: Promise<T>): Promise<T | undefined> {
  try {
    return await request
  }
  catch {
    return undefined
  }
}

/**
 * Workers API, newest first:
 * - `GET /accounts/{account_id}/workers/scripts/{script_name}/deployments`: the first one gets the traffic, as in
 *   `wrangler deployments list`. https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
 * - `GET .../versions?per_page=`: a bounded page of versions, with the `workers/message` annotation. A version in no
 *   deployment is a preview (`wrangler versions upload`). https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/
 * - `GET /accounts/{account_id}/workers/subdomain`: the account's `workers.dev` suffix. https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/
 * - `GET .../scripts/{script_name}/subdomain`: whether production and preview `workers.dev` URLs are enabled. https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get/
 */
export const listCloudflareDeployments: ListDeployments = async (context, { limit, includeLive }) => {
  const accountId = context.link.account?.id ?? context.credentials.accountId
  if (!accountId) throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOYMENTS_ACCOUNT_REQUIRED({ host: "cloudflare" }), setupExitCodes.inputNeeded, { missing: [{ field: "CLOUDFLARE_ACCOUNT_ID" }], rerun: "vitehub link --host cloudflare --account <id>" })
  const client = createCloudflareProvisionClient({ accountId, token: context.credentials.token }, context.fetch)
  const script = `/workers/scripts/${encodeURIComponent(context.link.project.name)}`
  const [deployments, versions, subdomain, settings] = await Promise.all([
    client(`${script}/deployments`, { parse: parseDeployments, query: { per_page: String(limit) } }),
    client(`${script}/versions`, { parse: parseVersions, query: { per_page: String(limit) } }),
    optional(client("/workers/subdomain", { parse: value => isRecord(value) ? optionalString(value.subdomain) : undefined })),
    optional(client(`${script}/subdomain`, { parse: value => isRecord(value) ? { enabled: value.enabled === true, previewsEnabled: value.previews_enabled === true } : undefined })),
  ])
  const byId = new Map((versions.result ?? []).map(version => [version.id, version]))
  const listed = (deployments.result ?? []).slice(0, limit)
  const missing = [...new Set(listed.flatMap(item => item.versionId && !byId.has(item.versionId) ? [item.versionId] : []))]
  for (const version of await Promise.all(missing.map(id => optional(client(`${script}/versions/${encodeURIComponent(id)}`, { parse: parseVersion }))))) {
    if (version?.result) byId.set(version.result.id, version.result)
  }

  const name = context.link.project.name
  const host = subdomain?.result ? `${subdomain.result}.workers.dev` : undefined
  const productionUrl = host && settings?.result?.enabled ? `https://${name}.${host}` : undefined
  const previewUrl = (version: CloudflareVersion | undefined) => host && settings?.result?.previewsEnabled && version?.hasPreview ? `https://${version.id.slice(0, 8)}-${name}.${host}` : undefined
  const deployed = new Set(listed.flatMap(item => item.versionIds))
  const result: HostDeployment[] = listed.map((item, index) => {
    const version = item.versionId ? byId.get(item.versionId) : undefined
    const url = index === 0 ? productionUrl : previewUrl(version)
    return {
      createdAt: item.createdAt,
      id: item.id,
      live: index === 0,
      source: item.source,
      state: "ready",
      target: "production",
      ...(url ? { url } : {}),
      ...(item.versionId ? { version: item.versionId } : {}),
      ...(version?.commit ? { commit: { ...version.commit, from: "vitehub" } } : {}),
    } satisfies HostDeployment
  })
  for (const version of versions.result ?? []) {
    if (deployed.has(version.id)) continue
    const url = previewUrl(version)
    result.push({
      createdAt: version.createdAt,
      id: version.id,
      live: false,
      source: version.source,
      state: "ready",
      target: "preview",
      version: version.id,
      ...(url ? { url } : {}),
      ...(version.commit ? { commit: { ...version.commit, from: "vitehub" } } : {}),
    })
  }
  const recent = result.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
  const live = result.find(item => item.live)
  if (includeLive && live && !recent.includes(live)) recent.push(live)
  return recent
}
