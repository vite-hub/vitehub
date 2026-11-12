import { existsSync } from "node:fs"

import { createNetlifyApiClient } from "@vite-hub/internal/provision"
import { join } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"
import { commitMessage, hostCli, hostCliFailed, isoTime, isRecord, lastJsonObject, optionalString, parseCommitMessage } from "./host.ts"

import type { DeployAdapter, DeployContext, HostDeployment, ListDeployments } from "./host.ts"

interface NetlifySite {
  id: string
  accountId?: string
}

/** Nitro's Netlify preset writes static files to `dist` (`output.publicDir`). */
const publishDir = "dist"

// Netlify CLI 27.11: `netlify deploy --help`, recorded in test/fixtures/host-cli-help/. The CLI reads NETLIFY_AUTH_TOKEN
// from the environment.
export function netlifyAdapter(context: DeployContext): DeployAdapter {
  const netlify = hostCli("netlify", "netlify-cli", context.root, context.env)
  const linked = context.link?.host === "netlify" && context.link.project.id ? context.link : undefined
  let site: NetlifySite | undefined = linked?.project.id ? { id: linked.project.id, ...(linked.account ? { accountId: linked.account.id } : {}) } : undefined

  return {
    async deploy() {
      const args = ["deploy", "--no-build", "--dir", publishDir, "--json", ...(context.preview ? ["--context", "deploy-preview"] : ["--prod"])]
      // ViteHub writes this wrapper for the older Nitro layout. Netlify finds `.netlify/v1/functions` by itself.
      if (existsSync(join(context.outputDir, "functions", "server.mjs"))) args.push("--functions", join(context.outputDir, "functions"))
      args.push(...(site ? ["--site", site.id] : ["--site-name", context.projectName]))
      if (context.commit) args.push("--message", commitMessage(context.commit))
      const result = await context.run(netlify[0], [...netlify.slice(1), ...args], { cwd: context.root, env: context.env, show: true })
      if (result.exitCode !== 0) throw hostCliFailed("netlify deploy", result, context.secrets)
      const json = lastJsonObject(result.stdout)
      const url = optionalString(json?.url) ?? optionalString(json?.deploy_url)
      if (!url) throw hostCliFailed("netlify deploy printed no URL", result, context.secrets)
      const siteId = optionalString(json?.site_id)
      if (siteId && siteId !== site?.id) site = { id: siteId }
      const deploymentId = optionalString(json?.deploy_id)
      const name = optionalString(json?.site_name) ?? context.projectName
      return { url, ...(deploymentId ? { deploymentId } : {}), project: { ...(site ? { id: site.id } : {}), name, ...(site?.accountId ? { accountId: site.accountId } : {}) } }
    },
  }
}

const buildingStates = new Set(["new", "pending_review", "accepted", "enqueued", "building", "uploading", "uploaded", "preparing", "prepared", "processing", "processed", "retrying"])

function netlifyState(value: unknown): HostDeployment["state"] {
  if (value === "ready") return "ready"
  if (value === "error") return "error"
  if (value === "rejected") return "canceled"
  return typeof value === "string" && buildingStates.has(value) ? "building" : "unknown"
}

function parseNetlifyDeploys(value: unknown, published: string | undefined): HostDeployment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const id = isRecord(item) ? optionalString(item.id) : undefined
    if (!id || !isRecord(item)) return []
    // `netlify deploy --message` is the deploy `title`. A Git build has `commit_ref`.
    const marked = parseCommitMessage(item.title)
    const ref = optionalString(item.commit_ref)
    const commit: HostDeployment["commit"] = marked ? { ...marked, from: "vitehub" } : ref ? { dirty: false, from: "host", sha: ref } : undefined
    const url = optionalString(item.deploy_ssl_url) ?? optionalString(item.deploy_url)
    return [{
      createdAt: isoTime(item.created_at),
      id,
      live: id === published,
      source: marked ? "cli" : ref ? "git" : "unknown",
      state: netlifyState(item.state),
      target: item.context === "production" ? "production" : "preview",
      ...(url ? { url } : {}),
      ...(commit ? { commit } : {}),
    } satisfies HostDeployment]
  })
}

/**
 * Netlify API (https://open-api.netlify.com/), with the site id that `vitehub link` or the first `vitehub deploy` stored:
 * - `GET /api/v1/sites/{site_id}/deploys?per_page=`, newest first (`listSiteDeploys`).
 * - `GET /api/v1/sites/{site_id}`: `published_deploy.id` is the deploy that serves production (`getSite`).
 */
export const listNetlifyDeployments: ListDeployments = async (context, { limit, includeLive }) => {
  const siteId = context.link.project.id
  if (!siteId) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOYMENTS_PROJECT_ID_REQUIRED({ host: "netlify" }), setupExitCodes.inputNeeded, { missing: [{ field: "project.id" }], rerun: "vitehub link --host netlify" })
  const client = createNetlifyApiClient(context.credentials.token, context.fetch)
  const path = `/sites/${encodeURIComponent(siteId)}`
  const [site, deploys] = await Promise.all([client(path), client(`${path}/deploys`, { query: { page: "1", per_page: String(limit) } })])
  const published = isRecord(site) && isRecord(site.published_deploy) ? optionalString(site.published_deploy.id) : undefined
  const recent = parseNetlifyDeploys(deploys, published).slice(0, limit)
  if (includeLive && published && !recent.some(item => item.live)) {
    const live = await client(`/deploys/${encodeURIComponent(published)}`)
    recent.push(...parseNetlifyDeploys([live], published))
  }
  return recent
}
