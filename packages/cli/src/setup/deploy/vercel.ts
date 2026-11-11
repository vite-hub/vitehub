import { readFile } from "node:fs/promises"

import { createVercelProvisionClient } from "@vite-hub/internal/provision"
import { join } from "pathe"

import { createDeployRun, hostCli, hostCliFailed, isoTime, isRecord, lastJsonObject, optionalString } from "./host.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { DeployAdapter, DeployContext, DeployResult, HostDeployment, HostDeploymentSource, ListDeployments } from "./host.ts"

/** Check the CLI's saved session without reading its auth files or exposing a token. */
export async function hasVercelLogin(root: string, context: ViteHubCliContext): Promise<boolean> {
  try {
    const [command, ...args] = hostCli("vercel", "vercel", root, context.env)
    const run = context.runHostCli ?? createDeployRun(context.stderr, [])
    const result = await run(command, [...args, "whoami"], { cwd: root, env: context.env })
    return result.exitCode === 0
  }
  catch {
    return false
  }
}

/** Reads `claimUrl` and `expiresAt` that `vercel deploy --temporary` keeps in `.vercel/anonymous.json`. Its token stays there. */
async function readClaim(root: string): Promise<DeployResult["claim"]> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(root, ".vercel", "anonymous.json"), "utf8"))
  }
  catch {
    return
  }
  const url = isRecord(value) ? optionalString(value.claimUrl) : undefined
  if (!url || !isRecord(value)) return
  return { url, ...(typeof value.expiresAt === "number" ? { expiresAt: new Date(value.expiresAt).toISOString() } : {}) }
}

// Vercel CLI 65.11: `vercel deploy --help`, recorded in test/fixtures/host-cli-help/. The CLI reads VERCEL_TOKEN from the environment, so no token goes in argv.
export function vercelAdapter(context: DeployContext): DeployAdapter {
  const vercel = hostCli("vercel", "vercel", context.root, context.env)
  const credentialTeam = context.credentials.ok ? context.credentials.teamId : optionalString(context.env.VERCEL_TEAM_ID?.trim()) ?? optionalString(context.env.VERCEL_ORG_ID?.trim())
  const team = (context.link?.host === "vercel" ? context.link.account?.id : undefined) ?? credentialTeam
  const project = context.link?.host === "vercel" ? context.link.project.id ?? context.projectName : context.projectName
  const target = context.temporary ? [] : ["--project", project, ...(team ? ["--scope", team] : [])]
  const run = (args: readonly string[], options: { stdin?: string, show?: boolean } = {}) =>
    context.run(vercel[0], [...vercel.slice(1), ...args], { cwd: context.root, env: context.env, ...options })

  return {
    async deploy() {
      const args = ["deploy", "--prebuilt", "--yes", "--json", ...(context.preview ? [] : ["--prod"])]
      if (context.temporary) args.push("--temporary")
      else args.push(...target, "--create-if-missing")
      if (context.commit) args.push("--meta", `vitehubCommit=${context.commit.sha}`, "--meta", `vitehubDirty=${context.commit.dirty}`)
      const result = await run(args, { show: true })
      if (result.exitCode !== 0) throw hostCliFailed("vercel deploy", result, context.secrets)
      // Without a terminal the CLI wraps the deployment in `{ status, deployment }`.
      const json = lastJsonObject(result.stdout)
      const deployment = isRecord(json?.deployment) ? json.deployment : json
      const url = context.preview ? optionalString(deployment?.url) : optionalString(deployment?.productionUrl) ?? optionalString(deployment?.url)
      if (!url) throw hostCliFailed("vercel deploy printed no URL", result, context.secrets)
      const id = optionalString(deployment?.id)
      const claim = context.temporary ? await readClaim(context.root) : undefined
      return { url, ...(id ? { deploymentId: id } : {}), ...(claim ? { claim } : {}), ...(context.temporary ? {} : { project: { name: context.projectName, ...(team ? { accountId: team } : {}) } }) }
    },
  }
}

const gitSources = new Set(["git", "git-deploy-hook", "api-trigger-git-deploy", "import/repo", "clone/repo"])

/** `source` of a deployment: https://vercel.com/docs/rest-api/reference/endpoints/deployments/list-deployments */
function vercelSource(value: unknown, commit: HostDeployment["commit"]): HostDeploymentSource {
  if (value === "cli") return "cli"
  if (typeof value === "string" && gitSources.has(value)) return "git"
  if (value === "redeploy" || value === "import" || value === "drop" || value === "v0-web") return "dashboard"
  return commit?.from === "host" ? "git" : "unknown"
}

function vercelState(value: unknown): HostDeployment["state"] {
  if (value === "READY") return "ready"
  if (value === "ERROR") return "error"
  if (value === "CANCELED" || value === "DELETED") return "canceled"
  if (value === "BUILDING" || value === "INITIALIZING" || value === "QUEUED" || value === "BLOCKED") return "building"
  return "unknown"
}

/** `vitehubCommit` and `vitehubDirty` from `vercel deploy --meta`, else the commit of a Git integration build. */
function vercelCommit(meta: unknown): HostDeployment["commit"] {
  if (!isRecord(meta)) return
  const marked = optionalString(meta.vitehubCommit)
  if (marked && /^[0-9a-f]{40,64}$/u.test(marked)) return { dirty: meta.vitehubDirty === "true", from: "vitehub", sha: marked }
  const git = optionalString(meta.githubCommitSha) ?? optionalString(meta.gitlabCommitSha) ?? optionalString(meta.bitbucketCommitSha)
  return git ? { dirty: false, from: "host", sha: git } : undefined
}

function parseVercelDeployments(value: unknown, production: string | undefined): HostDeployment[] {
  const items = isRecord(value) && Array.isArray(value.deployments) ? value.deployments : []
  return items.flatMap((item: unknown) => {
    const id = isRecord(item) ? optionalString(item.uid) ?? optionalString(item.id) : undefined
    if (!id || !isRecord(item)) return []
    const commit = vercelCommit(item.meta)
    const url = optionalString(item.url)
    return [{
      createdAt: isoTime(item.created ?? item.createdAt),
      id,
      live: id === production,
      source: vercelSource(item.source, commit),
      state: vercelState(item.state ?? item.readyState),
      target: item.target === "production" ? "production" : "preview",
      ...(url ? { url: url.startsWith("https://") ? url : `https://${url}` } : {}),
      ...(commit ? { commit } : {}),
    } satisfies HostDeployment]
  })
}

/**
 * Vercel REST API, with `teamId` for a team:
 * - `GET /v6/deployments?projectId=&limit=`, newest first. The Vercel CLI 65.11 lists with v6; the docs show the same
 *   fields on v7: https://vercel.com/docs/rest-api/reference/endpoints/deployments/list-deployments
 * - `GET /v9/projects/{idOrName}`: `targets.production` is the deployment that serves production, which the Vercel CLI
 *   also reads. https://vercel.com/docs/rest-api/reference/endpoints/projects/find-a-project-by-id-or-name
 */
export const listVercelDeployments: ListDeployments = async (context, { limit, includeLive }) => {
  const linked = context.link.account?.id
  // `vitehub link` stores the project owner, which is a user id on a personal account. Only a team id goes in `teamId`.
  const teamId = linked ? (linked.startsWith("team_") ? linked : undefined) : context.credentials.teamId
  const client = createVercelProvisionClient({ teamId, token: context.credentials.token }, context.fetch)
  const project = context.link.project.id ?? context.link.project.name
  const [details, list] = await Promise.all([
    client(`/v9/projects/${encodeURIComponent(project)}`),
    client("/v6/deployments", { query: { limit: String(limit), projectId: project } }),
  ])
  const targets = isRecord(details) && isRecord(details.targets) ? details.targets : undefined
  const production = targets && isRecord(targets.production) ? optionalString(targets.production.id) : undefined
  const recent = parseVercelDeployments(list, production).slice(0, limit)
  if (includeLive && production && !recent.some(item => item.live)) {
    const live = await client(`/v13/deployments/${encodeURIComponent(production)}`)
    recent.push(...parseVercelDeployments({ deployments: [live] }, production))
  }
  return recent
}
