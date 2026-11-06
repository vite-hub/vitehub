import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { createCloudflareProvisionClient } from "@vite-hub/internal/provision"
import { join, resolve } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"
import { commandRejected, commitMessage, findUrl, hostCli, hostCliFailed, isoTime, isRecord, listsName, optionalString, parseCommitMessage, splitManifestCommand } from "./host.ts"

import type { DeployAdapter, DeployCommit, DeployContext, DeployResult, HostDeployment, HostDeploymentSource, ListDeployments } from "./host.ts"

/** The flags that ViteHub's own build writes into `commands.deploy` (`packages/vite-hub/src/index.ts`). */
const valueFlags = new Set(["--config", "--secrets-file"])
const plainFlags = new Set(["--containers-rollout=gradual"])

interface WranglerCommand {
  /** `--config` and `--secrets-file` with their values, and the rollout flag, in build order. */
  args: string[]
  config: string
}

/**
 * Reads `commands.deploy` from `<output>/nitro.json` and checks that it is the Wrangler deploy that the build writes:
 * `npx wrangler deploy --config <file> [--secrets-file <file>] [--containers-rollout=gradual]`.
 */
async function readWranglerCommand(outputDir: string): Promise<WranglerCommand> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(outputDir, "nitro.json"), "utf8"))
  }
  catch {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file: join(outputDir, "nitro.json") }), setupExitCodes.error)
  }
  const command = isRecord(manifest) && isRecord(manifest.commands) ? optionalString(manifest.commands.deploy) : undefined
  if (!command) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file: `commands.deploy in ${join(outputDir, "nitro.json")}` }), setupExitCodes.error)
  const words = splitManifestCommand(command)
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
  return { args, config }
}

interface WranglerOutputEntry {
  type?: unknown
  version_id?: unknown
  targets?: unknown
  preview_url?: unknown
  worker_name?: unknown
}

/** Wrangler writes one JSON object per line to `WRANGLER_OUTPUT_FILE_PATH`. */
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

const durationUnits: Record<string, number> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }

/** `Claim within: 59 minutes` as an ISO time, from now. */
function claimExpiry(text: string): string | undefined {
  const match = /Claim within:\s*(\d+)\s*(second|minute|hour|day)s?/u.exec(text)
  return match ? new Date(Date.now() + Number(match[1]) * durationUnits[match[2]!]!).toISOString() : undefined
}

// Wrangler 4.158: `wrangler deploy --help`, `wrangler secret put --help`, `wrangler secret list --help`, and the global
// `--temporary` flag. Recorded in test/fixtures/host-cli-help/.
export async function cloudflareAdapter(context: DeployContext): Promise<DeployAdapter> {
  const command = await readWranglerCommand(context.outputDir)
  const wrangler = hostCli("wrangler", "wrangler", context.root, context.env)
  const env: NodeJS.ProcessEnv = {
    ...context.env,
    ...(context.credentials.ok && context.credentials.accountId ? { CLOUDFLARE_ACCOUNT_ID: context.credentials.accountId } : {}),
  }
  const run = (args: readonly string[], options: { stdin?: string, show?: boolean, env?: NodeJS.ProcessEnv } = {}) =>
    context.run(wrangler[0], [...wrangler.slice(1), ...args], { cwd: context.outputDir, env: options.env ?? env, ...options })

  return {
    async deploy(): Promise<DeployResult> {
      const folder = await mkdtemp(join(tmpdir(), "vitehub-deploy-"))
      const outputFile = join(folder, "wrangler-output.jsonl")
      try {
        const args = context.preview
          ? ["versions", "upload", ...command.args.filter(arg => !plainFlags.has(arg))]
          : ["deploy", ...command.args]
        if (context.temporary) args.push("--temporary")
        if (context.commit) args.push("--tag", context.commit.sha.slice(0, 12), "--message", commitMessage(context.commit))
        const result = await run(args, { env: { ...env, WRANGLER_OUTPUT_FILE_PATH: outputFile }, show: true })
        if (result.exitCode !== 0) throw hostCliFailed(context.preview ? "wrangler versions upload" : "wrangler deploy", result, context.secrets)
        const entry = (await readWranglerOutput(outputFile)).findLast(item => item.type === (context.preview ? "version-upload" : "deploy"))
        const text = `${result.stdout}\n${result.stderr}`
        const targets = Array.isArray(entry?.targets) ? entry.targets.filter(target => typeof target === "string") : []
        const url = (context.preview ? optionalString(entry?.preview_url) : targets[0]) ?? findUrl(text, /\.workers\.dev$/u)
        if (!url) throw hostCliFailed("wrangler deploy printed no URL", result, context.secrets)
        const version = optionalString(entry?.version_id)
        const claimUrl = /Claim URL:\s*(https:\/\/\S+)/u.exec(text)?.[1]
        const expiresAt = claimExpiry(text)
        const name = optionalString(entry?.worker_name)
        return {
          url,
          ...(version ? { version } : {}),
          ...(claimUrl ? { claim: { url: claimUrl, ...(expiresAt ? { expiresAt } : {}) } } : {}),
          ...(name ? { project: { name, ...(context.credentials.ok && context.credentials.accountId ? { accountId: context.credentials.accountId } : {}) } } : {}),
        }
      }
      finally {
        await rm(folder, { force: true, recursive: true })
      }
    },
    async setSecret(name, value) {
      // `wrangler secret put` reads the value from stdin when stdin is not a terminal. On a Worker that does not
      // exist yet, it creates a draft Worker without a prompt.
      const result = await run(["secret", "put", name, "--config", command.config], { stdin: value })
      if (result.exitCode !== 0) throw hostCliFailed(`wrangler secret put ${name}`, result, context.secrets)
    },
    async hasSecret(name) {
      const result = await run(["secret", "list", "--config", command.config, "--format", "json"])
      if (result.exitCode !== 0) return false
      try {
        return listsName(JSON.parse(result.stdout), ["name"], name)
      }
      catch {
        return false
      }
    },
    // `wrangler secret put` creates a draft Worker, so the secret can go first.
    projectExists: async () => true,
    async setTemporaryVar(name, value) {
      // A temporary account has no login for `wrangler secret put`, so the hash goes into the generated config as a
      // plain var. The project config does not change.
      const file = resolve(context.outputDir, command.config)
      const config: unknown = JSON.parse(await readFile(file, "utf8"))
      if (!isRecord(config)) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file }), setupExitCodes.error)
      config.vars = { ...(isRecord(config.vars) ? config.vars : {}), [name]: value }
      await writeFile(file, `${JSON.stringify(config, null, 2)}\n`)
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

/** Version and deployment `source` values: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/ */
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
  // `wrangler deploy --message` and `wrangler versions upload --message` store the marker on the version.
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
  /** The version with the most traffic. */
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

/** A Workers API request that answers undefined on any error, for data that only adds to a listing. */
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
 * - `GET .../versions?deployable=true`: the versions, with the `workers/message` annotation. A version in no
 *   deployment is a preview (`wrangler versions upload`). https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/
 * - `GET /accounts/{account_id}/workers/subdomain`: the `workers.dev` URL. https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/
 */
export const listCloudflareDeployments: ListDeployments = async (context, { limit }) => {
  const accountId = context.credentials.accountId ?? context.link.account?.id
  if (!accountId) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOYMENTS_ACCOUNT_REQUIRED({ host: "cloudflare" }), setupExitCodes.inputNeeded, { missing: [{ field: "CLOUDFLARE_ACCOUNT_ID" }], rerun: "vitehub link --host cloudflare --account <id>" })
  const client = createCloudflareProvisionClient({ accountId, token: context.credentials.token }, context.fetch)
  const script = `/workers/scripts/${encodeURIComponent(context.link.project.name)}`
  const [deployments, versions, subdomain] = await Promise.all([
    client(`${script}/deployments`, { parse: parseDeployments }),
    client(`${script}/versions`, { parse: parseVersions, query: { deployable: "true", per_page: String(Math.max(limit, 10)) } }),
    optional(client("/workers/subdomain", { parse: value => isRecord(value) ? optionalString(value.subdomain) : undefined })),
  ])
  const byId = new Map((versions.result ?? []).map(version => [version.id, version]))
  const listed = (deployments.result ?? []).slice(0, limit)
  // A deployment of an older version than the version list holds: read that version alone.
  const missing = [...new Set(listed.flatMap(item => item.versionId && !byId.has(item.versionId) ? [item.versionId] : []))]
  for (const version of await Promise.all(missing.map(id => optional(client(`${script}/versions/${encodeURIComponent(id)}`, { parse: parseVersion }))))) {
    if (version?.result) byId.set(version.result.id, version.result)
  }

  const name = context.link.project.name
  const host = subdomain?.result ? `${subdomain.result}.workers.dev` : undefined
  const previewUrl = (version: CloudflareVersion | undefined) => host && version?.hasPreview ? `https://${version.id.slice(0, 8)}-${name}.${host}` : undefined
  const deployed = new Set(listed.flatMap(item => item.versionIds))
  const result: HostDeployment[] = listed.map((item, index) => {
    const version = item.versionId ? byId.get(item.versionId) : undefined
    const url = index === 0 && host ? `https://${name}.${host}` : previewUrl(version)
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
  return result.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
}
